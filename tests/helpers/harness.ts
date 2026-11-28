import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { inject } from 'vitest';
import { ConnectorRegistry } from '@seedingsys/connectors-core';
import { FakePlatform, FakePublishConnector, FakeReadConnector } from '@seedingsys/connectors-fake';
import { Q, type QueueName } from '@seedingsys/contracts';
import { createDb, type Db } from '@seedingsys/db';
import { ManualClock, RetryLaterError } from '@seedingsys/domain';
import { FakeEditor, LlmGateway } from '@seedingsys/llm';
import { createLogger } from '@seedingsys/observability';
import { LocalStore } from '@seedingsys/storage';
import { handleContentRewrite, handleContentValidate, schedulerTick, type CoreCtx } from '../../apps/worker-core/src';
import { DEFAULT_BROWSER_SETTINGS, handleAgentRecover, handlePublish, handleReconcile, handleSourcePoll, type BrowserCtx } from '../../apps/worker-browser/src';
import { handleCommentScan } from '../../apps/worker-browser/src/handlers/comment-scan';
import { handleSourceProfileScan } from '../../apps/worker-browser/src/handlers/source-profile-scan';
import { handleAssetFetch, type MediaCtx } from '../../apps/worker-media/src';

export const MIN = 60_000;

export interface Harness {
  db: Db;
  clock: ManualClock;
  platform: FakePlatform;
  editor: FakeEditor;
  core: CoreCtx;
  browser: BrowserCtx;
  media: MediaCtx;
  ids: { sources: Record<string, string>; targets: Record<string, string> };
  failures: Array<{ queue: string; payload: unknown; error: string }>;
  tick(): Promise<Awaited<ReturnType<typeof schedulerTick>>>;
  drain(opts?: { maxRounds?: number; skip?: QueueName[] }): Promise<Record<string, number>>;
  advance(ms: number): void;
  setTime(iso: string): void;
  workerHeartbeat(): Promise<void>;
  close(): Promise<void>;
}

/** 09:50 Asia/Ho_Chi_Minh on 2026-11-20 (02:50Z). */
export const T0 = '2026-11-20T02:50:00.000Z';

