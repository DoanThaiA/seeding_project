import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { ConnectorError, isConnectorError, type ReadCommentsResult, type ReadConnector, type ReadMedia, type ReadPost, type ReadResult, type SourceRef } from '@seedingsys/connectors-core';
import type { IncompleteFlag } from '@seedingsys/contracts';
import { facebookSourceUrl, isAdvertisingLink, removeAdvertisingLinks, sha256 } from '@seedingsys/domain';
import { fbTargetProfilePath, type FbWebOptions } from './config';
import { CHECKPOINT_TEXT, sel, URLS } from './selectors';
import { parseViTime } from './vi-time';
import { collectVisibleComments } from './comments';

const MESSAGE = '[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"],[data-testid="post_message"]';
const STAMP = 'a[aria-describedby],a[href^="#?"],a[href*="/posts/"],a[href*="story_fbid"],a[href*="/videos/"],a[href*="/reel/"],a[href*="/watch"]';
const MORE = /^(?:xem thêm|see more)$/i;
const LOGIN_WALL = /log in to (?:continue|see|view)|đăng nhập (?:để tiếp tục|để xem)|this content (?:isn.t|is not) available|nội dung này hiện không hiển thị/i;
const CLOSE = /^(?:đóng|close)$/i;
const captionKey = (value: string) => value.normalize('NFKC')
  .replace(/[\p{Default_Ignorable_Code_Point}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\s…]/gu, '')
  .replace(/\.{3}$/, '').toLowerCase();
const NO_POSTS = /^(?:no posts(?: to show| yet)?|không có bài viết(?: nào)?|chưa có bài viết(?: nào)?)[.!]?$/im;
const MIME = /^(?:image\/(?:jpeg|png|gif|webp)|video\/mp4)$/;

interface Card {
  id: string;
  authorUrl: string;
}

interface CardContent {
  text: string;
  links: Array<{ url: string; label: string; dateTime: string }>;
  threadLinks: string[];
  images: Array<{ url: string; key: string }>;
  overflow: number;
  video: boolean;
  videoCount: number;
  videoUrls: string[];
  linkPreviews: string[];
  hasAttachment: boolean;
  pinned: boolean;
  shared: boolean;
  sponsored: boolean;
  quoteBackground?: string;
}

const EMPTY_CARD: CardContent = {
  text: '', links: [], threadLinks: [], images: [], overflow: 0, video: false, videoCount: 0, videoUrls: [],
  linkPreviews: [], hasAttachment: false, pinned: false, shared: false, sponsored: false,
};

// Only a story's own caption and media are read. Nested articles include comments and shares.
const FIND_CARDS = String.raw`(() => {
  const message = '${MESSAGE}';
  const article = 'article,[role="article"]';
  const heading = 'h2 a[href],h3 a[href],h4 a[href],[role="heading"] a[href]';
  const root = document.querySelector('[role="main"],main') || document.body;
  const cards = new Set();
  for (const card of root.querySelectorAll(article)) {
    if (card.parentElement.closest(article) || card.closest('[role="dialog"]')) continue;
    if (card.querySelector(heading)) cards.add(card);
  }
  for (const marker of root.querySelectorAll(message + ',[aria-label*="Actions for this post"],[aria-label*="Hành động đối với bài viết"]')) {
    if (marker.closest(article + ',[role="dialog"]')) continue;
    let candidate = null;
    for (let box = marker.parentElement; box && box !== root && !box.matches('[role="feed"]'); box = box.parentElement) {
      if (Array.from(box.querySelectorAll(message)).filter(m => !m.parentElement.closest(message)).length > 1) break;
      const header = box.querySelector(heading);
      if (!header || !box.querySelector('${STAMP}')) continue;
      if (!candidate) candidate = box;
      // Signed-in timelines can wrap a shared card before the source author's own header.
      if (box.querySelector('a[href*="#?"][aria-describedby],a[href*="/posts/"]:not([href*="comment_id"])')) {
        candidate = box;
      }
    }
    if (candidate) cards.add(candidate);
  }
  let next = Number(document.body.dataset.ssPublicNext || '0');
  const result = [];
  for (const card of cards) {
    if (!card.getClientRects().length) continue;
    const author = card.querySelector(heading);
    if (author.closest(article) && author.closest(article) !== card) continue;
    card.dataset.ssPublicCard ||= String(next++);
    result.push({ id: card.dataset.ssPublicCard, authorUrl: author.href });
  }
  document.body.dataset.ssPublicNext = String(next);
  return result;
})()`;

const READ_CARD = String.raw`card => {
  const article = 'article,[role="article"]';
  const own = selector => Array.from(card.querySelectorAll(selector)).filter(el => !el.closest(article) || el.closest(article) === card);
  const message = own('${MESSAGE}')[0];
  const header = own('h2,h3,h4,[role="heading"]')[0];
  const photo = 'a[href*="/photo/"],a[href*="/photo?"],a[href*="/photo.php"],a[href*="/photos/"]';
  const links = own('${STAMP}').filter(a => !a.closest(photo) && !message?.contains(a));
  const videos = own('video');
  const videoLinks = own('a[href*="/videos/"],a[href*="/reel/"],a[href*="/watch/?v="]').filter(a => !message?.contains(a));
  const caption = message?.innerText.trim() || '';
  card.querySelector('[data-ss-quote-body]')?.removeAttribute('data-ss-quote-body');
  let quoteBackground;
  if (message && caption && !own(photo).length && !videoLinks.length && !videos.length) {
    const quote = [message, ...message.querySelectorAll('div[style*="background"]')].find(el => {
      const rect = el.getBoundingClientRect();
      return rect.width >= 180 && rect.height >= 140 && /^url\(/.test(getComputedStyle(el).backgroundImage) && el.innerText.trim() === caption;
    });
    if (quote) {
      quote.setAttribute('data-ss-quote-body', '1');
      quoteBackground = getComputedStyle(quote).backgroundImage;
    }
  }
  const buttons = Array.from(message?.querySelectorAll('button,[role="button"]') || []);
  const expanded = buttons.some(b => /^(?:ẩn bớt|thu gọn|see less|show less)$/i.test(b.innerText.trim()));
  return {
    text: expanded ? caption.replace(/\s*(?:ẩn bớt|thu gọn|see less|show less)$/i, '') : caption,
    links: links.map(a => {
      const time = a.querySelector('time,abbr');
      const description = (a.getAttribute('aria-describedby') || '').split(' ').map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      return { url: a.href, label: description || time?.title || a.innerText.trim(), dateTime: time?.getAttribute('datetime') || '' };
    }),
    threadLinks: Array.from(card.querySelectorAll('a[href*="comment_id"]')).map(a => a.href),
    images: own(photo).filter(a => a.querySelector('img') || (a.offsetWidth >= 60 && a.offsetHeight >= 60))
      .flatMap(a => {
        const imgs = Array.from(a.querySelectorAll('img'));
        return imgs.length ? imgs.map(img => ({ url: img.currentSrc || img.src, key: a.href })) : [{ url: '', key: a.href }];
      }),
    quoteBackground,
    overflow: Math.max(0, ...own(photo).flatMap(a => Array.from(a.querySelectorAll('span,div')).filter(el => !el.children.length && /^\+\s*\d+$/.test(el.textContent.trim())).map(el => Number(el.textContent.trim().slice(1))))),
    video: Boolean(videos.length || videoLinks.length),
    videoCount: videos.length || Number(videoLinks.length > 0),
    videoUrls: videos.map(video => [video.currentSrc, video.src, video.querySelector('source')?.src].find(src => /^https?:/.test(src || '')) || ''),
    linkPreviews: own('a[href*="/l.php?"]').filter(a => !message?.contains(a)).map(a => a.href),
    hasAttachment: own(photo).length > 0 || own('canvas').some(el => !message?.contains(el)),
    pinned: /bài viết đã ghim|pinned post/i.test(card.getAttribute('aria-label') || '') || own('[aria-label]').some(el => /^(?:đã ghim|pinned)$/i.test(el.getAttribute('aria-label') || '')),
    shared: /đã chia sẻ|\bshared\b/i.test(header?.innerText || ''),
    sponsored: own('[aria-label],h2 span,h3 span,h4 span').some(el => /^(?:được tài trợ|sponsored)$/i.test((el.getAttribute('aria-label') || el.innerText || '').trim()))
  };
}`;

