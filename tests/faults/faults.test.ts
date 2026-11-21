import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Q } from '@seedingsys/contracts';
import { setControl } from '@seedingsys/db';
import { handlePublish } from '../../apps/worker-browser/src';
import { dispatchDueSlots, ensureSlots } from '../../apps/worker-core/src';
import { createHarness, cycle, MIN, pubsOf, type Harness } from '../helpers/harness';

let h: Harness;
beforeEach(async () => {
  h = await createHarness({ codes: [1, 2, 3] });
});
afterEach(async () => {
  await h.close();
});

const TEN = '2026-11-20T03:00:10.000Z'; // 10:00:10 VN
const ELEVEN = '2026-11-20T04:00:10.000Z';

/** One READY text post for A1/B1, clock left just before 10:00. */
async function readyPostForB1(text = 'Khai trương chi nhánh mới ngày 5/12, giảm 20%') {
  await cycle(h); // baseline
  h.platform.addSourcePost('A1', { text, contentType: 'TEXT', media: [] });
  h.advance(5 * MIN);
  await cycle(h);
  const v = await h.db.contentVariant.findFirstOrThrow({ where: { targetId: h.ids.targets.B1 } });
  expect(v.status).toBe('READY');
}

/** Run the slot dispatch at 10:00 but start the publish job by hand (not awaited). */
async function startPublishInBackground() {
  h.setTime(TEN);
  await h.tick();
  const row = await h.db.outboxEvent.findFirstOrThrow({ where: { queue: Q.PublishStandard, publishedAt: null } });
  await h.db.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: h.clock.now() } });
  const running = handlePublish(h.browser, row.payload as { publicationId: string; jobVersion: number });
  return { running, payload: row.payload as { publicationId: string } };
}

async function waitForStatus(pubId: string, statuses: string[], ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const p = await h.db.publication.findUniqueOrThrow({ where: { id: pubId } });
    if (statuses.includes(p.status)) return p;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`publication never reached ${statuses.join('|')}`);
}

