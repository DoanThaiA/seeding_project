import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConnectorError, type MediaFile, type PublishSession } from '@seedingsys/connectors-core';
import { FbWebPublishConnector, parseViTime, runCapability, type FbWebOptions } from '@seedingsys/connectors-fb-web';
import type { ContentType, PublishSnapshot } from '@seedingsys/contracts';
import { captionFingerprint } from '@seedingsys/domain';
import { MockFb } from '../helpers/mock-fb';

const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('parseViTime', () => {
  const now = new Date('2026-11-20T05:00:00Z'); // 12:00 in Vietnam
  it('reads the common relative forms', () => {
    expect(parseViTime('Vừa xong', now)?.at.getTime()).toBe(now.getTime());
    expect(parseViTime('5 phút', now)?.at.toISOString()).toBe('2026-11-20T04:55:00.000Z');
    expect(parseViTime('2 giờ', now)).toMatchObject({ tolMs: 3600_000 });
    expect(parseViTime('Hôm qua lúc 21:04', now)?.at.toISOString()).toBe('2026-11-19T14:04:00.000Z');
    expect(parseViTime('18 tháng 11 lúc 09:15', now)?.at.toISOString()).toBe('2026-11-18T02:15:00.000Z');
  });
  it('returns null for anything it does not understand', () => {
    expect(parseViTime('Thứ Hai', now)).toBeNull();
    expect(parseViTime('', now)).toBeNull();
  });
});