export async function createHarness(opts: { codes?: number[]; start?: string } = {}): Promise<Harness> {
  const adminUrl = inject('pgAdminUrl');
  const name = `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new Client({ connectionString: `${adminUrl}/postgres` });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${inject('pgTemplate')}`);
  await admin.end();

  const db = createDb(`${adminUrl}/${name}?connection_limit=5`);
  const clock = new ManualClock(new Date(opts.start ?? T0));
  const platform = new FakePlatform({ now: () => clock.now() });
  const registry = new ConnectorRegistry().addReader(new FakeReadConnector(platform)).addPublisher(new FakePublishConnector(platform));
  const storeDir = mkdtempSync(join(tmpdir(), 'seedingsys-store-'));
  const store = new LocalStore(storeDir);
  const log = createLogger('test', 'silent');
  const editor = new FakeEditor();
  const llm = new LlmGateway(db, editor, clock, { dailyBudgetUsd: 5, maxConcurrency: 2 });

  const core: CoreCtx = { db, clock, log, actor: 'test-core', llm, allowImplicitSlots: true };
  const browser: BrowserCtx = {
    db,
    clock,
    log,
    workerId: 'test-browser-1',
    actor: 'test-browser',
    registry,
    store,
    tmpDir: join(storeDir, 'tmp'),
    ...DEFAULT_BROWSER_SETTINGS,
    // Real-time timeouts are long so a "hung" step behaves like a dead worker in tests.
    timeouts: { stepMs: 3_600_000, commitMs: 3_600_000, videoMs: 3_600_000 },
  };
  const media: MediaCtx = { db, clock, log, actor: 'test-media', registry, store, maxFetchAttempts: 2 };

  // ── seed: A1..A5 → B1..B5 ──
  const codes = opts.codes ?? [1, 2, 3, 4, 5];
  const node = await db.workerNode.create({ data: { name: 'browser:test', kind: 'BROWSER', lastHeartbeatAt: clock.now() } });
  await db.connectorRelease.create({ data: { connector: 'fake', version: 'fake-1.0.0', active: true } });
  const ids = { sources: {} as Record<string, string>, targets: {} as Record<string, string> };
  for (const i of codes) {
    const s = await db.source.create({ data: { code: `A${i}`, name: `Nguồn A${i}`, externalRef: `A${i}`, connector: 'fake' } });
    const t = await db.targetAccount.create({
      data: { code: `B${i}`, name: `Tài khoản B${i}`, externalId: `fb-B${i}`, connector: 'fake', audience: 'ONLY_ME', styleProfile: { prefix: `[B${i}]` } },
    });
    await db.sourceTargetMapping.create({ data: { sourceId: s.id, targetId: t.id } });
    await db.browserProfile.create({ data: { targetId: t.id, workerNodeId: node.id, profileDir: `/profiles/B${i}` } });
    platform.ensureSource(`A${i}`);
    platform.ensureAccount(`fb-B${i}`);
    ids.sources[`A${i}`] = s.id;
    ids.targets[`B${i}`] = t.id;
  }

  const failures: Harness['failures'] = [];
  const retries = new Map<string, number>();

  const handlers: Record<string, (p: any) => Promise<unknown>> = {
    [Q.SchedulerTick]: () => schedulerTick(core),
    [Q.SourcePoll]: (p) => handleSourcePoll(browser, p),
    [Q.SourceProfileScan]: (p) => handleSourceProfileScan(browser, p),
    [Q.CommentScan]: (p) => handleCommentScan(browser, p),
    [Q.AssetFetch]: (p) => handleAssetFetch(media, p),
    [Q.ContentRewrite]: (p) => handleContentRewrite(core, p),
    [Q.ContentValidate]: (p) => handleContentValidate(core, p),
    [Q.PublishStandard]: (p) => handlePublish(browser, p),
    [Q.PublishAlbum]: (p) => handlePublish(browser, p),
    [Q.PublishVideo]: (p) => handlePublish(browser, p),
    [Q.PublishVerify]: (p) => handleReconcile(browser, p),
    [Q.PublishReconcile]: (p) => handleReconcile(browser, p),
    [Q.AgentRecover]: (p) => handleAgentRecover(browser, p),
  };

  /** In-process stand-in for relay + pg-boss: run due outbox events until quiet. */
  const drain: Harness['drain'] = async ({ maxRounds = 50, skip = [] } = {}) => {
    const counts: Record<string, number> = {};
    for (let round = 0; round < maxRounds; round++) {
      const now = clock.now();
      const rows = await db.outboxEvent.findMany({
        where: { publishedAt: null, queue: { notIn: skip }, OR: [{ startAfter: null }, { startAfter: { lte: now } }] },
        orderBy: { id: 'asc' },
      });
      if (!rows.length) return counts;
      for (const r of rows) {
        await db.outboxEvent.update({ where: { id: r.id }, data: { publishedAt: now } });
        counts[r.queue] = (counts[r.queue] ?? 0) + 1;
        try {
          await handlers[r.queue](r.payload);
        } catch (e) {
          const key = `${r.queue}:${JSON.stringify(r.payload)}`;
          const n = (retries.get(key) ?? 0) + 1;
          retries.set(key, n);
          if (!(e instanceof RetryLaterError)) failures.push({ queue: r.queue, payload: r.payload, error: String((e as Error).message) });
          if (n <= 3) {
            await db.outboxEvent.create({ data: { queue: r.queue, payload: r.payload as object, startAfter: new Date(now.getTime() + 30_000) } });
          }
        }
      }
    }
    return counts;
  };

  const workerHeartbeat = async () => {
    await db.workerNode.update({ where: { id: node.id }, data: { lastHeartbeatAt: clock.now() } });
  };

  return {
    db,
    clock,
    platform,
    editor,
    core,
    browser,
    media,
    ids,
    failures,
    async tick() {
      await workerHeartbeat();
      return schedulerTick(core);
    },
    drain,
    advance: (ms) => clock.advance(ms),
    setTime: (iso) => clock.set(iso),
    workerHeartbeat,
    async close() {
      await db.$disconnect();
      const a = new Client({ connectionString: `${adminUrl}/postgres` });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
      rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

/** Run one full cycle: scheduler tick, then process everything that became due. */
export async function cycle(h: Harness) {
  const t = await h.tick();
  const d = await h.drain();
  return { tick: t, drained: d };
}

export async function pubsOf(h: Harness, target: string) {
  return h.db.publication.findMany({ where: { targetId: h.ids.targets[target] }, orderBy: { createdAt: 'asc' }, include: { attempts: true } });
}
