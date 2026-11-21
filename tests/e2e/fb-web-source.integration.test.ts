import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FbWebReadConnector } from '@seedingsys/connectors-fb-web';
import { createHarness, cycle, MIN, pubsOf, type Harness } from '../helpers/harness';
import { MockProfile } from '../helpers/mock-profile';

const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);

describe.skipIf(!BROWSER)('A1 (own profile, fb-web reader) → B1: full pipeline', () => {
  let h: Harness;
  let mock: MockProfile;
  let dir: string;

  beforeEach(async () => {
    h = await createHarness({ codes: [1] });
    mock = new MockProfile();
    await mock.start();
    dir = mkdtempSync(join(tmpdir(), 'fbsrc-int-'));
    h.browser.registry.addReader(
      new FbWebReadConnector({
        baseUrl: mock.baseUrl,
        profilesRoot: join(dir, 'profiles'),
        headless: true,
        channel: BROWSER!.includes('msedge') ? 'msedge' : undefined,
        executablePath: BROWSER!.includes('msedge') ? undefined : BROWSER,
        enabledFormats: [],
        stepTimeoutMs: 6000,
        uploadTimeoutMs: 10_000,
        now: () => h.clock.now(),
      }),
    );
    await h.db.source.updateMany({ where: { code: 'A1' }, data: { connector: 'fb-web', externalRef: mock.userId } });
  });
  afterEach(async () => {
    await mock.stop();
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('first sync is baseline only; a new own post is read, its photos downloaded, and published to B1 at the next hour', async () => {
    mock.posts = [{ id: 'pfbid0OLD', text: 'Bài cũ trước khi chạy hệ thống' }];
    await cycle(h); // baseline
    expect(await h.db.sourcePost.count({ where: { isBaseline: true } })).toBe(1);
    expect(await h.db.contentVariant.count()).toBe(0);

    mock.posts.unshift({ id: 'pfbid0NEW', text: 'Khai trương chi nhánh mới ngày 5/12, giảm 20%', photos: 2 });
    h.advance(5 * MIN);
    await cycle(h);
    const v = await h.db.contentVariant.findFirstOrThrow({ include: { revision: { include: { post: true } } } });
    expect(v.revision.post.externalId).toBe('pfbid0NEW');
    expect(v.contentType).toBe('MULTI_PHOTO');
    expect(v.status).toBe('READY');
    expect(mock.imageHits).toBeGreaterThanOrEqual(2);

    h.setTime('2026-11-20T03:00:10.000Z');
    await cycle(h);
    const [p] = await pubsOf(h, 'B1');
    expect(p.status).toBe('PUBLISHED_VERIFIED');
    expect(h.platform.timeline('fb-B1')[0].mediaChecksums).toHaveLength(2);
    expect(h.platform.timeline('fb-B1')[0].caption).toContain('5/12');
    expect(h.failures).toEqual([]);
  }, 180_000);

  it('a video post is held for review (the file cannot be taken from the page)', async () => {
    await cycle(h);
    mock.posts = [{ id: 'pfbid0VID', text: 'Video giới thiệu sản phẩm', video: true }];
    h.advance(5 * MIN);
    await cycle(h);
    const v = await h.db.contentVariant.findFirstOrThrow();
    expect(v.status).toBe('NEEDS_REVIEW');
  }, 180_000);
});
