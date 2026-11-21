/**
 * State machines (spec §5 of the architecture). Values mirror the Prisma enums.
 * Every status change in the system goes through `assertTransition` so the tables below
 * are the single place that defines what is allowed.
 */

export const PUBLICATION_STATUSES = [
  'QUEUED',
  'PREPARING',
  'UPLOADING_DRAFT',
  'READY_TO_SUBMIT',
  'COMMITTING',
  'PLATFORM_PROCESSING',
  'VERIFYING',
  'PUBLISHED_VERIFIED',
  'FAILED_CONFIRMED',
  'UNKNOWN',
  'RECONCILING',
  'NEEDS_OPERATOR',
  'OPERATOR_CONFIRMED',
  'CANCELLED',
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/** Before COMMITTING nothing visible can have happened on the platform: safe to retry. */
export const PRE_COMMIT: readonly PublicationStatus[] = ['QUEUED', 'PREPARING', 'UPLOADING_DRAFT', 'READY_TO_SUBMIT'];
/** From COMMITTING on, any failure/timeout/lease loss must go to UNKNOWN / RECONCILING. */
export const POST_COMMIT_ACTIVE: readonly PublicationStatus[] = ['COMMITTING', 'PLATFORM_PROCESSING', 'VERIFYING'];
/** States where a browser holds the account. */
export const ACTIVE: readonly PublicationStatus[] = ['PREPARING', 'UPLOADING_DRAFT', 'READY_TO_SUBMIT', ...POST_COMMIT_ACTIVE];
/** Unresolved: the account must not get new publications until these are settled. */
export const UNRESOLVED: readonly PublicationStatus[] = [...POST_COMMIT_ACTIVE, 'UNKNOWN', 'RECONCILING', 'NEEDS_OPERATOR'];
/** Counted as success. UNKNOWN is never success. */
export const SUCCESS: readonly PublicationStatus[] = ['PUBLISHED_VERIFIED', 'OPERATOR_CONFIRMED'];
/** Content may be picked again for the same target (no side effect happened). */
export const RESELECTABLE: readonly PublicationStatus[] = ['FAILED_CONFIRMED', 'CANCELLED'];

const P: Record<PublicationStatus, readonly PublicationStatus[]> = {
  QUEUED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['UPLOADING_DRAFT', 'COMMITTING', 'QUEUED', 'FAILED_CONFIRMED', 'CANCELLED'],
  UPLOADING_DRAFT: ['READY_TO_SUBMIT', 'QUEUED', 'FAILED_CONFIRMED', 'CANCELLED'],
  READY_TO_SUBMIT: ['COMMITTING', 'QUEUED', 'FAILED_CONFIRMED', 'CANCELLED'],
  COMMITTING: ['PLATFORM_PROCESSING', 'VERIFYING', 'UNKNOWN', 'RECONCILING'],
  PLATFORM_PROCESSING: ['VERIFYING', 'UNKNOWN', 'RECONCILING'],
  VERIFYING: ['PUBLISHED_VERIFIED', 'FAILED_CONFIRMED', 'UNKNOWN', 'RECONCILING'],
  UNKNOWN: ['RECONCILING', 'NEEDS_OPERATOR'],
  RECONCILING: ['PUBLISHED_VERIFIED', 'FAILED_CONFIRMED', 'UNKNOWN', 'NEEDS_OPERATOR'],
  NEEDS_OPERATOR: ['OPERATOR_CONFIRMED', 'FAILED_CONFIRMED', 'PUBLISHED_VERIFIED'],
  // Re-selection of failed/cancelled content reuses the row (unique target+post).
  FAILED_CONFIRMED: ['QUEUED'],
  CANCELLED: ['QUEUED'],
  PUBLISHED_VERIFIED: [],
  OPERATOR_CONFIRMED: [],
};

export const SLOT_STATUSES = [
  'PLANNED',
  'RESERVED',
  'DISPATCHED',
  'STARTED',
  'DONE',
  'SKIPPED_NO_CONTENT',
  'DEFERRED',
  'MISSED',
] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

const S: Record<SlotStatus, readonly SlotStatus[]> = {
  PLANNED: ['RESERVED', 'DISPATCHED', 'SKIPPED_NO_CONTENT', 'DEFERRED', 'MISSED'],
  DEFERRED: ['RESERVED', 'DISPATCHED', 'SKIPPED_NO_CONTENT', 'DEFERRED', 'MISSED'],
  RESERVED: ['DISPATCHED', 'MISSED'],
  DISPATCHED: ['STARTED', 'MISSED'],
  STARTED: ['DONE'],
  DONE: [],
  SKIPPED_NO_CONTENT: [],
  MISSED: [],
};

export const VARIANT_STATUSES = [
  'BASELINE',
  'FETCHING_MEDIA',
  'REWRITING',
  'VALIDATING',
  'READY',
  'NEEDS_REVIEW',
  'REJECTED',
  'UNSUPPORTED',
  'EXPIRED',
  'SUPERSEDED',
  'DUPLICATE',
] as const;
export type VariantStatus = (typeof VARIANT_STATUSES)[number];

const V: Record<VariantStatus, readonly VariantStatus[]> = {
  BASELINE: ['REWRITING', 'FETCHING_MEDIA'], // only via explicit operator action
  FETCHING_MEDIA: ['REWRITING', 'NEEDS_REVIEW', 'SUPERSEDED', 'EXPIRED', 'UNSUPPORTED', 'DUPLICATE'],
  REWRITING: ['VALIDATING', 'NEEDS_REVIEW', 'SUPERSEDED', 'EXPIRED', 'DUPLICATE'],
  VALIDATING: ['READY', 'NEEDS_REVIEW', 'SUPERSEDED', 'EXPIRED', 'DUPLICATE'],
  READY: ['EXPIRED', 'SUPERSEDED', 'DUPLICATE'],
  NEEDS_REVIEW: ['READY', 'REJECTED', 'REWRITING', 'SUPERSEDED', 'EXPIRED', 'DUPLICATE'],
  REJECTED: [],
  UNSUPPORTED: ['NEEDS_REVIEW'],
  EXPIRED: [],
  SUPERSEDED: [],
  // Another source post holds this content for the target. Terminal: the target gets it once.
  DUPLICATE: [],
};

const MACHINES = { publication: P, slot: S, variant: V } as const;
export type Machine = keyof typeof MACHINES;

export function canTransition(machine: Machine, from: string, to: string): boolean {
  const table = MACHINES[machine] as Record<string, readonly string[]>;
  return (table[from] ?? []).includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly machine: Machine,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${machine} transition ${from} → ${to}`);
  }
}

export function assertTransition(machine: Machine, from: string, to: string): void {
  if (!canTransition(machine, from, to)) throw new IllegalTransitionError(machine, from, to);
}

/** All states from which `to` is reachable in one step (used to build conditional UPDATEs). */
export function sourcesOf(machine: Machine, to: string): string[] {
  const table = MACHINES[machine] as Record<string, readonly string[]>;
  return Object.keys(table).filter((k) => table[k].includes(to));
}

export const TRANSITION_TABLES = MACHINES;