const GALLERY_IMAGE = `(() => {
  const root = document.querySelector('[role="dialog"]:has(img[data-visualcompletion="media-vc-image"])') || document.querySelector('[role="main"],main') || document.body;
  const photos = Array.from(root.querySelectorAll('img[data-visualcompletion="media-vc-image"],img[data-source-photo]'))
    .filter(img => img.getClientRects().length && img.complete && img.naturalWidth > 0)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  return photos[0]?.currentSrc || photos[0]?.src || document.querySelector('meta[property="og:image"]')?.content || '';
})()`;

const GALLERY_ITEM = String.raw`({ id, set }) => {
  let uri;
  const next = new Set();
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    if (!/currMedia|nextMediaAfterNodeId/.test(script.textContent)) continue;
    try {
      const pending = [JSON.parse(script.textContent)];
      while (pending.length) {
        const item = pending.pop();
        if (!item || typeof item !== 'object') continue;
        const data = item.result?.data;
        if (String(data?.currMedia?.id) === id && data.mediaset?.id === btoa('mediaset:' + set)) {
          uri = data.currMedia.image?.uri;
        }
        if (data?.__isMediaSet && Object.hasOwn(data, 'nextMediaAfterNodeId')) {
          const node = data.nextMediaAfterNodeId;
          if (node === null || (node?.__typename === 'Photo' && /^\d+$/.test(String(node.id)))) next.add(node && String(node.id));
        }
        for (const value of Object.values(item)) if (value && typeof value === 'object') pending.push(value);
      }
    } catch {}
  }
  return uri ? { uri, ...(next.size === 1 && { next: [...next][0] }) } : null;
}`;

const VIDEO_URLS = String.raw`known => {
  const out = Array.from(document.querySelectorAll('meta[property^="og:video"]')).map(meta => meta.content);
  const ids = new Set([...known, new URL(location.href).searchParams.get('v'), location.pathname.split('/').filter(Boolean).at(-1)].filter(Boolean));
  for (const video of document.querySelectorAll('video[data-video-id]')) {
    if (ids.has(video.getAttribute('data-video-id'))) out.push(video.currentSrc, video.src, video.querySelector('source')?.src);
  }
  for (const url of out.filter(Boolean)) {
    try {
      const link = new URL(url);
      if (/^(?:www\.|m\.)?facebook\.com$/.test(link.hostname) && /^\d+$/.test(link.searchParams.get('v') || '')) ids.add(link.searchParams.get('v'));
    } catch {}
  }
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    if (!/browser_native_|playable_url|progressive_url/.test(script.textContent)) continue;
    try {
      const pending = [JSON.parse(script.textContent)];
      while (pending.length) {
        const item = pending.pop();
        if (!item || typeof item !== 'object') continue;
        if (ids.has(String(item.video_id || item.id || ''))) {
          out.push(item.browser_native_hd_url, item.browser_native_sd_url, item.playable_url_quality_hd, item.playable_url, item.progressive_url);
          const legacy = item.videoDeliveryLegacyFields;
          if (legacy) out.push(legacy.browser_native_hd_url, legacy.browser_native_sd_url, legacy.playable_url);
        }
        for (const value of Object.values(item)) if (value && typeof value === 'object') pending.push(value);
      }
    } catch {}
  }
  return out.filter(value => typeof value === 'string' && value);
}`;

interface PostAttachment {
  shared: boolean;
  originalUrl?: string;
  videoId?: string;
  urls: string[];
  caption?: string;
  ambiguous?: boolean;
  album?: { set: string; photos: Array<{ id: string; uri?: string }> };
}

