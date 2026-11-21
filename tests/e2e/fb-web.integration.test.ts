import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FB_WEB_VERSION, FbWebPublishConnector } from '@seedingsys/connectors-fb-web';
import { createHarness, cycle, MIN, pubsOf, type Harness } from '../helpers/harness';
import { MockFb } from '../helpers/mock-fb';

const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const TEN = '2026-11-20T03:00:10.000Z';
const ELEVEN = '2026-11-20T04:00:10.000Z';

describe.skipIf(!BROWSER)('scheduler + publish handler with the real fb-web connector (mock Facebook UI)', () => {
  let h: Harness;
  let mock: MockFb;
  let dir: string;

  beforeEach(async () => {
    h = await createHarness({ codes: [1] });
    mock = new MockFb(() => h.clock.now().getTime());
    await mock.start();
    dir = mkdtempSync(join(tmpdir(), 'fbweb-int-'));
    h.browser.registry.addPublisher(
      new FbWebPublishConnector({
        baseUrl: mock.baseUrl,
        profilesRoot: join(dir, 'profiles'),
        headless: true,
        channel: BROWSER!.includes('msedge') ? 'msedge' : undefined,
        executablePath: BROWSER!.includes('msedge') ? undefined : BROWSER,
        enabledFormats: ['TEXT', 'MULTI_PHOTO'],
        stepTimeoutMs: 6000,
        uploadTimeoutMs: 15_000,
        now: () => h.clock.now(),
      }),
    );
    // Target B1 now publishes through fb-web, certified for TEXT and MULTI_PHOTO only.
    await h.db.targetAccount.updateMany({ data: { connector: 'fb-web', externalId: mock.userId } });
    await h.db.connectorRelease.create({ data: { connector: 'fb-web', version: FB_WEB_VERSION, active: true } });
    const t = await h.db.targetAccount.findFirstOrThrow();
    for (const ct of ['TEXT', 'MULTI_PHOTO'] as const) {
      await h.db.capabilityCheck.create({ data: { targetId: t.id, contentType: ct, connector: 'fb-web', connectorVersion: FB_WEB_VERSION, passed: true, cases: 20 } });
    }
  });
  afterEach(async () => {
    await mock.stop();
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function readyPost(text: string, media: number = 0) {
    await cycle(h); // baseline
    h.platform.addSourcePost('A1', {
      text,
      contentType: media > 1 ? 'MULTI_PHOTO' : 'TEXT',
      media: Array.from({ length: media }, (_, i) => ({ kind: 'image' as const, ref: `A1-img-${i + 1}` })),
    });
    h.advance(5 * MIN);
    await cycle(h);
    expect(await h.db.contentVariant.count({ where: { status: 'READY' } })).toBe(1);
  }

  it('publishes a text post and verifies it on the timeline', async () => {
    await readyPost('Ưu đãi giảm 30% đến hết 25/11, không áp dụng online');
    h.setTime(TEN);
    await cycle(h);
    const [p] = await pubsOf(h, 'B1');
    expect(p.status).toBe('PUBLISHED_VERIFIED');
    expect(p.permalink).toMatch(/\/posts\//);
    expect(mock.posts).toHaveLength(1);
    expect(mock.posts[0].audience).toBe('Chỉ mình tôi');
    expect(mock.posts[0].caption).toContain('30%');
    expect(p.attempts[0].connectorVersion).toBe(FB_WEB_VERSION);
    expect(h.failures).toEqual([]);
  });

  it('publishes a 3-photo album as one post', async () => {
    await readyPost('Album sự kiện cuối tuần', 3);
    h.setTime(TEN);
    await cycle(h);
    expect((await pubsOf(h, 'B1'))[0].status).toBe('PUBLISHED_VERIFIED');
    expect(mock.posts).toHaveLength(1);
    expect(mock.posts[0].media).toBe(3);
  });

  it('does not dispatch a format that has not passed its capability test', async () => {
    await h.db.capabilityCheck.deleteMany({ where: { contentType: 'TEXT' } });
    await readyPost('Bài chưa được chứng nhận');
    h.setTime(TEN);
    await cycle(h);
    expect(mock.posts).toHaveLength(0);
    expect(await h.db.publication.count()).toBe(0);
  });

  it('a checkpoint stops the account before anything is posted and opens a takeover task', async () => {
    await readyPost('Bài gặp checkpoint');
    mock.session = 'CHECKPOINT';
    h.setTime(TEN);
    await cycle(h);
    const [p] = await pubsOf(h, 'B1');
    expect(p.status).toBe('CANCELLED');
    expect(p.lastReason).toContain('CHECKPOINT');
    expect(mock.posts).toHaveLength(0);
    expect(await h.db.operatorTask.count({ where: { kind: 'TAKEOVER_ACCOUNT', status: 'OPEN' } })).toBe(1);
    expect(await h.db.control.count({ where: { scope: 'TARGET', paused: true } })).toBe(1);
  });

  it('wrong logged-in account → stops, nothing posted', async () => {
    await readyPost('Sai tài khoản');
    mock.userId = '555000999';
    h.setTime(TEN);
    await cycle(h);
    expect((await pubsOf(h, 'B1'))[0].lastReason).toContain('WRONG_IDENTITY');
    expect(mock.posts).toHaveLength(0);
  });

  it('composer shows the wrong audience → stops before committing', async () => {
    await readyPost('Sai đối tượng');
    mock.defaultAudience = 'Công khai';
    mock.audienceLocked = true;
    h.setTime(TEN);
    await cycle(h);
    const [p] = await pubsOf(h, 'B1');
    expect(p.status).toBe('CANCELLED');
    expect(p.lastReason).toBe('AUDIENCE_MISMATCH');
    expect(mock.posts).toHaveLength(0);
  });

  it('UI said "posted" but nothing exists: stays UNKNOWN, becomes FAILED_CONFIRMED only after a conclusive scan, then posts exactly once', async () => {
    await readyPost('Bài bị nuốt');
    mock.addPost({ caption: 'Bài cũ trên trang', at: h.clock.now().getTime() - 5 * 3600_000 }); // proves the scan reaches past the window
    mock.postMode = 'drop';
    h.setTime(TEN);
    await cycle(h);
    expect((await pubsOf(h, 'B1'))[0].status).toBe('UNKNOWN');
    expect(mock.posts.filter((p) => p.caption.includes('nuốt'))).toHaveLength(0);

    for (let i = 0; i < 8; i++) {
      h.advance(2 * MIN + 1000);
      await h.workerHeartbeat();
      await h.drain();
    }
    expect((await pubsOf(h, 'B1'))[0].status).toBe('FAILED_CONFIRMED');

    mock.postMode = 'normal';
    h.setTime(ELEVEN);
    await cycle(h);
    const [p] = await pubsOf(h, 'B1');
    expect(p.status).toBe('PUBLISHED_VERIFIED');
    expect(p.publishTries).toBe(2);
    expect(mock.posts.filter((x) => x.caption.includes('nuốt'))).toHaveLength(1);
  }, 120_000);

  it('composer that never closes after Post → UNKNOWN → reconcile finds the real post, no duplicate', async () => {
    await readyPost('Bài đã đăng nhưng giao diện treo');
    // The post goes through but the dialog stays open (as if the UI hung after the click).
    const orig = mock.postMode;
    mock.postMode = 'noclose';
    h.setTime(TEN);
    const run = cycle(h);
    // 'noclose' mode in the mock stores nothing; emulate "stored but UI hung" by adding the post ourselves.
    mock.addPost({ caption: ['[B1]', '', 'Bài đã đăng nhưng giao diện treo', '', '(Nguồn: Nguồn A1)'].join('\n') });
    await run;
    mock.postMode = orig;
    const [p] = await pubsOf(h, 'B1');
    expect(['UNKNOWN', 'PUBLISHED_VERIFIED']).toContain(p.status);
    for (let i = 0; i < 4 && (await pubsOf(h, 'B1'))[0].status !== 'PUBLISHED_VERIFIED'; i++) {
      h.advance(2 * MIN + 1000);
      await h.workerHeartbeat();
      await h.drain();
    }
    expect((await pubsOf(h, 'B1'))[0].status).toBe('PUBLISHED_VERIFIED');
    expect(mock.posts).toHaveLength(1);
  }, 120_000);
});
