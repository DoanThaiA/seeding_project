/// <reference lib="dom" />
import type { Page } from 'playwright-core';
import { type ProfileDetailsSnapshot, PROFILE_ABOUT_SECTIONS } from '@seedingsys/contracts';
import { ConnectorError } from '@seedingsys/connectors-core';

type Section = ProfileDetailsSnapshot['sections'][number];
const displayedHeading = 'h1,h2,h3,[role="heading"]';
const INTRO = /^(?:Giới thiệu|Intro|Introduction)$/i;
const PERSONAL = /^(?:Thông tin cá nhân|Personal information|Personal details)$/i;
const BIO_EDIT = /^(?:Thêm tiểu sử|Chỉnh sửa tiểu sử|Add bio|Edit bio)$/i;
const BIO_BOX = /(?:tiểu sử|bio|describe who you are)/i;
const SAVE = /^(?:Lưu|Lưu thay đổi|Save|Save changes)$/i;

function evaluateProfilePage<T, A>(page: Page, read: (arg: A) => T, arg: A) {
  return page.evaluate<T>('((__name) => (' + read.toString() + ')(' + JSON.stringify(arg) + '))(value => value)');
}

/** Some Facebook profiles omit the main heading and show the name as a link to the verified profile. */
export async function readProfileName(page: Page, aliases: ReadonlySet<string>) {
  const title = page.locator('h1:visible,[role="heading"][aria-level="1"]:visible');
  const readLinkedName = () => evaluateProfilePage(page, ({ headingSelector, expected }) => {
    const keyOf = (href: string) => {
      try {
        const url = new URL(href, location.href);
        if (url.origin !== location.origin) return null;
        const path = url.pathname.replace(/\/$/, '');
        return path === '/profile.php' ? url.searchParams.get('id') :
          (path.match(/^\/people\/[^/]+\/(\d+)$/)?.[1] ?? path.match(/^\/([\w.]+)$/)?.[1])?.toLowerCase();
      } catch { return null; }
    };
    const names = new Set<string>();
    for (const heading of Array.from(document.querySelectorAll<HTMLElement>(headingSelector))) {
      if (!heading.getClientRects().length || heading.closest('[aria-hidden="true"],nav,[role="navigation"]')) continue;
      const links = [heading.closest<HTMLAnchorElement>('a[href]'), ...Array.from(heading.querySelectorAll<HTMLAnchorElement>('a[href]'))];
      for (const link of links) {
        if (!link) continue;
        const key = keyOf(link.href);
        const name = link.innerText.trim();
        if (key && expected.includes(key) && name && name.length <= 250 && heading.innerText.trim() === name) names.add(name);
      }
    }
    if (names.size === 1) return [...names][0];
    // Some profile pages render the name outside a heading. Confirm a profile record against a visible owner link.
    const visibleOwnerNames = new Set<string>();
    for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      const key = keyOf(link.href);
      if (!key || !expected.includes(key) || !link.getClientRects().length || link.closest('[aria-hidden="true"],[hidden]')) continue;
      for (const value of [link.innerText, link.getAttribute('aria-label')]) if (value?.trim()) visibleOwnerNames.add(value.trim());
    }
    const avatarLabels = new Set(Array.from(document.querySelectorAll('svg[aria-label]'))
      .filter(avatar => avatar.getClientRects().length && !avatar.closest('[aria-hidden="true"],[hidden]'))
      .map(avatar => avatar.getAttribute('aria-label')?.trim()));
    const verified = new Set<string>();
    const hasNumericOwner = expected.some(key => /^\d+$/.test(key));
    for (const script of Array.from(document.querySelectorAll('script[type="application/json"]'))) {
      if (!script.textContent?.includes('"__isProfile"')) continue;
      let data;
      try { data = JSON.parse(script.textContent); } catch { continue; }
      const pending = [data];
      while (pending.length) {
        const node = pending.pop();
        if (!node || typeof node !== 'object') continue;
        for (const child of Object.values(node)) if (child && typeof child === 'object') pending.push(child);
        if (!node.__isProfile || typeof node.name !== 'string' || typeof node.url !== 'string') continue;
        const key = keyOf(node.url);
        const id = String(node.id ?? '');
        const name = node.name.trim();
        if (!key || (!expected.includes(key) && !expected.includes(id)) || !name || name.length > 250) continue;
        if (hasNumericOwner && /^\d+$/.test(id) && !expected.includes(id)) continue;
        // The header avatar points to a photo, so its label needs confirmation from the active profile record.
        const renderedOwner = node.__isRenderedProfile && expected.includes(key) && avatarLabels.has(name);
        if (visibleOwnerNames.has(name) || renderedOwner) verified.add(name);
      }
    }
    return verified.size === 1 ? [...verified][0] : undefined;
  }, { headingSelector: displayedHeading, expected: [...aliases] });
  const deadline = Date.now() + 8500;
  do {
    const names = [...new Set((await title.allInnerTexts()).map(name => name.trim()).filter(Boolean))];
    if (names.length === 1 && names[0].length <= 250) return names[0];
    const linked = await readLinkedName();
    if (linked) return linked;
    await page.waitForTimeout(350);
  } while (Date.now() < deadline);
}

