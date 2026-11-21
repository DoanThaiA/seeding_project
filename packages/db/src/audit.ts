import type { Prisma } from '@prisma/client';

type Q = Prisma.TransactionClient;

export async function audit(
  t: Q,
  e: { entityType: string; entityId: string; action: string; from?: string | null; to?: string | null; actor: string; data?: unknown; at: Date },
): Promise<void> {
  await t.auditEvent.create({
    data: {
      entityType: e.entityType,
      entityId: e.entityId,
      action: e.action,
      fromState: e.from ?? null,
      toState: e.to ?? null,
      actor: e.actor,
      data: (e.data ?? undefined) as Prisma.InputJsonValue | undefined,
      at: e.at,
    },
  });
}
