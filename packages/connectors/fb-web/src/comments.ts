import type { Locator, Page } from 'playwright-core';
import type { ReadComment, ReadCommentsResult, ReadConnector } from '@seedingsys/connectors-core';
import { contentText, facebookPostId, removeAdvertisingLinks, stableMediaKey } from '@seedingsys/domain';

const ALL_COMMENTS = /^(?:tất cả bình luận|all comments)$/i;
const SORT_COMMENTS = /^(?:phù hợp nhất|liên quan nhất|mới nhất|most relevant|newest|top comments)$/i;
const EXPAND = /^(?:(?:xem|hiển thị|tải) (?:(?:các|thêm|tất cả|[\d.,]+) )*(?:bình luận|phản hồi|(?:câu |lượt )?trả lời)(?: (?:khác|trước đó|trước|cũ hơn|mới hơn))?|(?:view|see|show|load) (?:(?:all|more|previous|older|newer|[\d.,]+) )*(?:comments?|repl(?:y|ies))(?: more)?|[\d.,]+ (?:phản hồi|(?:câu |lượt )?trả lời|repl(?:y|ies)))(?:\s*[.…])?$/i;
const OPEN = /^(?:comment(?: on .+)?|bình luận(?: về bài viết .+)?)(?:,\s*[\d.,]+\s*(?:bình luận|comments?))?$/i;

interface Observation {
  comments: Array<Omit<ReadComment, 'postedAt'> & { date?: string }>;
  count?: number;
  empty: boolean;
  end: boolean;
  loading: boolean;
  allSelected: boolean;
  sortAvailable: boolean;
  scopedThread: boolean;
  expanders: Array<{ id: string; key: string }>;
  nextControlId: number;
  mediaThreads: string[];
  mountedMediaThread?: string;
}

interface PrimaryThread {
  aliases: string[];
  author?: string;
  count?: number;
  exactVideo: boolean;
  comments: Observation['comments'];
}

type CommentIdentity = Parameters<NonNullable<ReadConnector['readComments']>>[1]['identity'];

function evaluateCommentPage<T, A>(page: Page, read: (arg: A, postIdFromUrl: typeof facebookPostId) => T, arg: A): Promise<T> {
  // tsx can emit its keep-names helper for local functions. The browser has its own scope.
  return page.evaluate<T>('((__name) => (' + read.toString() + ')(' + JSON.stringify(arg) + ', ' +
    facebookPostId.toString() + '))((value) => value)');
}