/** Pick the profile's Intro card and the bio block immediately before its Add/Edit control or details list. */
export async function readProfileIntro(page: Page) {
  return evaluateProfilePage(page, ({ headingSelector, introPattern, personalPattern, editPattern }) => {
      const mains = Array.from(document.querySelectorAll('main,[role="main"]'));
      const visible = (element: Element) => element.getClientRects().length && !element.closest('[aria-hidden="true"],[hidden]');
      const text = (element: Element) => (element as HTMLElement).innerText.trim();
      const candidates = [...new Set(mains.flatMap(main => Array.from(main.querySelectorAll(headingSelector))))].filter(visible);
      const intro = candidates.filter(element => new RegExp(introPattern, 'i').test(text(element)));
      const matches = intro.length ? intro : candidates.filter(element => new RegExp(personalPattern, 'i').test(text(element)));
      const headings = matches.filter(element => !matches.some(other => element !== other && element.contains(other)));
      if (headings.length !== 1) return { bio: undefined, intro: [] as string[] };
      const [heading] = headings;
      const explicit = '[data-profile-bio],[data-testid="profile-bio"]';
      const controls = 'button,[role="button"]';
      const feed = 'article,[role="article"],[data-pagelet^="FeedUnit"]';
      let card: Element | undefined;
      let scope: Element | null = heading.parentElement;
      while (scope && !mains.includes(scope)) {
        if (scope.querySelector(feed) || Array.from(scope.querySelectorAll('h2,[role="heading"][aria-level="2"]')).some(other =>
          visible(other) && !other.contains(heading) && !heading.contains(other))) break;
        card = scope;
        if (scope.matches('section,[role="region"],[data-profile-intro]')) break;
        scope = scope.parentElement;
      }
      if (!card) return { bio: undefined, intro: [] as string[] };
      const bioRows = Array.from(card.querySelectorAll(explicit)).filter(visible);
      const edit = Array.from(card.querySelectorAll(controls)).find(el => visible(el) && new RegExp(editPattern, 'i').test(text(el)));
      const items = Array.from(card.querySelectorAll('li,[role="listitem"],[data-profile-intro-item]')).filter(visible).map(text).filter(Boolean);
      // Some profiles render the Intro rows without list roles. The first
      // detail icon also bounds the standalone bio above the rows.
      const firstDetails = Array.from(card.querySelectorAll('ul,[role="list"],li,[role="listitem"],[data-profile-intro-item],svg,img,i[style]'))
        .find(el => visible(el) && !heading.contains(el)
          && !!(heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
      const before = edit ?? firstDetails;
      const preceding = Array.from(card.querySelectorAll('div[dir="auto"],span[dir="auto"]')).filter(el =>
        visible(el) && !el.contains(heading) && !heading.contains(el) && !el.closest('a,button,[role="button"],li,[role="listitem"]') &&
        !!before && !!(el.compareDocumentPosition(before) & Node.DOCUMENT_POSITION_FOLLOWING) && !el.contains(before) && !!text(el));
      const leaves = preceding.filter(el => !preceding.some(other => el !== other && el.contains(other)));
      const bio = bioRows.length === 1 ? text(bioRows[0]) : (intro.length || edit) && leaves.length === 1 ? text(leaves[0]) : undefined;
      const bioLines = new Set(bio?.split(/\n+/).map(line => line.trim()));
      const fallback = !items.length ? text(card).split(/\n+/).map(value => value.trim()).filter(value => value &&
        value !== text(heading) && !bioLines.has(value)
        && !/^(?:xem thêm|see more|thu gọn|see less|chỉnh sửa|edit)$/i.test(value)) : [];
      return { bio: bio || undefined, intro: [...new Set([...items, ...fallback])].filter(value => value.length <= 2000).slice(0, 40) };
    }, { headingSelector: displayedHeading, introPattern: INTRO.source, personalPattern: PERSONAL.source, editPattern: BIO_EDIT.source });
}

const SECTION_HEADINGS: Record<Section['key'], RegExp> = {
  overview: /^(?:Giới thiệu|Tổng quan|Thông tin cá nhân|Công việc|Học vấn|Giáo dục|Nơi từng sống|Thông tin liên hệ|Trang web|Danh mục|About|Overview|Personal information|Work|Education|Places lived|Contact info|Website|Category)$/i,
  work_and_education: /^(?:Công việc và học vấn|Công việc|Học vấn|Học tập|Giáo dục|Trường trung học|Trung học|Đại học|Work and education|Work|Education|High school|College|University)$/i,
  places: /^(?:(?:Các )?Nơi (?:(?:từng|đã) )?sống|(?:Tỉnh\/)?Thành phố hiện tại và quê quán|Places lived|Places you've lived|Current city and hometown)$/i,
  contact_and_basic_info: /^(?:Thông tin liên hệ và cơ bản|Thông tin liên hệ|Thông tin cơ bản|Thông tin cá nhân|Giới tính|Ngày sinh|Trang web và liên kết (?:mạng )?xã hội|Contact and basic info|Contact info|Basic info|Personal details|Gender|Birthday|Websites and social links)$/i,
  family_and_relationships: /^(?:Gia đình và các mối quan hệ|Gia đình|Thành viên gia đình|Mối quan hệ|Family and relationships|Family members|Relationship)$/i,
  details: /^(?:Chi tiết về .+|Giới thiệu về .+|Cách phát âm tên|Tên khác|Trích dẫn yêu thích|Details about .+|About .+|Name pronunciation|Other names|Favorite quotes)$/i,
  life_events: /^(?:Sự kiện trong đời|Sự kiện cuộc đời|Life events)$/i,
};

async function readSection(page: Page, key: Section['key'], directoryHref?: string, activeTabHref?: string): Promise<Section['categories']> {
  const headings = page.locator(`main :is(${displayedHeading}),[role="main"] :is(${displayedHeading})`);
  const ready = directoryHref ? headings.and(page.locator('section *')) : headings.filter({ hasText: SECTION_HEADINGS[key] });
  await ready.filter({ visible: true }).first().waitFor({ timeout: 3000 }).catch(() => undefined);
  const read = () => evaluateProfilePage(page, ({ headingSelector, pattern, directoryHref, activeTabHref }) => {
    const nodes = [...new Set(Array.from(document.querySelectorAll('main,[role="main"]')).flatMap(main => Array.from(main.querySelectorAll(headingSelector))))];
    const visible = (element: Element) => element.getClientRects().length && !element.closest('[aria-hidden="true"],[hidden],nav,[role="navigation"]');
    const read = (element: Element) => (element as HTMLElement).innerText.trim();
    const known = new RegExp(pattern, 'i');
    const directoryTab = directoryHref && Array.from(document.querySelectorAll<HTMLAnchorElement>('a[role="tab"][href]'))
      .find(tab => tab.href === directoryHref && visible(tab));
    let directoryPanel: Element | undefined;
    if (directoryTab) {
      for (let el = directoryTab.parentElement; el && !el.matches('main,[role="main"],body'); el = el.parentElement) {
        if (nodes.some(heading => visible(heading) && el.contains(heading) && heading.closest('section'))) {
          directoryPanel = el;
          break;
        }
      }
    }
    const matching = nodes.filter(el => visible(el) && !el.closest('a,button,[role="tab"],[role="button"]')
      && (directoryPanel ? directoryPanel.contains(el) && !!el.closest('section') : known.test(read(el))));
    const categories = new Map<string, Set<string>>();
    document.querySelectorAll('[data-ss-profile-more]').forEach(element => element.removeAttribute('data-ss-profile-more'));
    const markMore = (field?: Element) => {
      for (const button of Array.from(field?.querySelectorAll('button,[role="button"]') ?? [])) {
        const label = button.getAttribute('aria-label') || read(button);
        if (visible(button) && !button.closest('form,a,[role="dialog"]') && button.getAttribute('aria-expanded') !== 'true'
          && !button.hasAttribute('data-ss-profile-more-tried')
          && /^(?:xem thêm|hiển thị thêm|see more|show more)$/i.test(label.trim())) button.setAttribute('data-ss-profile-more', '1');
      }
    };
    const fieldLines = (field: Element, label: string) => read(field).split(/\n+/).map(line => line.trim()).filter(line =>
      line && line !== label && line.length <= 2000
      && !/^(?:công khai|chỉ mình tôi|bạn bè|public|only me|friends|xem thêm|hiển thị thêm|see more|show more|thu gọn|see less|thêm|add|chỉnh sửa|edit)$/i.test(line));
    const store = (label: string, values: string[]) => {
      if (!label || label.length > 250 || !values.length) return;
      const prior = categories.get(label) ?? new Set<string>();
      for (const value of values) {
        if (!/^(?:không có|chưa có|no ).*(?:để hiển thị|to show)[.!]?$/i.test(value)) prior.add(value);
      }
      categories.set(label, prior);
    };
    for (const heading of matching.filter(el => !matching.some(other => el !== other && el.contains(other)))) {
      const label = read(heading);
      let scope = heading.parentElement;
      let field: Element | undefined;
      let values: string[] = [];
      while (scope && !scope.matches('main,[role="main"],body')) {
        if (scope.querySelector('article,[role="article"],nav,[role="navigation"],[role="tab"]')) break;
        const otherHeading = Array.from(scope.querySelectorAll(headingSelector)).some(other => visible(other) && !other.contains(heading) && !heading.contains(other));
        if (otherHeading) break;
        field = scope;
        const content = fieldLines(scope, label);
        if (content.length) values = content;
        if (scope.matches('section,[role="region"],[data-profile-category]')) break;
        scope = scope.parentElement;
      }
      markMore(field);
      store(label, values);
    }
    if (!categories.size && activeTabHref) {
      const active = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[role="tab"][href]')).find(tab => tab.href === activeTabHref
        && visible(tab) && (tab.getAttribute('aria-selected') === 'true' || ['true', 'page'].includes(tab.getAttribute('aria-current') ?? '')));
      const sidebar = active?.closest('[role="tablist"][aria-orientation="vertical"]')?.parentElement;
      const companions = Array.from(sidebar?.parentElement?.children ?? []).filter(el =>
        el !== sidebar && visible(el) && !el.querySelector('[role="tab"],nav,article,[role="article"]'));
      if (active && companions.length === 1) {
        const label = read(active);
        markMore(companions[0]);
        store(label, fieldLines(companions[0], label));
      }
    }
    return [...categories].slice(0, 30).map(([label, values]) => ({ label, values: [...values].slice(0, 100) }));
  }, { headingSelector: displayedHeading, pattern: SECTION_HEADINGS[key].source, directoryHref, activeTabHref });
  let categories = await read();
  const location = page.url();
  for (let pass = 0; pass < 5; pass++) {
    const more = page.locator('[data-ss-profile-more]:visible').first();
    if (!await more.count()) break;
    await more.evaluate(element => element.setAttribute('data-ss-profile-more-tried', '1'), undefined, { timeout: 900 }).catch(() => undefined);
    if (!await more.click({ timeout: 900 }).then(() => true, () => false)) break;
    await page.waitForTimeout(350);
    if (page.url() !== location) break;
    const expanded = await read();
    if (expanded.length) categories = expanded;
  }
  return categories;
}

function aboutUrl(profile: URL, key: Section['key']) {
  const url = new URL(profile);
  const tab = key === 'overview' ? 'about' : 'about_' + key;
  if (url.pathname === '/profile.php') url.searchParams.set('sk', tab);
  else url.pathname = url.pathname.replace(/\/$/, '') + '/' + tab;
  return url;
}

export function profilePageKey(url: URL) {
  const path = url.pathname.replace(/\/$/, '');
  if (path === '/profile.php') return url.searchParams.get('id') ?? '';
  return (path.match(/^\/people\/[^/]+\/(\d+)$/)?.[1] ?? path.match(/^\/([\w.]+)$/)?.[1] ?? '').toLowerCase();
}

function aboutRoute(value: string, profile: URL, aliases: ReadonlySet<string>) {
  const url = new URL(value);
  if (url.origin !== profile.origin) return;
  const path = url.pathname.replace(/\/$/, '');
  const route = url.searchParams.get('sk') ?? path.split('/').at(-1);
  if (!route || !/^(?:about(?:_[a-z_]+)?|directory_personal_details)$/.test(route)) return;
  if (path.endsWith('/' + route)) url.pathname = path.slice(0, -route.length - 1) || '/';
  if (aliases.has(profilePageKey(url))) return route;
}

/** Confirm that navigation kept the same profile and landed on the requested About tab. */
export async function readProfileSections(page: Page, profile: URL, aliases: ReadonlySet<string>, assertSession: () => Promise<void>) {
  const open = async (href: string) => {
    const response = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => null);
    await assertSession();
    return response?.ok() ? aboutRoute(page.url(), profile, aliases) : undefined;
  };
  const links = () => page.locator('a[role="tab"][href]:visible').evaluateAll(elements =>
    elements.map(element => ({ href: (element as HTMLAnchorElement).href,
      selected: element.getAttribute('aria-selected') === 'true' || ['true', 'page'].includes(element.getAttribute('aria-current') ?? '') })));
  const homeAbout = (await links()).find(link => aboutRoute(link.href, profile, aliases) === 'about');
  const firstRoute = await open(homeAbout?.href ?? aboutUrl(profile, 'overview').href);
  const firstUrl = page.url();
  if (firstRoute) {
    await page.locator('a[role="tab"][href*="about_"],a[role="tab"][href*="directory_personal_details"]')
      .filter({ visible: true }).first().waitFor({ timeout: 2500 }).catch(() => undefined);
  }
  const tabs = new Map((await links()).flatMap(link => {
    const route = aboutRoute(link.href, profile, aliases);
    return route ? [[route, link] as const] : [];
  }));
  const directory = tabs.get('directory_personal_details');
  const discoverable = [...tabs.keys()].some(route => route !== 'about');
  const sections: Section[] = [];
  for (const key of PROFILE_ABOUT_SECTIONS) {
    let categories: Section['categories'] = [];
    const tab = 'about_' + key;
    if (key === 'overview' && (firstRoute === 'about' || firstRoute === 'about_overview') && !directory) {
      categories = await readSection(page, key, undefined, tabs.get('about_overview')?.href);
    } else if (key === 'contact_and_basic_info' && directory) {
      const route = directory.selected && page.url() === firstUrl && firstRoute ? firstRoute : await open(directory.href);
      if (route === 'about' || route === 'directory_personal_details') categories = await readSection(page, key, directory.href);
    } else if (key !== 'overview' && (tabs.has(tab) || !discoverable)) {
      const route = await open(tabs.get(tab)?.href ?? aboutUrl(profile, key).href);
      if (route === tab) categories = await readSection(page, key, undefined, tabs.get(tab)?.href);
    }
    sections.push({ key, status: categories.length ? 'VISIBLE' : 'UNAVAILABLE', categories });
  }
  return sections;
}

export async function prepareProfileBio(page: Page, bio: string) {
  const edit = page.getByRole('button', { name: BIO_EDIT }).filter({ visible: true });
  await edit.click();
  const named = page.getByRole('textbox', { name: BIO_BOX });
  const editor = named.or(page.getByPlaceholder(BIO_BOX)).filter({ visible: true });
  await editor.fill(bio);
  const current = await editor.evaluate(el => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el as HTMLElement).innerText);
  const normalize = (value: string) => value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (normalize(current) !== normalize(bio)) throw new ConnectorError('UI_UNEXPECTED', 'Tiểu sử xem trước khác nội dung đã quét.');
  const dialog = editor.locator('xpath=ancestor::*[@role="dialog"][1]');
  const scope = await dialog.count() ? dialog : editor.locator('xpath=ancestor::*[.//button or .//*[@role="button"]][1]');
  const scoped = scope.getByRole('button', { name: SAVE }).filter({ visible: true });
  const save = await scoped.count() ? scoped : page.getByRole('button', { name: SAVE }).filter({ visible: true });
  await save.waitFor({ state: 'visible' });
  if (await save.count() !== 1 || !await save.isEnabled()) throw new ConnectorError('UI_UNEXPECTED', 'Không xác định được nút lưu tiểu sử.');
  return save;
}
