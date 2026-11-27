export const instagramAccess = { origins: ['https://www.instagram.com/*'] };

export async function readInstagram(mode, requested, limit, deadline, checkpoint, jobId, embed) {
  const origin = 'https://www.instagram.com';
  const identity = raw => {
    try {
      const url = new URL(raw, origin);
      if (url.origin !== origin) return null;
      const path = url.pathname.replace(/\/+$/, '');
      const post = /^\/(?:([a-z0-9_.]{1,30})\/)?(p|reels?|tv)\/([\w-]{1,32})$/i.exec(path);
      if (post) {
        const [, owner, rawSurface, id] = post;
        const surface = rawSurface.toLowerCase();
        return { id: 'post:' + id, kind: surface.startsWith('reel') ? 'reel' : surface === 'tv' ? 'video' : 'post',
          owner: owner?.toLowerCase(), url: origin + '/' + (surface === 'reels' ? 'reel' : surface) + '/' + id + '/' };
      }
      const name = /^\/([a-z0-9_.]{1,30})$/i.exec(path)?.[1]?.toLowerCase();
      if (!name || !/[a-z0-9]/.test(name)
        || /^(accounts|api|about|challenge|developer|direct|explore|legal|oauth|p|reel|reels|stories|tv)$/.test(name)) return null;
      return { id: 'profile:' + name, url: origin + '/' + name + '/' };
    } catch {
      return null;
    }
  };
  const expected = identity(requested);
  const live = () => Date.now() < deadline && expected && identity(location.href)?.id === expected.id;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const trimmed = (value, max) => String(value ?? '').trim().slice(0, max);
  const visible = el => Boolean(el.getClientRects().length && !el.closest('[hidden],[aria-hidden="true"]'));
  const all = (scope, selector) => [...scope.querySelectorAll(selector)].filter(visible);
  const mainRegion = () => document.querySelector('main,[role="main"]');
  const blocker = () => {
    const path = location.pathname;
    if (/^\/(?:challenge|checkpoint)(?:\/|$)/.test(path)) return 'IG_CHALLENGE';
    if (/^\/accounts\/(?:login|signup)(?:\/|$)/.test(path)) return 'IG_LOGIN';
    const main = mainRegion();
    const dialogs = all(document, '[role="dialog"]');
    const message = [main, ...all(document, '[role="alert"]'), ...dialogs]
      .map(region => region?.innerText ?? '').join('\n').slice(0, 7_000);
    if (/this account is private|tài khoản này (?:ở chế độ |là )?riêng tư|follow this account to see/i.test(message)) return 'IG_PRIVATE';
    if (/no posts yet|chưa có bài viết nào/i.test(message)) return 'IG_NO_POSTS';
    if (/sorry, this page isn.t available|trang này không (?:còn )?khả dụng/i.test(message)) return 'IG_UNAVAILABLE';
    if (/log in to see (?:photos|posts|more)|đăng nhập để xem (?:ảnh|bài viết|thêm)/i.test(message)
      || dialogs.some(dialog => /see (?:photos|videos)[\s\S]*more from|never miss a post|xem ảnh, video|không bỏ lỡ bài viết/i.test(dialog.innerText)
        && /\blog in\b|đăng nhập/i.test(dialog.innerText))
      || all(document, 'input[type="password"]').some(input => input.closest('main,[role="main"],[role="dialog"]'))) return 'IG_LOGIN';
    return null;
  };
  const wait = async (find, ms) => {
    const until = Math.min(deadline, Date.now() + ms);
    while (live() && Date.now() < until) {
      const value = find();
      if (value) return value;
      await pause(150);
    }
    return null;
  };
  if (mode === 'profile-tick' && Date.now() >= deadline) return null;
  if (!live()) return { issue: blocker() ?? 'IG_NAVIGATION' };

  if (mode === 'profile' || mode === 'profile-step' || mode === 'profile-tick') {
    const progressive = mode !== 'profile';
    const singleTick = mode === 'profile-tick';
    const rows = new Map((checkpoint?.rows ?? []).flatMap(row => {
      const post = identity(row.url);
      return post?.kind ? [[post.id, row]] : [];
    }));
    let scrollSteps = checkpoint?.scrollSteps ?? 0;
    // This lives only in the isolated world of the current Instagram document.
    const paging = progressive ? (globalThis.__seedingInstagramPaging?.id === jobId ? globalThis.__seedingInstagramPaging
      : (globalThis.__seedingInstagramPaging = { id: jobId, moreAtCount: -1 })) : { moreAtCount: -1 };
    const report = stopReason => ({ kind: 'RESEARCH_PROFILE', url: requested, rows: [...rows.values()].slice(0, limit),
      partial: rows.size < limit, scrollSteps, ...(stopReason && rows.size < limit && { stopReason }) });
    const knownPostCount = () => {
      const metadata = document.querySelector('meta[property="og:description"]')?.content;
      const match = /(?:^|[,–-]\s*)(\d{1,3}(?:[.,]\d{3})+|\d+)\s+(?:posts?|bài viết)\b/i.exec(metadata ?? '');
      return match ? Number(match[1].replace(/[.,]/g, '')) : null;
    };
    const grid = () => {
      const region = mainRegion() ?? document.querySelector('article,[role="article"]');
      if (!region) return [];
      return all(region, 'a[href]').flatMap(anchor => {
        if (anchor.closest('header,nav,aside,footer,[role="navigation"],[role="dialog"]')) return [];
        const post = identity(anchor.href);
        return post?.kind && (!post.owner || 'profile:' + post.owner === expected.id) ? [{ anchor, post }] : [];
      });
    };
    const showMore = () => {
      const region = mainRegion();
      if (!region) return null;
      const buttons = all(region, 'button,[role="button"]')
        .filter(button => !button.closest('[role="dialog"],header,nav') && !button.disabled && button.getAttribute('aria-disabled') !== 'true')
        .filter(button => /^(?:(?:show|load|see|view) more posts(?: from [a-z0-9_.]+)?|(?:xem|tải|hiện|hiển thị) thêm bài viết(?: (?:của|từ) [a-z0-9_.]+)?)$/i
          .test(trimmed(button.getAttribute('aria-label') || button.innerText, 100)));
      return buttons.length === 1 ? buttons[0] : null;
    };
    const scrollRoot = anchor => {
      for (let parent = anchor?.parentElement; parent; parent = parent.parentElement) {
        if (parent.clientHeight && parent.scrollHeight - parent.clientHeight > 2
          && /^(?:auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)) {
          return parent;
        }
      }
      return document.scrollingElement ?? document.documentElement;
    };
    const withinViewport = (button, root) => {
      const bounds = button.getBoundingClientRect();
      const viewport = root === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : root.getBoundingClientRect();
      return bounds.top < Math.min(window.innerHeight, viewport.bottom) && bounds.bottom > Math.max(0, viewport.top);
    };
    const advance = root => {
      const viewport = root.clientHeight || window.innerHeight;
      root.scrollBy({ top: Math.max(1, Math.round(viewport * 0.55)), behavior: 'instant' });
    };
    const outerWithRoom = root => {
      const documentRoot = document.scrollingElement ?? document.documentElement;
      for (let outer = root; outer !== documentRoot;) {
        outer = scrollRoot(outer);
        if (outer.scrollTop + (outer.clientHeight || window.innerHeight) < outer.scrollHeight - 2) return outer;
      }
      return null;
    };
    const recoverBottom = (root, more, idleMs) => {
      const outer = outerWithRoom(root);
      if (outer) {
        advance(outer);
        return true;
      }
      if (idleMs < 900) return false;
      const viewport = root.clientHeight || window.innerHeight;
      const now = Date.now();
      const recovery = paging.bottomRecovery?.count === rows.size ? paging.bottomRecovery : { count: rows.size, at: 0, attempts: 0 };
      if (recovery.attempts >= 2 || now - recovery.at < 2500) return false;
      if (more && withinViewport(more, root)) more.click();
      else if (root.scrollTop > 2) {
        // Move the last loaded tiles out of view so Instagram can observe them entering again.
        root.scrollBy({ top: -Math.min(root.scrollTop, Math.max(3, Math.round(viewport * 0.6))), behavior: 'instant' });
      } else return false;
      paging.bottomRecovery = { count: rows.size, at: now, attempts: recovery.attempts + 1 };
      return true;
    };
    const readyGrid = () => {
      const failure = blocker();
      if (failure) return { issue: failure };
      const tiles = grid();
      return tiles.length ? { tiles } : null;
    };
    const first = singleTick ? readyGrid() : await wait(readyGrid, 18_000);
    if (!first?.tiles) {
      const issue = first?.issue ?? blocker();
      if (issue) return rows.size ? report(issue) : { issue };
      return progressive ? report() : { issue: mainRegion() ? 'IG_NO_GRID' : 'IG_NO_MAIN' };
    }
    let lastTile = first.tiles.at(-1)?.anchor;
    let lastActivity = (singleTick && paging.lastActivity) || Date.now();
    let previousScroll = singleTick ? paging.previousScroll ?? null : null;
    let stopReason;
    for (let tiles = first.tiles; live(); tiles = grid()) {
      stopReason = blocker();
      if (stopReason) break;
      const before = rows.size;
      for (const { post } of tiles) {
        if (!rows.has(post.id)) rows.set(post.id, { url: post.url, title: post.kind === 'reel' ? 'Reel Instagram' : 'Bài Instagram', body: '', captionPartial: true });
        if (rows.size === limit) break;
      }
      lastTile = tiles.at(-1)?.anchor ?? lastTile;
      const root = scrollRoot(lastTile);
      const position = root.scrollTop;
      const height = root.scrollHeight;
      const viewport = root.clientHeight || window.innerHeight;
      if (previousScroll?.root === root && position > previousScroll.position + 1) scrollSteps++;
      if (rows.size !== before || previousScroll?.root !== root || previousScroll.position !== position
        || previousScroll.height !== height) lastActivity = Date.now();
      previousScroll = { root, position, height };
      if (rows.size === limit) break;

      const more = showMore();
      if (more && paging.moreAtCount !== rows.size && withinViewport(more, root)) {
        paging.moreAtCount = rows.size;
        lastActivity = Date.now();
        more.click();
      } else if (position + viewport < height - 2) {
        // Crossing each part of the grid lets Instagram's lazy-loading observers fire.
        advance(root);
      } else if (progressive) {
        const total = more ? null : knownPostCount();
        if (total !== null && rows.size >= total) {
          stopReason = 'IG_NO_MORE';
          break;
        }
        if (recoverBottom(root, more, Date.now() - lastActivity)) lastActivity = Date.now();
      }
      if (!progressive && Date.now() - lastActivity >= 15_000) {
        stopReason = 'IG_NO_MORE';
        break;
      }
      if (singleTick) {
        paging.lastActivity = lastActivity;
        paging.previousScroll = previousScroll;
        break;
      }
      await pause(300);
    }
    if (progressive) {
      const issue = stopReason ?? blocker() ?? (identity(location.href)?.id === expected.id ? undefined : 'IG_NAVIGATION');
      return issue && !rows.size ? { issue } : report(issue);
    }
    if (!rows.size) return { issue: blocker() ?? 'IG_NAVIGATION' };
    const partial = rows.size < limit;
    return report(partial ? stopReason ?? blocker() ?? (Date.now() >= deadline ? 'IG_LOAD_TIMEOUT' : 'IG_NAVIGATION') : undefined);
  }

  if (!expected.kind) return { issue: 'IG_NAVIGATION' };
  const main = await wait(mainRegion, 12_000);
  if (!main) return { issue: blocker() ?? 'IG_NO_MAIN' };
  const initialBlock = blocker();
  if (initialBlock) return { issue: initialBlock };
  const meta = key => document.querySelector('meta[property="' + key + '"]')?.content;
  const mediaUrl = raw => {
    try {
      const url = new URL(raw);
      if (String(raw).length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port
        || !/(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)) return null;
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  };
  const canonical = () => identity(document.querySelector('link[rel="canonical"]')?.href || meta('og:url') || '/');
  const scope = await wait(() => {
    const candidates = all(main, 'article,[role="article"]').filter(el => !el.parentElement.closest('article,[role="article"]'));
    const anchored = candidates.filter(el => all(el, 'a[href]').some(a => identity(a.href)?.id === expected.id));
    if (anchored.length === 1) return anchored[0];
    if (candidates.length === 1 && (!canonical()?.kind || canonical()?.id === expected.id)) return candidates[0];
    return candidates.length === 0 && canonical()?.id === expected.id && !all(main, 'a[href]').some(a => {
      const link = identity(a.href);
      return link?.kind && link.id !== expected.id;
    }) ? main : null;
  }, 6500);
  if (!scope) return { issue: blocker() ?? 'IG_NO_GRID' };

  const descriptions = () => all(scope, '[data-testid="post-caption"],[data-testid="caption"],h1')
    .filter(el => !el.closest('header') && trimmed(el.innerText, 16000));
  const captionNode = descriptions()[0];
  const more = captionNode && all(captionNode.parentElement, 'button,[role="button"]').filter(button =>
    /^(?:more|see more|thêm|xem thêm)$/i.test(trimmed(button.getAttribute('aria-label') ?? button.innerText, 40)));
  if (more?.length === 1 && live()) { more[0].click(); await pause(250); }
  const description = canonical()?.id === expected.id ? meta('og:description') : null;
  const quoted = description?.match(/:\s*["“]([\s\S]*?)["”]\s*\.?$/)?.[1];
  const articleText = descriptions()[0]?.innerText;
  const rawCaption = embed?.caption ?? (articleText || quoted || '');
  const body = rawCaption.slice(0, 16000);
  const captionPartial = embed?.caption == null && (rawCaption.length > body.length
    || (!!body && /(?:…|\.\.\.|xem thêm|see more)$/i.test(body.trim())) || (!articleText && !!description && quoted === undefined));
  const authorLink = all(scope, 'header a[href]').map(a => identity(a.href)).find(item => item && !item.kind);
  const author = authorLink?.id.slice('profile:'.length) ?? '';

  const carouselButtons = pattern => {
    const matches = all(scope, 'button,[role="button"]').filter(node => !node.closest('header,aside') && !node.disabled
      && node.getAttribute('aria-disabled') !== 'true' && [node.getAttribute('aria-label'), node.getAttribute('title'),
        node.innerText, ...[...node.querySelectorAll('svg[aria-label],svg title')].map(icon => icon.getAttribute('aria-label') ?? icon.textContent)]
        .some(label => pattern.test(trimmed(label, 60))));
    return matches.filter(node => !matches.some(other => other !== node && node.contains(other)));
  };
  const next = () => carouselButtons(/^(?:next(?: slide| photo)?|tiếp|tiếp theo|ảnh tiếp theo)$/i);
  const previous = () => carouselButtons(/^(?:previous(?: slide| photo)?|trước|trước đó|ảnh trước)$/i);
  const inside = element => {
    const r = element.getBoundingClientRect();
    return r.width >= 140 && r.height >= 90 && r.left < innerWidth && r.right > 0;
  };
  const activeAsset = () => {
    const video = all(scope, 'video').find(inside);
    if (video || expected.kind !== 'post' || carouselButtons(/^(?:play video|phát video)$/i).length === 1) {
      const url = (expected.kind !== 'post' && mediaUrl(embed?.video))
        || mediaUrl(video?.currentSrc) || mediaUrl(video?.src) || mediaUrl(video?.querySelector('source[src]')?.src)
        || (canonical()?.id === expected.id && (mediaUrl(meta('og:video:secure_url')) || mediaUrl(meta('og:video'))));
      return url ? { kind: 'video', url } : null;
    }
    const image = all(scope, 'img').filter(el => !el.closest('header,aside') && inside(el))
      .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height
        - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
    const candidates = (image?.srcset ?? '').split(',').flatMap(entry => {
      const [source, resolution] = entry.trim().split(/\s+/);
      const url = mediaUrl(source);
      const width = /^(\d+)w$/.exec(resolution ?? '')?.[1];
      return url && width ? [{ url, width: Number(width) }] : [];
    }).sort((a, b) => b.width - a.width);
    const url = candidates[0]?.url || mediaUrl(image?.currentSrc || image?.src)
      || (canonical()?.id === expected.id && !next().length && mediaUrl(meta('og:image')));
    return url ? { kind: 'image', url } : null;
  };
  const structured = Array.isArray(embed?.media) && embed.media.length === embed.declaredMediaCount
    && embed.media.length > 0 && embed.media.length <= 20 && embed.media.every(item => ['video', 'image'].includes(item.kind) && mediaUrl(item.url));
  const media = structured ? [...embed.media] : [];
  let partial = !structured && previous().length > 0;
  let current = structured ? null : await wait(activeAsset, 7500);
  if (current) media.push(current);
  const firstHasNext = !structured && next().length === 1;
  while (current && live() && !partial && media.length < 20) {
    const forward = next();
    if (!forward.length) break;
    if (forward.length !== 1) { partial = true; break; }
    forward[0].click();
    const updated = await wait(() => {
      const asset = activeAsset();
      return asset && asset.url !== current.url ? asset : null;
    }, 4500);
    if (!updated || media.some(item => item.url === updated.url)) { partial = true; break; }
    media.push(updated);
    current = updated;
  }
  if (!live() || blocker()) return { issue: blocker() ?? 'IG_NAVIGATION' };
  const declared = structured ? embed.declaredMediaCount : Number.isSafeInteger(embed?.declaredMediaCount) ? embed.declaredMediaCount : null;
  const visitedWholeCarousel = firstHasNext && media.length > 1 && next().length === 0 && !partial;
  const singleVideo = expected.kind !== 'post' && media.length === 1 && media[0].kind === 'video';
  const expectedMediaCount = declared ?? (visitedWholeCarousel || singleVideo ? media.length : null);
  const mediaPartial = partial || expectedMediaCount === null || media.length !== expectedMediaCount || (!structured && next().length > 0);
  return { kind: 'RESEARCH_POST', url: requested, body, captionPartial, author, authorUrl: authorLink?.url ?? null,
    location: '', hasMedia: true, mediaPartial, partial: mediaPartial || captionPartial, sourceKind: expected.kind,
    mediaLinks: media.map(item => item.url), instagramMedia: media, ...(expectedMediaCount !== null && { expectedMediaCount }) };
}

export const instagramTabKey = 'instagramResearchTab';

function instagramProfilePath(raw) {
  try {
    const url = new URL(raw);
    return url.origin === 'https://www.instagram.com' ? url.pathname.replace(/\/+$/, '').toLowerCase() : null;
  } catch { return null; }
}

export async function closeInstagramResearchTab(id) {
  const { [instagramTabKey]: entry } = await chrome.storage.session.get(instagramTabKey);
  if (!entry || (id && entry.id !== id)) return;
  await chrome.storage.session.remove(instagramTabKey);
  const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
  if (entry.owned && instagramProfilePath(tab?.url) === instagramProfilePath(entry.url) && !tab?.pendingUrl) {
    await chrome.tabs.remove(entry.tabId).catch(() => {});
  }
}

export async function scanInstagramStep(command, deadline, sameUid) {
  if (!await chrome.permissions.contains(instagramAccess)) return { report: null, issue: 'IG_PERMISSION' };
  if (!await sameUid()) return { report: null, issue: 'IG_UID_CHANGED' };
  const { [instagramTabKey]: entry } = await chrome.storage.session.get(instagramTabKey);
  let tab = entry?.id === command.id ? await chrome.tabs.get(entry.tabId).catch(() => null) : null;
  if (!tab || tab.discarded || tab.frozen) {
    if (entry) await closeInstagramResearchTab(entry.id);
    const expected = instagramProfilePath(command.url);
    const existing = (await chrome.tabs.query({ url: 'https://www.instagram.com/*' }))
      .find(candidate => !candidate.pendingUrl && !candidate.discarded && !candidate.frozen
        && instagramProfilePath(candidate.url) === expected);
    tab = existing ?? await chrome.tabs.create({ url: command.url, active: false });
    if (tab.id === undefined) return { report: null, issue: 'IG_BROWSER' };
    await chrome.storage.session.set({ [instagramTabKey]: { id: command.id, tabId: tab.id, owned: !existing, url: command.url } });
    if (!existing) await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => undefined);
  }
  const pending = { report: null, pending: true };
  if (tab.pendingUrl || !tab.url) return pending;
  if (!instagramProfilePath(tab.url)) return { report: null, issue: 'IG_NAVIGATION' };

  let checkpoint = command.checkpoint;
  let response = pending;
  while (Date.now() < deadline) {
    let timer;
    let result;
    try {
      // The renderer only performs one DOM operation. The extension worker controls the cadence.
      const script = chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readInstagram,
        args: ['profile-tick', command.url, command.limit, deadline, checkpoint, command.id] });
      result = await Promise.race([script, new Promise(resolve => { timer = setTimeout(resolve, Math.min(4000, deadline - Date.now())); })]);
    } catch (error) {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (!current || current.discarded || current.frozen || current.pendingUrl) break;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const value = result?.[0]?.result;
    if (!value) break;
    if (!value.kind) {
      response = { report: null, issue: value.issue };
      break;
    }
    checkpoint = value;
    response = { report: value, pending: value.partial && !value.stopReason };
    if (!response.pending) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(300, remaining)));
  }
  return await sameUid() ? response : { report: null, issue: 'IG_UID_CHANGED' };
}
