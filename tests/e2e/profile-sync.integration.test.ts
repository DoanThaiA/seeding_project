import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FbGraphReadConnector } from '@seedingsys/connectors-fb-graph';
import { dispatchBacklogItem, dispatchSlot, ingestPost, listBacklog, setControl } from '@seedingsys/db';
import { HOUR } from '@seedingsys/domain';
import { Q, type JobPayload } from '@seedingsys/contracts';
import { LibraryController } from '../../apps/api/src/library.controller';
import { handleProfileSync } from '../../apps/worker-browser/src/handlers/profile-sync';
import { handleCommentPublish } from '../../apps/worker-browser/src/handlers/comment-publish';
import { handlePublish } from '../../apps/worker-browser/src/handlers/publish';
import { handleSourcePoll } from '../../apps/worker-browser/src/handlers/source-poll';
import { createHarness, MIN, type Harness } from '../helpers/harness';

const actor = { actor: 'test-profile-admin', role: 'admin' } as const;

describe('profile sync and source trash', () => {
  let h: Harness;
  let library: LibraryController;
  beforeEach(async () => {
    h = await createHarness({ codes: [1, 2] });
    library = new LibraryController(h.db, h.clock);
  });
  afterEach(async () => { await h.close(); });

  it('stages only the chosen target, blocks dispatch from trash, and retains the archive across re-reads', async () => {
    const origin = h.ids.sources.A1;
    const targetId = h.ids.targets.B1;
    const body = { externalId: 'sample-a', contentType: 'TEXT', text: 'Một bài viết gốc cần giữ đầy đủ khi đồng bộ.',
      identityConfidence: 'HIGH', isPinned: false, isShared: false, incomplete: [], media: [] } as const;
    const store = () => h.db.$transaction(t => ingestPost(t, { sourceId: origin, connector: 'fake', now: h.clock.now(),
      baseline: false, actor: actor.actor, archiveOnly: true, post: { ...body, incomplete: [], media: [] } }));
    await store();
    const post = await h.db.sourcePost.findFirstOrThrow({ where: { sourceId: origin } });
    await h.db.sourceComment.create({ data: { sourcePostId: post.id, externalId: 'comment-1', text: 'Bình luận nguồn',
      position: 0, lastSeenAt: h.clock.now() } });
    const first = await library.queueProfileSync('A1', { targetId, history: false }, actor);
    expect(await library.queueProfileSync('A1', { targetId, history: false }, actor)).toEqual({ syncId: first.syncId, queued: false });
    await handleProfileSync(h.browser, { syncId: first.syncId, step: 0 });
    await handleProfileSync(h.browser, { syncId: first.syncId, step: 0 });
    const [summary] = await library.profileSyncs('A1');
    expect(summary.latest?.stats).toMatchObject({ posts: 1, toReview: 1, scansUnrequested: 1 });
    expect(await h.db.publicationComment.findFirst({ where: { destinationId: targetId } })).toMatchObject({ status: 'DRAFT', text: 'Bình luận nguồn', authorTargetId: null });
    const variant = await h.db.contentVariant.findFirstOrThrow({ where: { targetId } });
    expect(variant).toMatchObject({ status: 'NEEDS_REVIEW', caption: body.text });
    expect(await library.approveProfileSync(first.syncId, actor)).toEqual({ approved: 1 });
    await h.db.source.update({ where: { id: origin }, data: { enabled: false } });
    h.advance(HOUR - h.clock.now().getTime() % HOUR);
    await h.workerHeartbeat();
    const scheduled = await h.db.publicationSlot.create({ data: { targetId, slotAt: h.clock.now() } });
    expect(await dispatchSlot(h.core, scheduled.id)).toBe('SKIPPED_NO_CONTENT');
    h.advance(MIN);
    await h.workerHeartbeat();
    await h.db.capabilityCheck.updateMany({ where: { targetId, contentType: 'TEXT' }, data: { passed: false } });
    expect(await listBacklog(h.db, h.clock.now())).toContainEqual(expect.objectContaining({ id: variant.id, blockReason: 'FORMAT_NOT_CERTIFIED' }));
    await expect(dispatchBacklogItem(h.core, variant.id)).rejects.toMatchObject({ reason: 'FORMAT_NOT_CERTIFIED' });
    await h.db.capabilityCheck.updateMany({ where: { targetId, contentType: 'TEXT' }, data: { passed: true } });
    expect(await listBacklog(h.db, h.clock.now())).toContainEqual(expect.objectContaining({ id: variant.id, blockReason: null }));
    const pubId = await dispatchBacklogItem(h.core, variant.id);
    await library.archive(post.id, { archived: true }, actor);
    expect((await library.posts('A1', '1', '')).posts).toHaveLength(0);
    expect((await library.posts('A1', '1', '', '1')).posts[0]?.id).toBe(post.id);
    expect(await store()).toBe('UNCHANGED');
    expect(await h.db.publication.findUnique({ where: { id: pubId } })).toMatchObject({ status: 'CANCELLED', lastReason: 'SOURCE_POST_ARCHIVED' });
    await handlePublish(h.browser, { publicationId: pubId, jobVersion: 1 });
    expect(h.platform.timeline('fb-B1')).toHaveLength(0);
    await library.archive(post.id, { archived: false }, actor);
    expect((await library.posts('A1', '1', '')).posts[0]?.id).toBe(post.id);
    const next = await library.queueProfileSync('A1', { targetId, history: false }, actor);
    await handleProfileSync(h.browser, { syncId: next.syncId, step: 0 });
    expect(await h.db.contentVariant.count({ where: { sourcePostId: post.id, targetId } })).toBe(1);
    expect(await h.db.publicationComment.count({ where: { destinationId: targetId } })).toBe(1);
    h.advance(MIN);
    await h.workerHeartbeat();
    const restoredPubId = await dispatchBacklogItem(h.core, variant.id);
    const restoredPublication = await h.db.publication.findUniqueOrThrow({ where: { id: restoredPubId } });
    await handlePublish(h.browser, { publicationId: restoredPubId, jobVersion: restoredPublication.jobVersion });
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
    const authorId = h.ids.targets.B2;
    const permalink = 'https://www.facebook.com/B1/posts/123';
    await h.db.targetAccount.update({ where: { id: authorId }, data: { connector: 'fb-web' } });
    await expect(library.confirmPublishedLink(post.id, targetId, { permalink: 'https://www.facebook.com/B1' }, actor)).rejects.toThrow('liên kết trực tiếp');
    await library.confirmPublishedLink(post.id, targetId, { permalink }, actor);
    const original = await h.db.sourceComment.findFirstOrThrow({ where: { sourcePostId: post.id } });
    const reply = await h.db.sourceComment.create({ data: { sourcePostId: post.id, externalId: 'reply-1', parentExternalId: original.externalId,
      text: 'Trả lời bình luận nguồn', position: 1, lastSeenAt: h.clock.now() } });
    for (const c of [original, reply]) await library.updateComment(post.id, targetId, c.id, { action: 'approve', authorTargetId: authorId, text: c.text }, actor);
    const send = (commentId: string) => library.updateComment(post.id, targetId, commentId, { action: 'send' }, actor);
    await expect(send(original.id)).rejects.toThrow('Chỉ mình tôi');
    const frozen = (await h.db.contentVariant.findUniqueOrThrow({ where: { id: variant.id } })).snapshot as object;
    await h.db.contentVariant.update({ where: { id: variant.id }, data: { snapshot: { ...frozen, audience: 'FRIENDS' } } });
    await expect(send(reply.id)).rejects.toThrow('bình luận cha');
    const submitted: Array<{ parentId?: string; text: string }> = [];
    const commentWorker = { ...h.browser, actor: 'browser:test' };
    h.browser.registry.addPublisher({
      key: 'fb-web', version: 'test', capabilities: () => ({}),
      openSession: async target => {
        expect(target.code).toBe('B2');
        const session = await h.browser.registry.publisher('fake').openSession(target);
        session.postComment = async ({ parentId, text }, beforeSubmit) => {
          await beforeSubmit();
          submitted.push({ parentId, text });
          return parentId ? null : { externalId: '34', permalink: permalink + '?comment_id=34' };
        };
        return session;
      },
    });
    for (const c of [original, reply]) {
      await send(c.id);
      const event = await h.db.outboxEvent.findFirstOrThrow({ where: { queue: Q.CommentPublish }, orderBy: { id: 'desc' } });
      const payload = event.payload as JobPayload<typeof Q.CommentPublish>;
      await handleCommentPublish(commentWorker, payload);
      await handleCommentPublish(commentWorker, payload);
    }
    expect(submitted).toMatchObject([{ text: expect.stringContaining(original.text) }, { parentId: '34', text: expect.stringContaining(reply.text) }]);
    await expect(send(reply.id)).rejects.toThrow('đối chiếu');
    await library.updateComment(post.id, targetId, reply.id, { action: 'posted', permalink: permalink + '?comment_id=34&reply_comment_id=35' }, actor);
    expect(await h.db.publicationComment.count({ where: { destinationId: targetId, status: 'POSTED' } })).toBe(2);
    await library.archive(post.id, { archived: true }, actor);
    expect((await library.posts('B1', '1', '')).posts[0]).toMatchObject({ id: post.id, status: 'PUBLISHED_VERIFIED' });
  }, 45_000);

  it('reads all Graph history pages through separate jobs without changing the normal poll watermark', async () => {
    const sourceId = h.ids.sources.A1;
    const targetId = h.ids.targets.B1;
    const requested: string[] = [];
    h.browser.registry.addReader(new FbGraphReadConnector({ tokens: { A1: 'test' }, fetch: async input => {
      const cursor = new URL(String(input)).searchParams.get('after') ?? '';
      requested.push(cursor);
      return new Response(JSON.stringify({ data: [{ id: cursor ? '100_2' : '100_1', message: 'Bài lịch sử ' + (cursor || 'đầu'),
        permalink_url: 'https://www.facebook.com/100/posts/' + (cursor ? '2' : '1') }],
      ...(cursor ? {} : { paging: { next: 'https://graph.facebook.com/example', cursors: { after: 'page2' } } }) }));
    } }));
    await h.db.source.update({ where: { id: sourceId }, data: { connector: 'fb-graph', externalRef: '100', watermark: { newest: 123 }, collectComments: true } });
    const request = await library.queueProfileSync('A1', { targetId, history: true }, actor);
    for (let step = 0; step <= 2; step++) await handleProfileSync(h.browser, { syncId: request.syncId, step });
    expect(requested).toEqual(['', 'page2']);
    expect(await h.db.profileSync.findUnique({ where: { id: request.syncId } })).toMatchObject({ phase: 'PREPARED', historyDone: true });
    expect(await h.db.commentScan.count()).toBe(2);
    expect(await h.db.contentVariant.count({ where: { targetId, status: 'NEEDS_REVIEW' } })).toBe(2);
    expect(await h.db.source.findUnique({ where: { id: sourceId } })).toMatchObject({ watermark: { newest: 123 } });
  }, 45_000);

  it('continues Graph polls through a burst larger than the page budget and leaves no gaps', async () => {
    const sourceId = h.ids.sources.A1;
    const anchor = new Date('2026-11-20T02:35:00.000Z').getTime();
    const requested: number[] = [];
    h.browser.registry.addReader(new FbGraphReadConnector({ tokens: { A1: 'test' }, fetch: async input => {
      const index = Number(new URL(String(input)).searchParams.get('after') ?? 0);
      requested.push(index);
      return new Response(JSON.stringify({
        data: [{ id: `100_${index}`, message: `Bài nguồn ${index}`, created_time: new Date(anchor + (6 - index) * MIN).toISOString() }],
        ...(index < 6 && { paging: { next: 'https://graph.facebook.com/example', cursors: { after: String(index + 1) } } }),
      }));
    } }));
    await h.db.source.update({ where: { id: sourceId }, data: {
      connector: 'fb-graph', externalRef: '100', baselineDone: true, watermark: { newest: anchor }, overlapCount: 1,
    } });
    expect(await handleSourcePoll(h.browser, { sourceId })).toMatchObject({ outcome: 'OK', counts: { NEW_POST: 5 } });
    expect(await h.db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({
      watermark: { newest: anchor, nextCursor: '5' }, lastIncomplete: ['PAGINATION_INCOMPLETE'],
    });
    expect(await handleSourcePoll(h.browser, { sourceId })).toMatchObject({ outcome: 'OK', counts: { NEW_POST: 2 } });
    expect(requested).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(await h.db.sourcePost.count()).toBe(7);
    expect(await h.db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({
      watermark: { newest: anchor + 6 * MIN }, lastIncomplete: [],
    });
  });

  it('does not write posts or advance the watermark after the source is paused during the read', async () => {
    const sourceId = h.ids.sources.A1;
    h.browser.registry.addReader(new FbGraphReadConnector({ tokens: { A1: 'test' }, fetch: async () => {
      await setControl(h.db, 'SOURCE', sourceId, true, actor.actor);
      return new Response(JSON.stringify({ data: [{ id: '100_1', message: 'Bài đang đọc' }] }));
    } }));
    await h.db.source.update({ where: { id: sourceId }, data: { connector: 'fb-graph', externalRef: '100' } });
    expect(await handleSourcePoll(h.browser, { sourceId })).toEqual({ outcome: 'PAUSED' });
    expect(await h.db.sourcePost.count()).toBe(0);
    expect(await h.db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({
      baselineDone: false, watermark: null, lastSuccessAt: null,
    });
  });

  it('scans a source post and comment, then publishes each exactly once to a simulated destination', async () => {
    const sourceId = h.ids.sources.A1;
    const destinationId = h.ids.targets.B1;
    const authorId = h.ids.targets.B2;
    const originalText = 'Bài thử giới thiệu chương trình tại cửa hàng.';
    const commentText = 'Mình quan tâm tới chương trình này.';
    const destinationLink = 'https://www.facebook.com/mock-destination/posts/900';
    const commentLink = destinationLink + '?comment_id=400';
    h.browser.registry.addReader(new FbGraphReadConnector({ tokens: { A1: 'test' }, fetch: async input => {
      const path = new URL(String(input)).pathname;
      const data = path === '/100/posts'
        ? [{ id: '100_21', message: originalText, created_time: h.clock.now().toISOString(),
          permalink_url: 'https://www.facebook.com/100/posts/21' }]
        : path === '/100_21/comments' ? [{ id: '100_42', message: commentText, from: { name: 'Khách thử nghiệm' } }] : null;
      if (!data) throw new Error('Unexpected Graph fixture request: ' + path);
      return new Response(JSON.stringify({ data }));
    } }));
    await h.db.source.update({ where: { id: sourceId }, data: {
      connector: 'fb-graph', externalRef: '100', baselineDone: true, collectComments: true,
    } });
    await h.db.targetAccount.update({ where: { id: destinationId }, data: { audience: 'FRIENDS' } });
    await h.db.targetAccount.update({ where: { id: authorId }, data: { connector: 'fb-web' } });

    expect(await handleSourcePoll(h.browser, { sourceId })).toMatchObject({ outcome: 'OK', counts: { NEW_POST: 1 } });
    await h.drain();
    const post = await h.db.sourcePost.findFirstOrThrow({ where: { sourceId, externalId: '100_21' } });
    const variant = await h.db.contentVariant.findFirstOrThrow({ where: { sourcePostId: post.id, targetId: destinationId } });
    const detail = await library.detail(post.id);
    expect(detail.revision.text).toBe(originalText);
    expect(detail.scan).toMatchObject({ status: 'COMPLETE', readCount: 1 });
    const [comment] = detail.comments;
    expect(comment).toMatchObject({ text: commentText, replays: [{ status: 'DRAFT' }] });

    const publicationId = await dispatchBacklogItem(h.core, variant.id);
    await h.drain();
    expect(await h.db.publication.findUnique({ where: { id: publicationId } })).toMatchObject({ status: 'PUBLISHED_VERIFIED' });
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
    await library.confirmPublishedLink(post.id, destinationId, { permalink: destinationLink }, actor);

    const submissions: string[] = [];
    h.browser.registry.addPublisher({
      key: 'fb-web', version: 'test', capabilities: () => ({}),
      openSession: async target => {
        expect(target.id).toBe(authorId);
        const session = await h.browser.registry.publisher('fake').openSession(target);
        session.postComment = async ({ post, text }, beforeSubmit) => {
          expect(post.href).toBe(destinationLink);
          await beforeSubmit();
          submissions.push(text);
          return { externalId: '400', permalink: commentLink };
        };
        return session;
      },
    });
    await library.updateComment(post.id, destinationId, comment.id, { action: 'approve', authorTargetId: authorId, text: commentText }, actor);
    await library.updateComment(post.id, destinationId, comment.id, { action: 'send' }, actor);
    const job = await h.db.outboxEvent.findFirstOrThrow({ where: { queue: Q.CommentPublish } });
    const payload = job.payload as JobPayload<typeof Q.CommentPublish>;
    const commentWorker = { ...h.browser, actor: 'browser:test' };
    await handleCommentPublish(commentWorker, payload);
    await handleCommentPublish(commentWorker, payload);
    expect(submissions).toEqual([commentText]);
    expect(await h.db.publicationComment.findUnique({ where: { id: payload.replayId } })).toMatchObject({
      status: 'POSTED', permalink: commentLink,
    });
    expect(h.failures).toEqual([]);
  });
});
