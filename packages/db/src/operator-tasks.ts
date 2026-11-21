import type { OperatorTaskKind, Prisma } from '@prisma/client';

type Q = Prisma.TransactionClient;

/** Open an operator task unless an identical one is already open (partial unique index). */
export async function openOperatorTask(
  q: Q,
  t: { kind: OperatorTaskKind; reason: string; targetId?: string; publicationId?: string; variantId?: string; details?: unknown; now: Date },
): Promise<void> {
  const existing = await q.operatorTask.findFirst({
    where: {
      kind: t.kind,
      status: { in: ['OPEN', 'CLAIMED'] },
      targetId: t.targetId ?? null,
      publicationId: t.publicationId ?? null,
      variantId: t.variantId ?? null,
    },
    select: { id: true },
  });
  if (existing) return;
  await q.operatorTask.create({
    data: {
      kind: t.kind,
      reason: t.reason,
      targetId: t.targetId,
      publicationId: t.publicationId,
      variantId: t.variantId,
      details: (t.details ?? undefined) as Prisma.InputJsonValue | undefined,
      createdAt: t.now,
    },
  });
}

export async function closeVariantReviewTasks(q: Q, variantId: string, actor: string, now: Date, reason: string) {
  await q.operatorTask.updateMany({
    where: { variantId, kind: 'REVIEW_CONTENT', status: { in: ['OPEN', 'CLAIMED'] } },
    data: { status: 'DONE', resolvedBy: actor, closedAt: now, resolution: { reason } },
  });
}