async function primaryThread(page: Page, postId: string, knownPostIds: string[] = [], identity?: CommentIdentity): Promise<PrimaryThread> {
  const caption = contentText(identity?.text ?? '');
  const mediaKeys = identity?.mediaRefs.flatMap(ref => stableMediaKey(ref) ?? []) ?? [];
  return evaluateCommentPage<PrimaryThread, {
    id: string; knownPostIds: string[]; caption: string; mediaKeys: string[]; postedAt?: number;
  }>(page, ({ id, knownPostIds, caption, mediaKeys, postedAt }, postIdFromUrl) => {
    const aliases = new Set([id, ...knownPostIds]);
    const hasNumericAlias = [...aliases].some(key => /^\d+$/.test(key));
    const roots = new Map<string, any[]>();
    const reels: any[] = [];
    const postKey = (value: string) => {
      try {
        const url = new URL(value, location.href);
        if (url.origin !== location.origin && !/^(?:www\.|m\.|web\.)?facebook\.com$/i.test(url.hostname)) return undefined;
        return postIdFromUrl(url);
      } catch { return undefined; }
    };
    for (const script of Array.from(document.querySelectorAll('script[type="application/json"]'))) {
      if (!script.textContent?.includes('"node_v2"') && !hasNumericAlias) continue;
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
          if (aliases.has(String(reel?.id)) && reel?.creation_story) reels.push(reel.creation_story);
          for (const value of Object.values(item)) if (value && typeof value === 'object') pending.push(value);
        }
      } catch {}
    }
    const storyId = (value: unknown) => {
      if (typeof value !== 'string') return undefined;
      if (/^\d+$/.test(value)) return value;
      try { return /^S:_I\d+:(\d+)(?::\1)?$/.exec(atob(value))?.[1]; } catch { return undefined; }
    };
    const exact = [...roots.values()].filter(copies => copies.some(node => {
      const story = node.comet_sections.content.story;
      return [node.id, node.legacy_fbid, story.id, story.legacy_fbid]
        .some(value => aliases.has(String(value)) || aliases.has(storyId(value) ?? '')) ||
        [node.permalink_url, story.permalink_url].some(value => value && aliases.has(postKey(value) ?? ''));
    }));
    // An older permalink can resolve to a new pfbid. Match its structured story
    // against the archived post before accepting the numeric comment thread id.
    const matchingContent = exact.length ? [] : [...roots.values()].filter(copies => copies.some(node => {
      const sections = node.comet_sections.content.story.comet_sections;
      const story = node.comet_sections.content.story;
      const message = sections?.message?.story?.message?.text ?? story.message?.text;
      const displayed = typeof message === 'string' ? message.normalize('NFC').replace(/https?:\/\/[^\s<>"']+/gi, ' ')
        .replace(/[­​-‏⁠﻿]/g, '').replace(/\s+/g, ' ').trim().toLowerCase() : '';
      const sameCaption = !!caption && displayed === caption;
      const prefixMatches = caption.length >= 32 && displayed.startsWith(caption);
      const time = story.creation_time ?? node.creation_time ?? node.comet_sections.header?.story?.creation_time;
      const sameTime = postedAt !== undefined && typeof time === 'number' && Math.abs(time * 1000 - postedAt) <= 180_000;
      if (sameCaption && caption.length >= 24 && sameTime) return true;
      if (!mediaKeys.length || (caption && displayed && !sameCaption && !prefixMatches)) return false;
      const media = [...(story.attachments ?? []), ...(node.attachments ?? [])];
      while (media.length) {
        const item = media.pop();
        if (!item || typeof item !== 'object') continue;
        const type = item.__typename === 'Photo' ? 'image' : item.__typename === 'Video' ? 'video' : '';
        if (type && mediaKeys.includes(type + ':' + item.id) && (sameCaption || prefixMatches || sameTime || !caption)) return true;
        for (const entry of Object.values(item)) if (entry && typeof entry === 'object') media.push(entry);
      }
      return false;
    }));
    const matches = exact.length ? exact : matchingContent;
    const nodes = matches.length === 1 ? matches[0] : [];
    const comments: PrimaryThread['comments'] = [];
    const ids = new Map<string, string>();
    let author: string | undefined;
    let count: number | undefined;
    for (const node of [...nodes, ...reels]) {
      const sections = node.comet_sections;
      const content = sections?.content?.story ?? node;
      const ufi = sections?.feedback?.story?.story_ufi_container?.story ?? sections?.feedback?.story;
      for (const value of [node.legacy_fbid, content.legacy_fbid, node.id, content.id]) {
        const key = storyId(value);
        if (key) aliases.add(key);
      }
      for (const url of [node.permalink_url, content.permalink_url, ufi?.permalink_url]) {
        const key = url && postKey(url);
        if (key) aliases.add(key);
      }
      const title = sections?.header?.story?.comet_sections?.title?.story;
      author ??= content.actors?.[0]?.name ?? title?.actors?.[0]?.name ?? node.actors?.[0]?.name;
      const feedback = ufi?.feedback_context?.feedback_target_with_context ?? node.feedback;
      const connection = feedback?.comment_list_renderer?.feedback?.comment_rendering_instance_for_feed_location?.comments;
      const pending = [{ connection, parentId: undefined as string | undefined }];
      const total = feedback?.total_comment_count ?? node.feedback?.total_comment_count
        ?? (connection?.total_count === 0 && connection.page_info?.has_next_page === false ? 0 : undefined);
      if (typeof total === 'number') count = Math.max(count ?? 0, total);
      while (pending.length) {
        const { connection, parentId } = pending.pop()!;
        for (const c of connection?.nodes ?? connection?.edges?.map((edge: { node: unknown }) => edge.node) ?? []) {
          if (!c || c.__typename !== 'Comment' || !c.legacy_fbid) continue;
          const externalId = String(c.legacy_fbid);
          ids.set(String(c.id), externalId);
          const parent = c.comment_direct_parent;
          comments.push({ externalId, text: c.body?.text ?? c.preferred_body?.text ?? '', authorName: c.author?.name,
            parentExternalId: parentId ?? (parent?.legacy_fbid == null ? parent?.id : String(parent.legacy_fbid)),
            date: typeof c.created_time === 'number' ? new Date(c.created_time * 1000).toISOString() : undefined });
          const replies = c.feedback?.replies ?? c.replies;
          if (replies?.edges || replies?.nodes) pending.push({ connection: replies, parentId: externalId });
        }
      }
    }
    return { aliases: [...aliases], author, count, exactVideo: reels.length > 0, comments: comments.map(c => ({
      ...c, parentExternalId: c.parentExternalId && (ids.get(c.parentExternalId) ?? c.parentExternalId),
    })) };
  }, { id: postId, knownPostIds, caption, mediaKeys, postedAt: identity?.postedAt?.getTime() });
}