describe.skipIf(!BROWSER)('fb-web connector against the mock Facebook UI', () => {
  let mock: MockFb;
  let dir: string;
  let files: string[];
  let opts: FbWebOptions;
  let connector: FbWebPublishConnector;
  const target = { id: 't1', code: 'B1', externalId: '100012345', audience: 'ONLY_ME', uiLocale: 'vi-VN', profileDir: '/profiles/B1' };

  beforeAll(async () => {
    mock = new MockFb();
    await mock.start();
    dir = mkdtempSync(join(tmpdir(), 'fbweb-test-'));
    files = [1, 2, 3].map((i) => {
      const f = join(dir, `img${i}.png`);
      writeFileSync(f, Buffer.concat([PNG, Buffer.from([i])]));
      return f;
    });
    opts = {
      baseUrl: mock.baseUrl,
      profilesRoot: join(dir, 'profiles'),
      headless: true,
      channel: BROWSER!.includes('msedge') ? 'msedge' : undefined,
      executablePath: BROWSER!.includes('msedge') ? undefined : BROWSER,
      enabledFormats: ['TEXT', 'SINGLE_PHOTO', 'MULTI_PHOTO'],
      stepTimeoutMs: 6000,
      uploadTimeoutMs: 15_000,
      verifyMode: 'strict',
    };
    connector = new FbWebPublishConnector(opts);
  });
  afterAll(async () => {
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    Object.assign(mock, { session: 'OK', vanity: null, defaultAudience: 'Chỉ mình tôi', audienceLocked: false, mangleCaption: false, reelViaMenu: false, pfbidCommentLinks: false, postMode: 'normal', toast: true, posts: [] });
  });

  const withSession = async <T>(fn: (s: PublishSession) => Promise<T>): Promise<T> => {
    const s = await connector.openSession(target);
    try {
      return await fn(s);
    } finally {
      await s.close();
    }
  };
  const media = (n: number): MediaFile[] => files.slice(0, n).map((f, i) => ({ position: i, checksum: `sum${i}`, mime: 'image/png', kind: 'image', location: f }));
  const snap = (caption: string, n = 0, over: Partial<PublishSnapshot> = {}): PublishSnapshot => ({
    variantId: 'v1',
    targetId: 't1',
    contentType: (n === 0 ? 'TEXT' : n === 1 ? 'SINGLE_PHOTO' : 'MULTI_PHOTO') as ContentType,
    caption,
    audience: 'ONLY_ME',
    media: media(n).map((m) => ({ position: m.position, assetId: `a${m.position}`, checksum: m.checksum, objectKey: 'k', mime: m.mime, kind: m.kind })),
    ...over,
  });
  const hint = (caption: string, mediaCount = 0) => ({ captionFingerprint: captionFingerprint(caption), caption, mediaCount, committedAt: new Date(), windowMs: 30 * 60_000 });
  const expectation = (c: string, n = 0, audience = 'ONLY_ME') => ({ caption: c, mediaCount: n, mediaChecksums: media(n).map((m) => m.checksum), audience });

  it('advertises only the formats it was explicitly given (fail closed)', () => {
    expect(new FbWebPublishConnector({ ...opts, enabledFormats: [] }).capabilities(target)).toMatchObject({ TEXT: false, VIDEO: false, MULTI_PHOTO: false });
    expect(connector.capabilities(target)).toMatchObject({ TEXT: true, SINGLE_PHOTO: true, MULTI_PHOTO: true, VIDEO: false });
    expect(connector.capabilities(target)).not.toHaveProperty('NAMED_ALBUM');
  });

  it('reports logged-out and checkpoint states without trying to get past them', async () => {
    expect(await withSession((s) => s.sessionState())).toBe('OK');
    mock.session = 'LOGGED_OUT';
    expect(await withSession((s) => s.sessionState())).toBe('LOGGED_OUT');
    mock.session = 'CHECKPOINT';
    expect(await withSession((s) => s.sessionState())).toBe('CHECKPOINT');
    await expect(withSession((s) => s.prepare(snap('x'), []))).rejects.toMatchObject({ kind: 'CHECKPOINT' });
  });

  it('checks identity by numeric id or vanity name and rejects a different account', async () => {
    expect(await withSession((s) => s.checkIdentity('100012345'))).toMatchObject({ ok: true });
    expect(await withSession((s) => s.checkIdentity('999'))).toMatchObject({ ok: false, observed: '100012345' });
    mock.vanity = 'tester.vn';
    expect(await withSession((s) => s.checkIdentity('Tester.VN'))).toMatchObject({ ok: true });
    mock.session = 'LOGGED_OUT';
    expect(await withSession((s) => s.checkIdentity('100012345'))).toMatchObject({ ok: false, observed: 'logged_out' });
  });

  it('prepare + preview never publish; commit publishes once; verify finds exactly that post', async () => {
    const caption = 'Giảm 30% đến 25/11.\nKhông áp dụng online.';
    await withSession(async (s) => {
      const d = await s.prepare(snap(caption), []);
      expect(mock.posts).toHaveLength(0); // nothing posted yet
      const pv = await s.previewCheck(d, expectation(caption));
      expect(pv).toMatchObject({ ok: true, audienceOk: true, problems: [] });
      expect(mock.posts).toHaveLength(0);
      const sig = await s.commit(d);
      expect(mock.posts).toHaveLength(1);
      expect(sig.permalink).toMatch(/\/posts\/p1$/);
      const v = await s.verify(hint(caption));
      expect(v).toMatchObject({ kind: 'VERIFIED' });
      if (v.kind === 'VERIFIED') expect(v.permalink).toMatch(/\/posts\/p1$/);
    });
    expect(mock.posts[0].caption.replace(/\s+/g, ' ')).toBe(caption.replace(/\s+/g, ' '));
  });

  it('works without a confirmation toast (verify finds the post on the timeline)', async () => {
    mock.toast = false;
    await withSession(async (s) => {
      const d = await s.prepare(snap('Không có toast'), []);
      expect((await s.commit(d)).permalink).toBeUndefined();
      expect(await s.verify(hint('Không có toast'))).toMatchObject({ kind: 'VERIFIED' });
    });
  });

  it.each([false, true])('opens the Reel composer (menu-only: %s), verifies audience and publishes a Reel', async reelViaMenu => {
    const path = join(dir, 'reel.mp4');
    writeFileSync(path, Buffer.from('mock video'));
    const video = { position: 0, checksum: 'reel', mime: 'video/mp4', kind: 'video', location: path };
    const caption = 'Một thước phim có mô tả';
    mock.defaultAudience = 'Công khai';
    mock.reelViaMenu = reelViaMenu;
    mock.toast = !reelViaMenu;
    await withSession(async s => {
      const draft = await s.prepare(snap(caption, 0, { contentType: 'REEL' }), [video]);
      expect(mock.posts).toHaveLength(0);
      expect(await s.previewCheck(draft, expectation(caption, 1))).toMatchObject({ ok: true, audienceOk: true });
      expect(mock.posts).toHaveLength(0);
      const signal = await s.commit(draft);
      expect(mock.posts).toMatchObject([{ reel: true, video: true, audience: 'Chỉ mình tôi' }]);
      if (reelViaMenu) expect(signal.permalink).toBeUndefined();
      else expect(signal.permalink).toContain('/reel/');
      mock.posts[0].hiddenTime = true;
      expect(await s.verify({ ...hint(caption, 1), contentType: 'REEL', commitSignal: signal })).toMatchObject({
        kind: 'VERIFIED', permalink: `${mock.baseUrl}/reel/${mock.posts[0].id}`,
      });
    });
  });

  it.each(['Công khai', 'Chỉ mình tôi'])('publishes a public Reel when the settings chip carries a description (default: %s)', async start => {
    const path = join(dir, 'reel-public.mp4');
    writeFileSync(path, Buffer.from('mock video'));
    const video = { position: 0, checksum: 'reel', mime: 'video/mp4', kind: 'video', location: path };
    const caption = 'Thước phim công khai';
    mock.defaultAudience = start;
    mock.reelViaMenu = true;
    mock.toast = false;
    await withSession(async s => {
      const draft = await s.prepare(snap(caption, 0, { contentType: 'REEL', audience: 'PUBLIC' }), [video]);
      expect(await s.previewCheck(draft, expectation(caption, 1, 'PUBLIC'))).toMatchObject({ ok: true, audienceOk: true });
      await s.commit(draft);
      expect(mock.posts).toMatchObject([{ reel: true, video: true, audience: 'Công khai' }]);
    });
  });

  it('sends a comment and then replies to its verified permalink', async () => {
    const post = mock.addPost({ caption: 'Bài để thử bình luận' });
    const destination = new URL('/posts/' + post.id, mock.baseUrl);
    await withSession(async s => {
      await expect(s.postComment!({ post: destination, text: 'Chưa được phép gửi' }, async () => { throw new Error('stopped'); })).rejects.toThrow('stopped');
      expect(mock.comments.filter(c => c.postId === post.id)).toHaveLength(0);
      const root = await s.postComment!({ post: destination, text: 'Bình luận gốc' }, async () => {});
      expect(root?.permalink).toContain('comment_id=' + root?.externalId);
      const reply = await s.postComment!({ post: new URL(root!.permalink), parentId: root!.externalId, text: 'Phản hồi đúng nhánh' }, async () => {});
      expect(reply?.permalink).toContain('comment_id=' + root?.externalId + '&reply_comment_id=');
      expect(mock.comments.filter(c => c.postId === post.id)).toMatchObject([
        { text: 'Bình luận gốc' }, { text: 'Phản hồi đúng nhánh', parentId: root?.externalId },
      ]);
    });
  });

  it('confirms comments whose links use a pfbid post id, and stores them on the destination URL', async () => {
    const post = mock.addPost({ caption: 'Bài có link bình luận pfbid' });
    mock.pfbidCommentLinks = true;
    const destination = new URL('/posts/' + post.id, mock.baseUrl);
    await withSession(async s => {
      const root = await s.postComment!({ post: destination, text: 'Trích bình luận gốc của A · https://x.test/a\n\nNội dung gốc' }, async () => {});
      expect(root?.permalink).toBe(`${mock.baseUrl}/posts/${post.id}?comment_id=${root?.externalId}`);
      const reply = await s.postComment!({ post: new URL(root!.permalink), parentId: root!.externalId, text: 'Phản hồi pfbid' }, async () => {});
      expect(reply?.permalink).toBe(`${mock.baseUrl}/posts/${post.id}?comment_id=${root?.externalId}&reply_comment_id=${reply?.externalId}`);
    });
  });

  it('switches the composer audience when needed, and refuses to commit-ready if it cannot', async () => {
    mock.defaultAudience = 'Bạn bè';
    await withSession(async (s) => {
      const d = await s.prepare(snap('Đổi đối tượng'), []);
      expect(await s.previewCheck(d, expectation('Đổi đối tượng'))).toMatchObject({ ok: true, audienceOk: true });
      await s.discardDraft(d);
    });
    mock.audienceLocked = true;
    await withSession(async (s) => {
      const d = await s.prepare(snap('Khóa đối tượng'), []);
      const pv = await s.previewCheck(d, expectation('Khóa đối tượng'));
      expect(pv.audienceOk).toBe(false);
      expect(pv.ok).toBe(false);
      await s.discardDraft(d);
    });
    expect(mock.posts).toHaveLength(0);
  });

  it('preview catches a caption that the editor altered', async () => {
    mock.mangleCaption = false; // the editor is fine, but the expectation differs
    await withSession(async (s) => {
      const d = await s.prepare(snap('Nội dung A'), []);
      const pv = await s.previewCheck(d, expectation('Nội dung B'));
      expect(pv.ok).toBe(false);
      expect(pv.problems).toContain('caption mismatch');
      await s.discardDraft(d);
    });
  });

  it('posts several photos as ONE post and verifies the photo count', async () => {
    await withSession(async (s) => {
      const d = await s.prepare(snap('Album 3 ảnh', 3), media(3));
      expect(await s.previewCheck(d, expectation('Album 3 ảnh', 3))).toMatchObject({ ok: true });
      await s.commit(d);
      expect(mock.posts).toHaveLength(1);
      expect(mock.posts[0].media).toBe(3);
      expect(await s.verify(hint('Album 3 ảnh', 3))).toMatchObject({ kind: 'VERIFIED' });
      // a post with a different photo count must not be accepted as ours
      expect((await s.verify(hint('Album 3 ảnh', 2))).kind).toBe('NOT_FOUND');
    });
  });

  it('counts more than 5 photos the way Facebook shows them (5 tiles, "+N" on the 5th)', async () => {
    const six = [1, 2, 3, 4, 5, 6].map(i => {
      const f = join(dir, `six${i}.png`);
      writeFileSync(f, Buffer.concat([PNG, Buffer.from([40 + i])]));
      return { position: i - 1, checksum: `six${i}`, mime: 'image/png', kind: 'image', location: f } as MediaFile;
    });
    await withSession(async (s) => {
      const d = await s.prepare(snap('Album 6 ảnh', 2), six);
      expect(await s.previewCheck(d, expectation('Album 6 ảnh', 6))).toMatchObject({ ok: true });
      await s.discardDraft(d);
    });
  });

  it('preview reports a wrong photo count', async () => {
    await withSession(async (s) => {
      const d = await s.prepare(snap('Chỉ 2 ảnh', 2), media(2));
      const pv = await s.previewCheck(d, expectation('Chỉ 2 ảnh', 3));
      expect(pv.ok).toBe(false);
      expect(pv.problems.join()).toContain('media count');
      await s.discardDraft(d);
    });
  });

  it('absence is conclusive only after scanning past the commit time with readable timestamps', async () => {
    await withSession(async (s) => {
      // empty timeline: cannot conclude
      expect(await s.verify(hint('Bài chưa đăng'))).toMatchObject({ kind: 'NOT_FOUND', conclusive: false });
      // an old, readable post proves we looked far enough back
      mock.addPost({ caption: 'Bài cũ', at: Date.now() - 3 * 3600_000 });
      expect(await s.verify(hint('Bài chưa đăng'))).toMatchObject({ kind: 'NOT_FOUND', conclusive: true });
      // an unreadable timestamp → back to inconclusive
      mock.addPost({ caption: 'Lạ', timeText: 'Thứ Hai' });
      expect(await s.verify(hint('Bài chưa đăng'))).toMatchObject({ kind: 'NOT_FOUND', conclusive: false });
    });
  });

  it('two identical recent posts are ambiguous, never "verified"', async () => {
    mock.addPost({ caption: 'Trùng lặp' });
    mock.addPost({ caption: 'Trùng lặp' });
    expect(await withSession((s) => s.verify(hint('Trùng lặp')))).toMatchObject({ kind: 'AMBIGUOUS', matches: 2 });
  });

  it('a composer that never closes after Post is reported as a possible side effect', async () => {
    mock.postMode = 'noclose';
    await withSession(async (s) => {
      const d = await s.prepare(snap('Không đóng'), []);
      const err = await s.commit(d).then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).sideEffectPossible).toBe(true);
    });
  }, 40_000);

  it('rejects named albums and Reel drafts without a video file', async () => {
    for (const ct of ['NAMED_ALBUM', 'REEL'] as ContentType[]) {
      await expect(withSession((s) => s.prepare(snap('x', 0, { contentType: ct }), []))).rejects.toMatchObject({ kind: 'UNSUPPORTED' });
    }
  });

  it('a missing composer is a safe pre-commit UI error', async () => {
    const broken = new FbWebPublishConnector({ ...opts, baseUrl: `${mock.baseUrl}/profile.php` });
    const s = await broken.openSession(target);
    try {
      await expect(s.prepare(snap('x'), [])).rejects.toMatchObject({ kind: 'UI_UNEXPECTED', sideEffectPossible: false });
    } finally {
      await s.close();
    }
  }, 40_000);
});

