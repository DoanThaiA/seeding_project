import { ConnectorError } from '@seedingsys/connectors-core';

/** Reject with a TRANSIENT ConnectorError if `p` takes longer than `ms`. Timer is unref'd. */
export function withTimeout<T>(p: Promise<T>, ms: number, step: string, closeLateResult?: (value: T) => Promise<void>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new ConnectorError('TRANSIENT', `timeout in ${step} after ${ms}ms`));
    }, ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        if (timedOut && closeLateResult) {
          void closeLateResult(v).catch(() => undefined);
          return;
        }
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Simple counting semaphore for host-wide limits (publisher sessions, video uploads). */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
