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
  await title.first().waitFor({ timeout: 2500 }).catch(() => undefined);
  const names = [...new Set((await title.allInnerTexts()).map(name => name.trim()).filter(Boolean))];
  if (names.length === 1 && names[0].length <= 250) return names[0];
  return evaluateProfilePage(page, ({ headingSelector, expected }) => {
    const names = new Set<string>();
    for (const heading of Array.from(document.querySelectorAll<HTMLElement>(headingSelector))) {
      if (!heading.getClientRects().length || heading.closest('[aria-hidden="true"],nav,[role="navigation"]')) continue;
      const links = [heading.closest<HTMLAnchorElement>('a[href]'), ...Array.from(heading.querySelectorAll<HTMLAnchorElement>('a[href]'))];
      for (const link of links) {
        if (!link) continue;
        const url = new URL(link.href);
        if (url.origin !== location.origin) continue;
        const path = url.pathname.replace(/\/$/, '');
        const key = path === '/profile.php' ? url.searchParams.get('id') :
          (path.match(/^\/people\/[^/]+\/(\d+)$/)?.[1] ?? path.match(/^\/([\w.]+)$/)?.[1])?.toLowerCase();
        const name = link.innerText.trim();
        if (key && expected.includes(key) && name && name.length <= 250 && heading.innerText.trim() === name) names.add(name);
      }
    }
    return names.size === 1 ? [...names][0] : undefined;
  }, { headingSelector: displayedHeading, expected: [...aliases] });
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
      const firstDetails = Array.from(card.querySelectorAll('ul,[role="list"],li,[role="listitem"],[data-profile-intro-item]')).find(visible);
      const before = edit ?? firstDetails;
      const preceding = Array.from(card.querySelectorAll('div[dir="auto"],span[dir="auto"]')).filter(el =>
        visible(el) && !el.contains(heading) && !heading.contains(el) && !el.closest('a,button,[role="button"],li,[role="listitem"]') &&
        !!before && !!(el.compareDocumentPosition(before) & Node.DOCUMENT_POSITION_FOLLOWING) && !el.contains(before) && !!text(el));
      const leaves = preceding.filter(el => !preceding.some(other => el !== other && el.contains(other)));
      const bio = bioRows.length === 1 ? text(bioRows[0]) : (intro.length || edit) && leaves.length === 1 ? text(leaves[0]) : undefined;
      const fallback = !intro.length && !items.length ? text(card).split(/\n+/).map(value => value.trim()).filter(value => value &&
        value !== text(heading) && value !== bio && !/^(?:xem thêm|see more|chỉnh sửa|edit)$/i.test(value)) : [];
      return { bio: bio || undefined, intro: [...new Set([...items, ...fallback])].filter(value => value.length <= 2000).slice(0, 40) };
    }, { headingSelector: displayedHeading, introPattern: INTRO.source, personalPattern: PERSONAL.source, editPattern: BIO_EDIT.source });
}

