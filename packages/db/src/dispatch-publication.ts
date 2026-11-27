import { Prisma, type ContentType, type SlotStatus } from '@prisma/client';
import { ACTIVE, COMMENT_READERS, FB_WEB_PUBLISH_FORMATS, PUBLISH_QUEUE_BY_WORKFLOW, UNRESOLVED, workflowFor } from '@seedingsys/contracts';
import { MIN, isPastLaunchWindow, sourceScheduleOpen, type Clock } from '@seedingsys/domain';
import { accountResource, activeLease } from './lease';
import { activeKillSwitch } from './controls';
import { targetLateWindowMin } from './content-ops';
import { contentHolder, retireDuplicateVariants, settleReadyContentKeys } from './dedup';
import { movePublication, moveSlot } from './transitions';
import { enqueue } from './outbox';
import { audit } from './audit';
import type { Db } from './index';

type Tx = Prisma.TransactionClient;
export type SlotOutcome = 'DISPATCHED' | 'SKIPPED_NO_CONTENT' | 'DEFERRED' | 'MISSED' | 'NOOP';
export interface DispatchContext {
  db: Db;
  clock: Clock;
  actor: string;
  workerFreshMs?: number;
  scheduledPublishIntervalMin?: number;
  scheduledPublishBatch?: { limit: number; from: Date };
  allowImplicitSlots?: boolean;
}

async function defer(t: Tx, ctx: DispatchContext, slot: { id: string; status: SlotStatus; reason: string | null }, reason: string, manual: boolean): Promise<SlotOutcome> {
  if (manual) throw new BacklogDispatchError(reason);
  if (slot.status === 'DEFERRED' && slot.reason === reason) return 'DEFERRED'; // no audit spam every tick
  await moveSlot(t, { id: slot.id, from: slot.status, to: 'DEFERRED', actor: ctx.actor, now: ctx.clock.now(), reason });
  return 'DEFERRED';
}

export class BacklogDispatchError extends Error {
  constructor(readonly reason: string) { super(reason); }
}

export async function calendarForPublicationSlot(t: Tx, slotId: string | null): Promise<{ stoppedAt: Date | null } | null> {
  if (!slotId) return null;
  const [calendar] = await t.$queryRaw<Array<{ stoppedAt: Date | null }>>`
    SELECT schedule.stopped_at AS "stoppedAt" FROM publication_slots slot
    JOIN publication_schedules schedule ON schedule.id=slot.schedule_id
    WHERE slot.id=${slotId}::uuid FOR SHARE OF schedule`;
  return calendar ?? null;
}

interface Candidate {
  variant_id: string;
  source_post_id: string;
  content_type: ContentType;
  snapshot_hash: string;
  post_time: Date;
}

const backlogJoins = Prisma.sql`
  FROM content_variants v
  JOIN source_posts sp ON sp.id = v.source_post_id
  JOIN source_post_revisions r ON r.id = v.revision_id
  LEFT JOIN source_post_revisions latest ON latest.id = sp.latest_revision_id
  JOIN sources s ON s.id = sp.source_id
  JOIN target_accounts ta ON ta.id = v.target_id
  LEFT JOIN source_target_mappings m ON m.source_id = sp.source_id AND m.target_id = v.target_id
  LEFT JOIN publications p ON p.source_post_id = v.source_post_id AND p.target_id = v.target_id
  LEFT JOIN LATERAL (
    SELECT version FROM connector_releases WHERE connector = ta.connector AND active ORDER BY released_at DESC LIMIT 1
  ) rel ON true`;

const reservedForProfileSync = Prisma.sql`EXISTS (
  SELECT 1 FROM profile_sync_items i JOIN profile_syncs ps ON ps.id=i.sync_id
  WHERE i.source_post_id=sp.id AND ps.mapping_id=m.id AND ps.publish
    AND ps.phase IN ('PREPARING','PREPARED') AND i.publish_status='PENDING')`;

