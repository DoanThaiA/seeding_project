import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FbGraphReadConnector } from '@seedingsys/connectors-fb-graph';
import { COMMENT_STALL_MS, Q, type JobPayload } from '@seedingsys/contracts';
import { dispatchBacklogItem, ingestPost } from '@seedingsys/db';
import { LibraryController } from '../../apps/api/src/library.controller';
import { handleCommentPublish } from '../../apps/worker-browser/src/handlers/comment-publish';
import { handleCommentScan } from '../../apps/worker-browser/src/handlers/comment-scan';
import { handlePublish } from '../../apps/worker-browser/src/handlers/publish';
import { settleStalledComments } from '../../apps/worker-core/src/maintenance/comments';
import { createHarness, type Harness } from '../helpers/harness';

const actor = { actor: 'comments-admin', role: 'admin' } as const;
const body = 'Bài mẫu trong kho kiểm thử';
const permalink = 'https://www.facebook.com/200/posts/456';

describe('comment recovery', () => {
  let h: Harness;
  let library: LibraryController;
  let sourceId: string;
  let targetId: string;

  beforeEach(async () => {
    h = await createHarness({ codes: [1] });
    library = new LibraryController(h.db, h.clock);
    sourceId = h.ids.sources.A1;
    targetId = h.ids.targets.B1;
  });
  afterEach(async () => { await h.close(); });

  async function ingest(connector: string) {
    await h.db.source.update({ where: { id: sourceId }, data: { connector } });
    await h.db.$transaction(t => ingestPost(t, { sourceId, connector, now: h.clock.now(), baseline: false, actor: actor.actor,
      post: { externalId: '100_123', permalink: 'https://www.facebook.com/100/posts/123', text: body, contentType: 'TEXT', identityConfidence: 'HIGH',
        media: [], incomplete: [], isPinned: false, isShared: false } }));
    return h.db.sourcePost.findFirstOrThrow({ where: { sourceId } });
  }

  it('retries malformed Graph responses, stores partial reads, then fills the thread without duplicating its parent', async () => {
    const post = await ingest('fb-graph');
    let mode: 'bad-root' | 'bad-reply' | 'ok' = 'bad-root';
    h.browser.registry.addReader(new FbGraphReadConnector({ tokens: { A1: 'test' }, fetch: async input => {
      const replies = new URL(String(input)).pathname.startsWith('/100_201/');
      if ((replies && mode === 'bad-reply') || (!replies && mode === 'bad-root')) return Response.json({ data: [{ message: 'Thiếu ID' }] });
      return Response.json({ data: replies ? [{ id: '100_202', message: 'Phản hồi được quét lại' }]
        : [{ id: '100_201', message: 'Bình luận gốc', comment_count: 1 }] });
    } }));

    const first = await library.queueComments(post.id, actor);
    h.advance(COMMENT_STALL_MS + 1);
    expect((await settleStalledComments(h.core)).scans).toBe(0);
    expect(await library.queueComments(post.id, actor)).toEqual({ scanId: first.scanId, queued: false });
    await expect(handleCommentScan(h.browser, first)).rejects.toThrow('dữ liệu bình luận không hợp lệ');

    mode = 'bad-reply';
    await handleCommentScan(h.browser, first, 1);
    expect(await h.db.commentScan.findUnique({ where: { id: first.scanId } })).toMatchObject({ status: 'PARTIAL', readCount: 1 });
    expect(await h.db.sourceComment.count()).toBe(1);

    const retry = await library.queueComments(post.id, actor);
    await h.db.commentScan.update({ where: { id: retry.scanId }, data: { status: 'RUNNING', updatedAt: h.clock.now() } });
    h.advance(COMMENT_STALL_MS);
    expect((await settleStalledComments(h.core)).scans).toBe(1);
    expect(await h.db.commentScan.findUnique({ where: { id: retry.scanId } })).toMatchObject({ status: 'FAILED' });

    mode = 'ok';
    const request = await library.queueComments(post.id, actor);
    await handleCommentScan(h.browser, request);
    expect(await h.db.commentScan.findUnique({ where: { id: request.scanId } })).toMatchObject({ status: 'COMPLETE', readCount: 2 });
    expect(await h.db.sourceComment.findMany({ orderBy: { position: 'asc' } })).toMatchObject([
      { externalId: '100_201', parentExternalId: null }, { externalId: '100_202', parentExternalId: '100_201' },
    ]);
    expect(await h.db.publicationComment.count({ where: { status: 'DRAFT' } })).toBe(2);
  });

  it('sends every approved comment of a post at once: parents first, replies wait for their parent', async () => {
    const post = await ingest('fake');
    await h.drain();
    const variant = await h.db.contentVariant.findFirstOrThrow({ where: { sourcePostId: post.id } });
    const pubId = await dispatchBacklogItem(h.core, variant.id);
    await handlePublish(h.browser, { publicationId: pubId, jobVersion: 1 });
    await library.confirmPublishedLink(post.id, targetId, { permalink }, actor);
    await h.db.targetAccount.update({ where: { id: targetId }, data: { connector: 'fb-web' } });
    let position = 0;
    const create = (externalId: string, parentExternalId?: string) => h.db.sourceComment.create({ data: {
      sourcePostId: post.id, externalId, parentExternalId, text: 'Nội dung ' + externalId, position: position++, lastSeenAt: h.clock.now() } });
    // Thread order as scanned: a reply can come before a later top-level comment.
    const root = await create('r1');
    const child = await create('c1', 'r1');
    const grandchild = await create('g1', 'c1');
    const second = await create('r2');
    const skippedRoot = await create('r3');
    const orphan = await create('o1', 'r3');
    for (const c of [root, child, grandchild, second, skippedRoot, orphan]) {
      await library.updateComment(post.id, targetId, c.id, { action: 'approve', text: c.text, authorTargetId: targetId }, actor);
    }
    await library.updateComment(post.id, targetId, skippedRoot.id, { action: 'omit' }, actor);

    const result = await library.sendApprovedComments(post.id, targetId, actor);
    expect(result).toMatchObject({ queued: 4, skipped: [{ commentId: orphan.id, reason: expect.stringContaining('bỏ qua') }] });
    const jobs = (await h.db.outboxEvent.findMany({ where: { queue: Q.CommentPublish }, orderBy: { id: 'asc' } }))
      .map(e => e.payload as JobPayload<typeof Q.CommentPublish>);
    const replayOf = async (sourceCommentId: string) => h.db.publicationComment.findUniqueOrThrow({
      where: { destinationId_sourceCommentId: { destinationId: targetId, sourceCommentId } } });
    const ids = await Promise.all([root, second, child, grandchild].map(c => replayOf(c.id).then(r => r.id)));
    expect(jobs.map(j => j.replayId)).toEqual(ids);

    let next = 500;
    const sent: Array<{ text: string; parentId?: string; root: string | null }> = [];
    h.browser.registry.addPublisher({ key: 'fb-web', version: 'test', capabilities: () => ({}), openSession: async target => {
      const session = await h.browser.registry.publisher('fake').openSession(target);
      session.postComment = async ({ post: url, parentId, text }, beforeSubmit) => {
        await beforeSubmit();
        const id = String(next++);
        const rootId = url.searchParams.get('comment_id');
        sent.push({ text, parentId, root: rootId });
        return { externalId: id, permalink: permalink + (rootId ? `?comment_id=${rootId}&reply_comment_id=${id}` : `?comment_id=${id}`) };
      };
      return session;
    } });
    const worker = { ...h.browser, actor: 'browser:test' };
    // The reply's job runs before its parent was sent: it waits instead of failing.
    await expect(handleCommentPublish(worker, jobs[2])).rejects.toThrow('Chờ bình luận cha');
    expect(await replayOf(child.id)).toMatchObject({ status: 'QUEUED' });
    for (const job of jobs) await handleCommentPublish(worker, job);
    expect(sent).toEqual([
      { text: 'Nội dung r1', parentId: undefined, root: null }, { text: 'Nội dung r2', parentId: undefined, root: null },
      { text: 'Nội dung c1', parentId: '500', root: '500' }, { text: 'Nội dung g1', parentId: '502', root: '500' },
    ]);
    expect(await replayOf(grandchild.id)).toMatchObject({ status: 'POSTED', permalink: permalink + '?comment_id=500&reply_comment_id=503' });
    expect(await replayOf(orphan.id)).toMatchObject({ status: 'APPROVED' });
  });

  it('replies under a parent recorded from an encoded comment link, and refuses a reply whose parent was skipped', async () => {
    const post = await ingest('fake');
    await h.drain();
    const variant = await h.db.contentVariant.findFirstOrThrow({ where: { sourcePostId: post.id } });
    const pubId = await dispatchBacklogItem(h.core, variant.id);
    await handlePublish(h.browser, { publicationId: pubId, jobVersion: 1 });
    await library.confirmPublishedLink(post.id, targetId, { permalink }, actor);
    await h.db.targetAccount.update({ where: { id: targetId }, data: { connector: 'fb-web' } });
    const create = (externalId: string, position: number, parentExternalId?: string) => h.db.sourceComment.create({ data: {
      sourcePostId: post.id, externalId, parentExternalId, text: 'Bình luận ' + externalId, position, lastSeenAt: h.clock.now() } });
    const parent = await create('p1', 0);
    const child = await create('c1', 1, 'p1');
    const skipped = await create('p2', 2);
    const orphan = await create('c2', 3, 'p2');
    for (const c of [parent, child, skipped, orphan]) {
      await library.updateComment(post.id, targetId, c.id, { action: 'approve', text: c.text, authorTargetId: targetId }, actor);
    }
    await library.updateComment(post.id, targetId, skipped.id, { action: 'omit' }, actor);
    await expect(library.updateComment(post.id, targetId, orphan.id, { action: 'send' }, actor)).rejects.toThrow('đã được bỏ qua');

    const encoded = Buffer.from('comment:456_301').toString('base64url');
    await library.updateComment(post.id, targetId, parent.id, { action: 'posted', permalink: `${permalink}?comment_id=${encoded}&__cft__[0]=x` }, actor);
    expect(await h.db.publicationComment.findFirst({ where: { sourceCommentId: parent.id } }))
      .toMatchObject({ status: 'POSTED', externalId: '301', permalink: permalink + '?comment_id=301' });

    const submitted: Array<{ parentId?: string; root: string | null }> = [];
    h.browser.registry.addPublisher({ key: 'fb-web', version: 'test', capabilities: () => ({}), openSession: async target => {
      const session = await h.browser.registry.publisher('fake').openSession(target);
      session.postComment = async ({ post: url, parentId }, beforeSubmit) => {
        submitted.push({ parentId, root: url.searchParams.get('comment_id') });
        await beforeSubmit();
        return { externalId: '302', permalink: permalink + '?comment_id=301&reply_comment_id=302' };
      };
      return session;
    } });
    await library.updateComment(post.id, targetId, child.id, { action: 'send' }, actor);
    const job = (await h.db.outboxEvent.findFirstOrThrow({ where: { queue: Q.CommentPublish }, orderBy: { id: 'desc' } }))
      .payload as JobPayload<typeof Q.CommentPublish>;
    await handleCommentPublish({ ...h.browser, actor: 'browser:test' }, job);
    expect(submitted).toEqual([{ parentId: '301', root: '301' }]);
    expect(await h.db.publicationComment.findUnique({ where: { id: job.replayId } })).toMatchObject({ status: 'POSTED', externalId: '302' });
  });

  it('holds a lost submit for operator reconciliation and ignores the original job after a confirmed absence', async () => {
    const post = await ingest('fake');
    await h.drain();
    const variant = await h.db.contentVariant.findFirstOrThrow({ where: { sourcePostId: post.id } });
    const pubId = await dispatchBacklogItem(h.core, variant.id);
    await handlePublish(h.browser, { publicationId: pubId, jobVersion: 1 });
    await library.confirmPublishedLink(post.id, targetId, { permalink }, actor);
    await h.db.targetAccount.update({ where: { id: targetId }, data: { connector: 'fb-web' } });
    const original = 'Bình luận kiểm thử\nDòng thứ hai';
    const oldQuote = 'Trích bình luận gốc của Tác giả\n\n' + original;
    const comment = await h.db.sourceComment.create({ data: { sourcePostId: post.id, externalId: 'comment-1',
      text: 'Của tác giả\n' + original, position: 0, lastSeenAt: h.clock.now() } });
    const beforeApproval = await library.detail(post.id);
    expect(beforeApproval.comments[0].text).toBe(original);
    await library.updateComment(post.id, targetId, comment.id, { action: 'approve', text: oldQuote, authorTargetId: targetId }, actor);
    const replay = await h.db.publicationComment.findFirstOrThrow({ where: { sourceCommentId: comment.id, destinationId: targetId } });
    expect(replay.text).toBe(original);
    await h.db.publicationComment.update({ where: { id: replay.id }, data: { text: oldQuote } });
    expect((await library.detail(post.id)).comments[0].replays[0].text).toBe(original);
    const send = () => library.updateComment(post.id, targetId, comment.id, { action: 'send' }, actor);
    const lastJob = async () => (await h.db.outboxEvent.findFirstOrThrow({ where: { queue: Q.CommentPublish }, orderBy: { id: 'desc' } }))
      .payload as JobPayload<typeof Q.CommentPublish>;
    await send();
    const oldJob = await lastJob();
    expect((await h.db.publicationComment.findUniqueOrThrow({ where: { id: oldJob.replayId } })).text).toBe(original);
    await h.db.publicationComment.update({ where: { id: oldJob.replayId }, data: { status: 'SENDING', updatedAt: h.clock.now() } });

    h.advance(COMMENT_STALL_MS);
    expect((await settleStalledComments(h.core)).sending).toBe(1);
    await expect(library.archive(post.id, { archived: true }, actor)).rejects.toThrow('bình luận');
    await expect(send()).rejects.toThrow('đối chiếu');
    await expect(library.updateComment(post.id, targetId, comment.id, { action: 'confirmed_absent' }, { ...actor, role: 'reviewer' })).rejects.toThrow('quyền vận hành');
    await library.updateComment(post.id, targetId, comment.id, { action: 'confirmed_absent' }, actor);
    await send();
    const archivedJob = await lastJob();
    await library.archive(post.id, { archived: true }, actor);
    expect(await h.db.publicationComment.findUnique({ where: { id: archivedJob.replayId } })).toMatchObject({ status: 'FAILED' });
    await library.archive(post.id, { archived: false }, actor);
    await send();

    const freshJob = await lastJob();
    expect(freshJob.sendVersion).toBe(archivedJob.sendVersion + 1);
    await h.db.publicationComment.update({ where: { id: freshJob.replayId }, data: { text: oldQuote } });
    let submissions = 0;
    h.browser.registry.addPublisher({ key: 'fb-web', version: 'test', capabilities: () => ({}), openSession: async target => {
      const session = await h.browser.registry.publisher('fake').openSession(target);
      session.postComment = async ({ text }, beforeSubmit) => {
        expect(text).toBe(original);
        await beforeSubmit();
        submissions++;
        return { externalId: '301', permalink: permalink + '?comment_id=301' };
      };
      return session;
    } });
    const worker = { ...h.browser, actor: 'browser:test' };
    await handleCommentPublish(worker, oldJob);
    await handleCommentPublish(worker, archivedJob);
    await handleCommentPublish(worker, freshJob);
    await handleCommentPublish(worker, freshJob);
    expect(submissions).toBe(1);
    expect(await h.db.publicationComment.findUnique({ where: { id: freshJob.replayId } })).toMatchObject({ status: 'POSTED', externalId: '301', text: original });
  });
});
