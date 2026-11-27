/// <reference lib="dom" />
import type { Page } from 'playwright-core';
import { facebookSourceUrl } from '@seedingsys/domain';

export type FriendProfile = { name: string; url: string; birthYear: number | null; followers: string | null; score: number };
const allFriends = /^(?:Tất cả bạn bè|All friends)$/i;

function sectionUrl(profile: URL, section: string, base: string) {
  const url = new URL(profile.pathname + profile.search, base);
  if (url.pathname === '/profile.php') url.searchParams.set('sk', section);
  else url.pathname += '/' + section;
  return url.href;
}

export async function scanFriends(page: Page, base: string, source: string, limit: number, assertSession: () => Promise<void>,
  progress: (rows: FriendProfile[]) => Promise<void>) {
  const profile = facebookSourceUrl(source);
  if (!profile) throw new Error('Liên kết hồ sơ không hợp lệ.');
  const go = async (url: string) => {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await assertSession();
    if (response && [404, 403].includes(response.status())) return false;
    if (response && !response.ok()) throw new Error('Facebook trả về lỗi HTTP ' + response.status());
    return new URL(page.url()).origin === new URL(base).origin;
  };
  const skipped = { status: 'SKIPPED', message: 'Bỏ qua vì danh sách tất cả bạn bè bị ẩn hoặc không hiển thị.' };
  const listUrl = new URL(sectionUrl(profile, 'friends', base));
  if (!await go(listUrl.href)) return skipped;
  const landing = new URL(page.url());
  if (landing.pathname.replace(/\/$/, '') !== listUrl.pathname || landing.searchParams.get('id') !== listUrl.searchParams.get('id') ||
    landing.searchParams.get('sk') !== listUrl.searchParams.get('sk')) return skipped;
  const main = page.locator('main,[role=main]').first();
  const marker = main.getByText(allFriends, { exact: true }).first();
  if (!await marker.waitFor({ state: 'visible', timeout: 6500 }).then(() => true, () => false)) return skipped;
  const activeMutual = main.locator('[aria-selected=true],[aria-current=page]').filter({ hasText: /bạn chung|mutual friends/i });
  if (await activeMutual.count()) return skipped;
  if (await main.getByText(/^(?:Không có bạn bè|No friends to show|Chưa có bạn bè)[.!]?$/i).count())
    return { status: 'DONE', message: 'Danh sách hiển thị 0 bạn bè.' };
  const cards = new Map<string, string>();
  let idle = 0;
  for (let step = 0; step < limit + 4 && idle < 3 && cards.size < limit; step++) {
    const links = await marker.evaluate(el => {
      // Find the friends section, excluding the global profile header and recommendation panels.
      let root = el.parentElement;
      while (root && !root.matches('main,[role=main]') && !root.querySelector('a[href] img,a[href] svg image')) root = root.parentElement;
      if (!root || root.matches('main,[role=main]')) return [];
      const otherGroups = Array.from(root.querySelectorAll('h1,h2,h3,[role=heading]')).filter(h =>
        /^(?:Những người bạn có thể biết|Gợi ý kết bạn|People you may know|Suggested friends|Bạn chung|Mutual friends)$/i.test(h.textContent?.trim() ?? ''));
      return Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).flatMap(a => {
        if (!a.getClientRects().length || a.closest('article,[role=article],nav,[role=navigation]')) return [];
        if (otherGroups.some(h => h.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) return [];
        const name = a.innerText.trim();
        if (!name || name.includes('\n')) return [];
        // A friend card has a named link and a separate avatar link to the same profile.
        let box = a.parentElement;
        for (let depth = 0; box && box !== root && depth < 6; depth++, box = box.parentElement) {
          const avatars = Array.from(box.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(x => x.querySelector('img,svg image'));
          if (avatars.length > 1) break;
          if (avatars.some(x => x.origin === a.origin && x.pathname === a.pathname &&
            new URL(x.href).searchParams.get('id') === new URL(a.href).searchParams.get('id'))) return [{ href: a.href, name }];
        }
        return [];
      });
    });
    const before = cards.size;
    for (const link of links) {
      const href = new URL(link.href);
      if (href.origin !== new URL(base).origin) continue;
      const url = facebookSourceUrl('https://www.facebook.com' + href.pathname + href.search);
      if (url && url.href !== profile.href) cards.set(url.href, link.name);
      if (cards.size === limit) break;
    }
    idle = before === cards.size ? idle + 1 : 0;
    if (cards.size < limit && idle < 3) {
      await page.mouse.wheel(0, 780);
      await page.waitForTimeout(650);
    }
  }
  if (!cards.size) return skipped;
  const rows: FriendProfile[] = [];
  for (const [url, name] of cards) {
    const about = sectionUrl(new URL(url), 'about_contact_and_basic_info', base);
    let info = '';
    const available = await go(about);
    const actual = new URL(page.url());
    const expected = new URL(about);
    if (available && actual.pathname.replace(/\/$/, '') === expected.pathname &&
      actual.searchParams.get('id') === expected.searchParams.get('id') && actual.searchParams.get('sk') === expected.searchParams.get('sk')) {
      await main.waitFor({ timeout: 6000 }).catch(() => undefined);
      await main.getByText(/Năm sinh|Birth year|Ngày sinh|Birthday|Thông tin cơ bản|Basic info|người theo dõi|followers/i).first()
        .waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);
      info = await main.locator('span,div').evaluateAll(nodes => nodes.filter(n => !n.children.length &&
        !n.closest('article,[role=article],[role=feed]') && n.getClientRects().length).map(n => n.textContent?.trim()).join('\n'));
    }
    const birth = /(?:Năm sinh|Birth year)\s*[:\n]\s*((?:19|20)\d{2})\b|\b((?:19|20)\d{2})\s*\n\s*(?:Năm sinh|Birth year)/i.exec(info);
    const birthday = /(?:Ngày sinh|Birthday|Date of birth)\s*[:\n]\s*[^\n]{0,32}?\b((?:19|20)\d{2})\b|\b((?:19|20)\d{2})\s*\n(?:Ngày sinh|Birthday|Date of birth)/i.exec(info);
    const year = birth ?? birthday;
    const birthYear = year ? Number(year[1] ?? year[2]) : null;
    const followers = /([\d][\d., ]*(?:\s*(?:nghìn|triệu|[KMB]))?)\s*(?:người theo dõi|followers)/i.exec(info)?.[1].trim() ?? null;
    rows.push({ url, name, birthYear, followers, score: 1 + Number(birthYear !== null) + Number(followers !== null) });
    await progress(rows);
  }
  return { status: 'DONE', message: 'Đã thu thập ' + rows.length + ' hồ sơ.' };
}
