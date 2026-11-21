import { ACTIVE } from '@seedingsys/contracts';
import {
  dispatchSlot,
  movePublication,
  moveSlot,
  targetLateWindowMin,
  tx,
  type Tx,
} from '@seedingsys/db';
import { HOUR, isPastLaunchWindow, topOfHour } from '@seedingsys/domain';
import type { CoreCtx } from '../ctx';

export { dispatchSlot, type SlotOutcome } from '@seedingsys/db';

/** Create this hour's slot for every enabled target that has an enabled mapping (idempotent). */
export async function ensureSlots(ctx: CoreCtx): Promise<number> {
  const now = ctx.clock.now();
  const slotAt = topOfHour(now);
  const targets = await ctx.db.targetAccount.findMany({
    where: { enabled: true, mappings: { some: { enabled: true, source: { enabled: true } } } },
    select: { id: true, mappings: { where: { enabled: true }, select: { lateWindowMin: true } } },
  });
  // A slot whose launch window is already over when we first see it (e.g. the system starts at
  // 09:50) is simply not created — there is nothing to run and nothing to report as missed.
  const open = targets.filter((t) => !isPastLaunchWindow(slotAt, Math.min(...t.mappings.map((m) => m.lateWindowMin)), now));
  const r = await ctx.db.publicationSlot.createMany({
    data: open.map((t) => ({ targetId: t.id, slotAt })),
    skipDuplicates: true, // ON CONFLICT DO NOTHING on UNIQUE(target_id, slot_at)
  });
  return r.count;
}

/** Dispatch every open slot of the last 2 hours (older ones are MISSED anyway). */
export async function dispatchDueSlots(ctx: CoreCtx): Promise<Record<string, number>> {
  const now = ctx.clock.now();
  const slots = await ctx.db.publicationSlot.findMany({
    where: { manual: false, status: { in: ['PLANNED', 'DEFERRED'] }, slotAt: { lte: now, gte: new Date(now.getTime() - 2 * HOUR) } },
    orderBy: { slotAt: 'asc' },
    select: { id: true },
  });
  const counts: Record<string, number> = {};
  for (const s of slots) {
    const o = await dispatchSlot(ctx, s.id);
    counts[o] = (counts[o] ?? 0) + 1;
  }
  // Very old open slots (e.g. after a long outage) are closed as MISSED — never replayed in bulk.
  await ctx.db.publicationSlot.updateMany({
    where: { status: { in: ['PLANNED', 'DEFERRED'] }, slotAt: { lt: new Date(now.getTime() - 2 * HOUR) } },
    data: { status: 'MISSED', reason: 'OUTAGE_NOT_REPLAYED' },
  });
  return counts;
}

/**
 * A dispatched publication that never started inside the launch window is cancelled (content goes
 * back to the backlog) and its slot is MISSED. Races with a starting worker are settled by the
 * conditional QUEUED→PREPARING / QUEUED→CANCELLED update: exactly one wins.
 */
export async function sweepLateDispatches(ctx: CoreCtx): Promise<number> {
  const now = ctx.clock.now();
  const slots = await ctx.db.publicationSlot.findMany({ where: { status: 'DISPATCHED', slotAt: { lt: now } } });
  let n = 0;
  for (const s of slots) {
    const lw = await targetLateWindowMin(ctx.db, s.targetId);
    if (!isPastLaunchWindow(s.slotAt, lw, now) || !s.publicationId) continue;
    await tx(ctx.db, async (t) => {
      const cancelled = await movePublication(t, { id: s.publicationId!, from: 'QUEUED', to: 'CANCELLED', actor: ctx.actor, now, reason: 'LAUNCH_WINDOW_EXPIRED' });
      if (cancelled) {
        await moveSlot(t, { id: s.id, from: 'DISPATCHED', to: 'MISSED', actor: ctx.actor, now, reason: 'NOT_STARTED_IN_WINDOW' });
        n++;
      }
    });
  }
  // Slots whose publication finished (or was abandoned by a dead worker and settled) are closed.
  const started = await ctx.db.publicationSlot.findMany({ where: { status: 'STARTED' } });
  for (const s of started) {
    const p = s.publicationId ? await ctx.db.publication.findUnique({ where: { id: s.publicationId }, select: { status: true, slotId: true } }) : null;
    if (!p || !ACTIVE.includes(p.status) || p.slotId !== s.id) {
      await moveSlot(ctx.db as unknown as Tx, { id: s.id, from: 'STARTED', to: 'DONE', actor: ctx.actor, now });
    }
  }
  return n;
}
