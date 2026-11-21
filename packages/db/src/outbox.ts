import type { Prisma } from '@prisma/client';
import { JobSchemas, type JobPayload, type QueueName } from '@seedingsys/contracts';

type Tx = Prisma.TransactionClient;

/**
 * Transactional outbox: write the event in the same transaction as the state change.
 * The relay (worker-core) moves rows to pg-boss; delivery is at-least-once.
 */
export async function enqueue<N extends QueueName>(
  t: Tx,
  queue: N,
  payload: JobPayload<N>,
  opts: { singletonKey?: string; startAfter?: Date } = {},
): Promise<void> {
  JobSchemas[queue].parse(payload);
  await t.outboxEvent.create({
    data: {
      queue,
      payload: payload as Prisma.InputJsonValue,
      singletonKey: opts.singletonKey,
      startAfter: opts.startAfter,
    },
  });
}

export interface PendingOutbox {
  id: bigint;
  queue: string;
  payload: unknown;
  singletonKey: string | null;
  startAfter: Date | null;
}

/** Claim a batch of pending rows (SKIP LOCKED so several relays can run). Call inside a tx. */
export async function claimOutbox(t: Tx, limit = 100): Promise<PendingOutbox[]> {
  const rows = await t.$queryRaw<Array<{ id: bigint; queue: string; payload: unknown; singleton_key: string | null; start_after: Date | null }>>`
    SELECT id, queue, payload, singleton_key, start_after
    FROM outbox_events
    WHERE published_at IS NULL
    ORDER BY id
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED`;
  return rows.map((r) => ({ id: r.id, queue: r.queue, payload: r.payload, singletonKey: r.singleton_key, startAfter: r.start_after }));
}

export async function markOutboxPublished(t: Tx, ids: bigint[], at: Date): Promise<void> {
  if (!ids.length) return;
  await t.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { publishedAt: at } });
}
