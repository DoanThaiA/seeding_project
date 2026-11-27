import type { Page } from 'playwright-core';
import { ConnectorError } from '@seedingsys/connectors-core';

interface ArtworkHeader {
  owner: string;
  avatar: string | null;
  cover: string | null;
}

interface OwnedImage {
  url: string;
  width: number;
  height: number;
}

// Browser-side scripts are evaluated as text so Node's TypeScript runtime cannot inject helpers.
const ARTWORK_HEADER = String.raw`({ profile, requireBoth }) => {
  const headers = new Map();
  const photoId = value => {
    try {
      const url = new URL(value, location.href);
      return url.searchParams.get('fbid') ?? url.pathname.match(/\/(?:photo|photos)\/(\d+)\/?$/)?.[1];
    } catch { return undefined; }
  };
  const file = value => {
    try { return value ? new URL(value, location.href).pathname.split('/').at(-1) : undefined; }
    catch { return undefined; }
  };
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    if (!script.textContent?.includes('"cover_photo"')) continue;
    let payload;
    try { payload = JSON.parse(script.textContent); } catch { continue; }
    const pending = [payload];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== 'object') continue;
      for (const child of Object.values(node)) if (child && typeof child === 'object') pending.push(child);
      const owner = String(node.id ?? '');
      if (!/^\d+$/.test(owner) || !Object.hasOwn(node, 'cover_photo')) continue;
      let subject = '';
      try {
        const url = new URL(node.url ?? '/', location.href);
        if (url.origin === location.origin) subject = url.searchParams.get('id') ?? url.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? '';
      } catch { continue; }
      if (profile !== owner && profile !== subject) continue;
      const avatarFile = file(node.profilePicLarge?.uri ?? node.profile_picture?.uri);
      const linked = new Set();
      if (avatarFile) for (const image of document.querySelectorAll('main svg image,[role="main"] svg image')) {
        if (file(image.getAttribute('href') ?? image.getAttribute('xlink:href')) !== avatarFile) continue;
        const href = image.closest('a[href]')?.getAttribute('href');
        const id = href && photoId(href);
        if (id && /^\d+$/.test(id)) linked.add(id);
      }
      const structured = String(node.profilePhoto?.id ?? '');
      if (/^\d+$/.test(structured)) linked.add(structured);
      const probableCover = String(node.cover_photo?.photo?.id ?? '');
      const cover = /^\d+$/.test(probableCover) ? probableCover : null;
      if (node.cover_photo && !cover || linked.size > 1) continue;
      const avatar = [...linked][0] ?? null;
      if (requireBoth && (!avatar || !cover || avatar === cover)) continue;
      headers.set([owner, avatar, cover].join(':'), { owner, avatar, cover });
    }
  }
  return headers.size === 1 ? [...headers.values()][0] : null;
}`;

const OWNED_PHOTO = String.raw`({ photoId, owner }) => {
  const found = [];
  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    if (!script.textContent?.includes(photoId)) continue;
    let payload;
    try { payload = JSON.parse(script.textContent); } catch { continue; }
    const pending = [payload];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== 'object') continue;
      for (const child of Object.values(node)) if (child && typeof child === 'object') pending.push(child);
      if (String(node.id) !== photoId || String(node.owner?.id) !== owner) continue;
      for (const image of [node.viewer_image, node.image]) {
        if (typeof image?.uri === 'string' && Number.isInteger(image.width) && Number.isInteger(image.height)
          && image.width > 0 && image.height > 0) {
          found.push({ url: image.uri, width: image.width, height: image.height });
        }
      }
    }
  }
  return found.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
}`;

/** Match the configured profile and reject recommendations and ambiguous headers. */
export function readArtworkHeader(page: Page, expected: string, requireBoth = true) {
  return page.evaluate<ArtworkHeader | null>('(' + ARTWORK_HEADER + ')(' + JSON.stringify({ profile: expected, requireBoth }) + ')');
}

/** The exact photo's owner must match the profile. */
export function readOwnedPhoto(page: Page, photoId: string, owner: string) {
  return page.evaluate<OwnedImage | null>('(' + OWNED_PHOTO + ')(' + JSON.stringify({ photoId, owner }) + ')');
}

const AVATAR_ACTIONS = /^(?:Hành động với ảnh đại diện|Profile picture actions)$/i;
const CHOOSE_AVATAR = /^(?:Chọn ảnh đại diện|Select profile picture)$/i;
const EDIT_COVER = /^(?:Chỉnh sửa ảnh bìa|Edit cover photo)$/i;
const ADD_COVER = /^(?:Thêm ảnh bìa|Add cover photo)$/i;
const UPLOAD = /^(?:Tải ảnh lên|Upload photo)$/i;
const SHARE_UPDATE = /(?:chia sẻ (?:bản )?cập nhật.+(?:bảng feed|bảng tin)|share (?:your |this )?update.{0,30}feed)/i;

export async function uploadProfilePhoto(page: Page, kind: 'avatar' | 'cover',
  file: { name: string; mimeType: string; buffer: Buffer }) {
  const button = (name: RegExp) => page.getByRole('button', { name }).filter({ visible: true });
  let upload;
  if (kind === 'avatar') {
    await button(AVATAR_ACTIONS).click();
    await page.getByText(CHOOSE_AVATAR).filter({ visible: true }).click();
    upload = page.getByRole('dialog', { name: CHOOSE_AVATAR }).getByRole('button', { name: UPLOAD });
  } else {
    const edit = button(EDIT_COVER);
    const add = button(ADD_COVER);
    await edit.or(add).first().waitFor({ state: 'visible' });
    await (await edit.count() ? edit : add).click();
    upload = page.getByRole('menuitem', { name: UPLOAD }).filter({ visible: true });
  }
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15_000 }), upload.click()]);
  await chooser.setFiles(file);
  const save = kind === 'avatar'
    ? page.getByRole('dialog').filter({ visible: true }).getByRole('button', { name: /^(?:Lưu|Lưu thay đổi|Save|Save changes)$/i }).filter({ visible: true })
    : button(/^(?:Lưu thay đổi|Save changes)$/i);
  await save.waitFor({ state: 'visible' });
  if (await save.count() !== 1) throw new ConnectorError('UI_UNEXPECTED', 'Không xác định được đúng nút lưu ảnh.');
  const share = page.getByRole('checkbox', { name: SHARE_UPDATE }).filter({ visible: true });
  if (await share.count() && await share.isChecked()) {
    await share.uncheck();
    if (await share.isChecked()) throw new ConnectorError('UI_UNEXPECTED', 'Không tắt được tùy chọn chia sẻ ảnh lên bảng tin.');
  }
  return save;
}
