import { ConnectorError, type ReadCommentsResult, type SourceRef } from '@seedingsys/connectors-core';
import { accountResource, acquireLease, activeKillSwitch, assertLeaseHeld, prepareCommentDrafts, releaseLease, tx, type Lease, type Tx } from '@seedingsys/db';
import { removeAdvertisingLinks, RetryLaterError } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';

export async function handleCommentScan(ctx: BrowserCtx, { scanId, readTargetId, manual }: { scanId: string; readTargetId?: string; manual?: boolean }, retryCount = 0): Promise<void> {
  const scan = await ctx.db.commentScan.findUnique({ where: { id: scanId }, include: { post: { include: { source: true } } } });
  if (!scan || scan.status !== 'QUEUED') return;
  const { post } = scan;
  const { source } = post;
  const started = await ctx.db.commentScan.updateMany({ where: { id: scanId, status: 'QUEUED' }, data: { status: 'RUNNING', detail: null } });
  if (!started.count) return;
  let accountLease: Lease | null = null;
  try {
    if (post.archivedAt) throw new ConnectorError('SOURCE_UNREADABLE', 'Bài nguồn đã chuyển vào thùng rác.');
    if ((!source.enabled && !manual) || await activeKillSwitch(ctx.db, { sourceId: source.id, connector: source.connector })) {
      throw new ConnectorError('SOURCE_UNREADABLE', 'Nguồn đang tắt hoặc bị tạm dừng.');
    }
    const reader = ctx.registry.reader(source.connector);
    if (!reader.readComments) throw new ConnectorError('SOURCE_UNREADABLE', 'Kết nối này chưa hỗ trợ quét bình luận.');
    const sourceRef: SourceRef = { id: source.id, code: source.code, externalRef: source.externalRef };
    if (source.connector === 'fb-session') {
      const links = await ctx.db.sourceTargetMapping.findMany({
        where: { sourceId: source.id, enabled: true, ...(readTargetId && { targetId: readTargetId }), target: { enabled: true, connector: 'fb-web' } }, take: 2,
        include: { target: { include: { profile: { include: { workerNode: true } } } } },
      });
      const target = links[0]?.target;
      if (links.length !== 1 || !target?.profile || (target.profile.workerNode && target.profile.workerNode.name !== ctx.actor)) {
        throw new ConnectorError('SOURCE_UNREADABLE', 'Cần một hồ sơ Facebook đang bật trên worker này để mở bài.');
      }
      if (await activeKillSwitch(ctx.db, { targetId: target.id, connector: target.connector })) {
        throw new ConnectorError('SOURCE_UNREADABLE', 'Phiên Facebook dùng để đọc đang bị tạm dừng.');
      }
      accountLease = await acquireLease(ctx.db, { resource: accountResource(target.id), holder: ctx.workerId + ':comment-scan',
        ttlMs: 160_000, now: ctx.clock.now(), purpose: 'comment-scan' });
      if (!accountLease) throw new RetryLaterError('Phiên Facebook đang bận. Lượt quét bình luận sẽ đợi.');
      sourceRef.readAccount = { code: target.code, externalId: target.externalId, profileDir: target.profile.profileDir };
    }
    let lastRead = -1;
    let lastExpected: number | undefined;
    const result = await reader.readComments(sourceRef, { externalId: post.externalId, permalink: post.permalink ?? undefined },
      async (readCount, expectedCount) => {
        if (lastRead === readCount && lastExpected === expectedCount) return;
        lastRead = readCount;
        lastExpected = expectedCount;
        await ctx.db.commentScan.updateMany({ where: { id: scanId, status: 'RUNNING' }, data: { readCount, expectedCount } });
      });
    await tx(ctx.db, async t => {
      const now = ctx.clock.now();
      const [current] = await t.$queryRaw<Array<{ archived_at: Date | null }>>`
        SELECT archived_at FROM source_posts WHERE id=${post.id}::uuid FOR SHARE`;
      if (current?.archived_at) throw new ConnectorError('SOURCE_UNREADABLE', 'Bài nguồn đã chuyển vào thùng rác.');
      if (accountLease && !await assertLeaseHeld(t, accountLease, now)) throw new Error('Phiên đọc đã hết hiệu lực.');
      if (!await persistCommentScan(t, scanId, post.id, result, now)) return;
      const mappings = await t.sourceTargetMapping.findMany({ where: { sourceId: source.id, enabled: true }, select: { targetId: true } });
      await prepareCommentDrafts(t, post.id, mappings.map(m => m.targetId), now);
    }, 60_000);
  } catch (error) {
    if (error instanceof RetryLaterError && retryCount < 6) {
      await ctx.db.commentScan.updateMany({ where: { id: scanId, status: 'RUNNING' }, data: { status: 'QUEUED', detail: error.message } });
      throw error;
    }
    const detail = error instanceof ConnectorError || error instanceof RetryLaterError ? error.message : 'Lượt quét bị gián đoạn. Các bình luận đã lưu trước đó vẫn còn trong kho bài.';
    await ctx.db.commentScan.updateMany({ where: { id: scanId, status: 'RUNNING' }, data: { status: 'FAILED', detail: detail.slice(0, 400) } });
    ctx.log.warn({ scanId, errorKind: error instanceof ConnectorError ? error.kind : 'INTERNAL' }, 'comment scan stopped');
  } finally {
    if (accountLease) await releaseLease(ctx.db, accountLease, ctx.clock.now());
  }
}

export async function persistCommentScan(t: Tx, scanId: string, sourcePostId: string, result: ReadCommentsResult, now: Date) {
  const saved = await t.commentScan.updateMany({ where: { id: scanId, sourcePostId, status: 'RUNNING' }, data: {
    status: result.complete ? 'COMPLETE' : 'PARTIAL', readCount: result.comments.length, expectedCount: result.expectedCount ?? null, detail: result.detail ?? null,
  } });
  if (!saved.count) return false;
  for (const [position, { externalId, ...fields }] of result.comments.entries()) {
    const values = {
      text: removeAdvertisingLinks(fields.text), parentExternalId: fields.parentExternalId ?? null,
      authorName: fields.authorName ?? null, permalink: fields.permalink ?? null, postedAt: fields.postedAt ?? null,
      position, lastSeenAt: now,
    };
    await t.sourceComment.upsert({ where: { sourcePostId_externalId: { sourcePostId, externalId } },
      create: { ...values, externalId, sourcePostId }, update: { ...values,
        parentExternalId: fields.parentExternalId, permalink: fields.permalink,
      } });
  }
  return true;
}
