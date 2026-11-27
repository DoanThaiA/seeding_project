import type { PublishSession } from '@seedingsys/connectors-core';
import { COMMENT_PUBLISH_RETRIES, COMMENT_QUEUE_MS, type JobPayload, Q } from '@seedingsys/contracts';
import { accountResource, acquireLease, activeKillSwitch, assertLeaseHeld, audit, lockCommentScript, queueCommentScriptStep, releaseLease, tx, type Tx } from '@seedingsys/db';
import { facebookScriptComment, facebookScriptPost, RetryLaterError } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';
import { withTimeout } from '../runtime/timeout';

export async function handleCommentScriptStep(ctx: BrowserCtx, { stepId, sendVersion }: JobPayload<typeof Q.CommentScriptStep>, retryCount = 0) {
  const key = { id: stepId, sendVersion };
  const step = await ctx.db.commentScriptStep.findFirst({ where: { ...key, status: 'QUEUED' }, include: {
    script: true, target: { include: { profile: { include: { workerNode: true } } } },
  } });
  if (!step?.script.startedAt) return;
  const { script, target, replyTo, replyUrl } = step;
  const profile = target.profile;
  const expiresAt = +step.updatedAt + COMMENT_QUEUE_MS;
  const paused = (db: Tx) => activeKillSwitch(db, { targetId: target.id, connector: 'fb-web' });
  let lease: Awaited<ReturnType<typeof acquireLease>> = null;
  let session: PublishSession | undefined;
  let committed = false;
  try {
    if (+ctx.clock.now() >= expiresAt) throw new Error('Hết thời gian chờ worker. Có thể gửi lại.');
    if (!target.enabled || target.connector !== 'fb-web' || !profile) throw new Error('Hồ sơ B hiện không sẵn sàng.');
    if (profile.workerNode && profile.workerNode.name !== ctx.actor) throw new RetryLaterError('Đang chờ worker quản lý hồ sơ.');
    if (await paused(ctx.db)) throw new Error('Đăng bình luận trên hồ sơ này đang tạm dừng.');
    if (await ctx.db.commentScriptStep.count({ where: { scriptId: script.id, position: { lt: step.position }, status: { not: 'POSTED' } } })) {
      throw new Error('Cần xác nhận các bước đứng trước.');
    }
    const parent = replyTo === null ? null : await ctx.db.commentScriptStep.findUnique({
      where: { scriptId_position: { scriptId: script.id, position: replyTo } },
    });
    const parentLink = facebookScriptComment(parent?.permalink ?? replyUrl);
    if ((replyTo !== null || replyUrl) && !parentLink) throw new Error('Chưa có liên kết bình luận cần trả lời.');
    lease = await acquireLease(ctx.db, { resource: accountResource(target.id), holder: ctx.workerId + ':comment-script',
      ttlMs: 240_000, now: ctx.clock.now(), purpose: 'comment-script' });
    if (!lease) throw new RetryLaterError('Hồ sơ đang bận. Bình luận sẽ chờ.');
    const fence = lease;
    session = await withTimeout(ctx.registry.publisher(target.connector).openSession({ ...target, profileDir: profile.profileDir }),
      35_000, 'open comment profile', late => late.close());
    if (!session.postComment || await session.sessionState() !== 'OK' || !(await session.checkIdentity(target.externalId)).ok) {
      throw new Error('Hồ sơ Facebook chưa sẵn sàng hoặc đang đăng nhập sai tài khoản.');
    }
    let post = facebookScriptPost(script.resolvedUrl ?? script.postUrl);
    if (post && !post.id && session.resolveCommentPost) post = facebookScriptPost((await session.resolveCommentPost(post.url)).href);
    if (!post?.id) throw new Error('Không xác định được bài Facebook. Kiểm tra liên kết và quyền xem của hồ sơ B.');
    if (parentLink && parentLink.postId !== post.id) throw new Error('Bình luận cần trả lời thuộc bài Facebook khác.');
    const postUrl = post.url.href;
    if (parentLink) {
      post.url.searchParams.set('comment_id', parentLink.root);
      if (parentLink.reply) post.url.searchParams.set('reply_comment_id', parentLink.reply);
    }
    const result = await withTimeout(session.postComment({ post: post.url, parentId: parentLink?.id, text: step.text }, async () => {
      await tx(ctx.db, async t => {
        await lockCommentScript(t, script.id);
        const now = ctx.clock.now();
        const ready = await t.targetAccount.findFirst({ where: { id: target.id, enabled: true, connector: 'fb-web',
          externalId: target.externalId, profile: { is: { id: profile.id, profileDir: profile.profileDir, workerNodeId: profile.workerNodeId } } },
          select: { id: true } });
        if (!ready || +now >= expiresAt || !await assertLeaseHeld(t, fence, now, 20_000) || await paused(t)) {
          throw new Error('Hồ sơ hoặc lượt gửi không còn hiệu lực.');
        }
        const changed = await t.commentScriptStep.updateMany({ where: { ...key, status: 'QUEUED' },
          data: { status: 'SENDING', updatedAt: now } });
        if (!changed.count) throw new Error('Bước đã đổi trạng thái.');
        if (!script.resolvedUrl) await t.commentScript.update({ where: { id: script.id }, data: { resolvedUrl: postUrl } });
      });
      committed = true;
    }), 115_000, 'post script comment');
    const receipt = facebookScriptComment(result?.permalink);
    if (!committed || !receipt || receipt.postId !== post.id || receipt.id !== result?.externalId || (parentLink
      ? receipt.root !== parentLink.root || !receipt.reply || receipt.id === parentLink.id : !!receipt.reply)) {
      throw new Error('Chưa xác minh được liên kết bình luận trên Facebook.');
    }
    await tx(ctx.db, async t => {
      await lockCommentScript(t, script.id);
      const now = ctx.clock.now();
      if (!await assertLeaseHeld(t, fence, now)) throw new Error('Phiên hết hiệu lực trước khi ghi kết quả.');
      const changed = await t.commentScriptStep.updateMany({ where: { ...key, status: 'SENDING' },
        data: { status: 'POSTED', externalId: receipt.id, permalink: receipt.url.href, updatedAt: now } });
      if (!changed.count) return;
      await audit(t, { entityType: 'comment_script', entityId: script.id, action: 'comment_verified', actor: ctx.actor, at: now,
        data: { stepId, targetId: target.id, permalink: receipt.url.href } });
      await queueCommentScriptStep(t, script.id, now);
    });
  } catch (error) {
    if (error instanceof RetryLaterError && !lease && retryCount < COMMENT_PUBLISH_RETRIES) throw error;
    const detail = error instanceof Error ? error.message.split('\n')[0].slice(0, 250) : 'Không gửi được bình luận.';
    const now = ctx.clock.now();
    // A timeout can race the beforeSubmit transaction. Check the stored state before deciding if a retry is safe.
    const changed = await ctx.db.commentScriptStep.updateMany({ where: { ...key, status: 'QUEUED' },
      data: { status: 'FAILED', detail, updatedAt: now } });
    if (!changed.count) await ctx.db.commentScriptStep.updateMany({ where: { ...key, status: 'SENDING' },
      data: { status: 'UNKNOWN', detail, updatedAt: now } });
    ctx.log.warn({ stepId }, 'comment script step stopped');
  } finally {
    try { await session?.close(); } finally {
      if (lease) await releaseLease(ctx.db, lease, ctx.clock.now());
    }
  }
}
