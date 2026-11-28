import { ConnectorError, isConnectorError, type ReadPost, type ReadResult, type SourceRef } from '@seedingsys/connectors-core';
import { COMMENT_READERS, Q, SOURCE_POLL_BUSY_RETRIES, type JobPayload } from '@seedingsys/contracts';
import { acquireLease, activeKillSwitch, assertLeaseHeld, enqueue, ingestPost, profileScanBlocksPoll,
  releaseLease, sourceResource, tx, type Lease } from '@seedingsys/db';
import { RetryLaterError, isFacebookTimelineReader, sha256, sourceScheduleOpen } from '@seedingsys/domain';
import { assetObjectKey } from '@seedingsys/storage';
import type { BrowserCtx } from '../ctx';
import { withTimeout } from '../runtime/timeout';
import { SourceReadAccountBusy, claimSourceReadAccount } from '../runtime/source-read-account';

/** A feed can show one post twice while scrolling. Keep one read per id: the most complete one. */
export function uniqueReads(posts: ReadPost[]): ReadPost[] {
  const byId = new Map<string, ReadPost>();
  for (const post of posts) {
    const prior = byId.get(post.externalId);
    if (!prior || post.incomplete.length < prior.incomplete.length) byId.set(post.externalId, post);
  }
  return [...byId.values()];
}

/**
 * source.poll — read new posts (+ a bounded overlap) and store them in one transaction.
 * The watermark only advances after the results are committed. A read error is recorded as a
 * source error — never as "no new posts".
 */
