import type { PublishSession } from '@seedingsys/connectors-core';
import { SUCCESS, type PublishSnapshot } from '@seedingsys/contracts';
import { accountResource, acquireLease, activeKillSwitch, assertLeaseHeld, audit, releaseLease, tx } from '@seedingsys/db';
import { commentBody, facebookPostId, facebookUrl, RetryLaterError } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';

export async function handleCommentPublish(ctx: BrowserCtx, { replayId, sendVersion }: { replayId: string; sendVersion: number }, retryCount = 0) {
  const where = { id: replayId, sendVersion };
  const replay = await ctx.db.publicationComment.findFirst({ where: { ...where, status: 'QUEUED' }, include: {
    author: { include: { profile: { include: { workerNode: true } } } },
    source: { include: { post: true } },
  } });
  if (!replay) return;
  const { author, source, destinationId } = replay;
  if (author?.profile?.workerNode && author.profile.workerNode.name !== ctx.actor) {
    if (retryCount < 6) throw new RetryLaterError('Chờ worker quản lý hồ sơ bình luận.');
    await ctx.db.publicationComment.updateMany({ where: { ...where, status: 'QUEUED' }, data: { status: 'FAILED', sendDetail: 'Worker của hồ sơ bình luận chưa nhận lượt đăng.' } });
    return;
  }
  let session: PublishSession | undefined;
  let lease: Awaited<ReturnType<typeof acquireLease>> = null;
  let started = false;
  try {
    if (!author?.enabled || author.connector !== 'fb-web' || !author.profile || source.post.archivedAt) {
      throw new Error('Bài nguồn hoặc hồ sơ đăng bình luận hiện không khả dụng.');
    }
    const publication = await ctx.db.publication.findUnique({ where: { targetId_sourcePostId: { targetId: destinationId, sourcePostId: source.sourcePostId } },
      include: { target: true, variant: { select: { snapshot: true } } } });
    const post = facebookUrl(publication?.permalink);
    if (!post || !facebookPostId(post) || !publication || !SUCCESS.includes(publication.status) || !publication.target.enabled) {
      throw new Error('Bài đích chưa được xác nhận hoặc không còn khả dụng.');
    }
    const snapshot = publication.variant.snapshot as PublishSnapshot | null;
    if (author.id !== destinationId && (snapshot?.audience ?? publication.target.audience) === 'ONLY_ME') {
      throw new Error('Bài đích ở chế độ Chỉ mình tôi. Hồ sơ khác không thể bình luận.');
    }
    const parent = source.parentExternalId && await ctx.db.publicationComment.findFirst({
      where: { destinationId, status: 'POSTED', source: { externalId: source.parentExternalId, sourcePostId: source.sourcePostId } },
    });
    const parentUrl = parent ? facebookUrl(parent.permalink) : null;
    const parentId = parentUrl?.searchParams.get('reply_comment_id') ?? parentUrl?.searchParams.get('comment_id') ?? undefined;
    if (source.parentExternalId && (!parentId || !parentUrl || facebookPostId(parentUrl) !== facebookPostId(post))) {
      throw new Error('Chờ bình luận cha được đăng và có liên kết trên bài đích.');
    }
    const paused = () => Promise.all([author.id, destinationId].map(targetId =>
      activeKillSwitch(ctx.db, { targetId, connector: 'fb-web' }))).then(results => results.some(Boolean));
    if (await paused()) throw new Error('Đang tạm dừng đăng trên hồ sơ Facebook.');
    lease = await acquireLease(ctx.db, { resource: accountResource(author.id), holder: ctx.workerId + ':comment-publish',
      ttlMs: 240_000, now: ctx.clock.now(), purpose: 'comment-publish' });
    if (!lease) throw new RetryLaterError('Hồ sơ đang bận. Bình luận sẽ chờ.');
    const connector = ctx.registry.publisher(author.connector);
    session = await connector.openSession({ ...author, profileDir: author.profile.profileDir });
    if (!session.postComment || await session.sessionState() !== 'OK' || !(await session.checkIdentity(author.externalId)).ok) {
      throw new Error('Hồ sơ Facebook chưa sẵn sàng hoặc đang đăng nhập sai tài khoản.');
    }
    if (parentUrl) {
      post.searchParams.set('comment_id', parentUrl.searchParams.get('comment_id')!);
      if (parentUrl.searchParams.has('reply_comment_id')) post.searchParams.set('reply_comment_id', parentId!);
    }
    // Post only the comment text itself (no quotation header / source link).
    const text = commentBody(replay.text);
    if (!text) throw new Error('Bình luận trống sau khi bỏ nhãn tác giả.');
    const result = await session.postComment({ post, parentId, text }, async () => {
      if (await paused()) throw new Error('Đăng bình luận vừa được tạm dừng.');
      await tx(ctx.db, async t => {
        const [current] = await t.$queryRaw<Array<{ archived_at: Date | null }>>`SELECT archived_at FROM source_posts WHERE id=${source.sourcePostId}::uuid FOR SHARE`;
        if (!current || current.archived_at || !await assertLeaseHeld(t, lease!, ctx.clock.now())) {
          throw new Error('Bài nguồn hoặc phiên đăng không còn hiệu lực.');
        }
        const changed = await t.publicationComment.updateMany({ where: { ...where, status: 'QUEUED' }, data: { status: 'SENDING' } });
        if (!changed.count) throw new Error('Lượt gửi đã thay đổi.');
      });
      started = true;
    });
    if (!started || !result) throw new Error('Chưa xác minh được liên kết bình luận.');
    await tx(ctx.db, async t => {
      const changed = await t.publicationComment.updateMany({ where: { ...where, status: 'SENDING' },
        data: { status: 'POSTED', ...result, sendDetail: null } });
      if (changed.count) await audit(t, { entityType: 'source_post', entityId: source.sourcePostId, actor: ctx.actor,
        action: 'comment_published', at: ctx.clock.now(), data: { replayId, authorTargetId: author.id, destinationId } });
    });
  } catch (err) {
    if (!started && err instanceof RetryLaterError && retryCount < 6) throw err;
    const detail = started ? 'Chưa xác minh được kết quả. Mở bài đích để đối chiếu và ghi nhận liên kết.'
      : (err instanceof Error ? err.message : 'Không chuẩn bị được bình luận.').slice(0, 350);
    await ctx.db.publicationComment.updateMany({ where: { ...where, status: started ? 'SENDING' : 'QUEUED' },
      data: { status: started ? 'UNKNOWN' : 'FAILED', sendDetail: detail } });
  } finally {
    await session?.close();
    if (lease) await releaseLease(ctx.db, lease, ctx.clock.now());
  }
}
