import { ACTIVE, POST_COMMIT_ACTIVE, PRE_COMMIT, PUBLISH_QUEUE_BY_WORKFLOW, Q } from '@seedingsys/contracts';
import { accountResource, enqueue, movePublication, moveSlot, targetLateWindowMin, tx, type PublicationStatus } from '@seedingsys/db';
import { isPastLaunchWindow } from '@seedingsys/domain';
import type { CoreCtx } from '../ctx';

/**
 * Finds browser-side publications whose worker lost its account lease (crash, freeze, network).
 *  - Before COMMITTING: nothing can have been posted → back to QUEUED with a new job version
 *    (or settled if the launch window or retry budget is over).
 *  - From COMMITTING on: the post may exist → UNKNOWN + reconcile. Never re-published blindly.
 * A still-running old worker cannot interfere: every later write of its attempt is fenced by the
 * old token and fails.
 */
export async function sweepExpiredLeases(ctx: CoreCtx): Promise<{ requeued: number; unknown: number }> {
  const now = ctx.clock.now();
  const active: PublicationStatus[] = [...ACTIVE, 'RECONCILING'];
  const pubs = await ctx.db.publication.findMany({
    where: { status: { in: active } },
    include: { attempts: { orderBy: { attemptNo: 'desc' }, take: 1 }, post: { select: { sourceId: true } } },
  });
  let requeued = 0;
  let unknown = 0;
  for (const p of pubs) {
    const attempt = p.attempts[0];
    await tx(ctx.db, async (t) => {
      const [lease] = await t.$queryRaw<Array<{ fencing_token: bigint; released_at: Date | null; expires_at: Date }>>`
        SELECT fencing_token, released_at, expires_at FROM account_leases
        WHERE resource = ${accountResource(p.targetId)} FOR UPDATE`;
      if (attempt && lease && lease.fencing_token === attempt.fencingToken && !lease.released_at && lease.expires_at > now) return;
      const expected = { expectedJobVersion: p.jobVersion, expectedReconcileTries: p.reconcileTries };
      if (PRE_COMMIT.includes(p.status)) {
        const slot = p.slotId ? await t.publicationSlot.findUnique({ where: { id: p.slotId } }) : null;
        const lw = await targetLateWindowMin(t, p.targetId);
        const expired = slot ? isPastLaunchWindow(slot.slotAt, lw, now) : true;
        const mapping = await t.sourceTargetMapping.findUnique({
          where: { sourceId_targetId: { sourceId: p.post.sourceId, targetId: p.targetId } },
          select: { maxPublishTries: true },
        });
        const to = expired ? 'CANCELLED' : p.publishTries >= (mapping?.maxPublishTries ?? 2) ? 'FAILED_CONFIRMED' : 'QUEUED';
        const ok = await movePublication(t, {
          id: p.id,
          from: p.status,
          to,
          actor: ctx.actor,
          now,
          reason: to === 'FAILED_CONFIRMED' ? 'LEASE_LOST_RETRY_LIMIT' : 'LEASE_LOST_BEFORE_COMMIT',
          data: to === 'QUEUED' ? { jobVersion: { increment: 1 } } : undefined,
          ...expected,
        });
        if (!ok) return;
        if (attempt) await t.publicationAttempt.update({ where: { id: attempt.id }, data: { outcome: 'ABANDONED', finishedAt: now, errorClass: 'LEASE_LOST' } });
        if (to === 'QUEUED') {
          await enqueue(t, PUBLISH_QUEUE_BY_WORKFLOW[p.workflow], { publicationId: p.id, jobVersion: p.jobVersion + 1 });
          requeued++;
        } else if (slot?.status === 'STARTED') {
          await moveSlot(t, { id: slot.id, from: 'STARTED', to: 'DONE', actor: ctx.actor, now, reason: 'ABANDONED' });
        }
      } else if (POST_COMMIT_ACTIVE.includes(p.status) || p.status === 'RECONCILING') {
        const reason = p.status === 'RECONCILING' ? 'LEASE_LOST_DURING_RECONCILE' : 'LEASE_LOST_AFTER_COMMIT';
        const ok = await movePublication(t, { id: p.id, from: p.status, to: 'UNKNOWN', actor: ctx.actor, now, reason, ...expected });
        if (!ok) return;
        if (attempt) await t.publicationAttempt.update({ where: { id: attempt.id }, data: { outcome: 'UNKNOWN', finishedAt: now, errorClass: 'LEASE_LOST' } });
        await enqueue(t, Q.PublishReconcile, { publicationId: p.id });
        unknown++;
      }
    });
  }
  return { requeued, unknown };
}

/** Content past its validity is never published late. */
export async function expireContent(ctx: CoreCtx): Promise<number> {
  const now = ctx.clock.now();
  const r = await ctx.db.contentVariant.updateMany({
    where: { status: { in: ['READY', 'NEEDS_REVIEW', 'REWRITING', 'VALIDATING', 'FETCHING_MEDIA'] }, expiresAt: { lt: now } },
    data: { status: 'EXPIRED' },
  });
  return r.count;
}
