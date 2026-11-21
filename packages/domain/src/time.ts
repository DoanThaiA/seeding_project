/** Injected clock: every time-dependent decision uses this, never Date.now() directly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class ManualClock implements Clock {
  constructor(private t: Date) {}
  now() {
    return new Date(this.t.getTime());
  }
  set(t: Date | string) {
    this.t = new Date(t);
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** Vietnam has no DST (UTC+7), so the top of the hour is the same instant in UTC and VN time. */
export function topOfHour(d: Date): Date {
  const t = new Date(d.getTime());
  t.setUTCMinutes(0, 0, 0);
  return t;
}

export function addMs(d: Date, ms: number): Date {
  return new Date(d.getTime() + ms);
}

/** YYYY-MM-DD in Asia/Ho_Chi_Minh (used for daily budgets/reports). */
export function vnDay(d: Date): string {
  return new Date(d.getTime() + 7 * HOUR).toISOString().slice(0, 10);
}

/** Launch window of a slot: after slotAt + lateWindow it is MISSED if not started. */
export function isPastLaunchWindow(slotAt: Date, lateWindowMin: number, now: Date): boolean {
  return now.getTime() > slotAt.getTime() + lateWindowMin * MIN;
}
