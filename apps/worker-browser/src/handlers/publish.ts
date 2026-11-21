import { join } from 'node:path';
import { isConnectorError, type CommitSignal, type DraftHandle, type PublishSession, type TargetRef } from '@seedingsys/connectors-core';
import { PRE_COMMIT, Q, type PublishSnapshot } from '@seedingsys/contracts';
import {
  accountResource,
  acquireLease,
  activeKillSwitch,
  enqueue,
  heartbeatLease,
  movePublication,
  moveSlot,
  openOperatorTask,
  releaseLease,
  setControl,
  targetLateWindowMin,
  tx,
  type Lease,
  type PublicationStatus,
  type Workflow,
} from '@seedingsys/db';
import { FencedOutError, RetryLaterError, captionFingerprint, hashObject, isFacebookTimelineReader, isPastLaunchWindow } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';
import { cleanupMedia, materializeMedia } from '../runtime/media';
import { withTimeout } from '../runtime/timeout';
import { applyVerifyResult } from './verify-result';

export type PublishOutcome =
  | 'STALE'
  | 'MISSED'
  | 'PUBLISHED_VERIFIED'
  | 'UNKNOWN'
  | 'FAILED_CONFIRMED'
  | 'REQUEUED'
  | 'CANCELLED'
  | 'NEEDS_OPERATOR'
  | 'FENCED';

/** Errors that need a human on the account; the target is paused until they are handled. */
const OPERATOR_KINDS = new Set(['SESSION_LOGGED_OUT', 'CHECKPOINT', 'WRONG_IDENTITY', 'AUDIENCE_MISMATCH']);

class StopPreCommit extends Error {
  constructor(
    readonly to: 'CANCELLED' | 'FAILED_CONFIRMED' | 'QUEUED',
    readonly reason: string,
    readonly operator = false,
  ) {
    super(reason);
  }
}

/**
 * publish.standard / publish.album / publish.video.
 *
 * Invariants:
 *  - Only one worker per account (account lease with fencing token, shared by all workflows).
 *  - Everything before COMMITTING is side-effect free and may be retried.
 *  - COMMITTING is written (fenced, with lease margin) BEFORE pressing "Post".
 *  - From COMMITTING on, any error/timeout/lease loss → UNKNOWN → publish.reconcile. Never re-post.
 *  - The caption/media come only from the frozen snapshot; nothing is rewritten here.
 */
