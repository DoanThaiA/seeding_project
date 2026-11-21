import type { Page } from 'playwright-core';
import type { ReadComment, ReadCommentsResult } from '@seedingsys/connectors-core';
import { removeAdvertisingLinks } from '@seedingsys/domain';

const ALL_COMMENTS = /^(?:tất cả bình luận|all comments)$/i;
const SORT_COMMENTS = /^(?:phù hợp nhất|liên quan nhất|mới nhất|most relevant|newest|top comments)$/i;
const EXPAND = /^(?:(?:xem|hiển thị) (?:(?:thêm|tất cả|\d+) )*(?:bình luận|phản hồi|câu trả lời)(?: (?:khác|trước đó|trước))?|(?:view|see|show) (?:(?:all|more|previous|\d+) )*(?:comments|replies)(?: more)?|\d+ (?:phản hồi|replies))$/i;
const OPEN = /^(?:comment(?: on .+)?|bình luận(?: về bài viết .+)?)(?:,\s*[\d.,]+\s*(?:bình luận|comments?))?$/i;

interface Observation {
  comments: Array<Omit<ReadComment, 'postedAt'> & { date?: string }>;
  count?: number;
  empty: boolean;
  allSelected: boolean;
}

interface PrimaryThread {
  aliases: string[];
  author?: string;
  count?: number;
  comments: Observation['comments'];
}

function evaluateCommentPage<T, A>(page: Page, read: (arg: A) => T, arg: A): Promise<T> {
  // tsx can emit its keep-names helper for local functions. The browser has its own scope.
  return page.evaluate<T>('((__name) => (' + read.toString() + ')(' + JSON.stringify(arg) + '))((value) => value)');
}

async function primaryThread(page: Page, postId: string): Promise<PrimaryThread> {
  return evaluateCommentPage<PrimaryThread, string>(page, id => {
    const roots = new Map<string, any[]>();
    const reels: any[] = [];
    const postKey = (value: string) => {
      try {
        const url = new URL(value, location.href);
        return url.searchParams.get('story_fbid') || url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).at(-1);
      } catch { return undefined; }
    };
    for (const script of Array.from(document.querySelectorAll('script[type="application/json"]'))) {
      if (!script.textContent?.includes('"node_v2"') && !/^\d+$/.test(id)) continue;
      try {
        const pending = [JSON.parse(script.textContent ?? '')];
        while (pending.length) {
          const item = pending.pop();
          if (!item || typeof item !== 'object') continue;
          const node = item.result?.data?.node_v2;
          if (node?.id && node.comet_sections?.content?.story) {
            const copies = roots.get(node.id) ?? [];
            copies.push(node);
            roots.set(node.id, copies);
          }
          const reel = item.result?.data?.video;
          if (String(reel?.id) === id && reel?.creation_story) reels.push(reel.creation_story);
          for (const value of Object.values(item)) if (value && typeof value === 'object') pending.push(value);
        }
      } catch {}
    }
    const ranked = [...roots.values()].filter(copies => copies.some(node => postKey(node.permalink_url) === id));
    const [nodes] = ranked.length === 1 ? ranked : roots.size === 1 ? [...roots.values()] : [[]];
    const aliases = new Set([id]);
    const comments: PrimaryThread['comments'] = [];
    const ids = new Map<string, string>();
    let author: string | undefined;
    let count: number | undefined;
    for (const node of [...nodes, ...reels]) {
      const sections = node.comet_sections;
      const content = sections?.content?.story ?? node;
      const ufi = sections?.feedback?.story?.story_ufi_container?.story ?? sections?.feedback?.story;
      for (const url of [node.permalink_url, content.permalink_url, ufi?.permalink_url]) {
        const key = url && postKey(url);
        if (key) aliases.add(key);
      }
      const title = sections?.header?.story?.comet_sections?.title?.story;
      author ??= content.actors?.[0]?.name ?? title?.actors?.[0]?.name ?? node.actors?.[0]?.name;
      const feedback = ufi?.feedback_context?.feedback_target_with_context ?? node.feedback;
      const connection = feedback?.comment_list_renderer?.feedback?.comment_rendering_instance_for_feed_location?.comments;
      const pending = [connection];
      const total = feedback?.total_comment_count ?? node.feedback?.total_comment_count
        ?? (connection?.total_count === 0 && connection.page_info?.has_next_page === false ? 0 : undefined);
      if (typeof total === 'number') count = Math.max(count ?? 0, total);
      while (pending.length) {
        const connection = pending.pop();
        for (const edge of connection?.edges ?? []) {
          const c = edge.node;
          if (!c || c.__typename !== 'Comment' || !c.legacy_fbid) continue;
          const externalId = String(c.legacy_fbid);
          ids.set(String(c.id), externalId);
          const parent = c.comment_direct_parent;
          comments.push({ externalId, text: c.body?.text ?? c.preferred_body?.text ?? '', authorName: c.author?.name,
            parentExternalId: typeof parent?.legacy_fbid !== 'undefined' ? String(parent.legacy_fbid) : parent?.id,
            date: typeof c.created_time === 'number' ? new Date(c.created_time * 1000).toISOString() : undefined });
          const replies = c.feedback?.replies ?? c.replies;
          if (replies?.edges) pending.push(replies);
        }
      }
    }
    return { aliases: [...aliases], author, count, comments: comments.map(c => ({
      ...c, parentExternalId: c.parentExternalId && (ids.get(c.parentExternalId) ?? (/^\d+$/.test(c.parentExternalId) ? c.parentExternalId : undefined)),
    })) };
  }, postId);
}

