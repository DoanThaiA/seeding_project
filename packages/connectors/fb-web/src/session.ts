/// <reference lib="dom" />
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright-core';
import {
  ConnectorError,
  type CommitSignal,
  type DraftHandle,
  type MediaFile,
  type PreviewExpectation,
  type PublishSession,
  type VerifyHint,
  type VerifyResult,
} from '@seedingsys/connectors-core';
import type { PublishSnapshot } from '@seedingsys/contracts';
import { facebookPostId } from '@seedingsys/domain';
import type { FbWebOptions } from './config';
import { AUDIENCE_LABEL, CHECKPOINT_TEXT, PROCESSING_TEXT, URLS, sel } from './selectors';
import { parseViTime } from './vi-time';

const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
/** Facebook truncates long captions on the timeline ("Xem thêm"): compare a prefix. */
interface LinkInfo {
  href: string;
  text: string;
  label: string | null;
}
interface Hit {
  time: LinkInfo;
  imgs: number;
  videos: number;
  text: string;
}
interface ScanResult {
  dated: LinkInfo[];
  hits: Hit[];
  /** Copies of the caption visible outside the composer (independent of finding a timestamp). */
  occ: number;
}

/**
 * One Playwright persistent-context session for one target account.
 *
 * Safety rules baked in here:
 *  - prepare()/previewCheck() never press "Đăng". Only commit() does.
 *  - Checkpoints / login walls are only reported (CHECKPOINT / LOGGED_OUT); nothing tries to
 *    pass them. No stealth, fingerprint spoofing, or timing tricks.
 *  - Anything unexpected before commit → UI_UNEXPECTED (safe to retry or hand to a person).
 *  - "Not found" on the timeline is only `conclusive` when we provably scanned past the commit
 *    time with every timestamp readable; otherwise it stays inconclusive (→ reconcile/operator).
 */
export class FbWebSession implements PublishSession {
  private page!: Page;
  private shotN = 0;
  private verifyDumped = false;
  private lastCaption: string | null = null;

