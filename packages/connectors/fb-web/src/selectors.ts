import type { Locator, Page } from 'playwright-core';

/**
 * ┌─────────────────────────────────────────────────────────────────────────────────────┐
 * │ UNVERIFIED AGAINST THE LIVE FACEBOOK UI.                                            │
 * │ These locators are written from the vi-VN interface as it is commonly seen (role +  │
 * │ visible name, never CSS class names) and are exercised only against the local mock  │
 * │ in tests/helpers/mock-fb.ts. Phase 0 must re-capture them on the real UI (fixed     │
 * │ locale vi-VN, audience "Chỉ mình tôi") and the capability test (`pnpm fb:capability`)│
 * │ must pass before any format is enabled. Everything UI-specific lives in this file so │
 * │ a Facebook redesign is a one-file connector release.                                │
 * └─────────────────────────────────────────────────────────────────────────────────────┘
 */
export const SELECTORS_VERSION = 'vi-VN/unverified-1';

export const AUDIENCE_LABEL: Record<string, string> = {
  ONLY_ME: 'Chỉ mình tôi',
  FRIENDS: 'Bạn bè',
  PUBLIC: 'Công khai',
};

export const URLS = {
  login: /\/(login|recover|two_step_verification|reg)\b/i,
  checkpoint: /\/(checkpoint|confirmemail|security|disabled|locked)\b/i,
};

/** Text that means a human must act (never automated). */
export const CHECKPOINT_TEXT = /(xác nhận danh tính|xác minh danh tính|tài khoản.*(bị khóa|tạm khóa)|chúng tôi đã tạm khóa|nhập mã bảo mật|xác nhận đó là bạn)/i;

export const PROCESSING_TEXT = /(đang xử lý|đang được xử lý|đang tải lên|video đang)/i;

export const sel = {
  loginForm: (p: Page) => p.locator('input[name="pass"], input[type="password"]').first(),
  // Real UI (seen 2026-11): "<Tên> ơi, bạn đang nghĩ gì thế?" — lower-case "bạn", name prefix varies.
  composerOpen: (p: Page) =>
    p
      .getByRole('button', { name: /bạn đang nghĩ gì/i })
      .or(p.getByText(/bạn đang nghĩ gì/i))
      .first(),
  // Accessible name OR visible heading text: Facebook derives the name from a heading, so accept both.
  dialog: (p: Page) =>
    p
      .getByRole('dialog', { name: /Tạo bài viết/ })
      .or(p.getByRole('dialog').filter({ hasText: /Tạo bài viết/ }))
      .first(),
  textbox: (dlg: Locator) => dlg.getByRole('textbox').first(),
  reelOpen: (p: Page) => p.getByRole('button', { name: /^(Tạo (thước phim|reel)|Create reel)$/i })
    .or(p.getByRole('link', { name: /^(Tạo (thước phim|reel)|Create reel)$/i })).first(),
  createMenu: (p: Page) => p.getByRole('button', { name: /^(Menu trên Facebook|Menu)$/i }),
  menuReel: (p: Page) => p.getByRole('button', { name: /^(Thước phim|Reel)$/i }).filter({ visible: true }),
  reelComposer: (p: Page) => {
    const heading = p.getByRole('heading', { name: /^(?:tạo|chỉnh sửa|chia sẻ|cài đặt) (?:thước phim|reel)$|^(?:create|edit|share) reel$|^reel settings$/i });
    return p.getByRole('dialog').filter({ has: heading }).or(p.getByRole('dialog', { name: 'Tạo thước phim', exact: true }))
      .or(p.getByRole('main').filter({ has: heading })).filter({ visible: true }).first();
  },
  reelEditHeading: (p: Page) => p.getByRole('heading', { name: /^(Chỉnh sửa thước phim|Edit reel)$/i }),
  reelNext: (root: Locator) => root.getByRole('button', { name: /^(Tiếp|Tiếp theo|Next)$/i }),
  reelCaption: (root: Locator) => root.getByRole('textbox', { name: /mô tả|chú thích|caption|description/i }),
  reelPublish: (root: Locator) => root.getByRole('button', { name: /^(Đăng( thước phim)?|Chia sẻ thước phim|Publish reel|Share reel)$/i }),
  // Reel settings chip = audience label + a description that Facebook rewords over time.
  // Seen on the real UI (2026-11): "Chỉ mình tôi Chỉ mình tôi", "Công khai Bất kỳ ai ở trên hoặc ngoài Facebook".
  // Anchor on the leading label only so a reworded description does not lose the chip.
  reelAudienceButton: (root: Locator) => root.getByRole('button', {
    name: /^(?:Chỉ mình tôi|Bạn bè|Công khai|Only me|Friends|Public)(?:\s.*)?$/i,
  }),
  reelAudienceChoice: (p: Page, label: string) => p.getByRole('dialog').getByText(label, { exact: true }).filter({ visible: true }),
  reelPreviewPlayback: (root: Locator) => root.getByRole('button', { name: /^(Phát video|Tạm dừng video|Play video|Pause video)$/i }),
  audienceButton: (dlg: Locator) => dlg.getByRole('button', { name: /quyền riêng tư|đối tượng/i }).first(),
  audienceOption: (p: Page, label: string) => p.getByRole('radio', { name: new RegExp(label, 'i') }).first(),
  audienceDone: (p: Page) => p.getByRole('button', { name: /^(Xong|Lưu)$/ }).first(),
  addMedia: (dlg: Locator) => dlg.getByRole('button', { name: /Ảnh\/video/ }).first(),
  fileInput: (dlg: Locator) => dlg.locator('input[type="file"]').first(),
  mediaThumbs: (dlg: Locator) => dlg.locator('[aria-label^="Ảnh"] img, [aria-label^="Video"] img, [aria-label^="Video"] video'),
  postButton: (dlg: Locator) => dlg.getByRole('button', { name: 'Đăng', exact: true }),
  closeDialog: (dlg: Locator) => dlg.getByRole('button', { name: 'Đóng', exact: true }),
  discardConfirm: (p: Page) => p.getByRole('button', { name: /^(Bỏ bài viết|Bỏ)$/ }).first(),
  toastPermalink: (p: Page) => p.getByRole('link', { name: /Xem bài viết/ }).first(),
  articles: (p: Page) => p.getByRole('article'),
  articleTime: (a: Locator) => a.locator('a[href*="/posts/"], a[href*="/permalink"], a[href*="story_fbid"]').first(),
  articleMedia: (a: Locator) => a.locator('a[href*="/photo"] img, video'),
};