const SECTION_HEADINGS: Record<Section['key'], RegExp> = {
  overview: /^(?:Giới thiệu|Tổng quan|Thông tin cá nhân|Công việc|Học vấn|Giáo dục|Nơi từng sống|Thông tin liên hệ|Trang web|Danh mục|About|Overview|Personal information|Work|Education|Places lived|Contact info|Website|Category)$/i,
  work_and_education: /^(?:Công việc và học vấn|Công việc|Học vấn|Giáo dục|Trường trung học|Đại học|Work and education|Work|Education|High school|College|University)$/i,
  places: /^(?:Nơi từng sống|Nơi đã sống|Tỉnh\/Thành phố hiện tại và quê quán|Places lived|Places you've lived|Current city and hometown)$/i,
  contact_and_basic_info: /^(?:Thông tin liên hệ và cơ bản|Thông tin liên hệ|Thông tin cơ bản|Trang web và liên kết xã hội|Contact and basic info|Contact info|Basic info|Websites and social links)$/i,
  family_and_relationships: /^(?:Gia đình và các mối quan hệ|Gia đình|Thành viên gia đình|Mối quan hệ|Family and relationships|Family members|Relationship)$/i,
  details: /^(?:Chi tiết về .+|Giới thiệu về .+|Cách phát âm tên|Tên khác|Trích dẫn yêu thích|Details about .+|About .+|Name pronunciation|Other names|Favorite quotes)$/i,
  life_events: /^(?:Sự kiện trong đời|Sự kiện cuộc đời|Life events)$/i,
};

async function readSection(page: Page, key: Section['key']): Promise<Section['categories']> {
  const headings = page.locator(`main :is(${displayedHeading}),[role="main"] :is(${displayedHeading})`).filter({ hasText: SECTION_HEADINGS[key] });
  await headings.filter({ visible: true }).first().waitFor({ timeout: 2500 }).catch(() => undefined);
  return evaluateProfilePage(page, ({ headingSelector, pattern }) => {
    const nodes = [...new Set(Array.from(document.querySelectorAll('main,[role="main"]')).flatMap(main => Array.from(main.querySelectorAll(headingSelector))))];
    const visible = (element: Element) => element.getClientRects().length && !element.closest('[aria-hidden="true"],[hidden],nav,[role="navigation"]');
    const read = (element: Element) => (element as HTMLElement).innerText.trim();
    const known = new RegExp(pattern, 'i');
    const matching = nodes.filter(el => visible(el) && known.test(read(el)) && !el.closest('a,button,[role="tab"],[role="button"]'));
    const categories = new Map<string, Set<string>>();
    for (const heading of matching.filter(el => !matching.some(other => el !== other && el.contains(other)))) {
      const label = read(heading);
      let scope = heading.parentElement;
      let values: string[] = [];
      while (scope && !scope.matches('main,[role="main"],body')) {
        if (scope.querySelector('article,[role="article"],nav,[role="navigation"]')) break;
        const otherHeading = Array.from(scope.querySelectorAll(headingSelector)).some(other => visible(other) && !other.contains(heading) && !heading.contains(other));
        if (otherHeading) break;
        const content = read(scope).split(/\n+/).map(line => line.trim()).filter(line => line && line !== label && line.length <= 2000
          && !/^(?:công khai|chỉ mình tôi|bạn bè|public|only me|friends|xem thêm|see more|thêm|add|chỉnh sửa|edit)$/i.test(line));
        if (content.length) values = content;
        if (scope.matches('section,[role="region"],[data-profile-category]')) break;
        scope = scope.parentElement;
      }
      if (label.length > 250) continue;
      const prior = categories.get(label) ?? new Set<string>();
      for (const value of values) prior.add(value);
      categories.set(label, prior);
    }
    return [...categories].slice(0, 30).map(([label, values]) => ({ label, values: [...values].slice(0, 100) }));
  }, { headingSelector: displayedHeading, pattern: SECTION_HEADINGS[key].source });
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

/** Confirm that navigation kept the same profile and landed on the requested About tab. */
export async function readProfileSections(page: Page, profile: URL, aliases: ReadonlySet<string>, assertSession: () => Promise<void>) {
  const sections: Section[] = [];
  for (const key of PROFILE_ABOUT_SECTIONS) {
    const expected = aboutUrl(profile, key);
    const response = await page.goto(expected.href, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
    await assertSession();
    const opened = new URL(page.url());
    const path = opened.pathname.replace(/\/$/, '');
    const tab = key === 'overview' ? 'about' : 'about_' + key;
    const isTab = opened.searchParams.get('sk') === tab || path.endsWith('/' + tab);
    if (isTab) opened.pathname = path.replace(new RegExp('/' + tab + '$'), '');
    const categories = response?.ok() && opened.origin === profile.origin && isTab && aliases.has(profilePageKey(opened))
      ? await readSection(page, key) : [];
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
