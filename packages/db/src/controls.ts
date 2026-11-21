import type { ControlScope, Prisma } from '@prisma/client';

type Q = Prisma.TransactionClient;

export interface ControlQuery {
  sourceId?: string;
  targetId?: string;
  contentType?: string;
  connector?: string;
}

/** Returns the first active kill switch that applies, or null. Checked at dispatch and right before COMMITTING. */
export async function activeKillSwitch(q: Q, c: ControlQuery): Promise<{ scope: ControlScope; scopeKey: string; reason: string | null } | null> {
  const or: Prisma.ControlWhereInput[] = [{ scope: 'GLOBAL', scopeKey: '*' }];
  if (c.sourceId) or.push({ scope: 'SOURCE', scopeKey: c.sourceId });
  if (c.targetId) or.push({ scope: 'TARGET', scopeKey: c.targetId });
  if (c.contentType) or.push({ scope: 'FORMAT', scopeKey: c.contentType });
  if (c.connector) or.push({ scope: 'CONNECTOR', scopeKey: c.connector });
  const hit = await q.control.findFirst({ where: { paused: true, OR: or }, select: { scope: true, scopeKey: true, reason: true } });
  return hit;
}

export async function setControl(q: Q, scope: ControlScope, scopeKey: string, paused: boolean, setBy: string, reason?: string) {
  return q.control.upsert({
    where: { scope_scopeKey: { scope, scopeKey } },
    create: { scope, scopeKey, paused, setBy, reason },
    update: { paused, setBy, reason },
  });
}