describe.skipIf(!BROWSER)('verify modes (caption = default, off)', () => {
  let mock: MockFb;
  let dir: string;
  const target = { id: 't1', code: 'B1', externalId: '100012345', audience: 'ONLY_ME', uiLocale: 'vi-VN', profileDir: '/profiles/B1' };
  const mk = (verifyMode: 'caption' | 'off') =>
    new FbWebPublishConnector({
      baseUrl: mock.baseUrl,
      profilesRoot: join(dir, 'profiles-' + verifyMode),
      headless: true,
      channel: BROWSER!.includes('msedge') ? 'msedge' : undefined,
      executablePath: BROWSER!.includes('msedge') ? undefined : BROWSER,
      enabledFormats: ['TEXT'],
      stepTimeoutMs: 6000,
      uploadTimeoutMs: 10_000,
      verifyMode,
    });
  const hint = (caption: string, mediaCount = 0) => ({ captionFingerprint: captionFingerprint(caption), caption, mediaCount, committedAt: new Date(), windowMs: 30 * 60_000 });
  const verifyWith = async (c: FbWebPublishConnector, h: ReturnType<typeof hint>) => {
    const s = await c.openSession(target);
    try {
      return await s.verify(h);
    } finally {
      await s.close();
    }
  };

  beforeAll(async () => {
    mock = new MockFb();
    await mock.start();
    dir = mkdtempSync(join(tmpdir(), 'fbmode-test-'));
  });
  afterAll(async () => {
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    mock.posts = [];
  });

  it('caption mode accepts the post even when its timestamp cannot be read (as on the real profile)', async () => {
    mock.addPost({ caption: 'Bài mới vừa đăng', hiddenTime: true }); // timestamp link href="#", empty
    expect(await verifyWith(mk('caption'), hint('Bài mới vừa đăng', 3))).toMatchObject({ kind: 'VERIFIED' });
  });

  it('caption mode flags two copies of the same caption as a possible duplicate', async () => {
    mock.addPost({ caption: 'Bị đăng hai lần' });
    mock.addPost({ caption: 'Bị đăng hai lần' });
    expect(await verifyWith(mk('caption'), hint('Bị đăng hai lần'))).toMatchObject({ kind: 'AMBIGUOUS', matches: 2 });
  });

  it('caption mode does not find a caption that is not on the page', async () => {
    mock.addPost({ caption: 'Bài khác' });
    expect((await verifyWith(mk('caption'), hint('Không có bài này'))).kind).toBe('NOT_FOUND');
  });

  it('does not confirm a short caption that only occurs inside a different post', async () => {
    mock.addPost({ caption: 'Nội dung khác có chứa Cần tuyển người ở giữa bài' });
    expect((await verifyWith(mk('caption'), hint('Cần tuyển người'))).kind).toBe('NOT_FOUND');
  });

  it('uses the post permalink instead of the profile URL when the timeline exposes one', async () => {
    mock.addPost({ caption: 'Caption có đường dẫn riêng' });
    const result = await verifyWith(mk('caption'), hint('Caption có đường dẫn riêng'));
    expect(result).toMatchObject({ kind: 'VERIFIED', permalink: expect.stringMatching(/(?:\/posts\/|permalink\.php)/) });
  });

  it('hovers a timestamp whose link only appears on pointer-over to record the post permalink', async () => {
    const post = mock.addPost({ caption: 'Bài mới có link ẩn', lazyHref: true });
    const result = await verifyWith(mk('caption'), hint('Bài mới có link ẩn'));
    expect(result).toMatchObject({ kind: 'VERIFIED', permalink: expect.stringContaining(`/posts/${post.id}`) });
  });

  it('off mode does not look at the page and records that nothing was checked', async () => {
    const r = await verifyWith(mk('off'), hint('Không kiểm tra'));
    expect(r).toMatchObject({ kind: 'VERIFIED', evidence: { mode: 'off', checked: false } });
  });
});

