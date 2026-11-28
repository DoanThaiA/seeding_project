import type { Prisma } from '@prisma/client';
import { SOURCE_PROFILE_SCAN_STEP_MS } from '@seedingsys/contracts';

type Q = Prisma.TransactionClient;

export const accountResource = (targetId: string) => `account:${targetId}`;
export const sourceResource = (sourceId: string) => `source:${sourceId}`;
export const sourceProfileStepResource = (targetId: string) => `profile-scan-step:${targetId}`;
export const sourceProfileAccountHolder = (scanId: string) => `profile-scan:${scanId}`;
export const SOURCE_PROFILE_ACCOUNT_PURPOSE = 'source-profile-archive';

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
  const rows = await q.$queryRaw<Array<{ holder: string; fencing_token: bigint; expires_at: Date; purpose: string | null }>>`
    SELECT holder, fencing_token, expires_at, purpose FROM account_leases
    WHERE resource = ${resource} AND released_at IS NULL AND expires_at > ${now}`;
  return rows[0] ?? null;
}

export async function profileScanBlocksPoll(q: Q, sourceId: string, now: Date) {
  const fresh = new Date(+now - SOURCE_PROFILE_SCAN_STEP_MS);
  const [row] = await q.$queryRaw<Array<{ busy: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM source_profile_scans r JOIN sources s ON s.id=r.source_id
      WHERE s.id=${sourceId}::uuid AND r.connector='fb-session' AND r.connector=s.connector
        AND r.source_ref=s.external_ref AND r.reset_generation=s.reset_generation
        AND r.phase IN ('PROFILE','POSTS') AND r.updated_at>${fresh}
    ) OR EXISTS (
      SELECT 1 FROM source_target_mappings m JOIN sources s ON s.id=m.source_id
      JOIN target_accounts b ON b.id=m.target_id AND b.enabled AND b.connector='fb-web'
      JOIN account_leases l ON l.resource='account:'||b.id
      WHERE m.source_id=${sourceId}::uuid AND m.enabled AND s.connector='fb-session'
        AND l.purpose=${SOURCE_PROFILE_ACCOUNT_PURPOSE} AND l.released_at IS NULL AND l.expires_at>${now}
    ) AS busy`;
  return row?.busy ?? false;
}

/** Release the account between workflows only after its last browser step has closed. */
export async function releaseFinishedProfileScanAccount(q: Q, scanId: string, now: Date) {
  await q.$executeRaw`
    UPDATE account_leases l SET released_at=${now}
    FROM source_profile_scans r
    WHERE r.id=${scanId}::uuid AND l.holder=${sourceProfileAccountHolder(scanId)}
      AND l.purpose=${SOURCE_PROFILE_ACCOUNT_PURPOSE} AND l.released_at IS NULL
      AND (r.phase='FAILED' OR (r.phase='COLLECTING' AND NOT EXISTS (
        SELECT 1 FROM comment_scans c WHERE c.source_profile_scan_id=r.id AND c.status IN ('QUEUED','RUNNING')
      )))
      AND NOT EXISTS (
        SELECT 1 FROM account_leases step WHERE step.resource='profile-scan-step:'||substr(l.resource, 9)
          AND step.released_at IS NULL AND step.expires_at>${now}
      )`;
}