  constructor(
    private readonly ctx: BrowserContext,
    private readonly opts: FbWebOptions,
    private readonly who: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async init() {
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.page.setDefaultTimeout(this.opts.stepTimeoutMs);
    this.page.setDefaultNavigationTimeout(this.opts.stepTimeoutMs * 2);
    return this;
  }

  // ───────────── helpers ─────────────
  private async shot(tag: string): Promise<string | undefined> {
    if (!this.opts.screenshotDir) return undefined;
    try {
      await mkdir(this.opts.screenshotDir, { recursive: true });
      const base = join(this.opts.screenshotDir, `${this.who}-${Date.now()}-${++this.shotN}-${tag}`);
      await this.page.screenshot({ path: `${base}.png`, fullPage: false });
      await this.dumpUi(`${base}.ui.json`);
      return `${base}.png`;
    } catch {
      return undefined;
    }
  }

  /**
   * Number of media attached in the open composer. Counts only large <img>/<video> (≥ 60×60 px),
   * so toolbar icons ("Ảnh/video", emoji…) and the 40px avatar are ignored; a video counts once;
   * a "+N" overflow tile (Facebook shows at most 5 thumbnails) adds N.
   * Passed as a string on purpose: the transpiler must not inject helpers into the page context.
   */
  private async countMedia(_dlg: Locator): Promise<number> {
    const n = await this.page
      .evaluate(
        `(() => {
          const dialogs = Array.from(document.querySelectorAll('[role=dialog]')).filter((d) => /Tạo bài viết/.test((d.innerText || '') + ' ' + (d.getAttribute('aria-label') || '')));
          const root = dialogs[0];
          if (!root) return 0;
          const big = (e) => { const r = e.getBoundingClientRect(); return r.width >= 60 && r.height >= 60; };
          const imgs = Array.from(root.querySelectorAll('img')).filter(big).length;
          const videos = Array.from(root.querySelectorAll('video')).filter(big).length;
          let plus = 0;
          for (const el of Array.from(root.querySelectorAll('div,span'))) {
            if (el.children.length === 0) { const m = (el.textContent || '').trim().match(/^\\+(\\d{1,3})$/); if (m) plus = Number(m[1]); }
          }
          // Real UI (2026-11): with more than 5 photos Facebook shows 5 tiles and puts "+N" over the 5th,
          // where N counts that 5th photo too (6 photos → "+2"). So total = the 4 plain tiles + N.
          return videos > 0 ? videos : plus > 0 ? imgs - 1 + plus : imgs;
        })()`,
      )
      .catch(() => 0);
    return Number(n) || 0;
  }

  /**
   * Write the interface's own labels (roles + accessible names of buttons, textboxes, radios,
   * links, file inputs) to a JSON file next to the screenshot, so selectors can be fixed from text
   * instead of pictures. Posts/articles are skipped; open dialogs are listed first.
   */
  private async dumpUi(file: string) {
    const data = await this.page.evaluate(`(() => {
      const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const SEL = '[role=button],button,[role=textbox],[contenteditable=true],[role=radio],[role=checkbox],[role=menuitem],[role=tab],a[role=link],input[type=file],img,video';
      const describe = (e) => { const r = e.getBoundingClientRect(); return {
        tag: e.tagName.toLowerCase(), role: e.getAttribute('role'), label: e.getAttribute('aria-label'),
        text: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60), type: e.getAttribute('type'), accept: e.getAttribute('accept'),
        disabled: e.getAttribute('aria-disabled'), w: Math.round(r.width), h: Math.round(r.height) }; };
      const list = (root) => Array.from(root.querySelectorAll(SEL))
        .filter((e) => (e.tagName === 'INPUT' || visible(e)) && !e.closest('[role=article]')).slice(0, 120).map(describe);
      const dialogs = Array.from(document.querySelectorAll('[role=dialog]')).filter(visible).map((d) => ({
        label: d.getAttribute('aria-label'), heading: (d.querySelector('h1,h2,h3,[role=heading]') || {}).innerText || null, items: list(d) }));
      return { url: location.pathname, title: document.title, dialogs, page: dialogs.length ? [] : list(document) };
    })()`);
    await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  }

  /** Run a UI step; Playwright timeouts/misses become UI_UNEXPECTED with a screenshot. */
  private async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      const shot = await this.shot(name);
      const firstLine = (e as Error).message.split('\n')[0];
      throw new ConnectorError('UI_UNEXPECTED', `${name}: ${firstLine}`, false, { step: name, url: this.page.url(), screenshot: shot });
    }
  }

  private async go(path: string) {
    await this.page.goto(`${this.opts.baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('load').catch(() => undefined);
  }

  private async classify(): Promise<'OK' | 'LOGGED_OUT' | 'CHECKPOINT'> {
    const url = this.page.url();
    if (URLS.checkpoint.test(url)) return 'CHECKPOINT';
    if (URLS.login.test(url)) return 'LOGGED_OUT';
    if ((await sel.loginForm(this.page).count()) > 0) return 'LOGGED_OUT';
    const body = (await this.page.locator('body').innerText({ timeout: 3000 }).catch(() => '')) ?? '';
    if (CHECKPOINT_TEXT.test(body.slice(0, 4000))) return 'CHECKPOINT';
    return 'OK';
  }

  // ───────────── session & identity ─────────────
  async sessionState() {
    await this.step('open-home', () => this.go('/'));
    return this.classify();
  }

  /**
   * `/me` redirects to the logged-in profile: /profile.php?id=<numeric> or /<vanity>.
   * `expectedExternalId` may be the numeric id or the vanity name; we accept either form.
   */
  async checkIdentity(expectedExternalId: string) {
    await this.step('open-me', () => this.go('/me'));
    const state = await this.classify();
    if (state !== 'OK') return { ok: false, observed: state.toLowerCase() };
    const u = new URL(this.page.url());
    const observed = u.pathname.startsWith('/profile.php') ? (u.searchParams.get('id') ?? '') : (u.pathname.split('/').filter(Boolean)[0] ?? '');
    return { ok: observed !== '' && observed.toLowerCase() === expectedExternalId.toLowerCase(), observed };
  }

  async postComment({ post, parentId, text }: { post: URL; parentId?: string; text: string }, beforeSubmit: () => Promise<void>) {
    const postId = facebookPostId(post);
    if (!postId || (parentId && !/^[A-Za-z0-9_:-]{1,150}$/.test(parentId))) throw new ConnectorError('PERMANENT', 'Liên kết bài hoặc bình luận cha không hợp lệ.');
    const page = this.page;
    await this.go(post.pathname + post.search);
    const current = new URL(page.url());
    if (current.origin !== new URL(this.opts.baseUrl).origin || facebookPostId(current) !== postId || await this.classify() !== 'OK') {
      throw new ConnectorError('UI_UNEXPECTED', 'Không mở được đúng bài đích bằng hồ sơ đã chọn.');
    }
    const links = page.locator('a[href*="comment_id="]');
    const findReceipts = async () => {
      const found: Array<{ externalId: string; permalink: string; raw: string }> = [];
      for (const href of await links.evaluateAll(nodes => nodes.map(el => (el as HTMLAnchorElement).href))) {
        const url = new URL(href);
        // We are on the target post's own page. Facebook writes its comment links with a pfbid post id
        // (which also changes between reads), so a numeric post id cannot be compared with them.
        const linkPost = facebookPostId(url);
        if (url.origin !== current.origin || (linkPost !== postId && !linkPost?.startsWith('pfbid'))) continue;
        const root = url.searchParams.get('comment_id');
        const reply = url.searchParams.get('reply_comment_id');
        const externalId = parentId ? (root === parentId ? reply : null) : (reply ? null : root);
        if (!externalId || !/^[A-Za-z0-9_:-]{1,150}$/.test(externalId)) continue;
        // Store the link on the destination post's own URL so later checks compare like with like.
        const permalink = new URL(post.href);
        permalink.searchParams.delete('comment_id');
        permalink.searchParams.delete('reply_comment_id');
        permalink.searchParams.set('comment_id', root!);
        if (reply) permalink.searchParams.set('reply_comment_id', reply);
        found.push({ externalId, permalink: permalink.href, raw: url.href });
      }
      return found;
    };
    const commentBox = page.getByRole('textbox', { name: /viết (bình luận|phản hồi|câu trả lời)|write (a )?(comment|reply)|bình luận dưới tên/i }).filter({ visible: true });
    let editor = commentBox;
    if (parentId) {
      const hrefs = await links.evaluateAll(nodes => nodes.map(el => el.getAttribute('href')!));
      const href = hrefs.find(value => {
        const url = new URL(value, current);
        const linkPost = facebookPostId(url);
        return url.origin === current.origin && (linkPost === postId || !!linkPost?.startsWith('pfbid')) &&
          (url.searchParams.get('reply_comment_id') ?? url.searchParams.get('comment_id')) === parentId;
      });
      if (!href) throw new ConnectorError('UI_UNEXPECTED', 'Không tìm thấy đúng bình luận cha.');
      const parentLink = page.locator(`a[href=${JSON.stringify(href)}]:visible`);
      const parent = parentLink.locator('xpath=ancestor::*[self::article or @role="article" or @data-comment-id][1]');
      await parent.getByRole('button', { name: /^(Phản hồi|Trả lời|Reply)$/i }).click();
      editor = commentBox.and(page.locator(':focus'));
    } else if (!await commentBox.first().waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
      // The comment box renders a moment after the page; only then fall back to the "Bình luận" button.
      // Reels label it with the count ("Bình luận, 1 bình luận") and also render the next reel's
      // button further down the page: the first one belongs to the reel that is open.
      await page.getByRole('button', { name: /^(?:Bình luận|Comment)(?:, [\d.,]+[KkMTr]* (?:bình luận|comments?))?$/i }).first().click();
      await commentBox.first().waitFor({ state: 'visible', timeout: 10_000 });
    }
    const existing = new Set((await findReceipts()).map(c => c.externalId));
    await editor.fill(text);
    const focused = commentBox.and(page.locator(':focus'));
    const written = await focused.evaluate(el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : (el as HTMLElement).innerText);
    if (norm(written) !== norm(text)) throw new ConnectorError('UI_UNEXPECTED', 'Nội dung bình luận xem trước không khớp.');
    await beforeSubmit();
    await focused.press('Enter');
    const deadline = Date.now() + this.opts.stepTimeoutMs;
    while (Date.now() < deadline) {
      const added = new Map((await findReceipts()).filter(c => !existing.has(c.externalId)).map(c => [c.externalId, c]));
      if (added.size > 1) return null;
      for (const candidate of added.values()) {
        const url = new URL(candidate.raw);
        const receipt = page.locator(`a[href=${JSON.stringify(url.pathname + url.search)}],a[href=${JSON.stringify(candidate.raw)}]`)
          .locator('xpath=ancestor::*[self::article or @role="article" or @data-comment-id][1]');
        // Facebook may shorten the quoted source link, so the receipt is matched on the comment body.
        const body = norm(text.split(/\n\s*\n/).pop() ?? text);
        if (await receipt.count() === 1 && norm(await receipt.innerText()).includes(body)) return { externalId: candidate.externalId, permalink: candidate.permalink };
      }
      await page.waitForTimeout(500);
    }
    return null;
  }

  // ───────────── draft (no side effect) ─────────────
  async prepare(snapshot: PublishSnapshot, media: MediaFile[]): Promise<DraftHandle> {
    if (snapshot.contentType === 'NAMED_ALBUM' || snapshot.contentType === 'UNSUPPORTED') {
      throw new ConnectorError('UNSUPPORTED', `fb-web has no flow for ${snapshot.contentType}`);
    }
    const reel = snapshot.contentType === 'REEL';
    const isVideo = reel || snapshot.contentType === 'VIDEO';
    if (isVideo && (media.length !== 1 || media[0].kind !== 'video')) throw new ConnectorError('UNSUPPORTED', 'video post needs exactly one video file');

    await this.step('open-home', () => this.go('/'));
    const state = await this.classify();
    if (state !== 'OK') throw new ConnectorError(state === 'CHECKPOINT' ? 'CHECKPOINT' : 'SESSION_LOGGED_OUT', `session is ${state}`);
    if (reel) return this.prepareReel(snapshot, media[0]);

    const dlg = sel.dialog(this.page);
    await this.step('open-composer', async () => {
      await sel.composerOpen(this.page).click();
      await dlg.waitFor({ state: 'visible' });
    });

    this.lastCaption = snapshot.caption;
    await this.step('type-caption', async () => {
      const box = sel.textbox(dlg);
      await box.click();
      const lines = snapshot.caption.split('\n');
      for (const [i, line] of lines.entries()) {
        if (line) await this.page.keyboard.insertText(line);
        if (i < lines.length - 1) await this.page.keyboard.press('Shift+Enter');
      }
    });

    if (media.length) {
      await this.step('attach-media', async () => {
        const input = sel.fileInput(dlg);
        if ((await input.count()) === 0) await sel.addMedia(dlg).click();
        // One call, in manifest order: this is what guarantees photo order.
        await sel.fileInput(dlg).setInputFiles(media.map((m) => m.location));
        const want = media.length;
        const deadline = Date.now() + (isVideo ? this.opts.uploadTimeoutMs : this.opts.stepTimeoutMs * 3);
        while (Date.now() < deadline) {
          if ((await this.countMedia(dlg)) >= want) return;
          await this.page.waitForTimeout(300);
        }
        // Do not guess: previewCheck will report the real count.
      });
    }

    await this.step('set-audience', () => this.ensureAudience(dlg, snapshot.audience));
    return { id: `fbweb-${Date.now()}` };
  }

  private async prepareReel(snapshot: PublishSnapshot, file: MediaFile): Promise<DraftHandle> {
    const root = sel.reelComposer(this.page);
    await this.step('open-reel-composer', async () => {
      const home = sel.reelOpen(this.page);
      if (await home.isVisible()) {
        await home.click();
      } else {
        await sel.createMenu(this.page).click();
        await sel.menuReel(this.page).click();
      }
      await root.waitFor({ state: 'visible' });
    });
    await this.step('upload-reel-video', async () => {
      await sel.fileInput(root).setInputFiles(file.location);
      const caption = sel.reelCaption(root);
      if (!await caption.isVisible()) {
        await sel.reelNext(root).click({ timeout: this.opts.uploadTimeoutMs });
        const edit = sel.reelEditHeading(this.page);
        await caption.or(edit).first().waitFor({ state: 'visible' });
        if (await edit.isVisible()) await sel.reelNext(root).click({ timeout: this.opts.uploadTimeoutMs });
      }
      await caption.fill(snapshot.caption);
    });
    await this.step('set-reel-audience', () => this.ensureAudience(root, snapshot.audience, true));
    this.lastCaption = snapshot.caption;
    return { id: `fbweb-reel-${Date.now()}`, reel: true };
  }

  /** Text of the audience chip (aria-label + visible text). Short timeouts: a missing chip must not stall 20s. */
  private audienceButton(dlg: Locator, reel: boolean) {
    return reel ? sel.reelAudienceButton(dlg).or(sel.audienceButton(dlg)).first() : sel.audienceButton(dlg);
  }

  private async audienceText(dlg: Locator, reel = false): Promise<string> {
    const b = this.audienceButton(dlg, reel);
    const label = (await b.getAttribute('aria-label', { timeout: 1500 }).catch(() => null)) ?? '';
    const text = (await b.innerText({ timeout: 1500 }).catch(() => '')) ?? '';
    return `${label} ${text}`.trim();
  }

  /** Poll until the chip shows the wanted audience (Facebook re-renders it a moment after a change). */
  private async waitAudience(dlg: Locator, want: string, ms: number, reel = false): Promise<string> {
    const deadline = Date.now() + ms;
    for (;;) {
      const t = await this.audienceText(dlg, reel);
      if (norm(t).includes(norm(want)) || Date.now() > deadline) return t;
      await this.page.waitForTimeout(300);
    }
  }

  /** Switch the composer audience if needed. Never widens silently: previewCheck re-verifies. */
  private async ensureAudience(dlg: Locator, audience: string, reel = false) {
    const want = AUDIENCE_LABEL[audience];
    if (!want) throw new ConnectorError('AUDIENCE_MISMATCH', `unknown audience ${audience}`);
    if (norm(await this.audienceText(dlg, reel)).includes(norm(want))) return;
    await this.audienceButton(dlg, reel).click();
    const radio = sel.audienceOption(this.page, want);
    const choice = reel ? radio.or(sel.reelAudienceChoice(this.page, want)).first() : radio;
    await choice.click();
    await sel.audienceDone(this.page).click();
    await this.waitAudience(dlg, want, 6000, reel); // previewCheck decides whether it took effect
  }

  async previewCheck(draft: DraftHandle, exp: PreviewExpectation) {
    const reel = draft.reel === true;
    const dlg = reel ? sel.reelComposer(this.page) : sel.dialog(this.page);
    const problems: string[] = [];
    const want = AUDIENCE_LABEL[exp.audience] ?? '';
    const got = await this.step('read-preview', async () => ({
      text: reel ? await sel.reelCaption(dlg).evaluate(el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : (el as HTMLElement).innerText) : await sel.textbox(dlg).innerText(),
      thumbs: reel ? await this.countReelPreview(dlg) : await this.countMedia(dlg),
      audience: want ? await this.waitAudience(dlg, want, 4000, reel) : await this.audienceText(dlg, reel),
      postEnabled: await (reel ? sel.reelPublish(dlg) : sel.postButton(dlg)).isEnabled(),
    }));
    if (norm(got.text) !== norm(exp.caption)) problems.push('caption mismatch');
    if (got.thumbs !== exp.mediaCount) problems.push(`media count ${got.thumbs} ≠ ${exp.mediaCount}`);
    const audienceOk = want !== '' && norm(got.audience).includes(norm(want));
    if (!audienceOk) problems.push(`audience read: "${got.audience.slice(0, 120)}" (expected "${want}")`);
    if (!got.postEnabled) {
      // The Reel settings appear before Facebook finishes preparing the upload.
      // A trial click only waits for actionability and does not submit the draft.
      const ready = reel && problems.length === 0 &&
        await sel.reelPublish(dlg).click({ trial: true, timeout: Math.min(this.opts.uploadTimeoutMs, 75_000) })
          .then(() => true, () => false);
      if (!ready) problems.push('post button disabled');
    }
    const ok = problems.length === 0;
    if (!ok) await this.shot('preview-mismatch'); // screenshot + UI label dump for selector fixes
    return { ok, problems, audienceOk };
  }

  private async countReelPreview(root: Locator): Promise<number> {
    const videos = await root.locator('video:visible').count();
    if (videos) return videos;
    return await sel.reelPreviewPlayback(root).filter({ visible: true }).count() === 1 &&
      await root.locator('canvas:visible').count() === 1 ? 1 : 0;
  }

  // ───────────── THE side effect ─────────────
  async commit(draft: DraftHandle): Promise<CommitSignal> {
    const reel = draft.reel === true;
    const dlg = reel ? sel.reelComposer(this.page) : sel.dialog(this.page);
    try {
      await (reel ? sel.reelPublish(dlg) : sel.postButton(dlg)).click();
    } catch (e) {
      throw new ConnectorError('TRANSIENT', `post click failed: ${(e as Error).message.split('\n')[0]}`, true);
    }
    try {
      await dlg.waitFor({ state: 'hidden', timeout: this.opts.uploadTimeoutMs });
    } catch {
      throw new ConnectorError('TRANSIENT', 'composer did not close after Post', true, { screenshot: await this.shot('post-not-closed') });
    }
    const signal: CommitSignal = reel ? { raw: { reel: true } } : {};
    try {
      const link = reel ? this.page.getByRole('link', { name: /^(Xem thước phim|Watch reel|View reel)$/i }) : sel.toastPermalink(this.page);
      await link.waitFor({ state: 'visible', timeout: 4000 });
      const href = await link.getAttribute('href');
      if (href) signal.permalink = new URL(href, this.opts.baseUrl).toString();
    } catch {
      /* no toast: verify() will find the post on the timeline */
    }
    if (reel && !signal.permalink && this.reelId(this.page.url())) signal.permalink = this.page.url();
    return signal;
  }

  async waitProcessing(signal: CommitSignal, heartbeat: () => Promise<void>) {
    // Video: Facebook may keep processing after submit. Keep the lease alive while our post says so.
    if (this.lastCaption === null || (!this.lastCaption && signal.raw?.reel !== true)) return;
    const deadline = Date.now() + this.opts.uploadTimeoutMs;
    while (Date.now() < deadline) {
      await heartbeat();
      if (signal.raw?.reel === true) {
        if (!signal.permalink) return;
        const result = await this.verifyReel({ captionFingerprint: '', caption: this.lastCaption, mediaCount: 1, committedAt: this.now(), windowMs: 0, commitSignal: signal });
        if (result.kind !== 'PROCESSING') return;
        await this.page.waitForTimeout(15_000);
        continue;
      }
      const scan = await this.scanProfile(this.lastCaption, null, 6);
      if (scan.hits.length > 0 && !scan.hits.some((h) => PROCESSING_TEXT.test(h.text))) return;
      await this.page.waitForTimeout(15_000);
    }
  }

  async discardDraft(draft: DraftHandle) {
    try {
      const dlg = draft.reel ? sel.reelComposer(this.page) : sel.dialog(this.page);
      if (!(await dlg.isVisible())) return;
      await sel.closeDialog(dlg).click({ timeout: 3000 });
      const confirm = sel.discardConfirm(this.page);
      if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click({ timeout: 3000 });
    } catch {
      /* best effort: an abandoned draft is not a published post */
    }
  }

  // ───────────── verification ─────────────

  /**
   * One pass over what is currently rendered. Profile pages do not mark posts with role=article,
   * so posts are located by their CAPTION TEXT: from the deepest element containing the caption
   * we climb to the first ancestor that holds a short link to a post (the timestamp, e.g.
   * /permalink.php?story_fbid=…, /<user>/posts/…). Also returns every timestamp-like post link on the
   * page, used to prove we scrolled past the commit time. Page code is a string with no
   * backslashes (the transpiler and template literals would otherwise corrupt escapes).
   */
  private async scanOnce(want: string): Promise<ScanResult> {
    const script = `(() => {
      const WANT = ${JSON.stringify(want)};
      const WS = new RegExp('[' + String.fromCharCode(32, 9, 10, 13, 160) + ']+', 'g');
      const norm = (s) => (s || '').normalize('NFC').replace(WS, ' ').trim().toLowerCase();
      const isPost = (h) => !!h && (h.indexOf('permalink.php') >= 0 || h.indexOf('/posts/') >= 0 || h.indexOf('/reel/') >= 0 || h.indexOf('story_fbid') >= 0 || h.indexOf('pfbid') >= 0);
      const big = (e) => { const r = e.getBoundingClientRect(); return r.width >= 60 && r.height >= 60; };
      const short = (a) => { const t = (a.innerText || '').trim(); return t.length > 0 && t.length <= 25; };
      const info = (a) => ({ href: a.getAttribute('href') || '', text: (a.innerText || '').trim().slice(0, 40), label: a.getAttribute('aria-label') });
      const dated = Array.from(document.querySelectorAll('a')).filter((a) => isPost(a.getAttribute('href')) && short(a) && !a.closest('[role=dialog]')).map(info);
      const hits = [];
      let occ = 0;
      // Line breaks (<br>, paragraph divs) add no whitespace to textContent: compare with all whitespace removed.
      const squash = (s) => (s || '').normalize('NFC').replace(WS, '').toLowerCase();
      const PREFIX = WANT.slice(0, 160);
      const probe = squash(PREFIX).slice(0, 10);
      const message = '[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"],[data-testid="post_message"]';
      const matches = (el) => {
        const text = norm(el.innerText);
        return text === WANT || (WANT.length > 160 && text.startsWith(PREFIX)
          && /(?:…|[.]{3}|xem thêm|see more)$/.test(text)
          && WANT.startsWith(text.replace(/ *(?:…|[.]{3})? *(?:xem thêm|see more)?$/, '').trimEnd()));
      };
      if (WANT && norm(document.body.innerText).includes(PREFIX)) {
        for (const el of Array.from(document.querySelectorAll('div,span,p'))) {
          if (!squash(el.textContent).includes(probe)) continue;
          if (!matches(el)) continue;
          const ownMessage = el.closest(message);
          if (ownMessage && !matches(ownMessage)) continue;
          if (Array.from(el.children).some(matches)) continue;
          if (el.closest('[role=dialog],nav,[role=navigation],[role=banner],[contenteditable=true]')) continue;
          if (el.closest('[data-commentid],[data-comment-id],[role=article][aria-label^="Bình luận"],[role=article][aria-label^="Phản hồi"],[role=article][aria-label^="Comment by"],[role=article][aria-label^="Reply by"]')) continue;
          occ++;
          let box = el;
          let timeA = null;
          for (let i = 0; i < 30 && box && box !== document.body; i++) {
            box = box.parentElement;
            if (!box) break;
            timeA = Array.from(box.querySelectorAll('a')).find((a) => isPost(a.getAttribute('href')) && short(a)
              && !a.closest(message) && !a.href.includes('comment_id=')) || null;
            if (timeA) break;
          }
          if (!timeA || !box) continue;
          hits.push({ time: info(timeA), imgs: Array.from(box.querySelectorAll('img')).filter(big).length, videos: Array.from(box.querySelectorAll('video')).filter(big).length, text: (box.innerText || '').slice(0, 300) });
        }
      }
      return { dated, hits, occ };
    })()`;
    const r = (await this.page.evaluate(script).catch(() => null)) as ScanResult | null;
    return r ?? { dated: [], hits: [], occ: 0 };
  }

  /** Parse a post-link timestamp from its text, falling back to its aria-label. */
  private dateOf(l: LinkInfo) {
    return parseViTime(l.text, this.now()) ?? (l.label ? parseViTime(l.label, this.now()) : null);
  }

  /**
   * Open the profile and look for the post while scrolling down (Facebook renders posts lazily
   * and may unmount the ones scrolled past, so results are accumulated across scroll steps).
   */
  private async scanProfile(caption: string, olderThan: number | null, maxSteps = 10) {
    await this.step('open-timeline', () => this.go('/me'));
    const state = await this.classify();
    if (state !== 'OK') throw new ConnectorError(state === 'CHECKPOINT' ? 'CHECKPOINT' : 'SESSION_LOGGED_OUT', `session is ${state}`);
    const want = norm(caption);
    const hits = new Map<string, Hit>();
    const dated = new Map<string, LinkInfo>();
    let steps = 0;
    let copies = 0;
    for (; steps < maxSteps; steps++) {
      const r = await this.scanOnce(want);
      for (const h of r.hits) hits.set(h.time.href, h);
      copies = Math.max(copies, r.occ);
      for (const d of r.dated) dated.set(d.href, d);
      const passedWindow = olderThan !== null && [...dated.values()].some((d) => {
        const w = this.dateOf(d);
        return !!w && w.at.getTime() + w.tolMs < olderThan;
      });
      if (passedWindow || (copies > 0 && steps >= 1)) break;
      await this.page.mouse.wheel(0, 700);
      await this.page.waitForTimeout(900);
    }
    return { hits: [...hits.values()], dated: [...dated.values()], steps, copies };
  }

  /**
   * Facebook renders a new post's timestamp link as href="#" and only fills in the real URL when the
   * pointer reaches it. Starting from the rendered caption, climb to the nearest ancestor that holds
   * short links without a usable href, hover each and read the href it gets. Returns an absolute post
   * URL on the same origin, or null. Never clicks.
   */
  private async revealPermalink(caption: string): Promise<string | null> {
    const want = norm(caption);
    const found = (await this.page.evaluate(`(() => {
      const WANT = ${JSON.stringify(want)};
      const WS = new RegExp('[' + String.fromCharCode(32, 9, 10, 13, 160) + ']+', 'g');
      const norm = (s) => (s || '').normalize('NFC').replace(WS, ' ').trim().toLowerCase();
      const PREFIX = WANT.slice(0, 160);
      const isPost = (h) => !!h && (h.indexOf('permalink.php') >= 0 || h.indexOf('/posts/') >= 0 || h.indexOf('/reel/') >= 0 || h.indexOf('story_fbid') >= 0 || h.indexOf('pfbid') >= 0);
      const message = '[data-ad-preview="message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="story_message"],[data-testid="post_message"]';
      document.querySelectorAll('[data-sb-probe]').forEach((a) => a.removeAttribute('data-sb-probe'));
      const els = Array.from(document.querySelectorAll('div,span,p')).filter((el) => {
        const t = norm(el.innerText);
        return (t === WANT || (WANT.length > 160 && t.startsWith(PREFIX))) && !Array.from(el.children).some((c) => norm(c.innerText) === t)
          && !el.closest('[role=dialog],[contenteditable=true],[data-commentid],[data-comment-id]');
      });
      // Facebook may render the caption twice (collapsed + full); use the visible one.
      const shown = els.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!shown.length) return { marked: 0, pcb: null, photo: null };
      const candidate = (a) => {
        const h = a.getAttribute('href');
        const t = (a.innerText || '').trim();
        // Real UI (2026-11): href="?__cft__[0]=…" (query only) and an obfuscated, long timestamp text.
        const pending = !h || h === '#' || h.charAt(0) === '?';
        return (pending || (isPost(h) && t.length > 0)) && t.length <= 200 && !a.closest(message) && !(h || '').includes('comment_id=');
      };
      let box = shown[0];
      for (let i = 0; i < 30 && box && box !== document.body; i++) {
        box = box.parentElement;
        if (!box) break;
        const found = Array.from(box.querySelectorAll('a')).filter(candidate).slice(0, 6);
        if (found.length) {
          found.forEach((a, n) => a.setAttribute('data-sb-probe', String(n)));
          // Photos of a multi-photo post link to /photo/?fbid=…&set=pcb.<post id>.
          const pcb = Array.from(box.querySelectorAll('a[href*="set=pcb."]')).map((a) => (a.getAttribute('href').split('set=pcb.')[1] || '').split('&')[0]).filter((v) => /^[0-9]+$/.test(v));
          const photos = Array.from(new Set(Array.from(box.querySelectorAll('a[href*="/photo"]')).map((a) => { try { return new URL(a.getAttribute('href'), location.href).searchParams.get('fbid'); } catch (e) { return null; } }).filter((v) => v && /^[0-9]+$/.test(v))));
          return { marked: found.length, pcb: pcb.length && pcb.every((v) => v === pcb[0]) ? pcb[0] : null, photo: photos.length === 1 ? photos[0] : null };
        }
      }
      return { marked: 0, pcb: null, photo: null };
    })()`).catch(() => null)) as { marked: number; pcb: string | null; photo: string | null } | null;
    const marked = found?.marked ?? 0;
    const origin = new URL(this.page.url()).origin;
    for (let i = 0; i < marked; i++) {
      const a = this.page.locator(`[data-sb-probe="${i}"]`);
      await a.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
      await a.hover({ timeout: 2000 }).catch(() => undefined);
      await this.page.waitForTimeout(500);
      const href = await a.getAttribute('href', { timeout: 1000 }).catch(() => null);
      if (!href || href === '#' || href.includes('comment_id=')) continue;
      const url = new URL(href, this.page.url());
      if (url.origin === origin && facebookPostId(url)) return url.href;
    }
    const owner = new URL(this.page.url()).searchParams.get('id');
    if (found?.pcb && owner) return `${origin}/permalink.php?story_fbid=${found.pcb}&id=${owner}`;
    // Single-photo post: the photo page carries the same comment thread as the post.
    if (found?.photo && !found.pcb) return `${origin}/photo/?fbid=${found.photo}`;
    return null;
  }

  /** Find the direct link of an already-published post on the own profile (read-only). */
  async findPermalink(caption: string): Promise<string | null> {
    const scan = await this.scanProfile(caption, null, 12);
    if (scan.copies === 0) return null;
    if (scan.hits.length === 1) return new URL(scan.hits[0].time.href, this.page.url()).href;
    return scan.hits.length ? null : this.revealPermalink(caption);
  }

  async verify(hint: VerifyHint): Promise<VerifyResult> {
    if (hint.contentType === 'REEL') return this.verifyReel(hint);
    const mode = this.opts.verifyMode ?? 'caption';
    if (mode === 'off') {
      // Explicitly configured: no check. Recorded as unchecked in the attempt evidence.
      return { kind: 'VERIFIED', permalink: hint.commitSignal?.permalink ?? `${this.opts.baseUrl}/me`, evidence: { mode: 'off', checked: false } };
    }
    if (!hint.caption) throw new ConnectorError('PERMANENT', 'fb-web verify needs the caption text');
    const from = hint.committedAt.getTime() - hint.windowMs;
    const to = hint.committedAt.getTime() + hint.windowMs;
    const scan = await this.scanProfile(hint.caption, from);

    if (mode === 'caption' && scan.copies > 0) {
      // The caption is on the profile (outside the composer). Facebook hides new posts' timestamp links,
      // so time and photo count are not required here. Two copies at once = possible duplicate.
      const evidence = { mode, copies: scan.copies, steps: scan.steps };
      // Text-only: a second copy is a real duplicate. Posts with photos/video can show their caption more than once
      // (post + media viewer), so one-or-more copies counts as posted there.
      if (scan.hits.length > 1 || (scan.copies > 1 && hint.mediaCount === 0)) {
        return { kind: 'AMBIGUOUS', matches: Math.max(scan.copies, scan.hits.length), evidence };
      }
      const processing = scan.hits.some((h) => PROCESSING_TEXT.test(h.text));
      if (processing) return { kind: 'PROCESSING', evidence };
      let detected = scan.hits.length === 1 ? new URL(scan.hits[0].time.href, this.page.url()) : null;
      if (!detected && !hint.commitSignal?.permalink) {
        const revealed = await this.revealPermalink(hint.caption);
        detected = revealed ? new URL(revealed) : null;
        (evidence as Record<string, unknown>).revealed = !!revealed;
      }
      const permalink = detected?.origin === new URL(this.page.url()).origin ? detected.href : this.page.url();
      return { kind: 'VERIFIED', permalink: hint.commitSignal?.permalink ?? permalink, evidence };
    }

    const matches: Array<{ permalink: string; at: string; processing: boolean }> = [];
    for (const h of scan.hits) {
      const when = this.dateOf(h.time);
      if (!when) continue;
      const inWindow = when.at.getTime() + when.tolMs >= from && when.at.getTime() - when.tolMs <= to;
      if (!inWindow) continue;
      const media = h.videos > 0 ? h.videos : h.imgs;
      if (media !== hint.mediaCount) continue;
      matches.push({ permalink: new URL(h.time.href, this.opts.baseUrl).toString(), at: when.at.toISOString(), processing: PROCESSING_TEXT.test(h.text) });
    }

    let unreadable = 0;
    let sawOlder = false;
    for (const d of scan.dated) {
      const w = this.dateOf(d);
      if (!w) unreadable++;
      else if (w.at.getTime() + w.tolMs < from) sawOlder = true;
    }
    const evidence = { scanned: scan.dated.length, unreadable, hits: scan.hits.length, matches: matches.length, steps: scan.steps };
    if (matches.length > 1) return { kind: 'AMBIGUOUS', matches: matches.length, evidence };
    if (matches.length === 1) {
      if (matches[0].processing) return { kind: 'PROCESSING', evidence };
      return { kind: 'VERIFIED', permalink: matches[0].permalink, evidence };
    }
    // Absence is only conclusive if we scrolled past the commit time and could date every post link we saw.
    const conclusive = sawOlder && unreadable === 0 && scan.hits.length === 0;
    if (this.opts.screenshotDir && !this.verifyDumped) {
      // First miss of a session: record what the profile really looks like so selectors can be fixed.
      this.verifyDumped = true;
      const base = await this.shot('verify-notfound');
      if (base) {
        await writeFile(
          base.replace(/\.png$/, '.timeline.json'),
          JSON.stringify({ url: new URL(this.page.url()).pathname, evidence, hits: scan.hits, dated: scan.dated.slice(0, 40) }, null, 2),
          'utf8',
        ).catch(() => undefined);
      }
    }
    return { kind: 'NOT_FOUND', conclusive, evidence };
  }

  private reelId(value: string): string | undefined {
    const url = new URL(value, this.opts.baseUrl);
    if (url.origin === new URL(this.opts.baseUrl).origin) return /^\/reel\/([A-Za-z0-9_]+)\/?$/.exec(url.pathname)?.[1];
  }

  private async verifyReel(hint: VerifyHint): Promise<VerifyResult> {
    const permalink = hint.commitSignal?.permalink;
    const id = permalink && this.reelId(permalink);
    if (id) {
      const observed = await this.readReel(id, hint.caption);
      if (observed) return observed;
    }
    const from = +hint.committedAt - hint.windowMs;
    const notices = await this.reelNotifications();
    const matches: VerifyResult[] = [];
    for (const [candidate, at] of notices) {
      if (+at.at + at.tolMs < from || +at.at - at.tolMs > +hint.committedAt + hint.windowMs) continue;
      const observed = await this.readReel(candidate, hint.caption);
      if (observed?.kind === 'VERIFIED') matches.push(observed);
    }
    if (matches.length > 1) return { kind: 'AMBIGUOUS', matches: matches.length };
    if (matches.length === 1) return matches[0];
    if (!hint.caption) return { kind: 'NOT_FOUND', conclusive: false };
    const { hits } = await this.scanProfile(hint.caption, from);
    const timeline = hits.filter(hit => {
      const time = this.dateOf(hit.time);
      return this.reelId(hit.time.href) && time && +time.at + time.tolMs >= from && +time.at - time.tolMs <= +hint.committedAt + hint.windowMs;
    });
    if (timeline.length > 1) return { kind: 'AMBIGUOUS', matches: timeline.length };
    const hit = timeline[0];
    if (!hit) return { kind: 'NOT_FOUND', conclusive: false };
    if (PROCESSING_TEXT.test(hit.text)) return { kind: 'PROCESSING' };
    return { kind: 'VERIFIED', permalink: new URL(hit.time.href, this.opts.baseUrl).href, externalPostId: this.reelId(hit.time.href) };
  }

  private async readReel(id: string, expectedCaption?: string): Promise<VerifyResult | null> {
    await this.go(`/reel/${id}`);
    if (this.reelId(this.page.url()) !== id || await this.classify() !== 'OK') return null;
    const video = this.page.locator('video:visible').first();
    if (!await video.isVisible()) await video.waitFor({ state: 'visible', timeout: 3500 }).catch(() => undefined);
    const text = await this.page.locator('body').innerText();
    if (!await video.isVisible()) return PROCESSING_TEXT.test(text) ? { kind: 'PROCESSING' } : null;
    const caption = norm(expectedCaption ?? '');
    const firstLine = norm((expectedCaption ?? '').split('\n')[0] ?? '');
    if (caption && !norm(text).includes(caption) && !this.truncatedCaption(norm(text), caption, firstLine)) return null;
    return { kind: 'VERIFIED', permalink: this.page.url(), externalPostId: id };
  }

  /**
   * Reel pages show a long caption cut short: "<first part> … Xem thêm". Accept when a prefix of at
   * least 30 characters (never shorter than the whole caption would be) is shown followed by "Xem thêm".
   */
  private truncatedCaption(page: string, caption: string, firstLine = caption): boolean {
    // Facebook also cuts at the end of the first line ("!!! CẢNH BÁO LỪA ĐẢO… Xem thêm"), so the whole
    // first line (≥10 chars) is enough; otherwise at least 30 characters must be shown.
    const min = Math.min(30, Math.max(10, firstLine.length));
    if (caption.length <= min || !/(xem thêm|see more)/.test(page)) return false;
    for (let k = caption.length - 1; k >= min; k--) {
      const at = page.indexOf(caption.slice(0, k));
      if (at >= 0 && /^\s*(?:…|\.\.\.)?\s*(?:xem thêm|see more)/.test(page.slice(at + k))) return true;
    }
    return false;
  }

  private async reelNotifications() {
    // The "reel is ready" notices live on the notifications page; the profile only shows them sometimes.
    await this.go('/notifications');
    if (await this.classify() !== 'OK') return new Map<string, NonNullable<ReturnType<typeof parseViTime>>>();
    const recent = this.page.locator('a[href*="/reel/"]').filter({ hasText: /Bạn có thể xem thước phim rồi|Your reel is ready/i });
    await recent.first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => undefined);
    const receipts = await recent.evaluateAll(nodes => nodes.slice(0, 6).map(el => ({
      href: el.getAttribute('href') ?? '', text: el.textContent?.trim() ?? '',
    })));
    const byId = new Map<string, NonNullable<ReturnType<typeof parseViTime>>>();
    for (const receipt of receipts) {
      const id = this.reelId(receipt.href);
      const relative = /(?:vừa xong|\d+\s*(?:giây|phút|giờ|ngày))$/i.exec(receipt.text);
      const time = relative && parseViTime(relative[0], this.now());
      if (id && time) byId.set(id, time);
    }
    return byId;
  }

  async close() {
    await this.ctx.close().catch(() => undefined);
  }
}
