import { ConnectorError, isConnectorError, type ReadPost, type ReadResult, type SourceRef } from '@seedingsys/connectors-core';
import { COMMENT_READERS, Q } from '@seedingsys/contracts';
import { accountResource, acquireLease, activeKillSwitch, assertLeaseHeld, enqueue, ingestPost, releaseLease, sourceResource, tx, type Lease } from '@seedingsys/db';
import { isFacebookTimelineReader, sha256 } from '@seedingsys/domain';
import { assetObjectKey } from '@seedingsys/storage';
import type { BrowserCtx } from '../ctx';
import { withTimeout } from '../runtime/timeout';

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
export async function handleSourcePoll(ctx: BrowserCtx, p: { sourceId: string; collectComments?: boolean; history?: { targetId: string; cursor?: string } }): Promise<{
  outcome: string; counts?: Record<string, number>; history?: ReadResult['history']; error?: string;
}> {
  const source = await ctx.db.source.findUnique({ where: { id: p.sourceId } });
  if (!source || !source.enabled) return { outcome: 'DISABLED' };
  if (await activeKillSwitch(ctx.db, { sourceId: source.id, connector: source.connector })) return { outcome: 'PAUSED' };

  const lease = await acquireLease(ctx.db, {
    resource: sourceResource(source.id),
    holder: `${ctx.workerId}:poll`,
    ttlMs: ctx.leaseTtlMs.POLL,
    now: ctx.clock.now(),
    purpose: 'poll',
  });
  if (!lease) return { outcome: 'ALREADY_RUNNING' };

  let accountLease: Lease | null = null;
  try {
    const currentSource = {
      id: source.id, connector: source.connector, externalRef: source.externalRef,
      baselineDone: source.baselineDone, lastSuccessAt: source.lastSuccessAt, enabled: true,
    };
    let result;
    try {
      const reader = ctx.registry.reader(source.connector);
      let readAccount: SourceRef['readAccount'];
      if (source.connector === 'fb-session') {
        const mappings = await ctx.db.sourceTargetMapping.findMany({
          where: { sourceId: source.id, enabled: true, ...(p.history && { targetId: p.history.targetId }), target: { enabled: true, connector: 'fb-web' } },
          include: { target: { include: { profile: { include: { workerNode: true } } } } },
          take: 2,
        });
        const target = mappings[0]?.target;
        if (mappings.length !== 1 || !target?.profile) {
          throw new ConnectorError('SOURCE_UNREADABLE', 'Cần một đích Facebook đang bật và đã có hồ sơ trình duyệt trong luồng.');
        }
        if (target.profile.workerNode && target.profile.workerNode.name !== ctx.actor) {
          throw new ConnectorError('TRANSIENT', 'Phiên ' + target.code + ' nằm trên worker khác. Hệ thống sẽ thử lại ở lượt sau.');
        }
        if (await activeKillSwitch(ctx.db, { targetId: target.id, connector: target.connector })) {
          throw new ConnectorError('SOURCE_UNREADABLE', 'Phiên ' + target.code + ' đang bị tạm dừng.');
        }
        accountLease = await acquireLease(ctx.db, {
          resource: accountResource(target.id), holder: ctx.workerId + ':source-poll', ttlMs: ctx.leaseTtlMs.POLL,
          now: ctx.clock.now(), purpose: 'source-poll',
        });
        if (!accountLease) throw new ConnectorError('TRANSIENT', 'Phiên ' + target.code + ' đang bận. Hệ thống sẽ thử lại ở lượt sau.');
        readAccount = { code: target.code, externalId: target.externalId, profileDir: target.profile.profileDir };
      }
      const retry = !p.history && isFacebookTimelineReader(source.connector) ? await ctx.db.$queryRaw<Array<{ permalink: string }>>`
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
          ...(p.history && { history: { cursor: p.history.cursor } }) },
        p.history ? null : source.watermark as Record<string, unknown> | null, source.overlapCount,
      );
      // The session reader closes its browser at its own deadline. Await that cleanup before releasing B's lock.
      result = isFacebookTimelineReader(source.connector) || p.history ? await reading : await withTimeout(reading, ctx.timeouts.stepMs, 'read');
    } catch (e) {
      const msg = isConnectorError(e) ? `${e.kind}: ${e.message}` : String((e as Error).message ?? e);
      if (!p.history) await ctx.db.source.updateMany({ where: currentSource, data: { lastErrorAt: ctx.clock.now(), lastError: msg.slice(0, 500) } });
      ctx.log.warn({ source: source.code, err: msg }, 'source read failed');
      return { outcome: 'READ_ERROR', error: msg.slice(0, 400) };
    }

    const now = ctx.clock.now();
    const baseline = !p.history && !source.baselineDone && !isFacebookTimelineReader(source.connector);
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
    const counts: Record<string, number> = {};
    const committed = await tx(
      ctx.db,
      async (t) => {
        if (!(await assertLeaseHeld(t, lease, now))) return false; // another poll took over: discard
        if (accountLease && !(await assertLeaseHeld(t, accountLease, now))) return false;
        const updated = await t.source.updateMany({
          where: currentSource,
          data: p.history ? { updatedAt: now } : {
            watermark: { ...result.nextWatermark, lastReadCount: result.posts.length },
            baselineDone: true,
            lastSuccessAt: now,
            lastError: null,
            lastIncomplete: result.incomplete,
          },
        });
        if (!updated.count) return false;
        // Different ids for one post (rotated pfbid) are recognised by ingestPost.
        for (const post of posts) {
          const o = await ingestPost(t, { sourceId: source.id, connector: source.connector, post, baseline, now, actor: ctx.actor, archiveOnly: !!p.history });
          counts[o] = (counts[o] ?? 0) + 1;
        }
        const collectComments = !p.history && COMMENT_READERS.includes(source.connector)
          && (await t.source.findUnique({ where: { id: source.id }, select: { collectComments: true } }))?.collectComments;
        if (collectComments) {
          const readIds = posts.map(post => post.externalId);
          const explicit = p.collectComments === true;
          const retryBefore = new Date(+now - 6 * 60 * 60_000);
          const newlyRead = await t.$queryRaw<Array<{ id: string }>>`
            SELECT sp.id FROM source_posts sp
            LEFT JOIN LATERAL (SELECT status, updated_at FROM comment_scans WHERE source_post_id=sp.id ORDER BY created_at DESC,id DESC LIMIT 1) cs ON true
            WHERE sp.source_id=${source.id}::uuid AND sp.archived_at IS NULL
              AND (${source.connector === 'fb-graph'} OR sp.permalink IS NOT NULL)
              AND (sp.external_id=ANY(${readIds}::text[]) OR EXISTS (SELECT 1 FROM source_post_aliases a
                WHERE a.source_post_id=sp.id AND a.external_id=ANY(${readIds}::text[])))
              AND (cs.status IS NULL OR (${explicit} AND cs.status IN ('COMPLETE','PARTIAL','FAILED'))
                OR (cs.status IN ('PARTIAL','FAILED') AND cs.updated_at<${retryBefore}))
            FOR UPDATE OF sp`;
          // Older posts can also be caught up by scheduled collection.
          const latest = await t.$queryRaw<Array<{ id: string }>>`
            SELECT sp.id FROM source_posts sp
            LEFT JOIN LATERAL (SELECT status, updated_at FROM comment_scans WHERE source_post_id=sp.id ORDER BY created_at DESC,id DESC LIMIT 1) cs ON true
            WHERE sp.source_id=${source.id}::uuid AND sp.archived_at IS NULL
              AND (${source.connector === 'fb-graph'} OR sp.permalink IS NOT NULL)
              AND NOT (sp.id=ANY(${newlyRead.map(post => post.id)}::uuid[]))
              AND (cs.status IS NULL OR (cs.status IN ('PARTIAL','FAILED') AND cs.updated_at<${retryBefore}))
            ORDER BY coalesce(sp.posted_at,sp.first_seen_at) DESC,sp.id
            LIMIT 8 FOR UPDATE OF sp SKIP LOCKED`;
          for (const { id } of [...newlyRead, ...latest]) {
            const scan = await t.commentScan.create({ data: { sourcePostId: id, requestedBy: ctx.actor } });
            await enqueue(t, Q.CommentScan, { scanId: scan.id });
          }
        }
        return true;
      },
      60_000,
    );
    return { outcome: committed ? (baseline ? 'BASELINE' : 'OK') : 'FENCED', counts, history: committed ? result.history : undefined };
  } finally {
    try {
      if (accountLease) await releaseLease(ctx.db, accountLease, ctx.clock.now());
    } finally {
      await releaseLease(ctx.db, lease, ctx.clock.now());
    }
  }
}
