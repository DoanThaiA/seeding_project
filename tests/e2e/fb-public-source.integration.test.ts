import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FbPublicReadConnector } from '@seedingsys/connectors-fb-web';
import { accountResource, acquireLease, dispatchBacklogItem, editBacklogCaption, freezeSnapshot, ingestPost, releaseLease } from '@seedingsys/db';
import { handleSourcePoll } from '../../apps/worker-browser/src/handlers/source-poll';
import { handleCommentScan } from '../../apps/worker-browser/src/handlers/comment-scan';
import { LibraryController } from '../../apps/api/src/library.controller';
import { createHarness, cycle, MIN, pubsOf, type Harness } from '../helpers/harness';
import { MockProfile } from '../helpers/mock-profile';

const browser = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);

describe.skipIf(!browser)('guest Facebook source → B1', () => {
  let h: Harness;
  let mock: MockProfile;

  beforeEach(async () => {
    h = await createHarness({ codes: [1] });
    mock = new MockProfile();
    mock.guestMode = true;
    await mock.start();
    h.browser.registry.addReader(new FbPublicReadConnector({
      baseUrl: mock.baseUrl, executablePath: browser, profilesRoot: 'unused', headless: true,
      enabledFormats: [], stepTimeoutMs: 6000, uploadTimeoutMs: 10_000, now: () => h.clock.now(),
    }));
    await h.db.source.update({
      where: { id: h.ids.sources.A1 },
      data: { connector: 'fb-public', externalRef: 'https://www.facebook.com/profile.php?id=' + mock.userId },
    });
  });

  afterEach(async () => {
    await mock.stop();
    await h.close();
  });

  it('queues every guest post from the first scan, restores album photos and video, and publishes the selected item once', async () => {
    const caption = 'Khai trương chi nhánh mới ngày 5/12, giảm 20% cho các sản phẩm trong chương trình tại cửa hàng. Đội ngũ tại cửa hàng sẽ hướng dẫn khách chọn đúng sản phẩm cần dùng, kiểm tra thông tin và hỗ trợ nhận hàng trong ngày.';
    mock.posts = [
      { id: 'pfbidOLD', text: 'Bài cũ sẽ được đưa vào hàng đăng sau khi quét lại' },
      { id: 'pfbidNEW', text: caption, photos: 2, more: 2, gallery: true },
      { id: 'pfbidVIDEO', text: 'Video giới thiệu cửa hàng và quy trình cung cấp dịch vụ', video: true,
        detailCaption: 'Video giới thiệu cửa hàng và quy trình cung cấp dịch vụ\n\nHẹn gặp lại các bạn vào cuối tuần.' },
      { id: 'pfbidPARTIAL', text: 'Facebook chỉ hiển thị một phần bộ ảnh công khai', photos: 1, more: 2 },
      { id: 'pfbidOTHER', text: 'Bài người khác đăng trên tường', author: 'Người khác' },
      { id: 'pfbidSAMENAME', text: 'Bài của tài khoản khác có cùng tên hiển thị', author: mock.owner },
    ];
    await h.db.$transaction(t => ingestPost(t, {
      connector: 'fb-web', sourceId: h.ids.sources.A1, now: h.clock.now(), actor: 'fixture', baseline: true,
      post: { externalId: 'pfbidOLD', text: mock.posts[0].text, contentType: 'TEXT', identityConfidence: 'HIGH', isPinned: false, isShared: false, incomplete: [], media: [] },
    }));
    await cycle(h);
    expect(await h.db.sourcePost.count({ where: { isBaseline: false } })).toBe(4);
    expect(await h.db.contentVariant.count({ where: { status: 'READY' } })).toBe(3);
    const variant = await h.db.contentVariant.findFirstOrThrow({ where: { contentType: 'MULTI_PHOTO', status: 'READY' }, include: { revision: { include: { post: true } } } });
    expect(variant).toMatchObject({ status: 'READY', caption, contentType: 'MULTI_PHOTO', revision: { text: caption, post: { externalId: 'pfbidNEW' } } });
    expect(h.editor.calls).toBe(0);
    const assets = await h.db.asset.findMany();
    expect(assets).toHaveLength(6);
    expect(assets.filter(a => a.mime === 'video/mp4')).toHaveLength(1);
    expect((await h.db.contentVariant.findFirst({ where: { contentType: 'VIDEO' } }))?.caption).toBe(mock.posts[2].detailCaption);
    expect(assets.every(a => a.status === 'STORED' && a.checksum && a.objectKey)).toBe(true);
    for (const a of assets) expect((await h.media.store.get(a.objectKey!)).length).toBeGreaterThan(0);
    const partial = await h.db.contentVariant.findFirstOrThrow({ where: { status: 'NEEDS_REVIEW' } });
    await expect(h.db.$transaction(t => freezeSnapshot(t, { variantId: partial.id, from: 'NEEDS_REVIEW', now: h.clock.now(), actor: 'fixture', caption: 'Duyệt thử bài thiếu ảnh' }))).rejects.toThrow('chưa tải đủ ảnh hoặc video');
    expect(mock.timelineRequests.every(r => !r.cookie && r.path !== '/me')).toBe(true);
    h.advance(MIN);
    await h.workerHeartbeat();
    const edited = 'Caption được sửa trong Backlog.';
    await expect(h.db.$transaction(t => editBacklogCaption(t, {
      variantId: variant.id, snapshotHash: variant.snapshotHash!, caption: edited, actor: 'fixture', now: h.clock.now(),
    }))).resolves.toBe(true);
    const requests = await Promise.allSettled([dispatchBacklogItem(h.core, variant.id), dispatchBacklogItem(h.core, variant.id)]);
    expect(requests.filter(r => r.status === 'fulfilled'), requests.map(r => r.status === 'rejected' ? String(r.reason) : 'accepted').join('\n')).toHaveLength(1);
    expect(await h.db.publicationSlot.count({ where: { manual: true } })).toBe(1);
    await h.drain();
    expect(h.platform.timeline('fb-B1')[0].mediaChecksums).toHaveLength(4);
    expect(h.platform.timeline('fb-B1')[0].caption).toBe(edited);
    h.advance(5 * MIN);
    await cycle(h);
    expect(await h.db.sourcePost.count()).toBe(4);
    expect(await h.db.contentVariant.count()).toBe(4);
    expect(await h.db.asset.count()).toBe(6);
    expect((await pubsOf(h, 'B1')).map(p => p.status)).toEqual(['PUBLISHED_VERIFIED']);
    expect(h.failures).toEqual([]);
  }, 90_000);

  it('recovers attached and nested Reel MP4 files without sending the shares to the upload queue', async () => {
    mock.posts = [
      { id: 'pfbidSHARE', text: 'Nội dung chia sẻ của A1', video: true },
      { id: 'pfbidSHORTS', text: '', video: true },
      { id: 'pfbidREJECTED', text: 'Video đã được loại', video: true },
    ];
    await cycle(h);
    expect(await h.db.contentVariant.count({ where: { status: 'NEEDS_REVIEW' } })).toBe(3);
    const edited = 'Caption đã chỉnh trước khi tải lại video.';
    const previous = await h.db.contentVariant.findFirstOrThrow({ where: { revision: { post: { externalId: 'pfbidSHARE' } } } });
    await h.db.contentVariant.update({ where: { id: previous.id }, data: { caption: edited } });
    const rejected = await h.db.contentVariant.findFirstOrThrow({ where: { revision: { post: { externalId: 'pfbidREJECTED' } } } });
    await h.db.contentVariant.update({ where: { id: rejected.id }, data: { status: 'REJECTED' } });
    mock.posts[0].sharedReel = 'attached';
    mock.posts[1].sharedReel = 'shorts';
    mock.posts[2].sharedReel = 'attached';
    h.advance(5 * MIN);
    await cycle(h);
    const recovered = await h.db.contentVariant.findMany({
      where: { status: 'NEEDS_REVIEW' },
      include: { revision: { include: { post: true, assets: { include: { asset: true } } } } },
    });
    expect(recovered).toHaveLength(2);
    expect(recovered.find(v => v.revision.post.externalId === 'pfbidSHARE')?.caption).toBe(edited);
    for (const v of recovered) {
      expect(v.revision).toMatchObject({
        mediaStatus: 'READY', incomplete: [], post: { isShared: true },
        raw: { sharedPermalink: 'https://www.facebook.com/reel/1234567' },
        assets: [{ asset: { status: 'STORED', mime: 'video/mp4', sourceUrl: mock.baseUrl + '/video.mp4' } }],
      });
      await expect(h.db.$transaction(t => freezeSnapshot(t, {
        variantId: v.id, from: 'NEEDS_REVIEW', now: h.clock.now(), actor: 'fixture', caption: edited,
      }))).rejects.toThrow('chia sẻ trực tiếp trên Facebook');
    }
    h.advance(5 * MIN);
    await cycle(h);
    expect(await h.db.sourcePostRevision.count()).toBe(6);
    expect(await h.db.asset.count()).toBe(3);
    expect(await h.db.contentVariant.findMany({
      where: { sourcePostId: rejected.sourcePostId }, select: { status: true },
    })).toEqual([{ status: 'REJECTED' }]);
    expect(await h.db.publication.count()).toBe(0);
    expect(h.failures).toEqual([]);
    const library = new LibraryController(h.db, h.clock);
    const sourcePostId = recovered[0].sourcePostId;
    const actor = { role: 'admin', actor: 'test-library' } as const;
    const target = h.ids.targets.B1;
    await expect(library.confirmShare(sourcePostId, target, { permalink: 'https://www.facebook.com/reel/1234567' }, actor)).rejects.toThrow('bài mới');
    const result = await library.confirmShare(sourcePostId, target, { permalink: 'https://www.facebook.com/test/posts/1200' }, actor);
    expect(await h.db.publication.findUnique({ where: { id: result.publicationId } })).toMatchObject({ status: 'OPERATOR_CONFIRMED' });
    await expect(library.confirmShare(sourcePostId, target, { permalink: 'https://www.facebook.com/test/posts/1200' }, actor)).rejects.toThrow('đã có lượt đăng');
  }, 90_000);

  it('records a login wall without completing the baseline', async () => {
    mock.session = 'LOGGED_OUT';
    await cycle(h);
    const source = await h.db.source.findUniqueOrThrow({ where: { id: h.ids.sources.A1 } });
    expect(source).toMatchObject({ baselineDone: false, watermark: null, lastSuccessAt: null });
    expect(source.lastError).toContain('SOURCE_UNREADABLE');
  }, 30_000);

  it('uses the exact album cycle when the feed estimates one extra photo and the viewer has no next button', async () => {
    const id = '1004410';
    mock.posts = [{ id, text: 'Album có đủ sáu ảnh', photos: 5, more: 2, gallery: true, galleryWrapCount: 6, galleryPayload: true }];
    await cycle(h);
    const source = await h.db.sourcePost.findFirstOrThrow({ where: { externalId: id } });
    const revision = await h.db.sourcePostRevision.findUniqueOrThrow({
      where: { id: source.latestRevisionId! }, include: { assets: { include: { asset: true }, orderBy: { position: 'asc' } } },
    });
    expect(revision).toMatchObject({ incomplete: [], mediaStatus: 'READY', raw: { expectedPhotoCount: 6 } });
    expect(revision.assets.map(({ asset }) => asset.sourceRef)).toEqual(
      Array.from({ length: 6 }, (_, i) => `fb-public:${id}:image:${id}${i}`),
    );
    expect(revision.assets.every(({ asset }) => asset.status === 'STORED')).toBe(true);
  }, 45_000);

  it('saves the Reel native MP4 when the HD link fails and queues comments for every post in a manual scan', async () => {
    const reelId = '1014939';
    mock.posts = [
      { id: 'pfbidREEL', playbackVideoId: reelId, video: true, text: 'Nội dung đầy đủ của thước phim' },
      { id: 'pfbidEMPTY', text: 'Bài chưa có bình luận', emptyComments: true },
      ...Array.from({ length: 8 }, (_, i) => ({ id: 'pfbidCOMMENTS' + i, text: 'Bài có bình luận số ' + i, comments: true })),
    ];
    const sourceId = h.ids.sources.A1;
    expect((await handleSourcePoll(h.browser, { sourceId, collectComments: true })).outcome).toBe('OK');
    expect(await h.db.commentScan.count()).toBe(0);
    await h.db.source.update({ where: { id: sourceId }, data: { collectComments: true } });
    expect((await handleSourcePoll(h.browser, { sourceId, collectComments: true })).outcome).toBe('OK');
    const reel = await h.db.sourcePost.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId, externalId: reelId } } });
    expect(await h.db.commentScan.count()).toBe(10);
    await h.drain();
    const revision = await h.db.sourcePostRevision.findUniqueOrThrow({ where: { id: reel.latestRevisionId! },
      include: { assets: { include: { asset: true } } } });
    expect(revision).toMatchObject({ text: mock.posts[0].text, incomplete: [], mediaStatus: 'READY',
      assets: [{ asset: { kind: 'video', status: 'STORED', sourceUrl: mock.baseUrl + '/video.mp4' } }] });
    expect(await h.db.commentScan.count({ where: { status: 'COMPLETE', readCount: 2 } })).toBe(8);
    expect(await h.db.commentScan.count({ where: { status: 'COMPLETE', readCount: 0, expectedCount: 0 } })).toBe(1);
    expect(await h.db.sourceComment.count()).toBe(16);
  }, 90_000);

  it('reads story_message-only posts and archives the rendered quote background as an image', async () => {
    mock.posts = [
      { id: 'pfbidTEXTROLE', text: 'Bài chỉ có chữ trên bảng tin', messageRoleOnly: true },
      { id: 'pfbidQUOTEROLE', text: 'Bài chữ với ảnh nền', messageRoleOnly: true, quoteBackground: true },
    ];
    await cycle(h);
    const text = await h.db.sourcePost.findFirstOrThrow({ where: { externalId: 'pfbidTEXTROLE' } });
    expect(text.contentType).toBe('TEXT');
    const quote = await h.db.sourcePost.findFirstOrThrow({ where: { externalId: 'pfbidQUOTEROLE' } });
    expect(quote.contentType).toBe('QUOTE_IMAGE');
    const revision = await h.db.sourcePostRevision.findUniqueOrThrow({
      where: { id: quote.latestRevisionId! }, include: { assets: { include: { asset: true } } },
    });
    expect(revision).toMatchObject({ text: 'Bài chữ với ảnh nền', incomplete: [], mediaStatus: 'READY',
      raw: { expectedPhotoCount: 1 }, assets: [{ asset: { kind: 'image', mime: 'image/jpeg', status: 'STORED' } }] });
    const bytes = await h.media.store.get(revision.assets[0].asset.objectKey!);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  }, 30_000);

  it('reads a thread whose links use the post alias already verified in the archive', async () => {
    mock.posts = [{ id: 'pfbidCURRENT', comments: true, commentPermalinkId: 'pfbidKNOWN', text: 'Bình luận trên bài đã đổi mã' }];
    await cycle(h);
    const post = await h.db.sourcePost.findFirstOrThrow({ where: { externalId: 'pfbidCURRENT' } });
    await h.db.sourcePostAlias.create({ data: { sourceId: h.ids.sources.A1, sourcePostId: post.id, externalId: 'pfbidKNOWN' } });
    const library = new LibraryController(h.db, h.clock);
    await handleCommentScan(h.browser, await library.queueComments(post.id, { role: 'admin', actor: 'test-library' }));
    const detail = await library.detail(post.id);
    expect(detail.scan).toMatchObject({ status: 'COMPLETE', readCount: 2 });
    expect(detail.comments.map(c => c.externalId)).toEqual(['101', '102']);
  });

  it('shows posts by profile, archives a deduplicated comment tree, and requires a parent on the destination', async () => {
    mock.posts = [{
      id: 'pfbidTHREAD', comments: true, structuredComments: true, commentDelayMs: 1800,
      text: 'Đây là caption gốc https://s.shopee.vn/an_redir?affiliate_id=17 https://example.org/tin',
    }];
    await cycle(h);
    const library = new LibraryController(h.db, h.clock);
    const actor = { role: 'admin', actor: 'test-library' } as const;
    const from = await library.posts('A1', '1', '');
    expect(from.posts).toHaveLength(1);
    expect(from.posts[0].snippet).toContain('https://example.org/tin');
    expect(from.posts[0].snippet).not.toContain('shopee');
    const post = from.posts[0].id;
    // The link from the latest Facebook scan can use an alias of the original stored id.
    await h.db.sourcePost.update({ where: { id: post }, data: { externalId: 'pfbidOLDTHREAD' } });
    await h.db.sourcePostAlias.create({ data: {
      sourceId: h.ids.sources.A1, sourcePostId: post, externalId: 'pfbidTHREAD',
    } });
    const to = await library.posts('B1', '1', '');
    expect(to.posts.map(p => p.id)).toEqual([post]);
    const request = await library.queueComments(post, actor);
    expect((await library.queueComments(post, actor)).scanId).toBe(request.scanId);
    await handleCommentScan(h.browser, request);
    await handleCommentScan(h.browser, await library.queueComments(post, actor));
    const detail = await library.detail(post);
    expect(detail.scan).toMatchObject({ status: 'COMPLETE', readCount: 2, expectedCount: 2 });
    expect(detail.comments.map(c => [c.externalId, c.parentExternalId, c.text])).toEqual([
      ['101', null, 'Bình luận chính'], ['102', '101', 'Phản hồi'],
    ]);
    const targetId = h.ids.targets.B1;
    await h.db.targetAccount.update({ where: { id: targetId }, data: { connector: 'fb-web' } });
    const otherAuthor = await h.db.targetAccount.create({ data: { code: 'B2', name: 'Profile B2', connector: 'fb-web', externalId: '222' } });
    const [root, reply] = detail.comments;
    await library.updateComment(post, targetId, root.id, { action: 'approve', authorTargetId: otherAuthor.id, text: root.text }, actor);
    await library.updateComment(post, targetId, reply.id, { action: 'approve', authorTargetId: targetId, text: reply.text }, actor);
    const variant = detail.destinations[0].variant!;
    const base = 'https://www.facebook.com/test/posts/1100';
    await h.db.publication.create({ data: {
      sourcePostId: post, targetId, variantId: variant.id, status: 'OPERATOR_CONFIRMED', workflow: 'STANDARD', contentType: 'TEXT', snapshotHash: 'test', permalink: base,
    } });
    const replyInput = { action: 'posted', permalink: base + '?comment_id=201&reply_comment_id=202' };
    await expect(library.updateComment(post, targetId, reply.id, replyInput, actor)).rejects.toThrow('bình luận cha');
    await library.updateComment(post, targetId, root.id, { action: 'posted', permalink: base + '?comment_id=201' }, actor);
    await library.updateComment(post, targetId, reply.id, replyInput, actor);
    expect((await library.detail(post)).comments.map(c => [c.replays[0]?.status, c.replays[0]?.author?.code])).toEqual([
      ['POSTED', 'B2'], ['POSTED', 'B1'],
    ]);
  }, 55_000);

  it('verifies B1 identity and reads A1 only while holding the publishing account lock', async () => {
    const requireConnector = createRequire(join(process.cwd(), 'packages/connectors/fb-web/package.json'));
    const { chromium } = requireConnector('playwright-core') as typeof import('../../packages/connectors/fb-web/node_modules/playwright-core');
    const root = mkdtempSync(join(tmpdir(), 'seedingsys-test-session-'));
    const targetId = h.ids.targets.B1;
    const sourceId = h.ids.sources.A1;
    mock.signedInAs = '999999';
    mock.posts = [{ id: 'pfbidOWNER', text: 'Nội dung của A1' }, { id: 'pfbidOTHER', text: 'Bài của tài khoản khác', author: 'Bên thứ ba' }];
    try {
      const context = await chromium.launchPersistentContext(join(root, 'B1'), { executablePath: browser, headless: true });
      try { await context.addCookies([{ name: 'fixture-session', value: 'ok', url: mock.baseUrl, expires: Math.floor(Date.now() / 1000) + 3600 }]); }
      finally { await context.close(); }
      h.browser.registry.addReader(new FbPublicReadConnector({
        baseUrl: mock.baseUrl, executablePath: browser, profilesRoot: root, headless: true,
        enabledFormats: [], stepTimeoutMs: 6000, uploadTimeoutMs: 10_000, now: () => h.clock.now(),
      }, 'fb-session'));
      await h.db.source.update({ where: { id: sourceId }, data: { connector: 'fb-session' } });
      await h.db.targetAccount.update({ where: { id: targetId }, data: { connector: 'fb-web', externalId: mock.signedInAs } });
      await h.db.browserProfile.update({ where: { targetId }, data: { workerNodeId: null } });
      const lock = await acquireLease(h.db, { resource: accountResource(targetId), holder: 'publishing', ttlMs: MIN, now: h.clock.now() });
      expect(lock).toBeTruthy();
      expect((await handleSourcePoll(h.browser, { sourceId })).outcome).toBe('READ_ERROR');
      expect(mock.timelineRequests).toHaveLength(0);
      await releaseLease(h.db, lock!, h.clock.now());
      const scanned = await handleSourcePoll(h.browser, { sourceId });
      expect(scanned.outcome, (await h.db.source.findUniqueOrThrow({ where: { id: sourceId } })).lastError ?? '').toBe('OK');
      await h.drain();
      expect(await h.db.sourcePost.findMany({ select: { externalId: true } })).toEqual([{ externalId: 'pfbidOWNER' }]);
      expect(await h.db.contentVariant.count({ where: { status: 'READY' } })).toBe(1);
      expect(mock.timelineRequests[0]).toMatchObject({ path: '/me', cookie: 'fixture-session=ok' });
      await h.db.targetAccount.update({ where: { id: targetId }, data: { externalId: '888888' } });
      const before = mock.timelineRequests.filter(req => req.path === '/profile.php').length;
      expect((await handleSourcePoll(h.browser, { sourceId })).outcome).toBe('READ_ERROR');
      // Only the /me redirect, no second visit to the source.
      expect(mock.timelineRequests.filter(req => req.path === '/profile.php')).toHaveLength(before + 1);
      expect((await h.db.source.findUniqueOrThrow({ where: { id: sourceId } })).lastError).toContain('WRONG_IDENTITY');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 70_000);
});