export async function confirmedCommentPostIds(page: Page, postId: string): Promise<string[]> {
  return (await primaryThread(page, postId)).aliases;
}

interface ObservationInput {
  aliases: string[];
  seedIds: string[];
  author?: string;
  mediaPost: boolean;
  exactVideo: boolean;
  expand: string;
  beforeMediaOpen?: string[];
  mountedMediaThread?: string;
  nextControlId: number;
}

function observeComments(page: Page, input: ObservationInput): Promise<Observation> {
  return evaluateCommentPage<Observation, ObservationInput>(page, ({
    aliases, seedIds, author, mediaPost, exactVideo, expand, beforeMediaOpen, mountedMediaThread, nextControlId,
  }, postIdFromUrl) => {
    const seeds = new Set(seedIds);
    const article = 'article,[role="article"],[data-commentid],[data-comment-id],[aria-label^="Bình luận dưới "],[aria-label^="Phản hồi bình luận "],[aria-label^="Bình luận của "],[aria-label^="Comment by "],[aria-label^="Reply by "]';
    const anchorSelector = 'a[href*="comment_id="]';
    const postLinkMatches = (url: URL) => {
      if (url.origin !== location.origin && !/^(?:www\.|m\.|web\.)?facebook\.com$/i.test(url.hostname)) return false;
      const post = postIdFromUrl(url);
      return !!post && aliases.includes(post);
    };
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
    const mediaRoot = document.querySelector('[data-ss-media-comments]');
    const mediaThreads = new Set<string>();
    for (const a of allLinks) {
      if (!a.getClientRects().length || a.closest('[aria-hidden="true"]') || !a.closest(article)) continue;
      const url = new URL(a.href);
      const thread = threadOf(url);
      if (url.origin === location.origin && thread) mediaThreads.add(thread[1]);
    }
    // A Reel may open comment links with an encoded story id instead of its video id.
    // Only bind the single thread revealed by the exact video's own comment control.
    const currentPost = postIdFromUrl(new URL(location.href));
    if (mediaRoot && currentPost && aliases.includes(currentPost) && beforeMediaOpen && !mountedMediaThread) {
      const revealed = [...mediaThreads].filter(id => !beforeMediaOpen.includes(id));
      if (revealed.length === 1) mountedMediaThread = revealed[0];
    }
    const threadIds = new Set<string>();
    for (const a of allLinks) {
      const u = new URL(a.href);
      const thread = threadOf(u);
      if (thread && (seeds.has(thread[2]) || aliases.includes(thread[1])) && u.origin === location.origin) threadIds.add(thread[1]);
    }
    const belongsToThread = (url: URL) => {
      const thread = threadOf(url)?.[1];
      return !!thread && url.origin === location.origin && (threadIds.has(thread)
        || (thread === mountedMediaThread && !!mediaRoot && !!currentPost && aliases.includes(currentPost)));
    };
    const label = (el: HTMLElement) => (el.getAttribute('aria-label') ?? el.innerText ?? '').normalize('NFC')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim();
    const visible = (el: Element) => !!el.getClientRects().length && !el.closest('[aria-hidden="true"],[inert]')
      && getComputedStyle(el).visibility !== 'hidden';
    const onScreen = (el: Element) => {
      const r = el.getBoundingClientRect();
      return !el.closest('[aria-hidden="true"]') && r.height > 0 && r.width > 0 && r.top < innerHeight && r.bottom > 0;
    };
    const actions = (el: Element) => Array.from(el.querySelectorAll<HTMLElement>('button,[role=button]')).filter(b =>
      /^(?:bình luận(?:,| về bài viết)|comment(?:,| on ))/i.test(b.getAttribute('aria-label') ?? ''));
    const main = document.querySelector('main,[role="main"]');
    const countOf = (text: string) => {
      const value = /(?:^|,\s*)(\d+(?:[.,]\d{3})*)\s+(?:bình luận|comments?)$/i.exec(text)?.[1];
      return value === undefined ? undefined : Number(value.replace(/[.,]/g,''));
    };
    const counted = mediaPost && main ? actions(main).filter(button => visible(button)
      && /^(?:bình luận|comment),\s*\d[\d.,]*(?:\s*[kmb])?\s+(?:bình luận|comments?)$/i.test(label(button))) : [];
    const mediaCard = (button: HTMLElement) => {
      for (let card = button.parentElement; card; card = card.parentElement) {
        const parent = card.parentElement;
        if (!parent || parent === main || counted.some(other => other !== button && parent.contains(other))) return card;
      }
    };
    // On media permalinks the active player owns the comment action. Suggested
    // players below it can also have mounted controls with unrelated counts.
    const activePlayers = exactVideo ? counted.filter(button => {
      const player = mediaCard(button)?.querySelector('video');
      if (!player || !onScreen(button)) return false;
      const r = player.getBoundingClientRect();
      return r.width > 0 && Math.min(innerHeight, r.bottom) - Math.max(0, r.top) >= r.height / 2;
    }) : [];
    let mediaAction = document.querySelector<HTMLElement>('[data-ss-media-comment-action]');
    if (!beforeMediaOpen) {
      mediaRoot?.removeAttribute('data-ss-media-comments');
      mediaAction?.removeAttribute('data-ss-media-comment-action');
      mediaAction = activePlayers.length === 1 ? activePlayers[0]
        : counted.length === 1 && (!exactVideo || (main?.querySelectorAll('video').length ?? 0) < 2) ? counted[0] : null;
      mediaAction?.setAttribute('data-ss-media-comment-action', '1');
      if (mediaAction) (counted.length === 1 ? main : mediaCard(mediaAction))?.setAttribute('data-ss-media-comments', '1');
    }
    const primaryActions = actions(document.body).filter(b => author && visible(b)
      && (b.getAttribute('aria-label') ?? '').toLowerCase().includes(author.toLowerCase()));
    const primaryAction = primaryActions.find(onScreen) ?? primaryActions.find(b => b.getClientRects().length);
    const anchors = allLinks.filter(a => {
      const url = new URL(a.href);
      return visible(a) && (postLinkMatches(url) || seeds.has(commentId(url) ?? '') || belongsToThread(url));
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
          /^(?:phù hợp nhất|liên quan nhất|mới nhất|tất cả bình luận|most relevant|all comments|top comments|newest)$/i.test(label(b)))) nearSort ??= el;
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
    trusted ??= mediaRoot && anchors.some(anchor => mediaRoot.contains(anchor)) ? mediaRoot : undefined;
    // The video viewer can mount its discussion in a side panel outside <main>.
    // Scope pagination to that panel, stopping before any other comment thread.
    const panelAnchor = beforeMediaOpen && main && anchors.find(anchor => !main.contains(anchor));
    if (panelAnchor && (!trusted || !trusted.contains(panelAnchor))) {
      const ownCards = new Set(anchors.map(anchor => anchor.closest(article)));
      const foreignCards = [...new Set(allLinks.filter(visible).map(anchor => anchor.closest(article)))]
        .filter(card => card && !ownCards.has(card));
      for (let el = panelAnchor.closest(article)?.parentElement; el && el !== document.body; el = el.parentElement) {
        if (el.contains(main!) || foreignCards.some(card => el!.contains(card))) break;
        trusted = el;
        if (el.matches('[role="dialog"]')) break;
      }
    }
    const panel = trusted ?? primaryAction?.closest('[role="dialog"]') ?? mediaRoot ?? main ?? document.body;
    document.querySelector('[data-ss-comment-scope]')?.removeAttribute('data-ss-comment-scope');
    panel.setAttribute('data-ss-comment-scope','1');
    for (const old of Array.from(document.querySelectorAll('[data-ss-comment-action]'))) old.removeAttribute('data-ss-comment-action');
    const candidates = (primaryActions.length ? primaryActions : actions(panel)).filter(onScreen);
    if (candidates.length === 1) candidates[0].setAttribute('data-ss-comment-action','1');
    const menuElements = Array.from(document.querySelectorAll<HTMLElement>(
      'button,[role=button],[role=link],a[href],[role=menuitem],[role=menuitemradio],[role=option]',
    )).filter(visible);
    const mark = (attr: string, matching: HTMLElement[]) => {
      for (const old of Array.from(document.querySelectorAll('[' + attr + ']'))) old.removeAttribute(attr);
      const local = matching.filter(el => panel.contains(el));
      if (local.length === 1) local[0].setAttribute(attr, '1');
      else if (matching.length === 1 && (seedIds.length || trusted || primaryActions.length)) matching[0].setAttribute(attr, '1');
    };
    const sortButtons = menuElements.filter(el => /^(?:phù hợp nhất|liên quan nhất|mới nhất|most relevant|newest|top comments)$/i.test(label(el)));
    mark('data-ss-comment-sort', sortButtons);
    const sortAvailable = !!document.querySelector('[data-ss-comment-sort]') || sortButtons.some(el => panel.contains(el));
    mark('data-ss-comment-all', menuElements.filter(el => el.getClientRects().length &&
      el.matches('[role=menuitem],[role=menuitemradio],[role=option]') && /^(?:tất cả bình luận|all comments)(?:$|[\n,])/i.test(label(el))));
    const allSelected = menuElements.some(el => panel.contains(el) && el.getClientRects().length &&
      el.matches('button,[role=button]') && /^(?:tất cả bình luận|all comments)$/i.test(label(el)));
    const expansionPattern = new RegExp(expand, 'i');
    const replyControl = /(?:trả lời|phản hồi|repl(?:y|ies))/i;
    const knownCards = new Set(anchors.map(anchor => anchor.closest(article)).filter(Boolean));
    const commentOwner = (el: HTMLElement) => {
      const card = el.closest(article);
      if (card) return knownCards.has(card) ? card : undefined;
      // Some reply controls sit beside the parent card rather than inside it.
      const container = el.parentElement;
      const nearby = [...knownCards].filter(candidate => candidate && container?.contains(candidate));
      return nearby.length === 1 ? nearby[0] ?? undefined : undefined;
    };
    const controls = menuElements.flatMap(el => {
      const text = label(el);
      const owner = commentOwner(el);
      const reply = replyControl.test(text);
      const card = el.closest(article);
      const foreignComment = !owner && card && Array.from(card.querySelectorAll(anchorSelector)).some(a => a !== el && a.closest(article) === card);
      const bodyMore = !!owner && /^(?:xem thêm|see more)$/i.test(text)
        && !!el.closest('[data-comment-text],[data-ad-preview="message"],[dir="auto"]');
      if (!bodyMore && (!expansionPattern.test(text) || foreignComment
        || (!owner && !(reply ? trusted : panel)?.contains(el)))) return [];
      if (el instanceof HTMLAnchorElement && !['', '#'].includes(el.getAttribute('href') ?? '')) {
        const url = new URL(el.href);
        if (url.origin !== location.origin || (!postLinkMatches(url) && url.pathname !== location.pathname)) return [];
      }
      return [{ el, text, owner, priority: bodyMore ? 0 : reply ? 1 : 2 }];
    }).sort((a, b) => a.priority - b.priority);
    const slots = new Map<string, number>();
    const expanders = controls.map(({ el, text, owner }) => {
      let id = el.getAttribute('data-ss-comment-expand');
      if (!id || !/^\d+$/.test(id)) {
        id = String(nextControlId++);
        el.setAttribute('data-ss-comment-expand', id);
      }
      const parent = owner && anchors.find(anchor => anchor.closest(article) === owner);
      // Keep the attempt count when Facebook re-renders a control without loading any data.
      const prefix = (parent ? commentId(new URL(parent.href)) ?? id : 'thread') + ':' + text;
      const slot = slots.get(prefix) ?? 0;
      slots.set(prefix, slot + 1);
      return { id, key: prefix + ':' + slot };
    });
    const links = new Map<Element, { externalId: string; parentExternalId?: string; permalink: string }>();
    const ambiguous = new Set<Element>();
    for (const a of allLinks) {
      if (!visible(a)) continue;
      const url = new URL(a.href);
      const card = a.closest(article);
      const sameThread = belongsToThread(url) || !!card && Array.from(card.querySelectorAll<HTMLAnchorElement>(anchorSelector))
        .some(link => link.closest(article) === card && belongsToThread(new URL(link.href)));
      const targetsPost = postLinkMatches(url) || seeds.has(commentId(url) ?? '') || sameThread;
      if (!targetsPost || (url.origin !== location.origin && !/^(?:www\.|m\.|web\.)?facebook\.com$/i.test(url.hostname))) continue;
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
    const counts = [...new Set(labels.flatMap(label => countOf(label ?? '') ?? []))];
    const explicit = (panel.closest('[data-comment-count]') ?? panel.querySelector('[data-comment-count]'))?.getAttribute('data-comment-count');
    const mediaCount = mediaAction ? countOf(label(mediaAction)) : undefined;
    const count = explicit && /^\d+$/.test(explicit) ? Number(explicit) : mediaCount ?? (counts.length === 1 ? counts[0] : undefined);
    const messages = Array.from(panel.querySelectorAll('p,span,[role="status"]')).filter(el => visible(el) && !knownCards.has(el.closest(article)));
    const empty = messages.some(el => /^(?:chưa có bình luận(?: nào)?|no comments yet|be the first to comment)[.!]?$/i.test(el.textContent?.trim() ?? ''));
    const end = !!trusted && messages.some(el => /^(?:không còn bình luận(?: nào)?|đã hiển thị tất cả bình luận|no more comments|all comments loaded)[.!]?$/i.test(el.textContent?.trim() ?? ''));
    const loadingSelector = '[aria-busy="true"],[role="progressbar"]';
    const loading = panel.matches(loadingSelector) || Array.from(panel.querySelectorAll(loadingSelector)).some(visible);
    const scopedThread = !!trusted && anchors.some(anchor => panel.contains(anchor));
    return { comments, count, empty, end, loading, expanders, nextControlId, allSelected, sortAvailable, scopedThread,
      mediaThreads: [...mediaThreads], mountedMediaThread };
  }, input);
}

async function scrollCommentThread(lastComment: Locator) {
  if (!await lastComment.count()) return false;
  return lastComment.evaluate(card => {
    for (let el = card.parentElement; el; el = el.parentElement) {
      if (/^(?:auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 2) {
        const before = el.scrollTop;
        const remainingToCard = card.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
        el.scrollBy({ top: Math.max(remainingToCard, 180, el.clientHeight * 0.8), behavior: 'instant' });
        return el.scrollTop > before;
      }
    }
    const belowViewport = card.getBoundingClientRect().bottom > innerHeight;
    const before = scrollY;
    if (belowViewport) card.scrollIntoView({ block: 'end', behavior: 'instant' });
    window.scrollBy({ top: Math.min(240, window.innerHeight * 0.3), behavior: 'instant' });
    return belowViewport && scrollY > before;
  }, undefined, { timeout: 900 }).catch(() => false);
}

export async function collectVisibleComments(
  page: Page,
  postId: string,
  deadline: number,
  onProgress: (readCount: number, expectedCount?: number) => Promise<void>,
  knownPostIds: string[] = [],
  { mediaPost = false, knownCommentIds = [], identity }: {
    mediaPost?: boolean; knownCommentIds?: string[]; identity?: CommentIdentity;
  } = {},
): Promise<ReadCommentsResult> {
  const seen = new Map<string, ReadComment>();
  const clicked = new Map<string, number>();
  let nextControlId = 1;
  let count: number | undefined;
  let all = false;
  let sawSort = false;
  let opened = false;
  let beforeMediaOpen: string[] | undefined;
  let mountedMediaThread: string | undefined;
  let refreshed = false;
  let quietSince = Date.now();
  let lastVisible = '';
  let sortAttempts = 0;
  let primary = await primaryThread(page, postId, knownPostIds, identity);
  count = primary.count;
  const pageOrigin = new URL(page.url()).origin;
  const result = (complete: boolean, detail?: string): ReadCommentsResult => ({ comments: [...seen.values()], complete, expectedCount: count, detail });
  const store = ({ date, ...comment }: Observation['comments'][number]) => {
    const postedAt = date ? new Date(date) : undefined;
    const previous = seen.get(comment.externalId);
    const text = removeAdvertisingLinks(comment.text);
    seen.set(comment.externalId, { ...previous, ...comment, permalink: comment.permalink ?? previous?.permalink,
      authorName: comment.authorName ?? previous?.authorName,
      parentExternalId: comment.parentExternalId ?? previous?.parentExternalId, text: text || previous?.text || '',
      postedAt: postedAt && Number.isFinite(+postedAt) ? postedAt : previous?.postedAt });
    return !previous || (!!text && text !== previous.text) || (!!comment.parentExternalId && previous.parentExternalId !== comment.parentExternalId);
  };
  primary.comments.forEach(store);
  try {
    while (Date.now() < deadline) {
      const currentUrl = new URL(page.url());
      const currentPost = facebookPostId(currentUrl);
      if (currentUrl.origin !== pageOrigin || !currentPost || !primary.aliases.includes(currentPost)) {
        return result(false, 'Facebook đã chuyển khỏi bài đang quét. Đã lưu phần bình luận và phản hồi đọc được.');
      }
      const found = await observeComments(page, { aliases: primary.aliases, seedIds: [...knownCommentIds, ...seen.keys()], author: primary.author,
        mediaPost, exactVideo: primary.exactVideo, expand: EXPAND.source, beforeMediaOpen, mountedMediaThread, nextControlId });
      nextControlId = found.nextControlId;
      mountedMediaThread = found.mountedMediaThread;
      if (found.count !== undefined) count = Math.max(count ?? 0, found.count);
      const visibleIds = found.comments.map(comment => comment.externalId).join(',');
      const changed = found.comments.map(store).some(Boolean);
      if (changed) clicked.clear();
      if (changed || visibleIds !== lastVisible) quietSince = Date.now();
      lastVisible = visibleIds;
      all ||= found.allSelected;
      sawSort ||= found.sortAvailable;
      await onProgress(seen.size, count);

      const root = page.locator('[data-ss-comment-scope]').first();
      const taggedAll = page.locator('[data-ss-comment-all]');
      const allOption = await taggedAll.count() ? taggedAll.first()
        : root.getByText(ALL_COMMENTS, { exact: true }).filter({ visible: true }).first();
      if (!all && await allOption.isVisible() && await allOption.click({ timeout: 1200 }).then(() => true, () => false)) {
        all = true;
        quietSince = Date.now();
        await page.waitForTimeout(750);
        continue;
      }
      if (!all && sortAttempts < 2) {
        const tagged = page.locator('[data-ss-comment-sort]');
        const scoped = root.getByText(SORT_COMMENTS, { exact: true }).filter({ visible: true });
        const sort = await tagged.count() ? tagged.first() : scoped.first();
        if (await sort.isVisible()) {
          sortAttempts++;
          if (await sort.click({ timeout: 1200 }).then(() => true, () => false)) {
            quietSince = Date.now();
            await page.waitForTimeout(650);
            continue;
          }
        }
      }

      if (!opened && !found.expanders.length && !found.empty && count !== 0
        && (!found.comments.length || (mediaPost && count !== undefined && seen.size < count && !all))) {
        const tagged = page.locator('[data-ss-comment-action]').first();
        const mediaAction = page.locator('[data-ss-media-comment-action]');
        const canBindMedia = await mediaAction.count() === 1;
        const untagged = root.getByRole('button', { name: OPEN }).filter({ visible: true });
        const button = canBindMedia ? mediaAction : await tagged.count() ? tagged : untagged;
        if (await button.count() === 1 && await button.isVisible() && await button.click({ timeout: 1200 }).then(() => true, () => false)) {
          opened = true;
          if (canBindMedia) beforeMediaOpen = found.mediaThreads;
          quietSince = Date.now();
          await page.waitForTimeout(650);
          continue;
        }
      }

      // Drain every branch. A click that leaves its control unchanged gets another
      // chance, then yields to other branches and pagination controls.
      const idle = Date.now() - quietSince;
      if (found.loading && idle < 18_000) {
        await page.waitForTimeout(600);
        continue;
      }
      const next = found.expanders.find(control => (clicked.get(control.key) ?? 0) < 2);
      if (next) {
        const attempts = clicked.get(next.key) ?? 0;
        clicked.set(next.key, attempts + 1);
        const expanded = await page.locator(`[data-ss-comment-expand="${next.id}"]`)
          .click({ timeout: 1200 }).then(() => true, () => false);
        if (expanded) await page.waitForTimeout(attempts ? 1600 : 1000);
        continue;
      }

      // A count can cover only top-level comments, so even a matching count
      // cannot skip controls or a final pass through a lazy-loading thread.
      const comments = [...seen.values()];
      const parentsKnown = comments.every(c => !c.parentExternalId || seen.has(c.parentExternalId));
      const topLevel = comments.filter(c => !c.parentExternalId).length;
      const unfiltered = all || (!sawSort && (found.scopedThread || (mediaPost && opened)));
      const verified = parentsKnown && (seen.size === 0 && (count === 0 || (count === undefined && found.empty))
        || unfiltered && (count === seen.size || (topLevel > 0 && count === topLevel) || (count === undefined && found.end)));
      const settleMs = verified ? 2400 : 6500;
      if (!refreshed && idle >= 1600 && !verified && (!found.comments.length || (count !== undefined && seen.size < count))) {
        refreshed = true;
        const hydrated = await primaryThread(page, postId, knownPostIds, identity);
        primary = { ...hydrated, aliases: [...new Set([...primary.aliases, ...hydrated.aliases])], author: hydrated.author ?? primary.author,
          exactVideo: hydrated.exactVideo || primary.exactVideo };
        if (hydrated.count !== undefined) count = Math.max(count ?? 0, hydrated.count);
        if (hydrated.comments.map(store).some(Boolean)) quietSince = Date.now();
        continue;
      }
      const advanced = !found.end && found.comments.length > 0 && await scrollCommentThread(page.locator('[data-ss-last-comment]').first());
      if (advanced) quietSince = Date.now();
      if (advanced || idle < settleMs) {
        await page.waitForTimeout(600);
        continue;
      }
      if (found.expanders.length || found.loading) {
        return result(false, 'Facebook còn nút tải thêm hoặc đang tải bình luận. Đã lưu phần đọc được.');
      }
      if (verified) {
        if (count === topLevel && topLevel < seen.size) {
          count = seen.size;
          return result(true, `Facebook hiển thị ${topLevel} bình luận gốc. Đã đọc thêm ${seen.size - topLevel} phản hồi.`);
        }
        return result(true);
      }
      return result(false, seen.size
        ? 'Đã kiểm tra hết các trang và nhánh phản hồi đang hiển thị. Facebook chưa xác nhận đã trả đủ bình luận.'
        : 'Phiên đọc chưa thấy luồng bình luận của bài này trên Facebook.');
    }
  } catch (error) {
    if (!seen.size || !(page.isClosed() || (error instanceof Error && /execution context was destroyed|target page, context or browser has been closed/i.test(error.message)))) throw error;
    return result(false, 'Facebook đã ngắt trang bình luận. Đã lưu phần đọc được.');
  }
  return result(false, 'Đã lưu phần đọc được trước khi hết thời gian quét bình luận.');
}