function reservedForSchedule(ownSlotId?: string) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM publication_slots reserved
    JOIN publication_schedules schedule ON schedule.id=reserved.schedule_id AND schedule.stopped_at IS NULL
    WHERE reserved.scheduled_variant_id=v.id
      AND reserved.status IN ('PLANNED','DEFERRED','RESERVED','DISPATCHED','STARTED')
      ${ownSlotId ? Prisma.sql`AND reserved.id<>${ownSlotId}::uuid` : Prisma.empty})`;
}

// Static blockers shared by the backlog and manual dispatch. Leases and other
// in-flight jobs are checked separately when dispatch actually starts.
function backlogBlocker(now: Date, ownSlotId?: string) {
  return Prisma.sql`CASE
    WHEN sp.archived_at IS NOT NULL OR v.status <> 'READY' OR v.snapshot_hash IS NULL THEN 'ITEM_UNAVAILABLE'
    WHEN v.expires_at <= ${now} THEN 'ITEM_EXPIRED'
    WHEN v.revision_id IS DISTINCT FROM sp.latest_revision_id THEN 'SOURCE_REVISION_CHANGED'
    WHEN NOT ta.enabled THEN 'TARGET_DISABLED'
    WHEN v.snapshot->>'audience' IS DISTINCT FROM ta.audience THEN 'AUDIENCE_CONFIG_CHANGED'
    WHEN NOT coalesce(m.enabled, false) THEN 'MAPPING_DISABLED'
    WHEN ${reservedForSchedule(ownSlotId)} THEN 'SCHEDULE_RESERVED'
    WHEN ${reservedForProfileSync} AND ${ownSlotId !== undefined} THEN 'PROFILE_SYNC_RESERVED'
    WHEN r.raw->>'sharedPermalink' IS NOT NULL OR latest.raw->>'sharedPermalink' IS NOT NULL THEN 'NATIVE_SHARE_REQUIRED'
    WHEN r.media_status IN ('FAILED','PENDING')
      OR r.incomplete ?| ARRAY['MEDIA_COUNT_UNKNOWN','MEDIA_UNAVAILABLE']
      THEN 'MEDIA_INCOMPLETE'
    WHEN p.id IS NOT NULL AND p.status NOT IN ('FAILED_CONFIRMED','CANCELLED') THEN 'ITEM_UNAVAILABLE'
    WHEN p.id IS NOT NULL AND p.publish_tries >= m.max_publish_tries THEN 'RETRY_LIMIT_REACHED'
    WHEN rel.version IS NULL THEN 'NO_CONNECTOR_RELEASE'
    WHEN ta.connector = 'fb-web' AND v.content_type::text <> ALL(${[...FB_WEB_PUBLISH_FORMATS]}::text[]) THEN 'FORMAT_UNSUPPORTED'
    WHEN ta.connector <> 'fb-web' AND NOT EXISTS (
      SELECT 1 FROM capability_checks cc WHERE cc.target_id = v.target_id AND cc.content_type = v.content_type
        AND cc.connector = ta.connector AND cc.connector_version = rel.version AND cc.passed
    ) THEN 'FORMAT_NOT_CERTIFIED'
    WHEN EXISTS (SELECT 1 FROM controls c WHERE c.paused AND (c.scope = 'SOURCE' AND c.scope_key = sp.source_id::text
      OR c.scope = 'FORMAT' AND c.scope_key = v.content_type::text)) THEN 'KILL_SWITCH_CONTENT'
    ELSE NULL END`;
}

export function listBacklog(db: Db, now: Date) {
  return db.$queryRaw<Array<{ id: string; source: string; target: string; contentType: ContentType; readyAt: Date | null;
    expiresAt: Date | null; preview: string | null; caption: string | null; snapshotHash: string | null; targetAudience: string; blockReason: string | null }>>`
    SELECT v.id, s.code AS source, ta.code AS target, v.content_type AS "contentType", v.ready_at AS "readyAt", v.expires_at AS "expiresAt",
      left(v.caption, 160) AS preview, v.caption, v.snapshot_hash AS "snapshotHash", ta.audience AS "targetAudience", ${backlogBlocker(now)} AS "blockReason"
    ${backlogJoins}
    WHERE v.status = 'READY' AND sp.archived_at IS NULL AND (v.expires_at IS NULL OR v.expires_at > ${now})
      AND (p.id IS NULL OR p.status IN ('FAILED_CONFIRMED','CANCELLED'))
      AND NOT ${reservedForProfileSync}
    ORDER BY ta.code, coalesce(sp.posted_at, sp.first_seen_at)
    LIMIT 300`;
}

/**
 * Oldest READY content for the target that is still valid, not yet published to it (or whose
 * earlier attempt failed without side effects), supported by the active connector and not paused.
 */
async function selectCandidate(t: Tx, targetId: string, connector: string, version: string, now: Date,
  { variantId, sourceIds, restrictedSources, requestedVariants, scheduleSlot }: {
    variantId?: string; sourceIds?: string[]; restrictedSources: string[]; requestedVariants: string[]; scheduleSlot?: string;
  }): Promise<Candidate | null> {
  const rows = await t.$queryRaw<Candidate[]>`
    SELECT v.id AS variant_id, v.source_post_id, v.content_type, v.snapshot_hash,
           COALESCE(sp.posted_at, sp.first_seen_at) AS post_time
    FROM content_variants v
    JOIN source_posts sp ON sp.id = v.source_post_id
    JOIN source_post_revisions r ON r.id = v.revision_id
    LEFT JOIN source_post_revisions latest ON latest.id = sp.latest_revision_id
    JOIN sources s ON s.id = sp.source_id AND (s.enabled OR ${!!variantId || !!scheduleSlot})
    JOIN target_accounts ta ON ta.id = v.target_id
    JOIN source_target_mappings m ON m.source_id = sp.source_id AND m.target_id = v.target_id AND m.enabled
    LEFT JOIN publications p ON p.target_id = v.target_id AND p.source_post_id = v.source_post_id
    WHERE v.target_id = ${targetId}::uuid
      ${sourceIds ? Prisma.sql`AND sp.source_id = ANY(${sourceIds}::uuid[])` : Prisma.empty}
      ${restrictedSources.length ? Prisma.sql`
        AND (NOT sp.source_id=ANY(${restrictedSources}::uuid[]) OR v.id=ANY(${requestedVariants}::uuid[]))` : Prisma.empty}
      AND sp.archived_at IS NULL
      AND v.revision_id = sp.latest_revision_id
      AND v.status = 'READY'
      AND v.snapshot_hash IS NOT NULL
      AND v.snapshot->>'audience' = ta.audience
      AND r.raw->>'sharedPermalink' IS NULL
      AND latest.raw->>'sharedPermalink' IS NULL
      AND r.media_status NOT IN ('FAILED','PENDING')
      AND (${variantId ?? null}::uuid IS NULL OR v.id = ${variantId ?? null}::uuid)
      ${variantId && !scheduleSlot ? Prisma.empty : Prisma.sql`AND NOT ${reservedForProfileSync}`}
      AND NOT ${reservedForSchedule(scheduleSlot)}
      AND NOT (r.incomplete ?| ARRAY['MEDIA_COUNT_UNKNOWN','MEDIA_UNAVAILABLE'])
      AND (v.expires_at IS NULL OR v.expires_at > ${now})
      AND (p.id IS NULL OR (p.status IN ('FAILED_CONFIRMED','CANCELLED') AND p.publish_tries < m.max_publish_tries))
      -- An explicit source reset lets the new collection publish content from retired collections.
      AND NOT EXISTS (
        SELECT 1 FROM publications dp
        JOIN content_variants dv ON dv.id = dp.variant_id
        JOIN source_post_revisions dr ON dr.id = dv.revision_id
        JOIN source_posts prior_post ON prior_post.id = dp.source_post_id
        JOIN sources prior_source ON prior_source.id = prior_post.source_id
        WHERE dp.target_id = v.target_id AND dp.source_post_id <> v.source_post_id
          AND dp.status NOT IN ('FAILED_CONFIRMED','CANCELLED')
          AND (sp.reset_generation = 0 OR prior_post.reset_generation >= prior_source.reset_generation)
          AND r.content_key <> '' AND dr.content_key = r.content_key)
      AND ((${connector} = 'fb-web' AND v.content_type::text = ANY(${[...FB_WEB_PUBLISH_FORMATS]}::text[]))
        OR (${connector} <> 'fb-web' AND EXISTS (
        SELECT 1 FROM capability_checks cc
        WHERE cc.target_id = v.target_id AND cc.content_type = v.content_type
          AND cc.connector = ${connector} AND cc.connector_version = ${version} AND cc.passed)))
      AND NOT EXISTS (
        SELECT 1 FROM controls c WHERE c.paused AND (
          (c.scope = 'FORMAT' AND c.scope_key = v.content_type::text) OR
          (c.scope = 'SOURCE' AND c.scope_key = sp.source_id::text)))
    ORDER BY post_time ASC, v.ready_at ASC
    LIMIT 1
    FOR UPDATE OF v SKIP LOCKED FOR SHARE OF sp SKIP LOCKED`;
  return rows[0] ?? null;
}

/** strict_order: is there older content for this target that is not READY yet (and still alive)? */
async function olderPendingExists(t: Tx, targetId: string, before: Date | null, now: Date, sourceIds?: string[]): Promise<boolean> {
  const rows = await t.$queryRaw<Array<{ x: number }>>`
    SELECT 1 AS x FROM content_variants v
    JOIN source_posts sp ON sp.id = v.source_post_id
    JOIN source_target_mappings m ON m.source_id = sp.source_id AND m.target_id = v.target_id AND m.enabled AND m.strict_order
    WHERE v.target_id = ${targetId}::uuid
      ${sourceIds ? Prisma.sql`AND sp.source_id = ANY(${sourceIds}::uuid[])` : Prisma.empty}
      AND sp.archived_at IS NULL
      AND v.revision_id = sp.latest_revision_id
      AND v.status IN ('FETCHING_MEDIA','REWRITING','VALIDATING','NEEDS_REVIEW')
      AND (v.expires_at IS NULL OR v.expires_at > ${now})
      AND (${before}::timestamptz IS NULL OR COALESCE(sp.posted_at, sp.first_seen_at) < ${before})
    LIMIT 1`;
  return rows.length > 0;
}

/** Try to give one slot its publication. Safe to call repeatedly and concurrently. */
export async function dispatchSlot(ctx: DispatchContext, slotId: string): Promise<SlotOutcome> {
  return ctx.db.$transaction(async t => {
    const slot = await t.publicationSlot.findUnique({ where: { id: slotId }, select: { scheduleId: true } });
    if (!slot) return 'NOOP';
    const [schedule] = slot.scheduleId ? await t.$queryRaw<Array<{ stopped_at: Date | null; interval_minutes: number }>>`
      SELECT stopped_at, interval_minutes FROM publication_schedules WHERE id=${slot.scheduleId}::uuid FOR SHARE` : [];
    if (schedule?.stopped_at) return 'NOOP';
    return dispatch(t, ctx, slotId, undefined, false, schedule?.interval_minutes);
  });
}

export async function dispatchBacklogItem(ctx: DispatchContext, variantId: string,
  profileSync?: { syncId: string; sourcePostId: string }): Promise<string> {
  return ctx.db.$transaction(async t => {
    const variant = await t.contentVariant.findUnique({ where: { id: variantId }, select: { targetId: true } });
    if (!variant) throw new BacklogDispatchError('ITEM_UNAVAILABLE');
    const { targetId } = variant;
    await t.$queryRaw`SELECT id FROM target_accounts WHERE id = ${targetId}::uuid FOR UPDATE`;
    const now = ctx.clock.now();
    if (profileSync) {
      await t.$queryRaw`SELECT sync_id FROM profile_sync_items WHERE sync_id=${profileSync.syncId}::uuid
        AND source_post_id=${profileSync.sourcePostId}::uuid FOR UPDATE`;
      const item = await t.profileSyncItem.findUnique({ where: { syncId_sourcePostId: profileSync },
        include: { sync: { include: { mapping: { include: { source: true } } } } } });
      if (item?.publishStatus !== 'PENDING' || item.preparedVariantId !== variantId || item.sync.phase !== 'PREPARED'
        || !item.sync.publish || item.sync.mapping.targetId !== targetId) throw new BacklogDispatchError('ITEM_UNAVAILABLE');
      const sourceInterval = item.sync.mapping.source.publishIntervalMin;
      const interval = sourceInterval ?? ctx.scheduledPublishIntervalMin;
      if (interval != null && await t.publication.findFirst({ where: { targetId,
        ...(sourceInterval != null && { post: { sourceId: item.sync.mapping.sourceId } }),
        committedAt: { gt: new Date(+now - interval * MIN) } }, select: { id: true } })) {
        throw new BacklogDispatchError('PUBLISH_INTERVAL_NOT_ELAPSED');
      }
    }
    let ms = now.getTime();
    while (ms % MIN === 0 || await t.publicationSlot.findUnique({ where: { targetId_slotAt: { targetId, slotAt: new Date(ms) } }, select: { id: true } })) ms--;
    const slot = await t.publicationSlot.create({ data: { targetId, slotAt: new Date(ms), manual: true } });
    if (await dispatch(t, ctx, slot.id, variantId, !!profileSync) !== 'DISPATCHED') throw new BacklogDispatchError('ITEM_UNAVAILABLE');
    const queued = await t.publicationSlot.findUniqueOrThrow({ where: { id: slot.id }, select: { publicationId: true } });
    if (profileSync) await t.profileSyncItem.update({ where: { syncId_sourcePostId: profileSync },
      data: { publishStatus: 'TRACKED', publishDetail: null } });
    return queued.publicationId!;
  });
}

async function dispatch(t: Tx, ctx: DispatchContext, slotId: string, variantId?: string, profileSync = false,
  scheduleInterval?: number): Promise<SlotOutcome> {
  const manual = !!variantId;
  const now = ctx.clock.now();
  const freshMs = ctx.workerFreshMs ?? 90_000;
  const locked = await t.$queryRaw<Array<{ id: string }>>`SELECT id FROM publication_slots WHERE id = ${slotId}::uuid FOR UPDATE`;
  if (!locked.length) return 'NOOP';
  const slot = await t.publicationSlot.findUniqueOrThrow({ where: { id: slotId } });
  if ((slot.status !== 'PLANNED' && slot.status !== 'DEFERRED') || slot.slotAt > now) return 'NOOP';
  const explicit = !!slot.scheduleId;
  const scheduledVariant = slot.scheduledVariantId ?? undefined;
  if (!manual) await t.$queryRaw`SELECT id FROM target_accounts WHERE id = ${slot.targetId}::uuid FOR UPDATE`;
  const wait = (reason: string) => defer(t, ctx, slot, reason, manual);

  const lw = await targetLateWindowMin(t, slot.targetId);
  if (isPastLaunchWindow(slot.slotAt, lw, now)) {
    await moveSlot(t, { id: slot.id, from: slot.status, to: 'MISSED', actor: ctx.actor, now, reason: slot.reason ? `LAUNCH_WINDOW_EXPIRED after ${slot.reason}` : 'LAUNCH_WINDOW_EXPIRED' });
    return 'MISSED';
  }
  const target = await t.targetAccount.findUniqueOrThrow({ where: { id: slot.targetId }, include: { profile: { include: { workerNode: true } } } });
  if (!target.enabled) return wait('TARGET_DISABLED');
  const kill = await activeKillSwitch(t, { targetId: target.id, connector: target.connector });
  if (kill) return wait(`KILL_SWITCH_${kill.scope}`);
  const sources = manual ? undefined : await t.source.findMany({
    where: { ...(explicit ? { id: { in: slot.scheduleSourceIds } } : { enabled: true }),
      ...(!explicit && ctx.allowImplicitSlots !== true && { runNowUntil: { gt: now } }),
      mappings: { some: { targetId: target.id, enabled: true } } },
    select: { id: true, runStartMinute: true, runEndMinute: true, runNowFrom: true, runNowUntil: true,
      runNowLimit: true, runNowVariantIds: true, publishIntervalMin: true },
  });
  if (explicit && !sources?.length) return wait('MAPPING_DISABLED');
  if (!manual && !explicit && ctx.allowImplicitSlots !== true && !sources?.length) return 'NOOP';
  const openSources = sources?.filter(source => explicit || sourceScheduleOpen(source, now));
  if (openSources?.length === 0 && sources?.length) return wait('OUTSIDE_SOURCE_WINDOW');

  // Count assignments under the target lock, including unresolved or failed attempts.
  // Slots persist across restarts and concurrent scheduler ticks cannot oversubscribe the batch.
  const batch = ctx.scheduledPublishBatch;
  const eligibleSources = [];
  for (const source of openSources ?? []) {
    const run = !explicit && source.runNowFrom && source.runNowUntil && source.runNowUntil > now && source.runNowLimit
      ? { from: source.runNowFrom, limit: source.runNowLimit } : undefined;
    if (run && slot.slotAt < run.from) continue;
    const cap = explicit ? undefined : run ?? batch;
    if (!cap || slot.slotAt < cap.from && !run) {
      eligibleSources.push(source);
      continue;
    }
    const assigned = await t.publicationSlot.count({
      where: { targetId: target.id, manual: false, slotAt: { gte: cap.from }, publicationId: { not: null } },
    });
    if (assigned < cap.limit) eligibleSources.push(source);
  }
  if (openSources?.length && !eligibleSources.length) return wait('SCHEDULED_PUBLISH_LIMIT_REACHED');

  const node = target.profile?.workerNode;
  if (!node?.lastHeartbeatAt || now.getTime() - node.lastHeartbeatAt.getTime() > freshMs) return wait('NO_WORKER');

  const release = await t.connectorRelease.findFirst({ where: { connector: target.connector, active: true }, orderBy: { releasedAt: 'desc' } });
  if (!release) return wait('NO_CONNECTOR_RELEASE');

  // One thing at a time per account, and nothing new while a previous result is unresolved.
  const blocking = await t.publication.findFirst({ where: { targetId: target.id, status: { in: ['QUEUED', ...ACTIVE, ...UNRESOLVED] } }, select: { status: true } });
  if (blocking) return wait(blocking.status === 'QUEUED' || ACTIVE.includes(blocking.status) ? 'ACCOUNT_BUSY' : 'UNRESOLVED_PUBLICATION');
  if (await activeLease(t, accountResource(target.id), now)) return wait('ACCOUNT_BUSY');
  const readySourceIds: string[] = [];
  for (const source of eligibleSources) {
    const interval = scheduleInterval ?? source.publishIntervalMin ?? ctx.scheduledPublishIntervalMin;
    if (interval === undefined) {
      readySourceIds.push(source.id);
      continue;
    }
    const recent = await t.publication.findFirst({ where: {
      targetId: target.id, committedAt: { gt: new Date(+now - interval * MIN) },
      ...(!explicit && source.publishIntervalMin != null && { post: { sourceId: source.id } }),
    }, select: { id: true } });
    if (!recent) readySourceIds.push(source.id);
  }
  if (eligibleSources.length && !readySourceIds.length) return wait('PUBLISH_INTERVAL_NOT_ELAPSED');
  const sourceIds = manual ? undefined : readySourceIds;

  // Same content from another source post: an explicit request says so, a scheduled slot just skips it.
  await settleReadyContentKeys(t, target.id);
  if (manual) {
    const v = await t.contentVariant.findUnique({ where: { id: variantId }, select: { sourcePostId: true, revision: { select: { contentKey: true } } } });
    if (v && await contentHolder(t, { targetId: target.id, sourcePostId: v.sourcePostId, contentKey: v.revision.contentKey, now,
      publicationsOnly: profileSync })) {
      throw new BacklogDispatchError('DUPLICATE_CONTENT');
    }
  } else {
    await retireDuplicateVariants(t, { targetId: target.id, now, actor: ctx.actor });
  }

  const restricted = explicit ? [] : eligibleSources.filter(source => source.runNowUntil && source.runNowUntil > now && source.runNowVariantIds.length);
  const selected = variantId ?? scheduledVariant;
  const cand = await selectCandidate(t, target.id, target.connector, release.version, now, { variantId: selected, sourceIds,
    restrictedSources: restricted.map(source => source.id), requestedVariants: restricted.flatMap(source => source.runNowVariantIds),
    scheduleSlot: explicit ? slot.id : undefined });
  if (!cand && selected) {
    const [row] = await t.$queryRaw<Array<{ reason: string | null }>>`
      SELECT ${backlogBlocker(now, explicit ? slot.id : undefined)} AS reason ${backlogJoins} WHERE v.id = ${selected}::uuid`;
    const reason = row?.reason ?? 'ITEM_UNAVAILABLE';
    if (manual) throw new BacklogDispatchError(reason);
    return wait(reason);
  }
  if (!profileSync && !scheduledVariant && await olderPendingExists(t, target.id, cand?.post_time ?? null, now, sourceIds)) return wait('STRICT_ORDER_WAIT');
  if (!cand) {
    if (explicit) return wait('NO_ELIGIBLE_CONTENT');
    await moveSlot(t, { id: slot.id, from: slot.status, to: 'SKIPPED_NO_CONTENT', actor: ctx.actor, now });
    return 'SKIPPED_NO_CONTENT';
  }

  const workflow = workflowFor(cand.content_type)!;
  const source = await t.sourcePost.findUniqueOrThrow({ where: { id: cand.source_post_id },
    select: { source: { select: { publishComments: true, connector: true } } } });
  const autoReplayComments = target.connector === 'fb-web' && source.source.publishComments
    && COMMENT_READERS.includes(source.source.connector);
  const existing = await t.publication.findUnique({ where: { targetId_sourcePostId: { targetId: target.id, sourcePostId: cand.source_post_id } } });
  let publicationId: string;
  let jobVersion: number;
  if (existing) {
    const ok = await movePublication(t, {
      id: existing.id,
      from: existing.status,
      to: 'QUEUED',
      actor: ctx.actor,
      now,
      reason: 'RESELECTED',
      data: {
        slotId: slot.id, variantId: cand.variant_id, snapshotHash: cand.snapshot_hash,
        contentType: cand.content_type, workflow, jobVersion: { increment: 1 },
        reconcileTries: 0, committedAt: null, verifiedAt: null, permalink: null, externalPostId: null, autoReplayComments,
      },
    });
    if (!ok) return wait('RACE');
    publicationId = existing.id;
    jobVersion = existing.jobVersion + 1;
  } else {
    const p = await t.publication.create({
      data: {
        targetId: target.id,
        sourcePostId: cand.source_post_id,
        variantId: cand.variant_id,
        slotId: slot.id,
        workflow,
        contentType: cand.content_type,
        status: 'QUEUED',
        snapshotHash: cand.snapshot_hash, autoReplayComments,
      },
    });
    await audit(t, { entityType: 'publication', entityId: p.id, action: 'created', to: 'QUEUED', actor: ctx.actor, data: { slotId: slot.id }, at: now });
    publicationId = p.id;
    jobVersion = 1;
  }
  await moveSlot(t, { id: slot.id, from: slot.status, to: 'DISPATCHED', actor: ctx.actor, now, publicationId,
    reason: profileSync ? 'PROFILE_SYNC' : manual ? 'MANUAL_PUBLISH' : explicit ? 'PUBLICATION_SCHEDULE'
      : ctx.allowImplicitSlots !== true ? 'SOURCE_RUN' : undefined });
  await enqueue(t, PUBLISH_QUEUE_BY_WORKFLOW[workflow], { publicationId, jobVersion });
  return 'DISPATCHED';
}