export async function collectVisibleComments(
  page: Page,
  postId: string,
  deadline: number,
  onProgress: (readCount: number, expectedCount?: number) => Promise<void>,
): Promise<ReadCommentsResult> {
  const seen = new Map<string, ReadComment>();
  const exhausted = new Set<string>();
  let count: number | undefined;
  let all = false;
  let empty = false;
  let opened = false;
  let idle = 0;
  const primary = await primaryThread(page, postId);
  count = primary.count;
  const store = ({ date, ...comment }: Observation['comments'][number]) => {
    const postedAt = date ? new Date(date) : undefined;
    const previous = seen.get(comment.externalId);
    const text = removeAdvertisingLinks(comment.text);
    seen.set(comment.externalId, { ...previous, ...comment, permalink: comment.permalink ?? previous?.permalink,
      authorName: comment.authorName ?? previous?.authorName,
      parentExternalId: comment.parentExternalId ?? previous?.parentExternalId, text: text || previous?.text || '',
      postedAt: postedAt && Number.isFinite(+postedAt) ? postedAt : previous?.postedAt });
  };
  primary.comments.forEach(store);
  for (let step = 0; step < 100 && Date.now() < deadline; step++) {
    const found = await evaluateCommentPage<Observation, { aliases: string[]; seedIds: string[]; author?: string }>(page, ({ aliases, seedIds, author }) => {
      const article = 'article,[role="article"],[data-commentid],[data-comment-id],[aria-label^="Bình luận dưới "],[aria-label^="Phản hồi bình luận "],[aria-label^="Bình luận của "],[aria-label^="Comment by "],[aria-label^="Reply by "]';
      const anchorSelector = 'a[href*="comment_id="]';
      const postLinkMatches = (url: URL) => aliases.includes(url.pathname.replace(/\/$/, '').split('/').at(-1) ?? '')
        || ['story_fbid', 'v', 'fbid'].some(key => aliases.includes(url.searchParams.get(key) ?? ''));
      const decodedComment = (value: string | null) => {
        if (!value || /^\d+$/.test(value)) return null;
        try {
          return /^comment:(\d+)_(\d+)$/.exec(atob(value.replace(/-/g,'+').replace(/_/g,'/')));
        } catch { return null; }
      };
      const numericId = (value: string | null) => value && /^\d+$/.test(value) ? value : decodedComment(value)?.[2];
      const commentId = (url: URL) => numericId(url.searchParams.get('reply_comment_id') ?? url.searchParams.get('comment_id'));
      const threadOf = (url: URL) => decodedComment(url.searchParams.get('reply_comment_id') ?? url.searchParams.get('comment_id'));
      const allLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(anchorSelector));
      const threadIds = new Set<string>();
      for (const a of allLinks) {
        const u = new URL(a.href);
        const thread = threadOf(u);
        if (thread && seedIds.includes(thread[2]) && u.origin === location.origin) threadIds.add(thread[1]);
      }
      const belongsToThread = (url: URL) => url.origin === location.origin && threadIds.has(threadOf(url)?.[1] ?? '');
      const label = (el: HTMLElement) => (el.getAttribute('aria-label') ?? el.innerText ?? '').normalize('NFC')
        .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '').trim();
      const onScreen = (el: Element) => {
        const r = el.getBoundingClientRect();
        return !el.closest('[aria-hidden="true"]') && r.height > 0 && r.width > 0 && r.top < innerHeight && r.bottom > 0;
      };
      const actions = (el: Element) => Array.from(el.querySelectorAll<HTMLElement>('button,[role=button]')).filter(b =>
        /^(?:bình luận(?:,| về bài viết)|comment(?:,| on ))/i.test(b.getAttribute('aria-label') ?? ''));
      const primaryActions = actions(document.body).filter(b => author && !b.closest('[aria-hidden="true"]')
        && (b.getAttribute('aria-label') ?? '').toLowerCase().includes(author.toLowerCase()));
      const primaryAction = primaryActions.find(onScreen) ?? primaryActions.find(b => b.getClientRects().length);
      const anchors = allLinks.filter(a => {
        const url = new URL(a.href);
        return postLinkMatches(url) || seedIds.includes(commentId(url) ?? '') || belongsToThread(url);
      });
      let trusted: Element | undefined;
      let nearSort: Element | undefined;
      for (const seed of [...anchors].reverse()) {
        for (let el = seed.parentElement; el && el !== document.body; el = el.parentElement) {
          const buttons = actions(el);
          if (primaryActions.length && buttons.some(b => !primaryActions.includes(b))) break;
          if (buttons.length && primaryActions.length) {
            trusted = el;
            break;
          }
          if (el.matches('[role="dialog"]') || Array.from(el.querySelectorAll<HTMLElement>('[role=button],button')).some(b =>
            /^(?:phù hợp nhất|tất cả bình luận|most relevant|all comments)$/i.test(label(b)))) nearSort ??= el;
        }
        if (trusted) break;
      }
      trusted ??= nearSort;
      if (!trusted && primaryActions.length) {
        const button = primaryActions.find(onScreen) ?? primaryActions[0];
        for (let el = button.parentElement; el && el !== document.body; el = el.parentElement) {
          if (actions(el).some(b => !primaryActions.includes(b))) break;
          if (el.querySelector(anchorSelector)) { trusted = el; break; }
        }
      }
      const panel = trusted ?? primaryAction?.closest('[role="dialog"]') ?? document.querySelector('main,[role="main"]') ?? document.body;
      document.querySelector('[data-ss-comment-scope]')?.removeAttribute('data-ss-comment-scope');
      panel.setAttribute('data-ss-comment-scope','1');
      for (const old of Array.from(document.querySelectorAll('[data-ss-comment-action]'))) old.removeAttribute('data-ss-comment-action');
      const candidates = (primaryActions.length ? primaryActions : actions(panel)).filter(onScreen);
      if (candidates.length === 1) candidates[0].setAttribute('data-ss-comment-action','1');
      const menuElements = Array.from(document.querySelectorAll<HTMLElement>('button,[role=button],[role=menuitem],[role=menuitemradio],[role=option]'));
      const mark = (attr: string, matching: HTMLElement[]) => {
        for (const old of Array.from(document.querySelectorAll('[' + attr + ']'))) old.removeAttribute(attr);
        const local = matching.filter(el => panel.contains(el));
        if (local.length === 1) local[0].setAttribute(attr, '1');
        else if (matching.length === 1 && (seedIds.length || trusted || primaryActions.length)) matching[0].setAttribute(attr, '1');
      };
      mark('data-ss-comment-sort', menuElements.filter(el => el.getClientRects().length && /^(?:phù hợp nhất|liên quan nhất|mới nhất|most relevant|newest|top comments)$/i.test(label(el))));
      mark('data-ss-comment-all', menuElements.filter(el => el.getClientRects().length &&
        el.matches('[role=menuitem],[role=menuitemradio],[role=option]') && /^(?:tất cả bình luận|all comments)(?:$|[\n,])/i.test(label(el))));
      const allSelected = menuElements.some(el => panel.contains(el) && el.getClientRects().length &&
        el.matches('button,[role=button]') && /^(?:tất cả bình luận|all comments)$/i.test(label(el)));
      for (const old of Array.from(document.querySelectorAll('[data-ss-comment-expand]'))) old.removeAttribute('data-ss-comment-expand');
      const expansionPattern = /^(?:(?:xem|hiển thị) (?:(?:thêm|tất cả|\d+) )*(?:bình luận|phản hồi|câu trả lời)(?: (?:khác|trước đó|trước))?|(?:view|see|show) (?:(?:all|more|previous|\d+) )*(?:comments|replies)(?: more)?|\d+ (?:phản hồi|replies))$/i;
      const belongsToKnownReply = (el: HTMLElement) => {
        if (!/(?:câu trả lời|phản hồi|replies)$/i.test(label(el))) return false;
        let parent = el.parentElement;
        for (let level = 0; parent && level < 5; level++, parent = parent.parentElement) {
          if (anchors.some(anchor => parent?.contains(anchor))) return true;
        }
        return false;
      };
      const expanders = menuElements.filter(el => el.getClientRects().length && expansionPattern.test(label(el)));
      const replies = expanders.filter(el => /(?:câu trả lời|phản hồi|replies)$/i.test(label(el)));
      const expansion = replies.find(el => trusted?.contains(el) || belongsToKnownReply(el))
        ?? (threadIds.size === 1 && replies.length === 1 ? replies[0] : undefined)
        ?? expanders.find(el => trusted?.contains(el));
      expansion?.setAttribute('data-ss-comment-expand', '1');
      const links = new Map<Element, { externalId: string; parentExternalId?: string; permalink: string }>();
      const ambiguous = new Set<Element>();
      for (const a of allLinks) {
        if (!a.getClientRects().length) continue;
        const url = new URL(a.href);
        const card = a.closest(article);
        const sameThread = belongsToThread(url) || !!card && Array.from(card.querySelectorAll<HTMLAnchorElement>(anchorSelector))
          .some(link => link.closest(article) === card && belongsToThread(new URL(link.href)));
        const targetsPost = postLinkMatches(url) || seedIds.includes(commentId(url) ?? '') || sameThread;
        if (!targetsPost || (url.origin !== location.origin && !/^(?:www\.|m\.)?facebook\.com$/.test(url.hostname))) continue;
        const root = numericId(url.searchParams.get('comment_id'));
        const reply = numericId(url.searchParams.get('reply_comment_id'));
        const comment = reply ?? root;
        if (!card || !comment || !/^[A-Za-z0-9_:-]+$/.test(comment)) continue;
        if (links.has(card) && links.get(card)?.externalId !== comment) ambiguous.add(card);
        const pageUrl = new URL(location.href);
        const permalink = new URL((postLinkMatches(url) ? url : pageUrl).pathname, 'https://www.facebook.com');
        for (const key of ['id', 'story_fbid', 'v', 'fbid', 'comment_id', 'reply_comment_id']) {
          const value = key === 'comment_id' ? root : key === 'reply_comment_id' ? reply : (postLinkMatches(url) ? url : pageUrl).searchParams.get(key);
          if (value) permalink.searchParams.set(key, value);
        }
        const previous = links.get(card);
        if (!previous || (reply && root) || (postLinkMatches(url) && !previous.parentExternalId)) {
          links.set(card, { externalId: comment, ...(reply && root && { parentExternalId: root }), permalink: permalink.href });
        }
      }
      const comments: Observation['comments'] = [];
      document.querySelector('[data-ss-last-comment]')?.removeAttribute('data-ss-last-comment');
      let lastCard: Element | undefined;
      for (const [card, link] of links) {
        if (ambiguous.has(card)) continue;
        lastCard = card;
        const own = (selector: string) => Array.from(card.querySelectorAll<HTMLElement>(selector)).filter(el => el.closest(article) === card);
        const messages = own('[data-comment-text],[data-ad-preview="message"],[dir="auto"]').filter(el =>
          !el.closest('a,button,[role="button"],h2,h3,h4,[role="heading"]') && el.innerText.trim());
        const topMessages = messages.filter(el => !messages.some(other => other !== el && other.contains(el)));
        const text = topMessages.map(el => el.innerText.trim()).join('\n');
        const named = own('[data-comment-author],h2 a,h3 a,h4 a,[role="heading"] a')[0]?.innerText.trim();
        const label = card.getAttribute('aria-label') ?? '';
        const authorName = named || label.match(/^(?:bình luận (?:của|dưới tên)|reply by|comment by)\s+(.+?)(?:\s+\d.*)?$/i)?.[1];
        const nested = card.parentElement?.closest(article);
        const parentExternalId = card.getAttribute('data-parent-comment-id') || (nested && links.get(nested)?.externalId) || link.parentExternalId;
        comments.push({ ...link, text, authorName, ...(parentExternalId && parentExternalId !== link.externalId && { parentExternalId }),
          date: own('time[datetime]')[0]?.getAttribute('datetime') ?? undefined });
      }
      lastCard?.setAttribute('data-ss-last-comment', '1');
      const labels = Array.from(panel.querySelectorAll<HTMLElement>('button,[role="button"],[data-comment-count]'))
        .filter(el => el.getClientRects().length && !el.closest('[aria-hidden="true"]'))
        .flatMap(el => [el.getAttribute('aria-label'), el.innerText?.trim().slice(0, 80)]).filter(Boolean);
      labels.push(...primaryActions.map(button => label(button)));
      const counts = [...new Set(labels.map(label => /(?:^|,\s*)([\d.]+)\s+(?:bình luận|comments?)$/i.exec(label ?? '')?.[1])
        .filter((n): n is string => n !== undefined).map(n => Number(n.replace(/\./g,''))))];
      const explicit = panel.getAttribute('data-comment-count') ?? panel.querySelector('[data-comment-count]')?.getAttribute('data-comment-count');
      const count = explicit && /^\d+$/.test(explicit) ? Number(explicit) : counts.length === 1 ? counts[0] : undefined;
      const empty = Array.from(panel.querySelectorAll('p,span,[role="status"]')).some(el => el.getClientRects().length
        && !el.closest('[aria-hidden="true"]') && /^(?:chưa có bình luận(?: nào)?|no comments yet|be the first to comment)[.!]?$/i.test(el.textContent?.trim() ?? ''));
      return { comments, count, empty, allSelected };
    }, { aliases: primary.aliases, seedIds: [...seen.keys()], author: primary.author });
    if (found.count !== undefined) count = Math.max(count ?? 0, found.count);
    empty ||= found.empty;
    const previousSize = seen.size;
    found.comments.forEach(store);
    if (seen.size > previousSize) idle = 0;
    all ||= found.allSelected;
    await onProgress(seen.size, count);
    const surface = page.locator('[data-ss-comment-scope]').first();
    const root = await surface.count() ? surface : page.locator('body');
    const taggedAll = page.locator('[data-ss-comment-all]');
    const allOption = await taggedAll.count() ? taggedAll.first() : root.getByText(ALL_COMMENTS, { exact: true })
      .or(page.getByRole('menuitem', { name: ALL_COMMENTS })).or(page.getByRole('menuitemradio', { name: ALL_COMMENTS })).filter({ visible: true }).first();
    if (!all && await allOption.isVisible()) {
      all = await allOption.click({ timeout: 1000 }).then(() => true, () => false);
      if (all) {
        await page.waitForTimeout(1000);
        continue;
      }
    }
    const scopedSort = root.getByText(SORT_COMMENTS, { exact: true }).filter({ visible: true });
    const uniqueSort = page.getByText(SORT_COMMENTS, { exact: true }).filter({ visible: true });
    const taggedSort = page.locator('[data-ss-comment-sort]');
    const sort = await taggedSort.count() ? taggedSort.first() : await scopedSort.count() ? scopedSort.first() : await uniqueSort.count() === 1 ? uniqueSort.first() : scopedSort;
    if (!all && !exhausted.has('sort') && await sort.isVisible()) {
      exhausted.add('sort');
      if (await sort.click({ timeout: 1200 }).then(() => true, () => false)) {
        await page.waitForTimeout(250);
        continue;
      }
    }
    const taggedExpand = page.locator('[data-ss-comment-expand]');
    const expand = await taggedExpand.count() ? taggedExpand.first() : root.getByRole('button', { name: EXPAND }).first();
    if (!await expand.isVisible()) {
      if (!opened && !empty && !seen.size && count !== 0) {
        opened = true;
        const tagged = page.locator('[data-ss-comment-action]').first();
        const button = await tagged.count() ? tagged : root.getByRole('button', { name: OPEN }).filter({ visible: true }).first();
        if (await button.isVisible() && await button.click({ timeout: 1000 }).then(() => true, () => false)) {
          await page.waitForTimeout(450);
          continue;
        }
      }
      const complete = ((seen.size === 0 && (empty || count === 0)) || (all && count !== undefined && seen.size === count)) &&
        [...seen.values()].every(c => !c.parentExternalId || seen.has(c.parentExternalId));
      if (!complete && count !== undefined && seen.size < count && idle++ < 6) {
        const lastComment = page.locator('[data-ss-last-comment]');
        if (await lastComment.count()) await lastComment.scrollIntoViewIfNeeded({ timeout: 900 }).catch(() => undefined);
        await page.waitForTimeout(850);
        continue;
      }
      return { comments: [...seen.values()], complete, expectedCount: count,
        detail: complete ? undefined : 'Facebook chưa xác nhận đã hiển thị đủ bình luận và phản hồi.' };
    }
    const clicked = await expand.click({ timeout: 1200 }).then(() => true, () => false);
    if (!clicked) break;
    await page.waitForTimeout(900);
  }
  return { comments: [...seen.values()], complete: false, expectedCount: count, detail: 'Đã lưu phần đọc được. Facebook còn mục chưa mở hoặc lượt quét đã hết thời gian.' };
}
