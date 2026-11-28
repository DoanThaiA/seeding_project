/// <reference lib="dom" />
import type { Page } from 'playwright-core';
import { facebookPostId } from '@seedingsys/domain';

type Caption = { caption: string; author: string | null };
type ReadResult = Caption | { expand: true };

const EXPAND = 'data-seedingsys-expand-caption';
const READ_POST = String.raw`(expected, allowExpand, expandAttr, postIdFromUrl) => {
  const isPost = href => {
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin || url.searchParams.has('comment_id') || url.searchParams.has('reply_comment_id')) return false;
      return postIdFromUrl(url) === expected;
    } catch { return false; }
  };
  const photo = /^[/]photo(?:[.]php)?[/]?$/.test(location.pathname);
  const numericStory = /^[0-9]+$/.test(expected) && /^[/](?:story|permalink)[.]php$/.test(location.pathname);
  const fromData = [];
  const capture = (author, ...messages) => {
    const message = messages.find(value => typeof value === 'string' || typeof value?.text === 'string');
    if (message !== undefined || messages.some(value => value === null)) {
      fromData.push({ caption: (message?.text ?? message ?? '').trim(), author: typeof author === 'string' ? author.trim() : null });
    }
  };
  const readStory = story => {
    if (!story) return;
    const content = story.comet_sections?.content?.story ?? story;
    capture(story.actors?.[0]?.name ?? content.actors?.[0]?.name,
      content.comet_sections?.message?.story?.message, content.message);
  };
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    const raw = script.textContent ?? '';
    if (!raw.includes(expected) && !raw.includes(encodeURIComponent(expected))) continue;
    try {
      const pending = [JSON.parse(raw)];
      while (pending.length) {
        const item = pending.pop();
        if (!item || typeof item !== 'object') continue;
        // A numeric album link can serve a primary story whose canonical
        // permalink is a pfbid. Confirm the exact numeric ID on that story.
        const primary = item.result?.data?.node_v2;
        if (numericStory && primary?.__typename === 'Story' && String(primary.post_id) === expected) readStory(primary);
        if (photo && String(item.id) === expected && (item.__isMedia === 'Photo' || item.__typename === 'Photo' || (item.__isMedia && item.owner))) {
          capture(item.owner?.name, item.message_preferred_body, item.message,
            item.container_story?.comet_sections?.message?.story?.message, item.container_story?.message,
            item.creation_story?.comet_sections?.message?.story?.message, item.creation_story?.message);
        }
        if (!photo && item.__typename === 'Video' && String(item.id) === expected) {
          readStory(item.creation_story);
          if (item.description) capture(item.owner?.name, item.description);
        }
        if (!photo && isPost(item.permalink_url ?? item.url) && (item.__typename === 'Story' || item.comet_sections?.content?.story)) readStory(item);
        for (const value of Object.values(item)) if (value && typeof value === 'object') pending.push(value);
      }
    } catch {}
  }
  const captions = [...new Set(fromData.map(item => item.caption).filter(Boolean))].sort((a, b) => b.length - a.length);
  const author = fromData.find(item => item.author)?.author ?? null;
  if (captions.length && captions.every(text => captions[0].startsWith(text))) return { caption: captions[0], author };

  const article = 'article,[role="article"],[data-pagelet^="FeedUnit"],[data-post]';
  const comment = '[data-comment-id],[data-commentid],[aria-label^="Bình luận dưới "],[aria-label^="Phản hồi bình luận "],[aria-label^="Comment by "],[aria-label^="Reply by "],[contenteditable="true"]';
  const message = '[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"],[data-testid="post_message"],[data-post-caption]';
  const cards = [...document.querySelectorAll(article)].filter(card =>
    !card.closest(comment) && (card.getAttribute('data-post') === expected ||
      [...card.querySelectorAll('a[href]')].some(link => link.closest(article) === card && !link.closest(comment) && isPost(link.href))));
  const bodies = cards.flatMap(card => [...card.querySelectorAll(message)].filter(el =>
    el.closest(article) === card && !el.closest(comment) && !el.parentElement?.closest(message) && el.getClientRects().length));
  const expand = [...new Set(bodies.flatMap(el => [...el.querySelectorAll('button,[role="button"]')]
    .filter(button => /^(?:Xem thêm|See more)$/i.test(button.innerText.trim()) && button.getClientRects().length)))];
  if (expand.length) {
    if (!allowExpand || expand.length !== 1) return null;
    expand[0].setAttribute(expandAttr, '');
    return { expand: true };
  }
  const messages = [...new Set(bodies.map(el => el.innerText.trim()).filter(Boolean))];
  if (messages.length === 1) {
    const heading = cards[0]?.querySelector('h2 a,h3 a,[data-post-author]');
    return { caption: messages[0], author: author ?? (heading?.innerText.trim() || null) };
  }
  return fromData.length && !captions.length ? { caption: '', author } : null;
}`;

export async function readPostCaption(page: Page, postId: string, waitMs: number): Promise<Caption | null> {
  const waitForCaption = async (allowExpand: boolean) => {
    const expression = '(' + READ_POST + ')(' + [JSON.stringify(postId), allowExpand, JSON.stringify(EXPAND), facebookPostId.toString()].join(',') + ')';
    const result = await page.waitForFunction(expression, undefined, { timeout: waitMs, polling: 600 }).catch(() => null);
    if (!result) return null;
    try {
      return await result.jsonValue() as ReadResult;
    } finally {
      await result.dispose();
    }
  };
  const first = await waitForCaption(true);
  if (!first || !('expand' in first)) return first;
  if (!await page.locator(`[${EXPAND}]`).click({ timeout: 2000 }).then(() => true, () => false)) return null;
  const expanded = await waitForCaption(false);
  return expanded && 'caption' in expanded ? expanded : null;
}

/** Ảnh thuộc chính bài viết: bỏ ảnh trong bình luận, ảnh đại diện và icon nhỏ. */
const READ_IMAGES = String.raw`(limit) => {
  const comment = '[data-comment-id],[data-commentid],[aria-label^="Bình luận"],[aria-label^="Phản hồi"],[aria-label^="Comment by "],[aria-label^="Reply by "],[contenteditable="true"]';
  const skip = /(ảnh đại diện|ảnh bìa|profile picture|cover photo|avatar|logo|emoji|sticker)/i;
  const seen = new Set();
  const out = [];
  for (const img of document.querySelectorAll('img')) {
    const src = img.currentSrc || img.src || '';
    if (!/^https:/.test(src) || !/fbcdn|scontent/.test(src)) continue;
    if (img.closest(comment)) continue;
    if (skip.test(img.getAttribute('alt') || '')) continue;
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (Math.min(width, height) < 200 || width * height < 90000) continue;
    let key = src;
    try { const url = new URL(src); key = url.origin + url.pathname; } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(src);
    if (out.length >= limit) break;
  }
  return out;
}`;

/** Danh sách URL ảnh của bài, theo thứ tự xuất hiện. Lỗi đọc trang thì trả về rỗng. */
export async function readPostImageSources(page: Page, limit: number): Promise<string[]> {
  const result = await page.evaluate<string[]>('(' + READ_IMAGES + ')(' + String(limit) + ')').catch(() => []);
  return Array.isArray(result) ? result.filter(item => typeof item === 'string') : [];
}
