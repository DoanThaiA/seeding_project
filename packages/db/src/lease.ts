import type { Prisma } from '@prisma/client';

type Q = Prisma.TransactionClient;

export const accountResource = (targetId: string) => `account:${targetId}`;
export const sourceResource = (sourceId: string) => `source:${sourceId}`;

export interface Lease {
  resource: string;
  holder: string;
  token: bigint;
  expiresAt: Date;
}

/**
 * Acquire a lease if it is free, released or expired. Each acquisition gets a new, globally
 * increasing fencing token; writes that matter are conditioned on that token.
 * Note: taking over an *expired* lease never grants the right to re-publish an in-flight
 * publication — the lease-sweeper moves those to RECONCILING first.
 */
export async function acquireLease(
  q: Q,
  args: { resource: string; holder: string; ttlMs: number; now: Date; purpose?: string },
): Promise<Lease | null> {
  const exp = new Date(args.now.getTime() + args.ttlMs);
  const rows = await q.$queryRaw<Array<{ fencing_token: bigint }>>`
    INSERT INTO account_leases (resource, holder, fencing_token, purpose, acquired_at, heartbeat_at, expires_at, released_at)
    VALUES (${args.resource}, ${args.holder}, nextval('fencing_token_seq'), ${args.purpose ?? null}, ${args.now}, ${args.now}, ${exp}, NULL)
    ON CONFLICT (resource) DO UPDATE SET
      holder = EXCLUDED.holder,
      fencing_token = EXCLUDED.fencing_token,
      purpose = EXCLUDED.purpose,
      acquired_at = EXCLUDED.acquired_at,
      heartbeat_at = EXCLUDED.heartbeat_at,
      expires_at = EXCLUDED.expires_at,
      released_at = NULL
    WHERE account_leases.released_at IS NOT NULL OR account_leases.expires_at <= ${args.now}
    RETURNING fencing_token`;
  if (!rows.length) return null;
  return { resource: args.resource, holder: args.holder, token: rows[0].fencing_token, expiresAt: exp };
}

/** Extend a lease still held. Returns false if it was lost (expired or taken over). */
export async function heartbeatLease(q: Q, lease: Lease, ttlMs: number, now: Date): Promise<boolean> {
  const exp = new Date(now.getTime() + ttlMs);
  const n = await q.$executeRaw`
    UPDATE account_leases SET heartbeat_at = ${now}, expires_at = ${exp}
    WHERE resource = ${lease.resource} AND fencing_token = ${lease.token}
      AND released_at IS NULL AND expires_at > ${now}`;
  if (n === 1) lease.expiresAt = exp;
  return n === 1;
}

export async function releaseLease(q: Q, lease: Lease, now: Date): Promise<void> {
  await q.$executeRaw`
    UPDATE account_leases SET released_at = ${now}
    WHERE resource = ${lease.resource} AND fencing_token = ${lease.token} AND released_at IS NULL`;
}

/**
 * Inside a transaction: lock the lease row (FOR SHARE blocks a concurrent takeover) and
 * check we still hold it with at least `minRemainingMs` left. Use before side-effect writes.
 */
export async function assertLeaseHeld(t: Q, lease: Pick<Lease, 'resource' | 'token'>, now: Date, minRemainingMs = 0): Promise<boolean> {
  const minExp = new Date(now.getTime() + minRemainingMs);
  const rows = await t.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok FROM account_leases
    WHERE resource = ${lease.resource} AND fencing_token = ${lease.token}
      AND released_at IS NULL AND expires_at > ${minExp}
    FOR SHARE`;
  return rows.length === 1;
}

export async function activeLease(q: Q, resource: string, now: Date) {
  const rows = await q.$queryRaw<Array<{ holder: string; fencing_token: bigint; expires_at: Date }>>`
    SELECT holder, fencing_token, expires_at FROM account_leases
    WHERE resource = ${resource} AND released_at IS NULL AND expires_at > ${now}`;
  return rows[0] ?? null;
}
