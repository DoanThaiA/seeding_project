import type { Db } from '@seedingsys/db';
import type { Clock } from '@seedingsys/domain';
import type { LlmGateway } from '@seedingsys/llm';
import type { Logger } from '@seedingsys/observability';

export interface CoreCtx {
  db: Db;
  clock: Clock;
  log: Logger;
  /** Identity written into audit events, e.g. "worker-core:host-1". */
  actor: string;
  llm: LlmGateway;
  /** A browser worker counts as available if it sent a heartbeat within this window. */
  workerFreshMs?: number;
}