// The permalink's primary story can carry a Reel inside an attached story or a
// Shorts card. The same response also contains unrelated video recommendations.
const POST_ATTACHMENT = String.raw`(expected => {
  const roots = new Map();
  const exactVideo = [];
  const permalinkId = value => {
    try {
      const u = new URL(value, location.href);
      return u.searchParams.get('story_fbid') || u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).at(-1);
    } catch { return null; }
  };
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    if (!script.textContent.includes('"node_v2"') && !/^\d+$/.test(expected)) continue;
    try {
      const pending = [JSON.parse(script.textContent)];
      while (pending.length) {
        const item = pending.pop();
        if (!item || typeof item !== 'object') continue;
        const node = item.result?.data?.node_v2;
        if (node?.id && node.comet_sections?.content?.story) {
          const copies = roots.get(node.id) || [];
          copies.push(node);
          roots.set(node.id, copies);
        }
        if (String(item.id ?? item.video_id) === expected && (item.__typename === 'Video' || item.videoDeliveryLegacyFields || item.videoDeliveryResponseFragment)) exactVideo.push(item);
        const reel = item.result?.data?.video;
        if (String(reel?.id) === expected && reel.creation_story) {
          const story = reel.creation_story;
          const caption = story.comet_sections?.message?.story?.message?.text ?? story.message?.text;
          const playback = story.short_form_video_context?.playback_video;
          if (playback) exactVideo.push({ ...playback, description: { text: caption } });
          for (const a of story.attachments ?? []) {
            if (String(a.media?.id) === expected) exactVideo.push({ ...a.media, description: { text: caption } });
          }
        }
        for (const value of Object.values(item)) if (value && typeof value === 'object') pending.push(value);
      }
    } catch {}
  }
  const sources = item => {
    const delivery = item.videoDeliveryResponseFragment?.videoDeliveryResponseResult;
    const legacy = item.videoDeliveryLegacyFields;
    return [...(delivery?.progressive_urls ?? []).map(entry => entry?.progressive_url),
      item.playable_url_quality_hd, item.playable_url, item.browser_native_hd_url, item.browser_native_sd_url,
      legacy?.browser_native_hd_url, legacy?.browser_native_sd_url].filter(value => typeof value === 'string' && value);
  };
  if (!roots.size) {
    if (!exactVideo.length) return null;
    const captions = new Set(exactVideo.map(v => v.description?.text).filter(value => typeof value === 'string' && value));
    return { shared: false, videoId: expected, urls: exactVideo.flatMap(sources), caption: captions.size === 1 ? [...captions][0] : undefined };
  }
  const exactRoots = [...roots.values()].filter(copies => copies.some(node => permalinkId(node.permalink_url) === expected));
  if (roots.size > 1 && exactRoots.length !== 1) return { shared: false, urls: [], ambiguous: true };

  const videos = new Map();
  const originalLinks = new Set();
  const captions = new Set();
  const albums = new Map();
  let shared = false;
  for (const root of exactRoots[0] ?? roots.values().next().value) {
    const stories = [root, root.comet_sections.content.story];
    const message = root.comet_sections.content.story.comet_sections?.message?.story?.message?.text
      ?? root.comet_sections.content.story.message?.text;
    if (typeof message === 'string') captions.add(message);
    if (stories.some(story => story.attached_story)) shared = true;
    for (const story of stories) {
      const source = story.attached_story ?? story;
      const original = source.url ?? source.permalink_url ?? source.wwwURL;
      if (story.attached_story && typeof original === 'string') originalLinks.add(original);
      for (const attachment of source.attachments ?? []) {
        try {
          const set = attachment.target?.id && /^mediaset:(pcb\.\d+)$/.exec(atob(attachment.target.id));
          if (!set) continue;
          const photos = albums.get(set[1]) ?? new Map();
          const style = attachment.styles?.attachment;
          for (const { media } of [...attachment.all_subattachments?.nodes ?? [], ...style?.all_subattachments?.nodes ?? [], ...style?.five_photos_subattachments?.nodes ?? []]) {
            if (media?.__typename !== 'Photo' || !/^\d+$/.test(String(media.id))) continue;
            const uri = media.viewer_image?.uri ?? media.image?.uri;
            if (uri || !photos.has(String(media.id))) photos.set(String(media.id), uri);
          }
          albums.set(set[1], photos);
        } catch {}
      }
      const pending = (source.attachments ?? []).map(item => ({ item, reel: false }));
      while (pending.length) {
        const { item, reel } = pending.pop();
        if (!item || typeof item !== 'object') continue;
        if (item.__typename === 'Video' && /^\d+$/.test(String(item.id))) {
          const id = String(item.id);
          const urls = videos.get(id) || new Set();
          for (const url of sources(item)) urls.add(url);
          videos.set(id, urls);
          if (reel && !/^\/(?:[^/]+\/)?(?:reel|videos)\//.test(location.pathname)) {
            shared = true;
            if (!story.attached_story) originalLinks.add('https://www.facebook.com/reel/' + id);
          }
        }
        for (const [key, value] of Object.entries(item)) {
          if (value && typeof value === 'object') pending.push({ item: value, reel: reel || key === 'fb_shorts_story' });
        }
      }
    }
  }
  const [videoId, urls] = videos.size === 1 ? videos.entries().next().value : [undefined, []];
  const [set, photos] = albums.size === 1 ? albums.entries().next().value : [undefined, []];
  return {
    shared,
    originalUrl: originalLinks.size === 1 ? originalLinks.values().next().value : undefined,
    videoId,
    urls: Array.from(urls).filter(value => typeof value === 'string' && value),
    caption: captions.size === 1 ? captions.values().next().value : undefined,
    ambiguous: videos.size > 1,
    album: set && { set, photos: Array.from(photos, ([id, uri]) => ({ id, uri })) },
  };
})`;

const DETAIL_ALBUM = String.raw`set => {
  const photos = new Map();
  let overflow = 0;
  for (const a of document.querySelectorAll('a[href*="/photo"]')) {
    const url = new URL(a.href);
    if (url.searchParams.get('set') !== set) continue;
    const id = url.searchParams.get('fbid');
    if (!id) continue;
    const image = a.querySelector('img');
    photos.set(id, { key: a.href, url: image?.currentSrc || image?.src || '' });
    for (const el of a.querySelectorAll('span,div')) {
      const more = /^\+\s*(\d+)$/.exec(el.textContent.trim());
      if (!el.children.length && more) overflow = Math.max(overflow, Number(more[1]));
    }
  }
  return { images: [...photos.values()], overflow };
}`;

function profileIdentity(url: URL): string {
  return url.searchParams.get('id') ?? url.pathname.split('/').at(-1)!.toLowerCase();
}

function postLink(value: string, base: URL): { id: string; url: string } | undefined {
  let link: URL;
  try { link = new URL(value, base); } catch { return; }
  if (!postLinkHost(link, base)) return;
  const path = link.pathname.replace(/\/$/, '');
  const story = /^\/(?:permalink|story)\.php$/.test(path);
  const match = path.match(/\/(?:posts|videos|reel)\/([a-z\d_]+)$/i);
  const watch = path === '/watch';
  const id = story ? link.searchParams.get('story_fbid') : watch ? link.searchParams.get('v') : match?.[1];
  if (!id || !/^[a-z\d_]+$/i.test(id) || link.searchParams.has('comment_id') || link.searchParams.has('reply_comment_id')) return;
  const permalink = new URL(path, 'https://www.facebook.com');
  if (watch) permalink.searchParams.set('v', id);
  if (story) {
    permalink.searchParams.set('story_fbid', id);
    const owner = link.searchParams.get('id');
    if (owner && /^\d+$/.test(owner)) permalink.searchParams.set('id', owner);
  }
  return { id, url: permalink.href };
}

function postLinkHost(link: URL, base: URL): boolean {
  return !link.username && !link.password && (link.origin === base.origin || !!facebookSourceUrl(link.origin + '/example'));
}

function photoId(url: URL): string | null {
  return url.searchParams.get('fbid') ?? url.pathname.match(/\/(?:photo|photos)\/([a-z\d_]+)\/?$/i)?.[1] ?? null;
}

