import { POST_COMMIT_ACTIVE, PRE_COMMIT, PUBLISH_QUEUE_BY_WORKFLOW, Q } from '@seedingsys/contracts';
import { accountResource, enqueue, movePublication, moveSlot, targetLateWindowMin, tx, type PublicationStatus } from '@seedingsys/db';
import { isPastLaunchWindow } from '@seedingsys/domain';
import type { CoreCtx } from '../ctx';

/**
 * Finds browser-side publications whose worker lost its account lease (crash, freeze, network).
 *  - Before COMMITTING: nothing can have been posted → back to QUEUED with a new job version
 *    (or CANCELLED if the launch window is over).
 *  - From COMMITTING on: the post may exist → UNKNOWN + reconcile. Never re-published blindly.
 * A still-running old worker cannot interfere: every later write of its attempt is fenced by the
 * old token and fails.
 */
export async function sweepExpiredLeases(ctx: CoreCtx): Promise<{ requeued: number; unknown: number }> {
  const now = ctx.clock.now();
  const active: PublicationStatus[] = ['PREPARING', 'UPLOADING_DRAFT', 'READY_TO_SUBMIT', 'COMMITTING', 'PLATFORM_PROCESSING', 'VERIFYING'];
  const pubs = await ctx.db.publication.findMany({
    where: { status: { in: active } },
    include: { attempts: { orderBy: { attemptNo: 'desc' }, take: 1 } },
  });
  let requeued = 0;
  let unknown = 0;
  for (const p of pubs) {
    const attempt = p.attempts[0];
    const lease = await ctx.db.accountLease.findUnique({ where: { resource: accountResource(p.targetId) } });
    const held = !!attempt && !!lease && lease.fencingToken === attempt.fencingToken && !lease.releasedAt && lease.expiresAt > now;
    if (held) continue;

    await tx(ctx.db, async (t) => {
      if (PRE_COMMIT.includes(p.status)) {
        const slot = p.slotId ? await t.publicationSlot.findUnique({ where: { id: p.slotId } }) : null;
        const lw = await targetLateWindowMin(t, p.targetId);
        const expired = slot ? isPastLaunchWindow(slot.slotAt, lw, now) : true;
        const ok = await movePublication(t, {
          id: p.id,
          from: p.status,
          to: expired ? 'CANCELLED' : 'QUEUED',
          actor: ctx.actor,
          now,
          reason: 'LEASE_LOST_BEFORE_COMMIT',
          data: expired ? {} : { jobVersion: { increment: 1 } },
        });
        if (!ok) return;
        if (attempt) await t.publicationAttempt.update({ where: { id: attempt.id }, data: { outcome: 'ABANDONED', finishedAt: now, errorClass: 'LEASE_LOST' } });
        if (expired) {
          if (slot && slot.status === 'STARTED') await moveSlot(t, { id: slot.id, from: 'STARTED', to: 'DONE', actor: ctx.actor, now, reason: 'ABANDONED' });
        } else {
          if (slot && slot.status === 'STARTED') {
            // Slot keeps STARTED; the re-run continues it.
          }
          await enqueue(t, PUBLISH_QUEUE_BY_WORKFLOW[p.workflow], { publicationId: p.id, jobVersion: p.jobVersion + 1 });
        }
        requeued++;
      } else if (POST_COMMIT_ACTIVE.includes(p.status)) {
        const ok = await movePublication(t, { id: p.id, from: p.status, to: 'UNKNOWN', actor: ctx.actor, now, reason: 'LEASE_LOST_AFTER_COMMIT' });
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