describe('fault injection (spec §12, plan phase 6)', () => {
  it('worker dies BEFORE COMMITTING → safe re-run, exactly one post', async () => {
    await readyPostForB1();
    let entered!: () => void;
    const dead = new Promise<void>((r) => (entered = r));
    h.platform.inject({ stage: 'prepare', action: { kind: 'hang', onEnter: entered }, match: 'fb-B1' });
    const { payload } = await startPublishInBackground();
    await dead;
    expect((await h.db.publication.findUniqueOrThrow({ where: { id: payload.publicationId } })).status).toBe('PREPARING');

    h.advance(4 * MIN); // lease (3') expired, still inside the 15' launch window
    const r = await h.tick();
    expect(r.leases.requeued).toBe(1);
    await h.drain();

    const [p] = await pubsOf(h, 'B1');
    expect(p.status).toBe('PUBLISHED_VERIFIED');
    expect(p.attempts.map((a) => a.outcome).sort()).toEqual(['ABANDONED', 'SUCCEEDED']);
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
  });

  it('worker dies AFTER pressing post → UNKNOWN → reconcile finds it, never re-posts', async () => {
    await readyPostForB1();
    let entered!: () => void;
    const dead = new Promise<void>((r) => (entered = r));
    h.platform.inject({ stage: 'commit.after', action: { kind: 'hang', onEnter: entered }, match: 'fb-B1' });
    const { payload } = await startPublishInBackground();
    await dead;
    await waitForStatus(payload.publicationId, ['COMMITTING']);
    expect(h.platform.timeline('fb-B1')).toHaveLength(1); // the post exists

    h.advance(4 * MIN);
    const r = await h.tick();
    expect(r.leases.unknown).toBe(1);
    expect((await pubsOf(h, 'B1'))[0].status).toBe('UNKNOWN');
    await h.drain();

    const [p] = await pubsOf(h, 'B1');
    expect(p.status).toBe('PUBLISHED_VERIFIED');
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
  });

  it('lease expires while the old worker is still alive → fencing blocks it', async () => {
    await readyPostForB1();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let entered!: () => void;
    const inPrepare = new Promise<void>((r) => (entered = r));
    h.platform.inject({ stage: 'prepare', action: { kind: 'gate', wait: gate, onEnter: entered }, match: 'fb-B1' });
    const { running } = await startPublishInBackground();
    await inPrepare; // old worker is now stalled inside prepare(), holding a draft

    h.advance(4 * MIN);
    await h.tick(); // requeue with a new job version
    await h.drain(); // the new worker publishes
    expect((await pubsOf(h, 'B1'))[0].status).toBe('PUBLISHED_VERIFIED');

    open(); // the stalled worker wakes up
    expect(await running).toBe('FENCED');
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
    expect((await pubsOf(h, 'B1'))[0].status).toBe('PUBLISHED_VERIFIED');
  });

  it('error right after commit → UNKNOWN, reconcile verifies, one post', async () => {
    await readyPostForB1();
    h.platform.inject({ stage: 'commit.after', action: { kind: 'throw', errorKind: 'TRANSIENT', sideEffectPossible: true }, match: 'fb-B1' });
    h.setTime(TEN);
    await cycle(h);
    expect((await pubsOf(h, 'B1'))[0].status).toBe('UNKNOWN');
    h.advance(3 * MIN);
    await h.drain();
    expect((await pubsOf(h, 'B1'))[0].status).toBe('PUBLISHED_VERIFIED');
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
  });

  it('UI said "posted" but nothing exists → stays UNKNOWN until conclusive, then republished once', async () => {
    await readyPostForB1();
    h.platform.inject({ stage: 'commit.after', action: { kind: 'dropPost' }, match: 'fb-B1' });
    h.setTime(TEN);
    await cycle(h);
    expect((await pubsOf(h, 'B1'))[0].status).toBe('UNKNOWN');
    for (let i = 0; i < 6; i++) {
      h.advance(2 * MIN + 1000);
      await h.workerHeartbeat();
      await h.drain();
    }
    expect((await pubsOf(h, 'B1'))[0].status).toBe('FAILED_CONFIRMED');
    expect(h.platform.timeline('fb-B1')).toHaveLength(0);

    h.setTime(ELEVEN);
    await cycle(h);
    const [p] = await pubsOf(h, 'B1');
    expect(p.status).toBe('PUBLISHED_VERIFIED');
    expect(p.publishTries).toBe(2);
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
  });

  it('scheduler running twice for the same hour creates no duplicate slots or posts', async () => {
    await readyPostForB1();
    h.setTime(TEN);
    await h.workerHeartbeat();
    await Promise.all([ensureSlots(h.core), ensureSlots(h.core)]);
    await Promise.all([dispatchDueSlots(h.core), dispatchDueSlots(h.core)]);
    await cycle(h);
    expect(await h.db.publicationSlot.count({ where: { slotAt: new Date('2026-11-20T03:00:00.000Z') } })).toBe(3);
    expect(await h.db.publication.count()).toBe(1);
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
  });

  it('album with a missing image never posts partially', async () => {
    await cycle(h);
    h.platform.inject({ stage: 'fetchMedia', action: { kind: 'throw', errorKind: 'TRANSIENT' }, match: 'A2-img-2', times: 10 });
    h.platform.addSourcePost('A2', { text: 'Album 3 ảnh', contentType: 'MULTI_PHOTO', media: [1, 2, 3].map((i) => ({ kind: 'image' as const, ref: `A2-img-${i}` })) });
    h.advance(5 * MIN);
    await cycle(h);
    h.advance(31_000);
    await h.drain();
    const v = await h.db.contentVariant.findFirstOrThrow({ where: { targetId: h.ids.targets.B2 } });
    expect(v.status).toBe('NEEDS_REVIEW');
    expect(v.reviewReasons).toContain('MEDIA_FETCH_FAILED');
    h.setTime(TEN);
    await cycle(h);
    expect(h.platform.timeline('fb-B2')).toHaveLength(0);
    const slot = await h.db.publicationSlot.findFirstOrThrow({ where: { targetId: h.ids.targets.B2 } });
    expect(slot.status).toBe('SKIPPED_NO_CONTENT');
  });

  it.each([
    ['checkpoint', (hh: Harness) => hh.platform.setSession('fb-B1', 'CHECKPOINT'), 'SESSION_CHECKPOINT'],
    ['logged out', (hh: Harness) => hh.platform.setSession('fb-B1', 'LOGGED_OUT'), 'SESSION_LOGGED_OUT'],
    ['wrong identity', (hh: Harness) => hh.platform.setLoggedInAs('fb-B1', 'fb-someone-else'), 'WRONG_IDENTITY'],
    ['audience mismatch', (hh: Harness) => hh.platform.inject({ stage: 'preview', action: { kind: 'audienceMismatch' } }), 'AUDIENCE_MISMATCH'],
  ])('%s → stop before commit, pause the account, hand over to an operator', async (_name, arrange, reason) => {
    await readyPostForB1();
    arrange(h);
    h.setTime(TEN);
    await cycle(h);
    const [p] = await pubsOf(h, 'B1');
    expect(p.status).toBe('CANCELLED');
    expect(p.lastReason).toContain(reason);
    expect(h.platform.timeline('fb-B1')).toHaveLength(0);
    const ctl = await h.db.control.findFirst({ where: { scope: 'TARGET', scopeKey: h.ids.targets.B1, paused: true } });
    expect(ctl).not.toBeNull();
    expect(await h.db.operatorTask.count({ where: { kind: 'TAKEOVER_ACCOUNT', targetId: h.ids.targets.B1, status: 'OPEN' } })).toBe(1);

    // next hour: account stays paused
    h.setTime(ELEVEN);
    await cycle(h);
    const slot = await h.db.publicationSlot.findFirstOrThrow({ where: { targetId: h.ids.targets.B1, slotAt: new Date('2026-11-20T04:00:00.000Z') } });
    expect(slot.status).toBe('DEFERRED');
    expect(slot.reason).toBe('KILL_SWITCH_TARGET');
  });

  it('long outage: missed hours are not replayed as a burst', async () => {
    await cycle(h);
    for (const n of [1, 2, 3]) h.platform.addSourcePost('A1', { text: `Tin ${n}`, contentType: 'TEXT', media: [] });
    h.advance(5 * MIN);
    await cycle(h);
    // no scheduler from 10:00 to 15:05
    h.setTime('2026-11-20T08:05:00.000Z');
    await cycle(h);
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
    expect(await h.db.publicationSlot.count({ where: { targetId: h.ids.targets.B1 } })).toBe(1);
  });

  it('dispatched job that starts after the launch window is MISSED and the content returns to backlog', async () => {
    await readyPostForB1();
    h.setTime(TEN);
    await h.tick(); // dispatch, but no worker picks it up
    h.setTime('2026-11-20T03:16:00.000Z');
    await h.tick();
    const [p] = await pubsOf(h, 'B1');
    expect(p.status).toBe('CANCELLED');
    expect((await h.db.publicationSlot.findFirstOrThrow({ where: { targetId: h.ids.targets.B1 } })).status).toBe('MISSED');
    await h.drain(); // the late job is now stale
    expect(h.platform.timeline('fb-B1')).toHaveLength(0);
    h.setTime(ELEVEN);
    await cycle(h);
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
  });

  it('global kill switch defers every slot; nothing is posted', async () => {
    await readyPostForB1();
    await setControl(h.db, 'GLOBAL', '*', true, 'test', 'drill');
    h.setTime(TEN);
    await cycle(h);
    expect(h.platform.timeline('fb-B1')).toHaveLength(0);
    const slots = await h.db.publicationSlot.findMany();
    expect(new Set(slots.map((s) => s.status))).toEqual(new Set(['DEFERRED']));
  });

  it('unreadable source is reported as an error, not as "no new posts"', async () => {
    await cycle(h);
    const before = await h.db.source.findUniqueOrThrow({ where: { id: h.ids.sources.A1 } });
    h.platform.ensureSource('A1', false);
    h.advance(5 * MIN);
    await cycle(h);
    const after = await h.db.source.findUniqueOrThrow({ where: { id: h.ids.sources.A1 } });
    expect(after.lastError).toContain('SOURCE_UNREADABLE');
    expect(after.watermark).toEqual(before.watermark);
    expect(after.lastSuccessAt?.getTime()).toBe(before.lastSuccessAt?.getTime());
  });

  it('LLM failures end in NEEDS_REVIEW instead of looping', async () => {
    await cycle(h);
    h.platform.addSourcePost('A3', { text: 'Bài lỗi [[llm:fail]]', contentType: 'TEXT', media: [] });
    h.advance(5 * MIN);
    await cycle(h);
    h.advance(31_000);
    await h.drain();
    const v = await h.db.contentVariant.findFirstOrThrow({ where: { targetId: h.ids.targets.B3 } });
    expect(v.status).toBe('NEEDS_REVIEW');
    expect(v.rewriteTries).toBe(2);
  });
});
