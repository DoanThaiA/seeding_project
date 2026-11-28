import type { CommitSignal, VerifyResult } from '@seedingsys/connectors-core';
import { Q, RECONCILE_EXHAUSTED } from '@seedingsys/contracts';
import { enqueue, movePublication, openOperatorTask, tx, type Lease } from '@seedingsys/db';
import type { BrowserCtx } from '../ctx';

export type VerifyOutcome = 'PUBLISHED_VERIFIED' | 'FAILED_CONFIRMED' | 'UNKNOWN' | 'NEEDS_OPERATOR' | 'FENCED';

/**
 * Turn a verification result into a publication state. Only a single, matching post on the
 * target counts as success; an LLM opinion or a toast is never evidence.
 */
export async function applyVerifyResult(
  ctx: BrowserCtx,
  a: {
    publicationId: string; from: 'VERIFYING' | 'RECONCILING'; attemptId: string; result: VerifyResult;
    committedAt: Date; fence: Lease; verificationAttempts: number; commitSignal?: CommitSignal; targetExternalId?: string;
  },
): Promise<VerifyOutcome> {
  const now = ctx.clock.now();
  const r = a.result;
  const age = now.getTime() - a.committedAt.getTime();

  return tx(ctx.db, async (t) => {
    const attempt = (data: object) => t.publicationAttempt.update({ where: { id: a.attemptId }, data: { finishedAt: now, ...data } });

    if (r.kind === 'VERIFIED') {
      const ok = await movePublication(t, {
        id: a.publicationId,
        from: a.from,
        to: 'PUBLISHED_VERIFIED',
        actor: ctx.actor,
        now,
        fence: a.fence,
        data: { permalink: r.permalink, externalPostId: r.externalPostId ?? null, verifiedAt: now, lastReason: null },
      });
      if (!ok) return 'FENCED';
      await attempt({ outcome: 'SUCCEEDED', stage: 'VERIFIED', evidence: { verify: r } });
      return 'PUBLISHED_VERIFIED';
    }

    const giveUp = a.verificationAttempts >= ctx.verifyMaxTries;
    if (!giveUp && r.kind === 'NOT_FOUND' && r.conclusive && age >= ctx.reconcileMinAgeMs) {
      const ok = await movePublication(t, { id: a.publicationId, from: a.from, to: 'FAILED_CONFIRMED', actor: ctx.actor, now, fence: a.fence, reason: 'CONFIRMED_ABSENT' });
      if (!ok) return 'FENCED';
      await attempt({ outcome: 'FAILED_CONFIRMED', stage: 'VERIFY', evidence: { verify: r } });
      return 'FAILED_CONFIRMED';
    }

    if (a.from === 'RECONCILING' && giveUp) {
      const reason = RECONCILE_EXHAUSTED;
      const ok = await movePublication(t, { id: a.publicationId, from: 'RECONCILING', to: 'NEEDS_OPERATOR', actor: ctx.actor, now, fence: a.fence, reason });
      if (!ok) return 'FENCED';
      await attempt({ outcome: 'NEEDS_OPERATOR', stage: 'RECONCILE', evidence: { verify: r } });
      const pub = await t.publication.findUniqueOrThrow({ where: { id: a.publicationId } });
      await openOperatorTask(t, { kind: 'CONFIRM_RESULT', reason, targetId: pub.targetId, publicationId: pub.id, details: { verify: r }, now });
      return 'NEEDS_OPERATOR';
    }

    const ok = await movePublication(t, { id: a.publicationId, from: a.from, to: 'UNKNOWN', actor: ctx.actor, now, fence: a.fence, reason: `VERIFY_${r.kind}` });
    if (!ok) return 'FENCED';
    await attempt({ outcome: 'UNKNOWN', stage: 'VERIFY', evidence: {
      verify: r, ...(a.commitSignal && { commitSignal: a.commitSignal }), ...(a.targetExternalId && { targetExternalId: a.targetExternalId }),
    } });
    await enqueue(t, Q.PublishReconcile, { publicationId: a.publicationId }, { startAfter: new Date(now.getTime() + ctx.reconcileDelaySec * 1000) });
    return 'UNKNOWN';
  });
}
