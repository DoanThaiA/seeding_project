import { ConnectorError, type ReadCommentsResult, type SourceRef } from '@seedingsys/connectors-core';
import { Q } from '@seedingsys/contracts';
import { activeKillSwitch, assertLeaseHeld, enqueue, heartbeatLease, prepareCommentDrafts, releaseFinishedProfileScanAccount,
  releaseLease, tx, type Lease, type Tx } from '@seedingsys/db';
import { isFacebookTimelineReader, removeAdvertisingLinks, RetryLaterError } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';
import { SourceReadAccountBusy, claimSourceReadAccount } from '../runtime/source-read-account';

const LEASE_MS = 100_000;
const HEARTBEAT_MS = 25_000;

export async function handleCommentScan(ctx: BrowserCtx, { scanId, readTargetId, manual, archiveOnly }: {
  scanId: string; readTargetId?: string; manual?: boolean; archiveOnly?: boolean;
}, retryCount = 0): Promise<void> {
  const scan = await ctx.db.commentScan.findUnique({ where: { id: scanId }, include: { post: { include: {
    source: true, aliases: { select: { externalId: true } },
  } }, sourceProfileScan: true } });
  if (!scan || scan.status !== 'QUEUED') return;
  const { post } = scan;
  const { source } = post;
  const archive = scan.sourceProfileScan;
  const sourceKey = archive && { id: archive.sourceId, externalRef: archive.sourceRef, connector: archive.connector, resetGeneration: archive.resetGeneration };
  const started = await ctx.db.commentScan.updateMany({ where: { id: scanId, status: 'QUEUED' }, data: {
    status: 'RUNNING', detail: null, readCount: 0, expectedCount: null, updatedAt: ctx.clock.now(),
  } });
  if (!started.count) return;
  let accountLease: Lease | null = null;
  let accountReservation: Lease | null = null;
  let accountTargetId: string | undefined;
  try {
    if (sourceKey && (!await ctx.db.source.findFirst({ where: sourceKey, select: { id: true } }) || sourceKey.id !== source.id)) {
      throw new ConnectorError('SOURCE_UNREADABLE', 'Nguồn A đã đổi cấu hình hoặc làm lại kho.');
    }
    if (post.archivedAt) throw new ConnectorError('SOURCE_UNREADABLE', 'Bài nguồn đã chuyển vào thùng rác.');
    if (!manual && !source.collectComments) {
      throw new ConnectorError('SOURCE_UNREADABLE', 'Nguồn đang tắt quét bình luận tự động.');
    }
    if ((!source.enabled && !manual) || await activeKillSwitch(ctx.db, { sourceId: source.id, connector: source.connector })) {
      throw new ConnectorError('SOURCE_UNREADABLE', 'Nguồn đang tắt hoặc bị tạm dừng.');
    }
    const reader = ctx.registry.reader(source.connector);
    if (!reader.readComments) throw new ConnectorError('SOURCE_UNREADABLE', 'Kết nối này chưa hỗ trợ quét bình luận.');
    const sourceRef: SourceRef = { id: source.id, code: source.code, externalRef: source.externalRef };
    if (source.connector === 'fb-session') {
      const claim = await claimSourceReadAccount(ctx, source.id, 'comment-scan', LEASE_MS, readTargetId, archive?.id);
      ({ lease: accountLease, reservation: accountReservation, targetId: accountTargetId, account: sourceRef.readAccount } = claim);
    }
    let lastRead = -1;
    let lastExpected: number | undefined;
    let lastHeartbeat = +ctx.clock.now();
    // IDs from this post help identify a rotated permalink or encoded reply link on a re-scan.
    const [known, revision] = isFacebookTimelineReader(source.connector) ? await Promise.all([
      ctx.db.sourceComment.findMany({
        where: { sourcePostId: post.id }, select: { externalId: true }, orderBy: [{ position: 'asc' }, { id: 'asc' }], take: 500,
      }),
      post.latestRevisionId && ctx.db.sourcePostRevision.findUnique({
        where: { id: post.latestRevisionId }, select: {
          text: true, assets: { select: { asset: { select: { sourceRef: true } } } },
        },
      }),
    ]) : [[], null] as const;
    const result = await reader.readComments(sourceRef, {
      externalId: post.externalId, permalink: post.permalink ?? undefined,
      aliases: post.aliases.map(alias => alias.externalId), contentType: post.contentType,
      knownCommentIds: known.map(comment => comment.externalId),
      identity: revision ? {
        text: revision.text, mediaRefs: revision.assets.flatMap(({ asset }) => asset.sourceRef ? [asset.sourceRef] : []),
        postedAt: post.postedAt ?? undefined,
      } : undefined,
    },
      async (readCount, expectedCount) => {
        const now = ctx.clock.now();
        const heartbeatDue = +now - lastHeartbeat >= HEARTBEAT_MS;
        if (heartbeatDue) {
          if (accountLease && !await heartbeatLease(ctx.db, accountLease, LEASE_MS, now)) {
            throw new RetryLaterError('Phiên đọc đã hết hiệu lực. Hệ thống sẽ thử lại.');
          }
          lastHeartbeat = +now;
        }
        if (!heartbeatDue && lastRead === readCount && lastExpected === expectedCount) return;
        lastRead = readCount;
        lastExpected = expectedCount;
        await ctx.db.commentScan.updateMany({ where: { id: scanId, status: 'RUNNING' }, data: {
          readCount, expectedCount: expectedCount ?? null, updatedAt: now,
        } });
      });
    await tx(ctx.db, async t => {
      const now = ctx.clock.now();
      if (sourceKey) {
        await t.$queryRaw`SELECT id FROM sources WHERE id=${source.id}::uuid FOR SHARE`;
        if (!await t.source.findFirst({ where: sourceKey, select: { id: true } })) {
          throw new ConnectorError('SOURCE_UNREADABLE', 'Nguồn A đã đổi cấu hình hoặc làm lại kho.');
        }
      }
      const [current] = await t.$queryRaw<Array<{ archived_at: Date | null }>>`
        SELECT archived_at FROM source_posts WHERE id=${post.id}::uuid FOR SHARE`;
      if (!current || current.archived_at) throw new ConnectorError('SOURCE_UNREADABLE', 'Bài nguồn không còn trong kho đang hoạt động.');
      if (accountLease && !await assertLeaseHeld(t, accountLease, now)) throw new Error('Phiên đọc đã hết hiệu lực.');
      if (accountReservation && !await assertLeaseHeld(t, accountReservation, now)) throw new Error('Phiên quét hồ sơ đã hết hiệu lực.');
      if (await activeKillSwitch(t, { sourceId: source.id, connector: source.connector }) ||
        (accountTargetId && await activeKillSwitch(t, { targetId: accountTargetId, connector: 'fb-web' }))) {
        throw new ConnectorError('SOURCE_UNREADABLE', 'Nguồn hoặc phiên đọc đã được tạm dừng.');
      }
      const storeOnly = !!archive || archiveOnly === true;
      if (!await persistCommentScan(t, scanId, post.id, result, now, storeOnly) || storeOnly) return;
      const mappings = await t.sourceTargetMapping.findMany({ where: { sourceId: source.id, enabled: true }, select: { targetId: true } });
      await prepareCommentDrafts(t, post.id, mappings.map(m => m.targetId), now);
    }, 60_000);
  } catch (error) {
    if (error instanceof SourceReadAccountBusy && (error.waitingForProfileScan || archive)) {
      await tx(ctx.db, async t => {
        const now = ctx.clock.now();
        const stopped = await t.commentScan.updateMany({ where: { id: scanId, status: 'RUNNING' },
          data: { status: 'QUEUED', detail: error.message, updatedAt: now } });
        if (stopped.count) await enqueue(t, Q.CommentScan, { scanId, readTargetId, manual, archiveOnly }, { startAfter: new Date(+now + 30_000) });
      });
      return;
    }
    const detail = error instanceof ConnectorError || error instanceof RetryLaterError ? error.message : 'Lượt quét bị gián đoạn. Các bình luận đã lưu trước đó vẫn còn trong kho bài.';
    const retryable = error instanceof RetryLaterError || (error instanceof ConnectorError && ['TRANSIENT', 'RATE_LIMITED'].includes(error.kind));
    const retry = retryable && retryCount < 6;
    const stopped = await ctx.db.commentScan.updateMany({ where: { id: scanId, status: 'RUNNING' }, data: {
      status: retry ? 'QUEUED' : 'FAILED', detail: detail.slice(0, 400), updatedAt: ctx.clock.now(),
    } });
    if (retry && stopped.count) throw new RetryLaterError(detail);
    ctx.log.warn({ scanId, errorKind: error instanceof ConnectorError ? error.kind : 'INTERNAL' }, 'comment scan stopped');
  } finally {
    if (accountLease) await releaseLease(ctx.db, accountLease, ctx.clock.now());
    if (archive) await releaseFinishedProfileScanAccount(ctx.db, archive.id, ctx.clock.now());
  }
}

export async function persistCommentScan(t: Tx, scanId: string, sourcePostId: string, result: ReadCommentsResult, now: Date, archiveOnly = false) {
  const saved = await t.commentScan.updateMany({ where: { id: scanId, sourcePostId, status: 'RUNNING' }, data: {
    status: result.complete ? 'COMPLETE' : 'PARTIAL', readCount: result.comments.length, expectedCount: result.expectedCount ?? null,
    detail: result.detail ?? null, updatedAt: now,
  } });
  if (!saved.count) return false;
  for (const [position, { externalId, ...fields }] of result.comments.entries()) {
    const values = {
      text: removeAdvertisingLinks(fields.text), parentExternalId: fields.parentExternalId ?? null,
      authorName: fields.authorName ?? null, permalink: fields.permalink ?? null, postedAt: fields.postedAt ?? null,
      position, lastSeenAt: now,
    };
    await t.sourceComment.upsert({ where: { sourcePostId_externalId: { sourcePostId, externalId } },
      create: { ...values, externalId, sourcePostId, archiveOnly }, update: { ...values, ...(!archiveOnly && { archiveOnly: false }),
        parentExternalId: fields.parentExternalId, permalink: fields.permalink,
      } });
  }
  return true;
}
