/** The worker no longer holds the account lease (or a newer holder exists): stop touching the account. */
export class FencedOutError extends Error {
  constructor(resource: string, token: bigint | string) {
    super(`Lease ${resource} no longer held with fencing token ${token}`);
  }
}

/** Resource busy — the job should be retried later within its window. */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly delaySec = 30,
  ) {
    super(message);
  }
}
