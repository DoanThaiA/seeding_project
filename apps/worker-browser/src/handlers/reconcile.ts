import type { PublishSnapshot } from '@seedingsys/contracts';
import type { CommitSignal } from '@seedingsys/connectors-core';
import { Q } from '@seedingsys/contracts';
import { accountResource, acquireLease, enqueue, movePublication, openOperatorTask, releaseLease, tx } from '@seedingsys/db';
import { RetryLaterError, captionFingerprint } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';
import { withTimeout } from '../runtime/timeout';
import { applyVerifyResult, type VerifyOutcome } from './verify-result';

/**
 * publish.reconcile (and publish.verify) — settle an UNKNOWN publication by looking at the target's
 * timeline. Never posts. Repeats a bounded number of times, then hands over to a person.
 */
export async function handleReconcile(ctx: BrowserCtx, p: { publicationId: string }): Promise<VerifyOutcome | 'STALE'> {
  const pub = await ctx.db.publication.findUnique({ where: { id: p.publicationId }, include: { target: { include: { profile: true } }, variant: true } });
  if (!pub || (pub.status !== 'UNKNOWN' && pub.status !== 'RECONCILING')) return 'STALE';
  const now0 = ctx.clock.now();
  const lease = await acquireLease(ctx.db, {
    resource: accountResource(pub.targetId),
    holder: `${ctx.workerId}:reconcile:${pub.id}`,
    ttlMs: ctx.leaseTtlMs.RECONCILE,
    now: now0,
    purpose: 'reconcile',
  });
  if (!lease) throw new RetryLaterError('account busy');

  const connector = ctx.registry.publisher(pub.target.connector);
  let attemptId: string | null = null;
  try {
    const started = await tx(ctx.db, async (t) => {
      const ok = await movePublication(t, {
        id: pub.id,
        from: pub.status,
        to: 'RECONCILING',
        actor: ctx.actor,
        now: now0,
        fence: lease,
        data: { reconcileTries: { increment: 1 } },
      });
      if (!ok && pub.status !== 'RECONCILING') return null;
      const n = await t.publicationAttempt.count({ where: { publicationId: pub.id } });
      const a = await t.publicationAttempt.create({
        data: {
          publicationId: pub.id,
          attemptNo: n + 1,
          kind: 'reconcile',
          connector: connector.key,
          connectorVersion: connector.version,
          workerId: ctx.workerId,
          fencingToken: lease.token,
          startedAt: now0,
          stage: 'RECONCILE',
        },
      });
      return a.id;
    });
    if (!started) return 'STALE';
    attemptId = started;

    const snapshot = pub.variant.snapshot as unknown as PublishSnapshot;
    const session = await withTimeout(
      connector.openSession({ id: pub.target.id, code: pub.target.code, externalId: pub.target.externalId, audience: pub.target.audience, uiLocale: pub.target.uiLocale, profileDir: pub.target.profile?.profileDir }),
      ctx.timeouts.stepMs,
      'openSession',
    );
    try {
      const state = await session.sessionState();
      if (state !== 'OK') {
        await tx(ctx.db, async (t) => {
          const now = ctx.clock.now();
          if (await movePublication(t, { id: pub.id, from: 'RECONCILING', to: 'NEEDS_OPERATOR', actor: ctx.actor, now, fence: lease, reason: `SESSION_${state}` })) {
            await t.publicationAttempt.update({ where: { id: attemptId! }, data: { outcome: 'NEEDS_OPERATOR', finishedAt: now, errorClass: `SESSION_${state}` } });
            await openOperatorTask(t, { kind: 'CONFIRM_RESULT', reason: `SESSION_${state}`, targetId: pub.targetId, publicationId: pub.id, now });
          }
        });
        return 'NEEDS_OPERATOR';
      }
      const previous = snapshot.contentType === 'REEL' ? await ctx.db.publicationAttempt.findFirst({
        where: { publicationId: pub.id, kind: 'publish', committingAt: pub.committedAt ?? undefined },
        orderBy: { attemptNo: 'desc' }, select: { evidence: true },
      }) : null;
      const commitSignal = (previous?.evidence as { commitSignal?: CommitSignal } | null)?.commitSignal;
      const result = await withTimeout(
        session.verify({
          captionFingerprint: captionFingerprint(snapshot.caption),
          contentType: snapshot.contentType,
          commitSignal,
          caption: snapshot.caption,
          mediaCount: snapshot.media.length,
          committedAt: pub.committedAt ?? pub.updatedAt,
          windowMs: ctx.verifyWindowMs,
        }),
        ctx.timeouts.commitMs,
        'verify',
      );
      return await applyVerifyResult(ctx, {
        publicationId: pub.id,
        from: 'RECONCILING',
        attemptId,
        result,
        committedAt: pub.committedAt ?? pub.updatedAt,
        fence: lease,
        reconcileTries: pub.reconcileTries + 1,
      });
    } finally {
      await session.close().catch(() => undefined);
    }
  } catch (err) {
    // Could not look: stay unresolved and try again later (bounded by reconcileMaxTries).
    await tx(ctx.db, async (t) => {
      const now = ctx.clock.now();
      const giveUp = pub.reconcileTries + 1 >= ctx.reconcileMaxTries;
      const moved = await movePublication(t, { id: pub.id, from: 'RECONCILING', to: giveUp ? 'NEEDS_OPERATOR' : 'UNKNOWN', actor: ctx.actor, now, fence: lease, reason: 'RECONCILE_ERROR' });
      if (!moved) return;
      if (attemptId) await t.publicationAttempt.update({ where: { id: attemptId }, data: { outcome: giveUp ? 'NEEDS_OPERATOR' : 'UNKNOWN', finishedAt: now, errorMessage: String((err as Error).message).slice(0, 500) } });
      if (giveUp) await openOperatorTask(t, { kind: 'CONFIRM_RESULT', reason: 'RECONCILE_ERROR', targetId: pub.targetId, publicationId: pub.id, now });
      else await enqueue(t, Q.PublishReconcile, { publicationId: pub.id }, { startAfter: new Date(now.getTime() + ctx.reconcileDelaySec * 1000) });
    });
    ctx.log.warn({ publication_id: pub.id, err: (err as Error).message }, 'reconcile failed');
    return 'UNKNOWN';
  } finally {
    await releaseLease(ctx.db, lease, ctx.clock.now());
  }
}
