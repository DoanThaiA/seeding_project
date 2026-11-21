import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FbWebReadConnector, profileKey, type FbWebOptions } from '@seedingsys/connectors-fb-web';
import { MockProfile } from '../helpers/mock-profile';

const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);

describe('profileKey', () => {
  it('normalises ids, vanity names and profile links', () => {
    expect(profileKey('100094351016079')).toBe('100094351016079');
    expect(profileKey('https://www.facebook.com/profile.php?id=100094351016079')).toBe('100094351016079');
    expect(profileKey('https://www.facebook.com/Ten.Nguoi.Dung/')).toBe('ten.nguoi.dung');
    expect(profileKey('@Ten.Nguoi.Dung')).toBe('ten.nguoi.dung');
  });
});

describe.skipIf(!BROWSER)('fb-web reader: the logged-in account’s OWN profile (mock)', () => {
  let mock: MockProfile;
  let dir: string;
  let reader: FbWebReadConnector;
  const source = (ref = '100094351016079') => ({ id: 's1', code: 'A1', externalRef: ref });

  beforeAll(async () => {
    mock = new MockProfile();
    await mock.start();
    dir = mkdtempSync(join(tmpdir(), 'fbread-test-'));
    const opts: FbWebOptions = {
      baseUrl: mock.baseUrl,
      profilesRoot: join(dir, 'profiles'),
      headless: true,
      channel: BROWSER!.includes('msedge') ? 'msedge' : undefined,
      executablePath: BROWSER!.includes('msedge') ? undefined : BROWSER,
      enabledFormats: [],
      stepTimeoutMs: 6000,
      uploadTimeoutMs: 10_000,
    };
    reader = new FbWebReadConnector(opts, 10);
  });
  afterAll(async () => {
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    Object.assign(mock, { session: 'OK', userId: '100094351016079', posts: [] });
  });

  it('refuses when the profile is not logged in, or is at a checkpoint (never tries to pass it)', async () => {
    mock.session = 'LOGGED_OUT';
    await expect(reader.readSince(source(), null, 5)).rejects.toMatchObject({ kind: 'SOURCE_UNREADABLE', message: expect.stringContaining('fb:login A1') });
    mock.session = 'CHECKPOINT';
    await expect(reader.readSince(source(), null, 5)).rejects.toMatchObject({ kind: 'SOURCE_UNREADABLE', message: expect.stringContaining('xác minh') });
  });

  it('refuses to read when the logged-in account is not the configured source', async () => {
    await expect(reader.readSince(source('999999'), null, 5)).rejects.toMatchObject({ kind: 'SOURCE_UNREADABLE', message: expect.stringContaining('chính tài khoản') });
  });

  it('reads own posts: full caption (expands "Xem thêm"), stable id from the hovered timestamp, photos', async () => {
    const long = 'Ưu đãi tháng 12: giảm 25% cho mọi đơn hàng từ 500.000đ, áp dụng tới hết 31/12, không áp dụng cùng chương trình khác. Liên hệ để biết thêm.';
    mock.posts = [
      { id: 'pfbid0AAA', text: long, timeText: '5 phút' },
      { id: 'pfbid0BBB', text: 'Album sự kiện', photos: 3 },
      { id: 'pfbid0CCC', text: 'Một ảnh', photos: 1 },
    ];
    const r = await reader.readSince(source(), null, 5);
    const byId = Object.fromEntries(r.posts.map((p) => [p.externalId, p]));
    expect(Object.keys(byId).sort()).toEqual(['pfbid0AAA', 'pfbid0BBB', 'pfbid0CCC']);
    expect(byId.pfbid0AAA).toMatchObject({ text: long, contentType: 'TEXT', identityConfidence: 'HIGH', incomplete: [] });
    expect(byId.pfbid0AAA.permalink).toContain('/posts/pfbid0AAA');
    expect(byId.pfbid0AAA.postedAt).toBeInstanceOf(Date);
    expect(byId.pfbid0BBB).toMatchObject({ contentType: 'MULTI_PHOTO' });
    expect(byId.pfbid0BBB.media).toHaveLength(3);
    expect(byId.pfbid0CCC).toMatchObject({ contentType: 'SINGLE_PHOTO' });

    const img = await reader.fetchMedia(byId.pfbid0BBB.media[0]);
    expect(img.mime).toBe('image/png');
    expect(img.bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  }, 60_000);

  it('skips posts written by other people on the timeline', async () => {
    mock.posts = [
      { id: 'pfbid0OWN', text: 'Bài của chủ trang' },
      { id: 'pfbid0FRIEND', text: 'Chúc mừng sinh nhật!', author: 'Bạn Bè Khác' },
    ];
    const r = await reader.readSince(source(), null, 5);
    expect(r.posts.map((p) => p.externalId)).toEqual(['pfbid0OWN']);
  }, 60_000);

  it('flags what it cannot get completely instead of guessing', async () => {
    mock.posts = [
      { id: 'pfbid0BIG', text: 'Album lớn', photos: 4, more: 6 },
      { id: 'pfbid0VID', text: 'Video giới thiệu', video: true },
    ];
    const r = await reader.readSince(source(), null, 5);
    const byId = Object.fromEntries(r.posts.map((p) => [p.externalId, p]));
    expect(byId.pfbid0BIG.incomplete).toContain('MEDIA_COUNT_UNKNOWN');
    expect(byId.pfbid0VID).toMatchObject({ contentType: 'VIDEO', media: [] });
    expect(byId.pfbid0VID.incomplete).toContain('MEDIA_UNAVAILABLE');
  }, 60_000);
});