describe.skipIf(!BROWSER)('capability runner (against the mock Facebook UI)', () => {
  let mock: MockFb;
  let dir: string;
  let connector: FbWebPublishConnector;
  const target = { id: 't1', code: 'B1', externalId: '100012345', audience: 'ONLY_ME', uiLocale: 'vi-VN', profileDir: '/profiles/B1' };

  beforeAll(async () => {
    mock = new MockFb();
    await mock.start();
    dir = mkdtempSync(join(tmpdir(), 'fbcap-test-'));
    connector = new FbWebPublishConnector({
      baseUrl: mock.baseUrl,
      profilesRoot: join(dir, 'profiles'),
      headless: true,
      channel: BROWSER!.includes('msedge') ? 'msedge' : undefined,
      executablePath: BROWSER!.includes('msedge') ? undefined : BROWSER,
      enabledFormats: ['TEXT', 'SINGLE_PHOTO', 'MULTI_PHOTO'],
      stepTimeoutMs: 6000,
      uploadTimeoutMs: 10_000,
    });
  });
  afterAll(async () => {
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    Object.assign(mock, { session: 'OK', userId: '100012345', postMode: 'normal', posts: [] });
  });

  const run = (over: Record<string, unknown> = {}) =>
    runCapability({ connector, target, formats: ['TEXT', 'MULTI_PHOTO'], casesPerFormat: 2, minCases: 2, pauseMs: 0, workDir: join(dir, 'work'), verifyTimeoutMs: 1500, verifyEveryMs: 200, ...over });

  it('certifies a format only with enough cases and a passing rate', async () => {
    const r = await run();
    expect(r.map((x) => [x.format, x.cases, x.failures, x.passed])).toEqual([['TEXT', 2, 0, true], ['MULTI_PHOTO', 2, 0, true]]);
    expect(mock.posts).toHaveLength(4);
    expect(mock.posts.filter((p) => p.media === 3)).toHaveLength(2);
    // with the real minimum (20) two cases can never certify
    mock.posts = [];
    const strict = await run({ minCases: 20, formats: ['TEXT'] });
    expect(strict[0]).toMatchObject({ cases: 2, failures: 0, passed: false });
  });

  it('refuses to run against an account whose audience is not "Chỉ mình tôi"', async () => {
    await expect(run({ target: { ...target, audience: 'PUBLIC' } })).rejects.toThrow(/ONLY_ME/);
    expect(mock.posts).toHaveLength(0);
  });

  it('stops the whole run at a checkpoint, a wrong identity, or an unclear result', async () => {
    mock.session = 'CHECKPOINT';
    let r = await run();
    expect(r[0].aborted).toMatch(/CHECKPOINT/);
    expect(r[1].aborted).toBeDefined();
    expect(mock.posts).toHaveLength(0);

    mock.session = 'OK';
    mock.userId = '777';
    r = await run();
    expect(r[0].aborted).toMatch(/identity|đang đăng nhập/);
    expect(mock.posts).toHaveLength(0);

    mock.userId = '100012345';
    mock.postMode = 'drop'; // UI says posted, nothing appears → must stop, not keep posting
    r = await run({ casesPerFormat: 5 });
    expect(r[0].aborted).toMatch(/chưa rõ|không thấy/);
    expect(r[0].cases).toBe(1);
  }, 60_000);

  it('VIDEO needs a real file', async () => {
    const r = await run({ formats: ['VIDEO'] });
    expect(r[0]).toMatchObject({ passed: false, cases: 0 });
    expect(r[0].aborted).toMatch(/--video/);
  });
});
