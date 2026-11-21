import { ACTIVE, COMMENT_READERS, Q, SUCCESS, UNRESOLVED } from '@seedingsys/contracts';
import { acquireLease, activeKillSwitch, assertLeaseHeld, audit, closeVariantReviewTasks, contentHolder, enqueue, moveVariant,
  openOperatorTask, prepareCommentDrafts, Prisma, releaseLease, revisionContentKey, tx } from '@seedingsys/db';
import { RetryLaterError } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';
import { handleSourcePoll } from './source-poll';

const BATCH = 40;
const HOLD_PUBLICATION = ['QUEUED' as const, ...ACTIVE, ...SUCCESS, ...UNRESOLVED];

export async function handleProfileSync(ctx: BrowserCtx, { syncId, step }: { syncId: string; step: number }, retryCount = 0) {
  const run = await ctx.db.profileSync.findUnique({ where: { id: syncId }, include: { mapping: { include: { source: true, target: true } } } });
  if (!run || run.step !== step || !['DISCOVERING', 'PREPARING'].includes(run.phase)) return;
  const lease = await acquireLease(ctx.db, { resource: 'profile-sync:' + syncId, holder: ctx.workerId, ttlMs: 120_000, now: ctx.clock.now() });
  if (!lease) throw new RetryLaterError('Lượt đồng bộ đang được xử lý.');
  const { source, target } = run.mapping;
  try {
    if (!run.mapping.enabled) {
      await ctx.db.profileSync.updateMany({ where: { id: syncId, step }, data: { phase: 'FAILED', detail: 'Luồng nguồn → đích đã tắt.' } });
      return;
    }
    if (run.phase === 'DISCOVERING') {
      const result = await handleSourcePoll(ctx, { sourceId: source.id, history: { targetId: target.id, cursor: run.historyCursor ?? undefined } });
      if (['ALREADY_RUNNING', 'FENCED'].includes(result.outcome) || result.error?.startsWith('TRANSIENT:')) {
        if (retryCount < 8) throw new RetryLaterError('Đang đợi phiên nguồn để đọc lịch sử.');
      }
      await tx(ctx.db, async t => {
        const now = ctx.clock.now();
        if (!await assertLeaseHeld(t, lease, now)) throw new RetryLaterError('Khóa lượt đồng bộ đã hết hiệu lực.');
        const next = result.history?.nextCursor;
        const changed = await t.profileSync.updateMany({ where: { id: syncId, step, phase: 'DISCOVERING' }, data: {
          ...(next ? { historyCursor: next } : {
            phase: 'PREPARING', historyDone: !!result.history?.complete, capturedUntil: now,
            detail: result.history?.detail ?? (result.outcome !== 'OK'
              ? result.error ?? 'Nguồn chưa khả dụng để đọc lịch sử. Tiếp tục với dữ liệu đã lưu.' : null),
          }),
          step: { increment: 1 },
        } });
        if (changed.count) await enqueue(t, Q.ProfileSync, { syncId, step: step + 1 });
      });
      return;
    }

    const canReadComments = run.history && source.enabled && source.collectComments && (source.connector !== 'fb-session' || target.enabled)
      && COMMENT_READERS.includes(source.connector)
      && !await activeKillSwitch(ctx.db, { sourceId: source.id, connector: source.connector });
    await tx(ctx.db, async t => {
      const now = ctx.clock.now();
      if (!await assertLeaseHeld(t, lease, now)) throw new RetryLaterError('Khóa lượt đồng bộ đã hết hiệu lực.');
      const found = await t.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM source_posts
        WHERE source_id=${source.id}::uuid AND archived_at IS NULL AND latest_revision_id IS NOT NULL
          AND first_seen_at<=${run.capturedUntil} AND (${run.archiveCursor}::uuid IS NULL OR id>${run.archiveCursor}::uuid)
        ORDER BY id LIMIT ${BATCH} FOR UPDATE`;
      const posts = await t.sourcePost.findMany({
        where: { id: { in: found.map(p => p.id) } },
        include: { publications: { where: { targetId: target.id }, select: { status: true } },
          commentScans: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
        },
      });
      const revisions = await t.sourcePostRevision.findMany({ where: { id: { in: posts.flatMap(p => p.latestRevisionId ?? []) } } });
      const byRevision = new Map(revisions.map(r => [r.id, r]));
      const variants = await t.contentVariant.findMany({ where: { targetId: target.id, revisionId: { in: revisions.map(r => r.id) } } });
      const byVariant = new Map(variants.map(v => [v.revisionId, v]));
      const openOlder = await t.contentVariant.findMany({
        where: { targetId: target.id, sourcePostId: { in: posts.map(p => p.id) }, revisionId: { notIn: revisions.map(r => r.id) },
          status: { in: ['FETCHING_MEDIA','REWRITING','VALIDATING','READY','NEEDS_REVIEW'] } },
        select: { id: true, sourcePostId: true, status: true },
      });
      for (const post of posts) {
        const revision = post.latestRevisionId && byRevision.get(post.latestRevisionId);
        if (!revision) continue;
        const prior = byVariant.get(revision.id);
        let preparedVariantId = prior?.status === 'NEEDS_REVIEW' && (prior.reviewReasons as string[]).includes('PROFILE_SYNC_REVIEW') ? prior.id : undefined;
        const blocked = post.publications.some(p => HOLD_PUBLICATION.includes(p.status));
        // Another source post already gave (or is giving) this target the same content: nothing to prepare.
        const duplicate = !blocked && !!await contentHolder(t, {
          targetId: target.id, sourcePostId: post.id, contentKey: await revisionContentKey(t, revision.id), now,
        });
        if (!blocked && !duplicate && (!prior || ['EXPIRED', 'BASELINE', 'SUPERSEDED'].includes(prior.status))) {
          for (const old of openOlder.filter(v => v.sourcePostId === post.id)) {
            const changed = await moveVariant(t, { id: old.id, from: old.status, to: 'SUPERSEDED', actor: ctx.actor, now, reason: 'profile_sync_newer_revision' });
            if (changed && old.status === 'NEEDS_REVIEW') await closeVariantReviewTasks(t, old.id, ctx.actor, now, 'profile_sync_newer_revision');
          }
          const data = { caption: prior?.caption ?? revision.text, status: 'NEEDS_REVIEW' as const, reviewReasons: ['PROFILE_SYNC_REVIEW'],
            expiresAt: null, snapshot: Prisma.DbNull, snapshotHash: null, readyAt: null, reviewedBy: null };
          const prepared = prior
            ? await t.contentVariant.update({ where: { id: prior.id }, data })
            : await t.contentVariant.create({ data: { ...data, sourcePostId: post.id, revisionId: revision.id, targetId: target.id, contentType: post.contentType } });
          preparedVariantId = prepared.id;
          await openOperatorTask(t, { kind: 'REVIEW_CONTENT', targetId: target.id, variantId: prepared.id, now, reason: 'PROFILE_SYNC_REVIEW' });
        }

        const latestScan = post.commentScans[0];
        let scanId = latestScan?.id;
        if (!duplicate && canReadComments && (source.connector === 'fb-graph' || post.permalink) && !(latestScan &&
          (+latestScan.createdAt >= +run.createdAt || (['QUEUED', 'RUNNING'].includes(latestScan.status) && +now - +latestScan.updatedAt < 5 * 60_000)))) {
          const scan = await t.commentScan.create({ data: { sourcePostId: post.id, requestedBy: run.requestedBy } });
          scanId = scan.id;
          await enqueue(t, Q.CommentScan, { scanId, ...(source.connector === 'fb-session' && { readTargetId: target.id }) });
        }
        await t.profileSyncItem.create({ data: { syncId, sourcePostId: post.id, preparedVariantId, commentScanId: scanId } });
        if (!duplicate) await prepareCommentDrafts(t, post.id, [target.id], now);
      }
      const more = found.length === BATCH;
      const moved = await t.profileSync.updateMany({ where: { id: syncId, step, phase: 'PREPARING' }, data: {
        archiveCursor: found.at(-1)?.id ?? run.archiveCursor, step: { increment: 1 }, phase: more ? 'PREPARING' : 'PREPARED',
      } });
      if (!moved.count) throw new RetryLaterError('Lượt đồng bộ đã được cập nhật ở worker khác.');
      if (more) await enqueue(t, Q.ProfileSync, { syncId, step: step + 1 });
      else await audit(t, { entityType: 'profile_sync', entityId: syncId, action: 'prepared', actor: ctx.actor, at: now });
    }, 30_000);
  } catch (error) {
    if (retryCount < 8) throw error;
    ctx.log.warn({ syncId, error }, 'profile sync stopped');
    await ctx.db.profileSync.updateMany({ where: { id: syncId, step }, data: { phase: 'FAILED', detail: 'Lượt đồng bộ bị gián đoạn. Bài đã thu thập vẫn còn trong kho.' } });
  } finally {
    await releaseLease(ctx.db, lease, ctx.clock.now());
  }
}
