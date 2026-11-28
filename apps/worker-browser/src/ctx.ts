import type { ConnectorRegistry } from '@seedingsys/connectors-core';
import type { Db } from '@seedingsys/db';
import type { Clock } from '@seedingsys/domain';
import type { Logger } from '@seedingsys/observability';
import type { ObjectStore } from '@seedingsys/storage';

export interface BrowserTimeouts {
  /** Wall-clock limit per connector step before COMMITTING (prepare, preview...). */
  stepMs: number;
  /** Limit for commit + verify. */
  commitMs: number;
  /** Video upload/processing limit. */
  videoMs: number;
}

export interface BrowserCtx {
  db: Db;
  clock: Clock;
  log: Logger;
  workerId: string;
  actor: string;
  registry: ConnectorRegistry;
  store: ObjectStore;
  timeouts: BrowserTimeouts;
  /** Account lease TTL per workflow; heartbeats extend it while work progresses. */
  leaseTtlMs: { STANDARD: number; ALBUM: number; VIDEO: number; RECONCILE: number; POLL: number };
  /** COMMITTING is only written if the lease still has at least this much time left. */
  commitMarginMs: number;
  /** "Not found" after commit is only conclusive once this much time has passed. */
  reconcileMinAgeMs: number;
  /** Maximum initial verify and reconcile attempts combined. */
  verifyMaxTries: number;
  reconcileDelaySec: number;
  verifyWindowMs: number;
  tmpDir: string;
}

export const DEFAULT_BROWSER_SETTINGS = {
  timeouts: { stepMs: 90_000, commitMs: 120_000, videoMs: 45 * 60_000 },
  leaseTtlMs: { STANDARD: 3 * 60_000, ALBUM: 5 * 60_000, VIDEO: 5 * 60_000, RECONCILE: 3 * 60_000, POLL: 4 * 60_000 },
  commitMarginMs: 60_000,
  reconcileMinAgeMs: 10 * 60_000,
  verifyMaxTries: 2,
  reconcileDelaySec: 120,
  verifyWindowMs: 30 * 60_000,
} satisfies Partial<BrowserCtx>;