export async function handlePublish(ctx: BrowserCtx, p: { publicationId: string; jobVersion: number }): Promise<PublishOutcome> {
  const pub0 = await ctx.db.publication.findUnique({
    where: { id: p.publicationId },
    include: { target: { include: { profile: true } }, variant: { include: { revision: { select: { incomplete: true, raw: true } } } } },
  });
  if (!pub0 || pub0.status !== 'QUEUED' || pub0.jobVersion !== p.jobVersion) return 'STALE'; // duplicate / superseded delivery

  const workflow: Workflow = pub0.workflow;
  const target = pub0.target;
  const slot = pub0.slotId ? await ctx.db.publicationSlot.findUnique({ where: { id: pub0.slotId } }) : null;
  const now0 = ctx.clock.now();

  if (slot && isPastLaunchWindow(slot.slotAt, await targetLateWindowMin(ctx.db, target.id), now0)) {
    await tx(ctx.db, async (t) => {
      if (await movePublication(t, { id: pub0.id, from: 'QUEUED', to: 'CANCELLED', actor: ctx.actor, now: now0, reason: 'LAUNCH_WINDOW_EXPIRED' })) {
        if (slot.status === 'DISPATCHED') await moveSlot(t, { id: slot.id, from: 'DISPATCHED', to: 'MISSED', actor: ctx.actor, now: now0, reason: 'STARTED_TOO_LATE' });
      }
    });
    return 'MISSED';
  }

  const ttl = ctx.leaseTtlMs[workflow];
  const lease = await acquireLease(ctx.db, {
    resource: accountResource(target.id),
    holder: `${ctx.workerId}:${pub0.id}:${p.jobVersion}`,
    ttlMs: ttl,
    now: now0,
    purpose: `publish:${workflow}`,
  });
  if (!lease) throw new RetryLaterError('account busy'); // queue retries within the launch window

  const log = ctx.log.child({ publication_id: pub0.id, target_id: target.id, workflow });
  const heartbeat = async () => {
    if (!(await heartbeatLease(ctx.db, lease, ttl, ctx.clock.now()))) throw new FencedOutError(lease.resource, lease.token);
  };
  const tmp = join(ctx.tmpDir, pub0.id);
  let session: PublishSession | null = null;
  let draft: DraftHandle | null = null;
  let attemptId: string | null = null;
  let committed = false;
  let status: PublicationStatus = 'QUEUED';

  const move = async (to: PublicationStatus, extra: { data?: object; reason?: string; margin?: number } = {}) => {
    const ok = await tx(ctx.db, async (t) => {
      if (to === 'COMMITTING') {
        const [source] = await t.$queryRaw<Array<{ archived_at: Date | null }>>`
          SELECT archived_at FROM source_posts WHERE id=${pub0.sourcePostId}::uuid FOR SHARE`;
        if (source?.archived_at) throw new StopPreCommit('CANCELLED', 'SOURCE_POST_ARCHIVED');
      }
      return movePublication(t, {
        id: pub0.id,
        from: status,
        to,
        actor: ctx.actor,
        now: ctx.clock.now(),
        fence: lease,
        fenceMinRemainingMs: extra.margin,
        data: extra.data,
        reason: extra.reason,
      });
    });
    if (!ok) throw new FencedOutError(lease.resource, lease.token);
    status = to;
  };
  const stage = (s: string, evidence?: object) =>
    attemptId ? ctx.db.publicationAttempt.update({ where: { id: attemptId }, data: { stage: s, ...(evidence ? { evidence } : {}) } }) : undefined;

  try {
    // ── start attempt (fenced) ──
    const connector = ctx.registry.publisher(target.connector);
    attemptId = await tx(ctx.db, async (t) => {
      const now = ctx.clock.now();
      const ok = await movePublication(t, { id: pub0.id, from: 'QUEUED', to: 'PREPARING', actor: ctx.actor, now, fence: lease, data: { publishTries: { increment: 1 } } });
      if (!ok) return null;
      const n = await t.publicationAttempt.count({ where: { publicationId: pub0.id } });
      const a = await t.publicationAttempt.create({
        data: {
          publicationId: pub0.id,
          attemptNo: n + 1,
          connector: connector.key,
          connectorVersion: connector.version,
          workerId: ctx.workerId,
          fencingToken: lease.token,
          startedAt: now,
          stage: 'START',
        },
      });
      if (slot?.status === 'DISPATCHED') await moveSlot(t, { id: slot.id, from: 'DISPATCHED', to: 'STARTED', actor: ctx.actor, now });
      return a.id;
    });
    if (!attemptId) return 'STALE';
    status = 'PREPARING';

    const source = await ctx.db.sourcePost.findUnique({ where: { id: pub0.sourcePostId }, select: { archivedAt: true } });
    if (source?.archivedAt) throw new StopPreCommit('CANCELLED', 'SOURCE_POST_ARCHIVED');
    const kill = await activeKillSwitch(ctx.db, { targetId: target.id, connector: connector.key, contentType: pub0.contentType });
    if (kill) throw new StopPreCommit('CANCELLED', `KILL_SWITCH_${kill.scope}`);
    const tref: TargetRef = {
      id: target.id,
      code: target.code,
      externalId: target.externalId,
      audience: target.audience,
      uiLocale: target.uiLocale,
      profileDir: target.profile?.profileDir,
    };
    if (!connector.capabilities(tref)[pub0.contentType]) throw new StopPreCommit('CANCELLED', `CAPABILITY_MISSING_${pub0.contentType}`);

    // ── snapshot integrity ──
    const revision = pub0.variant.revision;
    const raw = revision.raw as { reader?: string; sharedPermalink?: string; expectedPhotoCount?: number } | null;
    const shared = await ctx.db.$queryRaw<Array<{ found: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM source_posts p
        JOIN source_post_revisions r ON r.id = p.latest_revision_id
        WHERE p.id = ${pub0.sourcePostId}::uuid AND r.raw->>'sharedPermalink' IS NOT NULL
      ) AS found`;
    if (raw?.sharedPermalink || shared[0]?.found) throw new StopPreCommit('CANCELLED', 'NATIVE_SHARE_REQUIRED');
    if (isFacebookTimelineReader(raw?.reader ?? '') && Array.isArray(revision.incomplete)
      && revision.incomplete.some(flag => flag === 'MEDIA_COUNT_UNKNOWN' || flag === 'MEDIA_UNAVAILABLE')) {
      throw new StopPreCommit('FAILED_CONFIRMED', 'ALBUM_MANIFEST_INCOMPLETE', true);
    }
    const snapshot = pub0.variant.snapshot as unknown as PublishSnapshot | null;
    if (!snapshot || pub0.variant.snapshotHash !== pub0.snapshotHash || hashObject(snapshot) !== pub0.snapshotHash) {
      throw new StopPreCommit('FAILED_CONFIRMED', 'SNAPSHOT_MISMATCH', true);
    }
    if (typeof raw?.expectedPhotoCount === 'number' && snapshot.media.filter(asset => asset.kind === 'image').length !== raw.expectedPhotoCount) {
      throw new StopPreCommit('FAILED_CONFIRMED', 'ALBUM_MANIFEST_INCOMPLETE');
    }
    if (pub0.contentType === 'MULTI_PHOTO' && snapshot.media.length < 2) throw new StopPreCommit('FAILED_CONFIRMED', 'ALBUM_MANIFEST_INCOMPLETE', true);
    if ((pub0.contentType === 'VIDEO' || pub0.contentType === 'REEL') && snapshot.media.filter((m) => m.kind === 'video').length !== 1) {
      throw new StopPreCommit('FAILED_CONFIRMED', 'VIDEO_MANIFEST_INVALID', true);
    }
    const media = await materializeMedia(ctx.store, snapshot, tmp);

    // ── session & identity ──
    await stage('SESSION');
    session = await withTimeout(connector.openSession(tref), ctx.timeouts.stepMs, 'openSession');
    const state = await withTimeout(session.sessionState(), ctx.timeouts.stepMs, 'sessionState');
    if (state !== 'OK') throw new StopPreCommit('CANCELLED', `SESSION_${state}`, true);
    const ident = await withTimeout(session.checkIdentity(target.externalId), ctx.timeouts.stepMs, 'checkIdentity');
    if (!ident.ok) throw new StopPreCommit('CANCELLED', `WRONG_IDENTITY:${ident.observed ?? '?'}`, true);
    await heartbeat();

    // ── prepare draft (no side effect) ──
    await stage('PREPARE');
    const isVideo = workflow === 'VIDEO';
    if (isVideo) await move('UPLOADING_DRAFT');
    draft = await withTimeout(session.prepare(snapshot, media), isVideo ? ctx.timeouts.videoMs : ctx.timeouts.stepMs, 'prepare');
    await heartbeat();
    if (isVideo) await move('READY_TO_SUBMIT');

    await stage('PREVIEW');
    const expectation = {
      caption: snapshot.caption, mediaCount: media.length, mediaChecksums: media.map(m => m.checksum),
      audience: target.audience, albumTitle: snapshot.albumTitle,
    };
    const checkPreview = async (preview: ReturnType<PublishSession['previewCheck']>, stageName: string) => {
      const verdict = await withTimeout(preview, ctx.timeouts.stepMs, stageName);
      if (!verdict.audienceOk) throw new StopPreCommit('CANCELLED', 'AUDIENCE_MISMATCH', true);
      if (!verdict.ok) throw new StopPreCommit('FAILED_CONFIRMED', `PREVIEW_MISMATCH:${verdict.problems.join('|')}`);
    };
    await checkPreview(session.previewCheck(draft, expectation), 'preview');

    // ── last gates, then the side-effect boundary ──
    if (connector.key === 'fb-web') await checkPreview(session.previewCheck(draft, expectation), 'pre-commit-preview');
    const kill2 = await activeKillSwitch(ctx.db, { targetId: target.id, connector: connector.key, contentType: pub0.contentType });
    if (kill2) throw new StopPreCommit('CANCELLED', `KILL_SWITCH_${kill2.scope}`);
    await heartbeat();
    const committingAt = ctx.clock.now();
    await move('COMMITTING', { data: { committedAt: committingAt }, margin: ctx.commitMarginMs });
    committed = true; // from here on: no automatic retry, only reconcile
    await ctx.db.publicationAttempt.update({ where: { id: attemptId }, data: { stage: 'COMMIT', committingAt } });

    const signal: CommitSignal = await withTimeout(session.commit(draft), ctx.timeouts.commitMs, 'commit');
    draft = null;
    await stage('COMMITTED', { commitSignal: signal });

    if (isVideo) {
      await move('PLATFORM_PROCESSING');
      if (session.waitProcessing) await withTimeout(session.waitProcessing(signal, heartbeat), ctx.timeouts.videoMs, 'processing');
    }
    await move('VERIFYING');
    const result = await withTimeout(
      session.verify({
        captionFingerprint: captionFingerprint(snapshot.caption),
        contentType: snapshot.contentType,
        caption: snapshot.caption,
        mediaCount: media.length,
        committedAt: committingAt,
        windowMs: ctx.verifyWindowMs,
        commitSignal: signal,
      }),
      ctx.timeouts.commitMs,
      'verify',
    );
    const final = await applyVerifyResult(ctx, { publicationId: pub0.id, from: 'VERIFYING', attemptId, result, committedAt: committingAt, fence: lease,
      commitSignal: snapshot.contentType === 'REEL' ? signal : undefined });
    log.info({ final }, 'publish finished');
    return final;
  } catch (err) {
    return await handleFailure(ctx, { err, committed, status, pubId: pub0.id, targetId: target.id, attemptId, lease, workflow, jobVersion: p.jobVersion, log });
  } finally {
    if (session && draft) await session.discardDraft(draft).catch(() => undefined);
    if (session) await session.close().catch(() => undefined);
    await cleanupMedia(tmp);
    await releaseLease(ctx.db, lease, ctx.clock.now());
    if (slot) {
      await tx(ctx.db, async (t) => {
        const s = await t.publicationSlot.findUnique({ where: { id: slot.id } });
        if (s?.status === 'STARTED') await moveSlot(t, { id: slot.id, from: 'STARTED', to: 'DONE', actor: ctx.actor, now: ctx.clock.now() });
      }).catch(() => undefined);
    }
  }
}

async function handleFailure(
  ctx: BrowserCtx,
  a: {
    err: unknown;
    committed: boolean;
    status: PublicationStatus;
    pubId: string;
    targetId: string;
    attemptId: string | null;
    lease: Lease;
    workflow: Workflow;
    jobVersion: number;
    log: BrowserCtx['log'];
  },
): Promise<PublishOutcome> {
  const { err, log } = a;
  const now = ctx.clock.now();
  const msg = (err as Error)?.message ?? String(err);
  const errorClass = err instanceof StopPreCommit ? err.reason : isConnectorError(err) ? err.kind : ((err as Error)?.name ?? 'Error');

  if (err instanceof FencedOutError) {
    // We lost the account. The sweeper/new owner decides; we must not write anything else.
    log.warn({ err: msg }, 'fenced out');
    return 'FENCED';
  }

  // ── after the side-effect boundary: the post may exist ──
  if (a.committed) {
    const ok = await tx(ctx.db, async (t) => {
      const moved = await movePublication(t, { id: a.pubId, from: a.status, to: 'UNKNOWN', actor: ctx.actor, now, reason: `POST_COMMIT_ERROR:${String(errorClass)}`, fence: a.lease });
      if (!moved) return false;
      if (a.attemptId) await t.publicationAttempt.update({ where: { id: a.attemptId }, data: { outcome: 'UNKNOWN', errorClass: String(errorClass), errorMessage: msg.slice(0, 1000), finishedAt: now } });
      await enqueue(t, Q.PublishReconcile, { publicationId: a.pubId }, { startAfter: new Date(now.getTime() + ctx.reconcileDelaySec * 1000) });
      return true;
    });
    log.warn({ err: msg, moved: ok }, 'post-commit failure → UNKNOWN');
    return ok ? 'UNKNOWN' : 'FENCED';
  }

  if (!a.attemptId || !PRE_COMMIT.includes(a.status)) {
    log.error({ err: msg }, 'publish failed before attempt start');
    throw err;
  }

  // ── before the side-effect boundary: safe to retry or hand back ──
  const kind = isConnectorError(err) ? err.kind : null;
  let to: 'CANCELLED' | 'FAILED_CONFIRMED' | 'QUEUED';
  let reason: string;
  let operator = false;
  if (err instanceof StopPreCommit) {
    to = err.to;
    reason = err.reason;
    operator = err.operator;
  } else if (kind && OPERATOR_KINDS.has(kind)) {
    to = 'CANCELLED';
    reason = kind;
    operator = true;
  } else if (kind === 'TRANSIENT' || kind === 'RATE_LIMITED' || kind === 'UI_UNEXPECTED' || !kind) {
    // Retry once more inside the launch window; persistent UI breakage goes to a human
    // (agent.recover will slot in here once the exception agent is released).
    const pub = await ctx.db.publication.findUniqueOrThrow({ where: { id: a.pubId }, include: { post: true } });
    const mapping = await ctx.db.sourceTargetMapping.findFirst({ where: { targetId: a.targetId, sourceId: pub.post.sourceId } });
    const tries = pub.publishTries;
    if (tries < (mapping?.maxPublishTries ?? 2)) {
      to = 'QUEUED';
      reason = `RETRY_AFTER_${kind ?? 'ERROR'}`;
    } else {
      to = 'FAILED_CONFIRMED';
      reason = `GAVE_UP_${kind ?? 'ERROR'}`;
      operator = kind === 'UI_UNEXPECTED';
    }
  } else {
    to = 'FAILED_CONFIRMED';
    reason = kind;
  }

  await tx(ctx.db, async (t) => {
    const moved = await movePublication(t, {
      id: a.pubId,
      from: a.status,
      to,
      actor: ctx.actor,
      now,
      reason,
      fence: a.lease,
      data: to === 'QUEUED' ? { jobVersion: { increment: 1 } } : undefined,
    });
    if (!moved) return;
    await t.publicationAttempt.update({
      where: { id: a.attemptId! },
      data: { outcome: operator ? 'NEEDS_OPERATOR' : 'FAILED_PRE_COMMIT', errorClass: reason.slice(0, 120), errorMessage: msg.slice(0, 1000), finishedAt: now },
    });
    if (to === 'QUEUED') {
      const queue = a.workflow === 'VIDEO' ? Q.PublishVideo : a.workflow === 'ALBUM' ? Q.PublishAlbum : Q.PublishStandard;
      await enqueue(t, queue, { publicationId: a.pubId, jobVersion: a.jobVersion + 1 }, { startAfter: new Date(now.getTime() + 60_000) });
    }
    if (operator) {
      // Stop the account until a person has looked at it; never try to get around checks.
      await setControl(t, 'TARGET', a.targetId, true, ctx.actor, reason);
      await openOperatorTask(t, { kind: 'TAKEOVER_ACCOUNT', reason, targetId: a.targetId, publicationId: a.pubId, details: { message: msg }, now });
    }
  });
  log.warn({ reason, to, operator }, 'pre-commit stop');
  return to === 'QUEUED' ? 'REQUEUED' : to === 'CANCELLED' ? (operator ? 'NEEDS_OPERATOR' : 'CANCELLED') : 'FAILED_CONFIRMED';
}
