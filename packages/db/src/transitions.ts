import type { Prisma, PublicationStatus, SlotStatus, VariantStatus } from '@prisma/client';
import { assertTransition, sourcesOf } from '@seedingsys/contracts';
import { audit } from './audit';
import { assertLeaseHeld, type Lease } from './lease';

type Q = Prisma.TransactionClient;

export class StaleStateError extends Error {}

/**
 * Conditional state change: only applies if the row is still in one of the expected states
 * (optimistic concurrency). Returns false when another actor already moved it.
 */
export async function movePublication(
  t: Q,
  args: {
    id: string;
    from: PublicationStatus | PublicationStatus[];
    to: PublicationStatus;
    actor: string;
    now: Date;
    data?: Prisma.PublicationUncheckedUpdateManyInput;
    reason?: string;
    expectedJobVersion?: number;
    expectedReconcileTries?: number;
    /** When set, the move only happens if this lease is still held (fencing). */
    fence?: Pick<Lease, 'resource' | 'token'>;
    fenceMinRemainingMs?: number;
  },
): Promise<boolean> {
  const from = Array.isArray(args.from) ? args.from : [args.from];
  for (const f of from) assertTransition('publication', f, args.to);
  if (args.fence) {
    const held = await assertLeaseHeld(t, args.fence, args.now, args.fenceMinRemainingMs ?? 0);
    if (!held) return false;
  }
  const r = await t.publication.updateMany({
    where: { id: args.id, status: { in: from }, jobVersion: args.expectedJobVersion, reconcileTries: args.expectedReconcileTries },
    data: { ...args.data, status: args.to, ...(args.reason !== undefined ? { lastReason: args.reason } : {}) },
  });
  if (r.count === 1) {
    await audit(t, {
      entityType: 'publication',
      entityId: args.id,
      action: 'transition',
      from: from.join('|'),
      to: args.to,
      actor: args.actor,
      data: args.reason ? { reason: args.reason } : undefined,
      at: args.now,
    });
  }
  return r.count === 1;
}

export async function moveSlot(
  t: Q,
  args: { id: string; from: SlotStatus | SlotStatus[]; to: SlotStatus; actor: string; now: Date; reason?: string; publicationId?: string },
): Promise<boolean> {
  const from = Array.isArray(args.from) ? args.from : [args.from];
  for (const f of from) assertTransition('slot', f, args.to);
  const r = await t.publicationSlot.updateMany({
    where: { id: args.id, status: { in: from } },
    data: { status: args.to, reason: args.reason ?? null, ...(args.publicationId ? { publicationId: args.publicationId } : {}) },
  });
  if (r.count === 1) {
    await audit(t, { entityType: 'slot', entityId: args.id, action: 'transition', from: from.join('|'), to: args.to, actor: args.actor, data: args.reason ? { reason: args.reason } : undefined, at: args.now });
  }
  return r.count === 1;
}

export async function moveVariant(
  t: Q,
  args: {
    id: string;
    from: VariantStatus | VariantStatus[];
    to: VariantStatus;
    actor: string;
    now: Date;
    data?: Prisma.ContentVariantUncheckedUpdateManyInput;
    reason?: string;
  },
): Promise<boolean> {
  const from = Array.isArray(args.from) ? args.from : [args.from];
  for (const f of from) assertTransition('variant', f, args.to);
  const r = await t.contentVariant.updateMany({ where: { id: args.id, status: { in: from } }, data: { ...args.data, status: args.to } });
  if (r.count === 1) {
    await audit(t, { entityType: 'variant', entityId: args.id, action: 'transition', from: from.join('|'), to: args.to, actor: args.actor, data: args.reason ? { reason: args.reason } : undefined, at: args.now });
  }
  return r.count === 1;
}

/** Every state from which `to` is a legal move (handy for "from any applicable state"). */
export function fromAny<T extends string>(machine: 'publication' | 'slot' | 'variant', to: T): T[] {
  return sourcesOf(machine, to) as T[];
}