function externalPreview(value: string): string | undefined {
  try {
    const redirect = new URL(value);
    if (!/^(?:l|lm|www)\.facebook\.com$/.test(redirect.hostname) || redirect.pathname !== '/l.php') return;
    const url = new URL(redirect.searchParams.get('u') ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    url.searchParams.delete('fbclid');
    return url.href;
  } catch { return; }
}

export class FbPublicReadConnector implements ReadConnector {
  readonly version = '1.7.0';
  private readonly base: URL;

  constructor(private readonly opts: FbWebOptions, readonly key: 'fb-public' | 'fb-session' = 'fb-public') {
    this.base = new URL(opts.baseUrl);
  }

  async readSince(source: SourceRef, watermark: Record<string, unknown> | null, overlap: number): Promise<ReadResult> {
    const profile = facebookSourceUrl(source.externalRef);
    if (!profile) throw new ConnectorError('SOURCE_UNREADABLE', 'Nhập URL trang cá nhân hoặc fanpage trên facebook.com.');
    const deadline = Date.now() + 105_000;
    const account = this.key === 'fb-session' ? source.readAccount : undefined;
    if (this.key === 'fb-session' && !account) throw new ConnectorError('SOURCE_UNREADABLE', 'Nguồn chưa có tài khoản đích Facebook để đọc.');
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (browser?.close() ?? context?.close() ?? Promise.resolve()).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const launch = { headless: account ? this.opts.headless : true, channel: this.opts.channel, executablePath: this.opts.executablePath, timeout: 15_000 };
      const config = { locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh', viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' as const };
      if (account) context = await chromium.launchPersistentContext(fbTargetProfilePath(this.opts.profilesRoot, account), { ...launch, ...config });
      else {
        browser = await chromium.launch(launch);
        context = await browser.newContext(config);
      }
      timer = setTimeout(() => { void close(); }, Math.max(1, deadline - Date.now()));
      const page = await context.newPage();
      page.setDefaultTimeout(2500);
      const accountIdentity = account ? await this.verifyReadAccount(page, account) : null;
      const limit = source.history ? 150 : Math.min(100, Math.max(account ? 30 : 10, overlap));
      const aliases = new Set([profileIdentity(profile)]);
      const { posts: result, partial } = source.exactPermalinks ? { posts: [], partial: false }
        : await this.readTimeline(page, profile, accountIdentity, account?.code, aliases, limit, deadline, !!source.history);
      const reread = source.exactPermalinks ?? source.retryPermalinks ?? [];
      const foundIds = new Set(result.map(item => item.post.externalId));
      for (const permalink of reread) {
        const link = postLink(permalink, this.base);
        if (!link || foundIds.has(link.id) || deadline - Date.now() < 4500) continue;
        const exact = await this.readPermalink(page, link, aliases);
        if (exact) { result.push(exact); foundIds.add(exact.post.externalId); }
      }
      const retries = new Set(reread.map(permalink => postLink(permalink, this.base)?.id));
      const priority = (post: ReadPost) => retries.has(post.externalId) ? 2
        : Number(post.incomplete.some(flag => flag !== 'TYPE_UNCERTAIN'));
      const enrichment = result.map((found, index) => ({ found, index }))
        .sort((a, b) => priority(b.found.post) - priority(a.found.post));
      const posts = result.map(found => found.post);
      for (let i = 0; i < enrichment.length; i += 2) {
        await Promise.all(enrichment.slice(i, i + 2).map(async ({ found, index }) => {
          posts[index] = await this.completeMedia(page, found.post, found.data, deadline);
        }));
      }
      const newest = posts.reduce((max, p) => Math.max(max, p.postedAt?.getTime() ?? 0), typeof watermark?.newest === 'number' ? watermark.newest : 0);
      return { posts, nextWatermark: { newest }, incomplete: partial || Date.now() >= deadline ? ['PAGINATION_INCOMPLETE'] : [],
        ...(source.history && { history: { complete: false, detail: 'Đã lấy các bài trình duyệt đọc được. Facebook không xác nhận đã hiển thị hết lịch sử profile.' } }),
      };
    } catch (error) {
      if (isConnectorError(error)) throw error;
      const detail = error instanceof Error ? error.message.split('\n')[0] : '';
      throw new ConnectorError('TRANSIENT', 'Lỗi tải hoặc đọc bảng tin Facebook. ' + detail);
    } finally {
      clearTimeout(timer);
      await close();
    }
  }

  private async readTimeline(page: Page, profile: URL, accountIdentity: string | null, accountCode: string | undefined,
    aliases: Set<string>, limit: number, deadline: number, history: boolean) {
    const response = await page.goto(new URL(profile.pathname + profile.search, this.base).href, {
      waitUntil: 'domcontentloaded', timeout: Math.min(this.opts.stepTimeoutMs * 2, 25_000),
    });
    if (response?.status() === 429) throw new ConnectorError('RATE_LIMITED', 'Facebook đang giới hạn truy cập nguồn.');
    if (accountCode) await this.assertReadSession(page, accountCode);
    if (response && !response.ok()) {
      throw new ConnectorError(response.status() >= 500 ? 'TRANSIENT' : 'SOURCE_UNREADABLE', 'Facebook trả về HTTP ' + response.status() + ' khi mở nguồn.');
    }
    const observed = this.profileAt(page.url());
    if (!observed) {
      throw new ConnectorError('SOURCE_UNREADABLE', accountCode ? `Facebook chuyển hướng khỏi trang nguồn khi dùng phiên ${accountCode}.`
        : 'Facebook chuyển hướng khỏi trang nguồn. Trang phải xem được khi chưa đăng nhập.');
    }
    const expectedId = profileIdentity(profile);
    const observedId = profileIdentity(observed);
    if (/^\d+$/.test(expectedId) && /^\d+$/.test(observedId) && observedId !== expectedId) {
      throw new ConnectorError('SOURCE_UNREADABLE', 'Facebook chuyển hướng sang profile khác với nguồn đã cấu hình.');
    }
    aliases.add(observedId);
    const canonicalLinks = await page.locator('link[rel="canonical"],meta[property="og:url"]').evaluateAll(elements =>
      elements.map(element => element.getAttribute('href') ?? element.getAttribute('content') ?? ''));
    for (const url of canonicalLinks) {
      const canonical = this.profileAt(url);
      if (canonical) aliases.add(profileIdentity(canonical));
    }
    if (accountIdentity && aliases.has(accountIdentity)) {
      throw new ConnectorError('SOURCE_UNREADABLE', 'Nguồn trùng với tài khoản đích. Chọn một trang nguồn khác để tránh đăng lặp.');
    }
    return this.collect(page, aliases, limit, deadline, history);
  }

  private async verifyReadAccount(page: Page, account: NonNullable<SourceRef['readAccount']>) {
    const response = await page.goto(new URL('/me', this.base).href, { waitUntil: 'domcontentloaded', timeout: 12_000 });
    await this.assertReadSession(page, account.code);
    if (response && !response.ok()) throw new ConnectorError('TRANSIENT', 'Facebook không xác nhận được phiên ' + account.code + ' (HTTP ' + response.status() + ').');
    const observed = this.profileAt(page.url());
    const configured = facebookSourceUrl(account.externalId);
    const expected = configured ? profileIdentity(configured) : account.externalId.trim().replace(/^@/, '').toLowerCase();
    if (!observed || profileIdentity(observed) !== expected) {
      throw new ConnectorError('WRONG_IDENTITY', 'Hồ sơ trình duyệt đang đăng nhập tài khoản khác với ' + account.code + '.');
    }
    return expected;
  }

  async readComments(source: SourceRef, post: { externalId: string; permalink?: string; aliases?: string[] },
    onProgress: (readCount: number, expectedCount?: number) => Promise<void>): Promise<ReadCommentsResult> {
    const link = post.permalink && postLink(post.permalink, this.base);
    if (!link || (link.id !== post.externalId && !post.aliases?.includes(link.id))) {
      throw new ConnectorError('SOURCE_UNREADABLE', 'Cần liên kết chính xác của bài nguồn để quét bình luận.');
    }
    const account = this.key === 'fb-session' ? source.readAccount : undefined;
    if (this.key === 'fb-session' && !account) throw new ConnectorError('SOURCE_UNREADABLE', 'Nguồn chưa có phiên Facebook để đọc.');
    const launch = { headless: account ? this.opts.headless : true, channel: this.opts.channel, executablePath: this.opts.executablePath, timeout: 15_000 };
    const settings = { locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' };
    const browser = account ? undefined : await chromium.launch(launch);
    let context: BrowserContext | undefined;
    try {
      context = account
        ? await chromium.launchPersistentContext(fbTargetProfilePath(this.opts.profilesRoot, account), { ...launch, ...settings })
        : await browser!.newContext(settings);
      const page = await context.newPage();
      page.setDefaultTimeout(1500);
      if (account) await this.verifyReadAccount(page, account);
      const url = new URL(link.url);
      const response = await page.goto(new URL(url.pathname + url.search, this.base).href, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (response?.status() === 429) throw new ConnectorError('RATE_LIMITED', 'Facebook đang giới hạn quét bình luận.');
      if (account) await this.assertReadSession(page, account.code);
      else await this.dismissOptionalLogin(page);
      if (!response?.ok() || postLink(page.url(), this.base)?.id !== link.id || (!account && await sel.loginForm(page).isVisible())) {
        throw new ConnectorError('SOURCE_UNREADABLE', 'Facebook chưa mở được đúng bài và phần bình luận với phiên này.');
      }
      return await collectVisibleComments(page, link.id, Date.now() + 85_000, onProgress, [post.externalId, ...(post.aliases ?? [])]);
    } finally {
      if (browser) await browser.close();
      else await context?.close();
    }
  }

  private async assertReadSession(page: Page, code: string) {
    const url = page.url();
    if (URLS.checkpoint.test(url)) throw new ConnectorError('CHECKPOINT', 'Facebook yêu cầu xác minh phiên ' + code + '.');
    if (URLS.login.test(url) || await sel.loginForm(page).isVisible()) {
      throw new ConnectorError('SESSION_LOGGED_OUT', 'Phiên ' + code + ' chưa đăng nhập. Mở lại bằng pnpm fb:login ' + code + '.');
    }
    const text = (await page.locator('body').innerText({ timeout: 1800 }).catch(() => '')).slice(0, 1600);
    if (CHECKPOINT_TEXT.test(text) && !await page.locator('[role="article"],article').first().isVisible()) {
      throw new ConnectorError('CHECKPOINT', 'Facebook yêu cầu xác minh phiên ' + code + '.');
    }
  }

  private async readPermalink(feed: Page, link: { id: string; url: string }, aliases: Set<string>): Promise<{ post: ReadPost; data: CardContent } | null> {
    const page = await feed.context().newPage().catch(() => null);
    if (!page) return null;
    page.setDefaultTimeout(1300);
    try {
      const url = new URL(link.url);
      const loaded = await page.goto(new URL(url.pathname + url.search, this.base).href, { waitUntil: 'domcontentloaded', timeout: 9500 });
      if (!loaded?.ok() || postLink(page.url(), this.base)?.id !== link.id) return null;
      const article = 'article,[role="article"]';
      await page.locator(article).first().waitFor({ timeout: 1400 }).catch(() => undefined);
      const [card] = await page.evaluate<Card[]>(FIND_CARDS);
      if (card) {
        const author = this.profileAt(card.authorUrl);
        if (author && aliases.has(profileIdentity(author))) {
          const found = await this.readCard(page, card.id, link);
          if (found?.post.externalId === link.id) return found;
        }
      }
      const attachment = await page.evaluate<PostAttachment | null>('(' + POST_ATTACHMENT + ')(' + JSON.stringify(link.id) + ')');
      if (attachment?.videoId || attachment?.album) {
        const reel = new URL(link.url).pathname.includes('/reel/');
        const album = attachment.album;
        const observed = album && await page.evaluate<Pick<CardContent, 'images' | 'overflow'>>(
          '(' + DETAIL_ALBUM + ')(' + JSON.stringify(album.set) + ')',
        );
        const images = album?.photos.length ? album.photos.map(photo => ({ url: photo.uri ?? '',
          key: new URL('/photo/?' + new URLSearchParams({ fbid: photo.id, set: album.set }), this.base).href,
        })) : observed?.images ?? [];
        const video = !!attachment.videoId;
        const data = { ...EMPTY_CARD, images, overflow: observed?.overflow ?? 0, video, videoCount: Number(video) };
        const incomplete: IncompleteFlag[] = ['MEDIA_UNAVAILABLE'];
        if (album) incomplete.push('MEDIA_COUNT_UNKNOWN');
        if (attachment.caption === undefined) incomplete.push('CAPTION_TRUNCATED');
        return { data, post: {
          externalId: link.id, permalink: link.url, text: removeAdvertisingLinks(attachment.caption ?? ''),
          contentType: reel ? 'REEL' : video ? 'VIDEO' : 'MULTI_PHOTO', media: [], incomplete,
          identityConfidence: 'HIGH', isPinned: false, isShared: attachment.shared, raw: { reader: this.key },
        } };
      }
      return null;
    } catch {
      return null;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private profileAt(value: string): URL | null {
    try {
      const url = new URL(value);
      return facebookSourceUrl(url.origin === this.base.origin ? 'https://www.facebook.com' + url.pathname + url.search : url.href);
    } catch {
      return null;
    }
  }

  private async dismissOptionalLogin(page: Page) {
    const prompt = page.getByRole('dialog').filter({ has: page.locator('input[type="password"]') }).first();
    const close = prompt.getByRole('button', { name: CLOSE }).first();
    if (await close.isVisible()) await close.click({ timeout: 900 }).catch(() => undefined);
  }

  private async collect(page: Page, aliases: Set<string>, max: number, deadline: number, history = false) {
    const posts = new Map<string, { post: ReadPost; data: CardContent }>();
    const settled = new Set<string>();
    let idle = 0;
    let scroll = '';
    let blockedMidScan = false;
    const scanUntil = Math.min(deadline, Date.now() + (history ? 48_000 : 38_000));
    for (let step = 0; step < (history ? 64 : 34) && idle < 4 && posts.size < max && Date.now() < scanUntil; step++) {
      await this.dismissOptionalLogin(page);
      const blocked = page.getByRole('dialog').filter({ hasText: LOGIN_WALL }).first();
      if (!this.profileAt(page.url()) || await blocked.isVisible()) {
        if (posts.size) {
          blockedMidScan = true;
          break;
        }
        throw new ConnectorError('SOURCE_UNREADABLE', 'Facebook yêu cầu đăng nhập hoặc trang nguồn không khả dụng cho khách.');
      }
      const cards = await page.evaluate<Card[]>(FIND_CARDS);
      if (!cards.length) {
        const body = await page.locator('body').innerText();
        if (LOGIN_WALL.test(body)) {
          if (posts.size) { blockedMidScan = true; break; }
          throw new ConnectorError('SOURCE_UNREADABLE', 'Facebook yêu cầu đăng nhập hoặc trang nguồn không khả dụng cho khách.');
        }
        if (!posts.size && NO_POSTS.test(body)) return { posts: [], partial: false };
      }
      const before = settled.size;
      for (const card of cards) {
        if (settled.has(card.id) || posts.size >= max || Date.now() >= scanUntil) continue;
        const author = this.profileAt(card.authorUrl);
        if (!author || !aliases.has(profileIdentity(author))) continue;
        const found = await this.readCard(page, card.id, undefined, aliases);
        if (!found) continue;
        settled.add(card.id);
        const prior = posts.get(found.post.externalId);
        if (!prior || prior.post.incomplete.length > found.post.incomplete.length) posts.set(found.post.externalId, found);
      }
      const progress = await page.evaluate(() => {
        const el = document.scrollingElement;
        return (el?.scrollTop ?? 0) + '/' + (el?.scrollHeight ?? 0);
      });
      idle = settled.size > before || progress !== scroll ? 0 : idle + 1;
      scroll = progress;
      if (posts.size < max && idle < 4) {
        await page.mouse.move(620, 550);
        await page.mouse.wheel(0, 1100);
        await page.waitForTimeout(550);
      }
    }
    if (!posts.size) throw new ConnectorError('SOURCE_UNREADABLE', this.key === 'fb-session'
      ? 'Facebook chưa hiển thị bài nào của nguồn cho phiên tài khoản đích.'
      : 'Facebook chưa hiển thị bài có thể đọc của nguồn ở chế độ khách.');
    return { posts: [...posts.values()], partial: blockedMidScan || idle < 4 };
  }

  private async readCard(page: Page, id: string, exact?: { id: string; url: string }, aliases?: Set<string>): Promise<{ post: ReadPost; data: CardContent } | null> {
    const selector = '[data-ss-public-card="' + id + '"]';
    const card = page.locator(selector);
    const stamp = card.locator('a[href*="#?"][aria-describedby]').or(card.locator('a[aria-describedby],a[href^="#?"]')).first();
    const read = () => page.evaluate<CardContent | null>(
      '(function () { const card = document.querySelector(' + JSON.stringify(selector) + '); return card ? (' + READ_CARD + ')(card) : null; })()',
    );
    const initial = await read();
    if (!initial?.links.some(link => this.isStoryLink(link.url)) && await stamp.count()) {
      await stamp.hover({ timeout: 500 }).catch(() => undefined);
      if (this.key === 'fb-session') {
        for (let i = 0; i < 4; i++) {
          const href = await stamp.getAttribute('href', { timeout: 350 }).catch(() => null);
          if (href && this.isStoryLink(href)) break;
          await page.waitForTimeout(120);
        }
      }
    }
    const more = card.locator(MESSAGE).first().getByRole('button', { name: MORE }).first();
    if (await more.isVisible()) {
      await more.click({ timeout: 1200 }).catch(() => undefined);
      await more.waitFor({ state: 'hidden', timeout: 600 }).catch(() => undefined);
    }
    const data = await read();
    if (!data || data.sponsored) return null;
    const links = data.links.map(link => ({ ...link, post: postLink(link.url, this.base) })).filter(link => link.post);
    const thread = this.key === 'fb-session' && aliases ? this.storyFromThread(data.threadLinks, aliases) : undefined;
    const candidate = exact ? links.find(link => link.post?.id === exact.id) ?? { post: exact, dateTime: '', label: '' }
      : links.find(link => this.isStoryLink(link.post!.url))
        ?? (thread ? { post: thread, dateTime: '', label: data.links[0]?.label ?? '' } : links[0]);
    if (!candidate?.post) return null;

    const { id: externalId, url: permalink } = candidate.post;
    const incomplete: IncompleteFlag[] = [];
    const caption = data.text.replace(/(?:…|\.\.\.)?\s*(?:xem thêm|see more|ẩn bớt|thu gọn|see less|show less)$/i, '').trim();
    if (/(?:\s|…|\.\.\.)(?:xem thêm|see more)$/i.test(data.text) || await more.isVisible()) incomplete.push('CAPTION_TRUNCATED');
    const previews = [...new Set(data.linkPreviews.map(externalPreview).filter((url): url is string => !!url && !isAdvertisingLink(url)))];
    const cleanCaption = removeAdvertisingLinks(caption);
    const text = [cleanCaption, ...previews.filter(url => !cleanCaption.includes(url) && !cleanCaption.includes(url.replace(/\/$/, '')))].filter(Boolean).join('\n\n');

    const media: ReadMedia[] = [];
    const photos = new Map<string, string>();
    for (const image of data.images) {
      const url = this.mediaUrl(image.url);
      if (!url) continue;
      const href = new URL(image.key);
      const key = photoId(href) ?? url.pathname;
      photos.set(key, url.href);
    }
    for (const [key, url] of photos) media.push({ kind: 'image', ref: 'fb-public:' + externalId + ':image:' + key, sourceUrl: url });
    if (data.quoteBackground) {
      const quote = card.locator('[data-ss-quote-body]').first();
      const url = /^url\(["']?(.*?)["']?\)$/.exec(data.quoteBackground)?.[1];
      const background = this.mediaUrl(url);
      if (background && !incomplete.includes('CAPTION_TRUNCATED')) {
        // The quote is rendered by the browser. Wait for its background before capturing just this element.
        const loaded = await quote.evaluate((el, src) => new Promise<boolean>(resolve => {
          const img = new Image();
          const timer = setTimeout(() => resolve(false), 1600);
          img.onload = () => { clearTimeout(timer); resolve(el.isConnected && img.naturalWidth > 0); };
          img.onerror = () => { clearTimeout(timer); resolve(false); };
          img.src = src;
        }), background.href).catch(() => false);
        const bytes = loaded && await quote.screenshot({ type: 'jpeg', quality: 92, animations: 'disabled', timeout: 2300 }).catch(() => null);
        if (bytes) media.push({ kind: 'image', ref: 'fb-public:' + externalId + ':image:quote:' + sha256(caption + '\n' + background.pathname),
          mime: 'image/jpeg', renderedImage: bytes });
      }
      if (!media.length) incomplete.push('MEDIA_UNAVAILABLE');
    }
    const videos = new Map<string, ReadMedia>();
    for (const url of data.videoUrls) {
      const video = this.videoMedia(externalId, url);
      if (video) videos.set(video.ref, video);
    }
    media.push(...videos.values());
    if (data.overflow) incomplete.push('MEDIA_COUNT_UNKNOWN');
    if (data.images.some(image => {
      const id = photoId(new URL(image.key));
      return id ? !photos.has(id) : !this.mediaUrl(image.url);
    }) || videos.size < Math.max(data.videoCount, Number(permalink.includes('/reel/'))) || (data.hasAttachment && !media.length)) {
      incomplete.push('MEDIA_UNAVAILABLE');
    }
    if (data.shared) incomplete.push('TYPE_UNCERTAIN');
    if (!text && !media.length && !incomplete.length) return null;
    const at = candidate.dateTime ? new Date(candidate.dateTime) : null;
    const now = this.opts.now?.() ?? new Date();
    const absolute = at && Number.isFinite(at.getTime()) ? at : null;
    const displayTime = parseViTime(candidate.label, now);
    const postedAt = absolute ?? displayTime?.at;
    const postedAtExact = !!absolute || displayTime?.tolMs === 120_000;
    const photoIds = new Set(data.images.map(image => photoId(new URL(image.key))));
    const expectedPhotoCount = data.quoteBackground ? 1 : !photoIds.has(null) && photoIds.size ? photoIds.size + data.overflow : undefined;
    const contentType = data.video && (photos.size || data.videoCount > 1) ? 'UNSUPPORTED'
      : permalink.includes('/reel/') ? 'REEL'
      : data.video ? 'VIDEO'
      : data.quoteBackground ? 'QUOTE_IMAGE'
      : Math.max(photoIds.size, photos.size) > 1 || data.overflow ? 'MULTI_PHOTO'
      : photos.size === 1 || data.images.length ? 'SINGLE_PHOTO'
      : data.hasAttachment || data.shared ? 'UNSUPPORTED'
      : 'TEXT';
    return { data, post: {
      externalId, permalink, postedAt, text, contentType, media, incomplete, identityConfidence: 'HIGH', isPinned: data.pinned, isShared: data.shared,
      raw: { reader: this.key, stamp: candidate.label || null, postedAtExact, ...(expectedPhotoCount && { expectedPhotoCount }), ...(previews.length && { linkPreviews: previews }) },
    } };
  }

  private isStoryLink(value: string): boolean {
    const link = postLink(value, this.base);
    return !!link && /\/posts\/|\/(?:story|permalink)\.php/.test(link.url);
  }

  private storyFromThread(links: string[], aliases: Set<string>) {
    const ids = new Map<string, { id: string; url: string }>();
    for (const href of links) {
      const url = new URL(href, this.base);
      const match = url.pathname.match(/^\/([^/]+)\/posts\/[^/]+\/?$/);
      if (!match || !aliases.has(match[1].toLowerCase())) continue;
      url.searchParams.delete('comment_id');
      url.searchParams.delete('reply_comment_id');
      const parent = postLink(url.href, this.base);
      if (parent) ids.set(parent.id, parent);
    }
    return ids.size === 1 ? ids.values().next().value : undefined;
  }

  private mediaUrl(value: string | null | undefined): URL | undefined {
    try {
      const url = new URL(value ?? '');
      if (url.username || url.password) return;
      // A loopback base URL is used by the browser integration fixture.
      if (url.origin === this.base.origin && /^(?:127\.0\.0\.1|localhost)$/.test(url.hostname)) return url;
      if (url.protocol === 'https:' && !url.port && /(?:^|\.)(?:fbcdn\.net|fbsbx\.com)$/.test(url.hostname)) return url;
    } catch {
      return;
    }
  }

  private videoMedia(id: string, value: string, videoId?: string): ReadMedia | undefined {
    const url = this.mediaUrl(value);
    if (!url || /\.(?:m3u8|mpd|m4s|ts)$/i.test(url.pathname)
      || [...url.searchParams.keys()].some(key => /^(?:bytestart|byteend|range)$/i.test(key))) return;
    return { kind: 'video', ref: 'fb-public:' + id + ':video:' + (videoId ?? url.pathname), sourceUrl: url.href };
  }

  private async selectVideo(postId: string, urls: string[], videoId: string | undefined, until: number) {
    for (const url of new Set(urls)) {
      const media = this.videoMedia(postId, url, videoId);
      if (!media || Date.now() >= until) continue;
      // Progressive HD and SD links can have different expiry or availability.
      // Check the response before choosing which URL the media worker will save.
      const response = await fetch(media.sourceUrl!, { redirect: 'manual', headers: { range: 'bytes=0-0' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(5000, until - Date.now()))) }).catch(() => null);
      if (!response) continue;
      const mime = response.headers.get('content-type')?.split(';')[0].trim();
      await response.body?.cancel().catch(() => undefined);
      if (mime === 'video/mp4' && (response.status === 200 || response.status === 206)) return media;
    }
  }

  private async completeMedia(feed: Page, post: ReadPost, card: CardContent, deadline: number): Promise<ReadPost> {
    const isVideo = card.video || post.contentType === 'REEL' || post.contentType === 'VIDEO';
    const needsPhotos = card.images.length > 0 && post.incomplete.includes('MEDIA_UNAVAILABLE') && !isVideo;
    const needsGallery = card.overflow > 0 || post.incomplete.includes('MEDIA_COUNT_UNKNOWN');
    if ((!needsGallery && !needsPhotos && !isVideo && !post.isShared && !post.incomplete.includes('CAPTION_TRUNCATED')) || deadline - Date.now() < 1500) return post;
    const until = Math.min(deadline, Date.now() + (needsGallery ? 50_000 : 25_000));
    const detail = await feed.context().newPage().catch(() => null);
    if (!detail) return post;
    detail.setDefaultTimeout(900);
    try {
      let detailCard: CardContent | undefined;
      if (post.permalink) {
        const link = new URL(post.permalink);
        const expectedIds = new Set([post.externalId, ...card.links.map(a => postLink(a.url, this.base)?.id).filter(Boolean)]);
        const response = await detail.goto(new URL(link.pathname + link.search, this.base).href, { waitUntil: 'domcontentloaded', timeout: 9500 }).catch(() => null);
        const observed = postLink(detail.url(), this.base);
        if (response?.ok() && observed && expectedIds.has(observed.id)) {
          const attachment = observed.id === post.externalId
            ? await detail.evaluate<PostAttachment | null>('(' + POST_ATTACHMENT + ')(' + JSON.stringify(post.externalId) + ')') : null;
          const original = attachment?.originalUrl && postLink(attachment.originalUrl, this.base);
          if (attachment?.shared) post.isShared = true;
          if (original && original.id !== post.externalId) post.raw = { ...post.raw, sharedPermalink: original.url };
          else if (attachment?.shared && attachment.videoId && attachment.videoId !== post.externalId) {
            post.raw = { ...post.raw, sharedPermalink: 'https://www.facebook.com/watch/?v=' + attachment.videoId };
          }
          if (attachment?.caption !== undefined) {
            const clean = removeAdvertisingLinks(attachment.caption.trim());
            const previews = Array.isArray(post.raw?.linkPreviews) ? post.raw.linkPreviews as string[] : [];
            const text = [clean, ...previews.filter(url => !clean.includes(url))].filter(Boolean).join('\n\n');
            const snippet = card.text.replace(/(?:…|\.\.\.)?\s*(?:xem thêm|see more)$/i, '').trim();
            const prefix = captionKey(snippet);
            if (!snippet || (prefix.length >= 4 && captionKey(clean).startsWith(prefix))) {
              post.text = text;
              post.incomplete = post.incomplete.filter(flag => flag !== 'CAPTION_TRUNCATED');
            }
          }
          if ((isVideo || attachment?.videoId) && !attachment?.ambiguous && card.videoCount <= 1) {
            const urls = [...attachment?.urls ?? []];
            if (isVideo) urls.push(...await detail.evaluate<string[]>('(' + VIDEO_URLS + ')(' + JSON.stringify([...expectedIds]) + ')'));
            urls.push(...card.videoUrls);
            const media = await this.selectVideo(post.externalId, urls, attachment?.videoId, until);
            if (media) {
              post.media = [...post.media.filter(m => m.kind !== 'video'), media];
              if (card.images.every(image => this.mediaUrl(image.url))) post.incomplete = post.incomplete.filter(flag => flag !== 'MEDIA_UNAVAILABLE');
              if (!card.images.length && post.contentType !== 'REEL') post.contentType = 'VIDEO';
            }
          }
          if (needsGallery || needsPhotos) {
            const details = await detail.evaluate<CardContent[]>(String.raw`Array.from(document.querySelectorAll('article,[role="article"]'))
              .filter(el => !el.parentElement.closest('article,[role="article"]'))
              .map(${READ_CARD})`);
            detailCard = details.find(candidate => candidate.links.some(a => postLink(a.url, this.base)?.id === post.externalId));
          }
        }
      }
      if (needsPhotos && !needsGallery) {
        const ids = [...new Set(card.images.map(image => photoId(new URL(image.key))))];
        const photos = this.confirmDetailPhotos(detailCard, ids, ids.length, post.externalId);
        if (photos) {
          post.media = photos;
          post.incomplete = post.incomplete.filter(flag => flag !== 'MEDIA_UNAVAILABLE');
        }
      }
      if (needsGallery && card.images.length && Date.now() < until) {
        const original = [...new Set(card.images.map(image => photoId(new URL(image.key))))];
        const direct = card.overflow ? this.confirmDetailPhotos(detailCard, original, original.length + card.overflow, post.externalId) : null;
        const photos = direct ?? await this.gallery(detail, card, post.externalId, until)
          ?? (detailCard && detailCard.overflow ? await this.gallery(detail, detailCard, post.externalId, until) : null);
        if (photos && original.every(id => id && photos.some(photo => photo.ref === 'fb-public:' + post.externalId + ':image:' + id))) {
          post.media = [...photos, ...post.media.filter(m => m.kind === 'video')];
          post.raw = { ...post.raw, expectedPhotoCount: photos.length };
          const missingVideo = post.media.filter(m => m.kind === 'video').length < card.videoCount;
          post.incomplete = post.incomplete.filter(flag => flag !== 'MEDIA_COUNT_UNKNOWN' && (flag !== 'MEDIA_UNAVAILABLE' || missingVideo));
        }
      }
      return post;
    } catch {
      // A single unavailable detail page must not discard the rest of the batch.
      return post;
    } finally {
      await detail.close().catch(() => undefined);
    }
  }

  private confirmDetailPhotos(card: CardContent | undefined, requiredIds: Array<string | null>, count: number, postId: string): ReadMedia[] | null {
    if (!card || card.overflow || requiredIds.includes(null)) return null;
    const files = new Map<string, ReadMedia>();
    for (const image of card.images) {
      const id = photoId(new URL(image.key));
      const url = this.mediaUrl(image.url);
      if (!id || !url) return null;
      files.set(id, { kind: 'image', ref: 'fb-public:' + postId + ':image:' + id, sourceUrl: url.href });
    }
    return files.size === count && requiredIds.every(id => files.has(id!)) ? [...files.values()] : null;
  }

  private async gallery(page: Page, card: Pick<CardContent, 'images' | 'overflow'>, postId: string, until: number): Promise<ReadMedia[] | null> {
    const urls = card.images.map(image => new URL(image.key));
    const first = urls[0];
    const set = urls.map(url => url.searchParams.get('set')).find(value => value?.startsWith('pcb.'));
    const firstId = first && photoId(first);
    if (!set?.startsWith('pcb.') || !firstId || !postLinkHost(first, this.base)) return null;
    const visible = new Set(urls.map(photoId));
    if (visible.has(null)) return null;
    const count = visible.size + card.overflow;
    if (count > 50) return null;
    first.searchParams.set('set', set);
    const open = (url: URL) => page.goto(new URL(url.pathname + url.search, this.base).href, {
      waitUntil: 'domcontentloaded', timeout: Math.max(1, Math.min(10_000, until - Date.now())),
    }).catch(() => null);
    const response = await open(first);
    if (!response?.ok() || !postLinkHost(new URL(page.url()), this.base)) return null;

    const photos = new Map<string, ReadMedia>();
    const loaded = new Set<string>();
    const complete = () => [...visible].every(id => id !== null && photos.has(id));
    for (let i = 0; i <= 50 && Date.now() < until; i++) {
      await this.dismissOptionalLogin(page);
      const current = new URL(page.url());
      const id = photoId(current);
      if (!postLinkHost(current, this.base) || current.searchParams.get('set') !== set || !id || (i === 0 && id !== firstId)) return null;
      // The photo viewer can wrap before the feed's “+N” estimate. Only a
      // complete round trip in this exact album can replace that estimate.
      if (photos.has(id)) return id === firstId && complete() && photos.size > visible.size ? [...photos.values()] : null;
      if (photos.size >= 50) return null;
      const item = await page.evaluate<{ uri: string; next?: string | null } | null>(
        '(' + GALLERY_ITEM + ')(' + JSON.stringify({ id, set }) + ')',
      );
      let file = this.mediaUrl(item?.uri);
      for (let attempt = 0; attempt < 10 && Date.now() < until; attempt++) {
        if (file) break;
        const candidate = this.mediaUrl(await page.evaluate<string>(GALLERY_IMAGE));
        if (candidate && !loaded.has(candidate.pathname)) { file = candidate; break; }
        await page.waitForTimeout(180);
      }
      if (!file) return null;
      loaded.add(file.pathname);
      photos.set(id, { kind: 'image', ref: 'fb-public:' + postId + ':image:' + id, sourceUrl: file.href });
      if (item?.next !== undefined) {
        if (item.next === null) return complete() && photos.size > visible.size ? [...photos.values()] : null;
        if (photos.has(item.next)) return item.next === firstId && complete() && photos.size > visible.size ? [...photos.values()] : null;
        const target = new URL(first);
        target.searchParams.set('fbid', item.next);
        const loaded = await open(target);
        if (!loaded?.ok() || photoId(new URL(page.url())) !== item.next) return null;
        continue;
      }
      const nextName = /^(?:ảnh tiếp theo|next photo)$/i;
      const next = page.getByRole('button', { name: nextName }).or(page.getByRole('link', { name: nextName })).filter({ visible: true }).first();
      if (!await next.isVisible()) return photos.size === count && complete() ? [...photos.values()] : null;
      try {
        const clickMs = Math.max(1, Math.min(3500, until - Date.now()));
        await next.click({ timeout: clickMs });
        await page.waitForURL(url => photoId(url) !== id, { timeout: Math.max(1, Math.min(5000, until - Date.now())) });
      } catch {
        return null;
      }
    }
    return null;
  }

  async fetchMedia(media: { ref: string; sourceUrl?: string | null }): Promise<{ bytes: Buffer; mime: string }> {
    const url = this.mediaUrl(media.sourceUrl);
    if (!url) throw new ConnectorError('PERMANENT', 'Media nằm ngoài CDN Facebook.');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(45_000) });
    const mime = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
    const isVideo = media.ref.includes(':video:');
    const limit = (isVideo ? 100 : 25) * 1024 * 1024;
    if (response.status !== 200 || !response.body || !MIME.test(mime) || isVideo !== (mime === 'video/mp4') || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new ConnectorError(response.status >= 500 ? 'TRANSIENT' : 'PERMANENT', 'Không tải được media Facebook hợp lệ (HTTP ' + response.status + ').');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new ConnectorError('PERMANENT', 'Media Facebook vượt giới hạn dung lượng.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (!size) throw new ConnectorError('PERMANENT', 'Media Facebook rỗng.');
    return { bytes: Buffer.concat(chunks, size), mime };
  }
}