export async function handleSourcePoll(ctx: BrowserCtx, p: JobPayload<typeof Q.SourcePoll> & {
  history?: { targetId: string; cursor?: string }; profileScanId?: string; profileReadTargetId?: string;
}, retryCount?: number): Promise<{
  outcome: string; counts?: Record<string, number>; history?: ReadResult['history']; error?: string;
}> {
  const defer = async (outcome: 'ALREADY_RUNNING' | 'WAITING_FOR_ACCOUNT', message: string) => {
    if (retryCount !== undefined) {
      const archiveActive = await profileScanBlocksPoll(ctx.db, p.sourceId, ctx.clock.now());
      if (archiveActive && !p.scheduled && p.requestedAt) {
        // Outlive a large archive without spending the ordinary transient retry budget.
        await enqueue(ctx.db, Q.SourcePoll, { sourceId: p.sourceId, collectComments: p.collectComments, requestedAt: p.requestedAt },
          { singletonKey: p.sourceId, startAfter: new Date(+ctx.clock.now() + 30_000) });
        return { outcome };
      }
      if (!archiveActive && retryCount < SOURCE_POLL_BUSY_RETRIES) throw new RetryLaterError(message);
      if (p.requestedAt) {
        const requestedAt = new Date(p.requestedAt);
        // Let the scheduler pick up a deferred poll again while preserving newer requests and successful polls.
        await ctx.db.$executeRaw`
          UPDATE sources SET last_poll_at=last_success_at
          WHERE id=${p.sourceId}::uuid AND last_poll_at=${requestedAt}
            AND (last_success_at IS NULL OR last_success_at<${requestedAt})
            AND (last_error_at IS NULL OR last_error_at<${requestedAt})`;
      }
    }
    return { outcome, error: 'TRANSIENT: ' + message };
  };
  const lease = await acquireLease(ctx.db, {
    resource: sourceResource(p.sourceId),
    holder: `${ctx.workerId}:poll`,
    ttlMs: ctx.leaseTtlMs.POLL,
    now: ctx.clock.now(),
    purpose: 'poll',
  });
  if (!lease) return defer('ALREADY_RUNNING', 'Nguồn đang được lượt quét khác sử dụng.');

  let accountLease: Lease | null = null;
  let accountReservation: Lease | null = null;
  let readTargetId: string | undefined;
  try {
    const source = await ctx.db.source.findUnique({ where: { id: p.sourceId } });
    if (!source || (!source.enabled && !p.profileScanId)) return { outcome: 'DISABLED' };
    if (p.requestedAt && source.lastSuccessAt && +source.lastSuccessAt >= Date.parse(p.requestedAt)) {
      return { outcome: 'OBSOLETE' };
    }
    const archive = p.profileScanId ? await ctx.db.sourceProfileScan.findFirst({ where: {
      id: p.profileScanId, sourceId: source.id, sourceRef: source.externalRef, connector: source.connector,
      resetGeneration: source.resetGeneration, phase: 'POSTS',
    } }) : null;
    if (p.profileScanId && !archive) return { outcome: 'OBSOLETE' };
    const history = !!(p.history || archive);
    if (p.scheduled && !sourceScheduleOpen(source, ctx.clock.now())) {
      await ctx.db.source.updateMany({ where: { id: source.id, lastPollAt: source.lastPollAt }, data: { lastPollAt: source.lastSuccessAt } });
      return { outcome: 'OUTSIDE_SOURCE_WINDOW' };
    }
    const sourceControl = { sourceId: source.id, connector: source.connector };
    if (await activeKillSwitch(ctx.db, sourceControl)) return { outcome: 'PAUSED' };
    if (!history && source.connector === 'fb-session' && await profileScanBlocksPoll(ctx.db, source.id, ctx.clock.now())) {
      return await defer('WAITING_FOR_ACCOUNT', 'Chờ lượt quét hồ sơ đang dùng phiên Facebook.');
    }

    const currentSource = {
      id: source.id, connector: source.connector, externalRef: source.externalRef,
      resetGeneration: source.resetGeneration,
      ...(!archive && { baselineDone: source.baselineDone, lastSuccessAt: source.lastSuccessAt, enabled: true }),
      ...(!history && { pollPostLimit: source.pollPostLimit }),
    };
    let result;
    try {
      const reader = ctx.registry.reader(source.connector);
      let readAccount: SourceRef['readAccount'];
      if (source.connector === 'fb-session') {
        const claimed = await claimSourceReadAccount(ctx, source.id, 'source-poll', ctx.leaseTtlMs.POLL,
          p.profileReadTargetId ?? p.history?.targetId, archive?.id);
        ({ lease: accountLease, reservation: accountReservation, targetId: readTargetId, account: readAccount } = claimed);
      }
      const retry = !history && isFacebookTimelineReader(source.connector) ? await ctx.db.$queryRaw<Array<{ permalink: string }>>`
        SELECT sp.permalink FROM source_posts sp
        JOIN source_post_revisions r ON r.id = sp.latest_revision_id
        WHERE sp.source_id = ${source.id}::uuid AND sp.archived_at IS NULL AND sp.permalink IS NOT NULL
          AND (r.media_status = 'FAILED' OR r.incomplete ?| ARRAY['MEDIA_COUNT_UNKNOWN','MEDIA_UNAVAILABLE','CAPTION_TRUNCATED'])
          AND (${p.collectComments === true} OR EXISTS (
            SELECT 1 FROM content_variants v
            WHERE v.revision_id = r.id AND v.status = 'NEEDS_REVIEW'
              AND (v.expires_at IS NULL OR v.expires_at > ${ctx.clock.now()})))
        ORDER BY sp.first_seen_at DESC, sp.id
        LIMIT ${p.collectComments ? 16 : 5}` : [];
      const reading = reader.readSince(
        { id: source.id, code: source.code, externalRef: source.externalRef, retryPermalinks: retry.map(item => item.permalink), readAccount,
          maxPosts: archive ? undefined : source.pollPostLimit ?? undefined,
          ...(history && { history: { cursor: p.history?.cursor, archive: !!archive } }) },
        history ? null : source.watermark as Record<string, unknown> | null, source.overlapCount,
      );
      // The session reader closes its browser at its own deadline. Await that cleanup before releasing B's lock.
      result = isFacebookTimelineReader(source.connector) || ['fb-web', 'fb-graph'].includes(source.connector)
        ? await reading : await withTimeout(reading, ctx.timeouts.stepMs, 'read');
      if (!history && source.pollPostLimit !== null && uniqueReads(result.posts).length > source.pollPostLimit) {
        throw new ConnectorError('TRANSIENT', 'Kết nối nguồn đọc quá số bài đã cấu hình. Giữ nguyên mốc quét.');
      }
    } catch (e) {
      if (e instanceof SourceReadAccountBusy) return await defer('WAITING_FOR_ACCOUNT', e.message);
      const msg = isConnectorError(e) ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : String(e);
      if (!history) await tx(ctx.db, async t => {
        const now = ctx.clock.now();
        if (await assertLeaseHeld(t, lease, now)) {
          await t.source.updateMany({ where: currentSource, data: { lastErrorAt: now, lastError: msg.slice(0, 500) } });
        }
      });
      ctx.log.warn({ source: source.code, err: msg }, 'source read failed');
      return { outcome: 'READ_ERROR', error: msg.slice(0, 400) };
    }

    const baseline = !history && !source.baselineDone && source.resetGeneration === 0 && !isFacebookTimelineReader(source.connector);
    const posts = await Promise.all(uniqueReads(result.posts).map(async post => {
      const media = await Promise.all(post.media.map(async item => {
        const { renderedImage, ...asset } = item;
        if (!renderedImage) return asset;
        const bytes = Buffer.from(renderedImage);
        const checksum = sha256(bytes);
        const mime = asset.mime ?? 'image/jpeg';
        const objectKey = assetObjectKey(checksum, mime);
        try {
          if (!await ctx.store.exists(objectKey)) await ctx.store.put(objectKey, bytes, mime);
          return { ...asset, mime, stored: { objectKey, checksum, bytes: bytes.length } };
        } catch {
          ctx.log.warn({ source: source.code, post: post.externalId }, 'could not store rendered quote image');
          return null;
        }
      }));
      return { ...post, media: media.filter(item => item !== null),
        incomplete: media.includes(null) ? [...new Set([...post.incomplete, 'MEDIA_UNAVAILABLE' as const])] : post.incomplete };
    }));
    const committed = await tx(
      ctx.db,
      async (t) => {
        const now = ctx.clock.now();
        if (!(await assertLeaseHeld(t, lease, now))) return 'FENCED';
        if (accountLease && !(await assertLeaseHeld(t, accountLease, now))) return 'FENCED';
        if (accountReservation && !await assertLeaseHeld(t, accountReservation, now)) return 'FENCED';
        if (await activeKillSwitch(t, sourceControl)
          || (readTargetId && await activeKillSwitch(t, { targetId: readTargetId, connector: 'fb-web' }))) return 'PAUSED';
        const updated = await t.source.updateMany({
          where: currentSource,
          data: history ? { updatedAt: now } : {
            watermark: { ...result.nextWatermark, lastReadCount: posts.length },
            baselineDone: true,
            lastSuccessAt: now,
            lastError: null,
            lastIncomplete: result.incomplete,
          },
        });
        if (!updated.count) return 'FENCED';
        if (archive) {
          const changed = await t.sourceProfileScan.updateMany({
            where: { id: archive.id, phase: 'POSTS' },
            data: { phase: 'COLLECTING', historyComplete: result.history?.complete === true,
              historyIssue: result.history?.detail ?? null, updatedAt: now },
          });
          if (!changed.count) return 'OBSOLETE';
        }
        // Different ids for one post (rotated pfbid) are recognised by ingestPost.
        const counts: Record<string, number> = {};
        for (const post of posts) {
          const o = await ingestPost(t, { sourceId: source.id, connector: source.connector, post, baseline, now,
            actor: ctx.actor, archiveOnly: history, retryFailedMedia: !!archive });
          counts[o] = (counts[o] ?? 0) + 1;
        }
        if (archive) {
          const readIds = posts.map(post => post.externalId);
          const seen = await t.$queryRaw<Array<{ id: string }>>`
            SELECT sp.id FROM source_posts sp WHERE sp.source_id=${source.id}::uuid
              AND sp.reset_generation=${archive.resetGeneration} AND sp.archived_at IS NULL
              AND (sp.external_id=ANY(${readIds}::text[]) OR EXISTS (SELECT 1 FROM source_post_aliases a
                WHERE a.source_post_id=sp.id AND a.external_id=ANY(${readIds}::text[])))
            ORDER BY coalesce(sp.posted_at,sp.first_seen_at) DESC, sp.id`;
          for (const { id } of seen) {
            const scan = await t.commentScan.create({ data: {
              sourcePostId: id, sourceProfileScanId: archive.id, requestedBy: archive.requestedBy, createdAt: now, updatedAt: now,
            } });
            await enqueue(t, Q.CommentScan, { scanId: scan.id, readTargetId, manual: true });
          }
        }
        const collectComments = !history && COMMENT_READERS.includes(source.connector)
          && (await t.source.findUnique({ where: { id: source.id }, select: { collectComments: true } }))?.collectComments;
        if (collectComments) {
          const readIds = posts.map(post => post.externalId);
          const explicit = p.collectComments === true;
          const retryBefore = new Date(+now - 6 * 60 * 60_000);
          const newlyRead = await t.$queryRaw<Array<{ id: string }>>`
            SELECT sp.id FROM source_posts sp
            LEFT JOIN LATERAL (SELECT status, updated_at FROM comment_scans WHERE source_post_id=sp.id AND source_profile_scan_id IS NULL ORDER BY created_at DESC,id DESC LIMIT 1) cs ON true
            WHERE sp.source_id=${source.id}::uuid AND sp.archived_at IS NULL
              AND (${source.connector === 'fb-graph'} OR sp.permalink IS NOT NULL)
              AND (sp.external_id=ANY(${readIds}::text[]) OR EXISTS (SELECT 1 FROM source_post_aliases a
                WHERE a.source_post_id=sp.id AND a.external_id=ANY(${readIds}::text[])))
              AND (cs.status IS NULL OR (${explicit} AND cs.status IN ('COMPLETE','PARTIAL','FAILED'))
                OR (cs.status IN ('PARTIAL','FAILED') AND cs.updated_at<${retryBefore}))
            FOR UPDATE OF sp`;
          // Catch-up is for uncapped polls. A capped poll scans comments on its own batch.
          const latest = source.pollPostLimit === null ? await t.$queryRaw<Array<{ id: string }>>`
            SELECT sp.id FROM source_posts sp
            LEFT JOIN LATERAL (SELECT status, updated_at FROM comment_scans WHERE source_post_id=sp.id AND source_profile_scan_id IS NULL ORDER BY created_at DESC,id DESC LIMIT 1) cs ON true
            WHERE sp.source_id=${source.id}::uuid AND sp.archived_at IS NULL
              AND (${source.connector === 'fb-graph'} OR sp.permalink IS NOT NULL)
              AND NOT (sp.id=ANY(${newlyRead.map(post => post.id)}::uuid[]))
              AND (cs.status IS NULL OR (cs.status IN ('PARTIAL','FAILED') AND cs.updated_at<${retryBefore}))
            ORDER BY coalesce(sp.posted_at,sp.first_seen_at) DESC,sp.id
            LIMIT 8 FOR UPDATE OF sp SKIP LOCKED` : [];
          const candidates = [...newlyRead, ...latest];
          const active = await t.commentScan.findMany({
            where: { sourcePostId: { in: candidates.map(post => post.id) }, status: { in: ['QUEUED', 'RUNNING'] } },
            select: { sourcePostId: true },
          });
          const scanning = new Set(active.map(scan => scan.sourcePostId));
          for (const { id } of candidates) {
            if (scanning.has(id)) continue;
            const scan = await t.commentScan.create({ data: { sourcePostId: id, requestedBy: ctx.actor } });
            await enqueue(t, Q.CommentScan, { scanId: scan.id, readTargetId });
          }
        }
        return counts;
      },
      60_000,
    );
    return typeof committed === 'string' ? { outcome: committed } :
      { outcome: baseline ? 'BASELINE' : 'OK', counts: committed, history: result.history };
  } finally {
    try {
      if (accountLease) await releaseLease(ctx.db, accountLease, ctx.clock.now());
    } finally {
      await releaseLease(ctx.db, lease, ctx.clock.now());
    }
  }
}
