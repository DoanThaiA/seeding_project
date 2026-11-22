import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { TargetRef } from '@seedingsys/connectors-core';

export function fbTargetProfilePath(root: string, target: Pick<TargetRef, 'code' | 'profileDir'>): string {
  const name = basename((target.profileDir ?? target.code).replace(/\\/g, '/')).replace(/[^\w.-]/g, '_');
  return join(root, name || target.code);
}
import { FB_WEB_PUBLISH_FORMATS, type ContentType } from '@seedingsys/contracts';

export interface FbWebOptions {
  /** https://www.facebook.com in production; a local mock in tests. */
  baseUrl: string;
  /** Directory holding one persistent Chromium profile per target. Must be on an encrypted disk. */
  profilesRoot: string;
  headless: boolean;
  /** 'msedge' | 'chrome' to use an installed browser; unset = Playwright's bundled Chromium. */
  channel?: string;
  executablePath?: string;
  /**
   * Formats this deployment is allowed to publish. An empty value disables all formats.
   */
  enabledFormats: ContentType[];
  /** Wait for any single UI element. */
  stepTimeoutMs: number;
  /** Wait for media/video to finish attaching in the composer. */
  uploadTimeoutMs: number;
  /** Failure screenshots may contain personal data: keep on the worker host, short retention. */
  screenshotDir?: string;
  /** Injected clock (tests). Used to interpret Facebook's relative post times. */
  now?: () => Date;
  /**
   * How a post is confirmed after pressing "Đăng":
   *  - caption (default): the caption text appears on the profile page (time/photo count not required,
   *    because Facebook hides the timestamp link of new posts until hovered). Two copies → AMBIGUOUS.
   *  - strict: caption + timestamp inside the commit window + exact photo count.
   *  - off: no check at all; the attempt is recorded as "not checked". A failed post goes unnoticed.
   */
  verifyMode?: 'caption' | 'strict' | 'off';
}

export const IMPLEMENTED_FORMATS: ContentType[] = [...FB_WEB_PUBLISH_FORMATS];

export function fbWebOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FbWebOptions {
  const formats = (env.FB_ENABLED_FORMATS ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean) as ContentType[];
  const bad = formats.filter((f) => !IMPLEMENTED_FORMATS.includes(f));
  if (bad.length) throw new Error(`FB_ENABLED_FORMATS contains formats without a flow: ${bad.join(', ')}`);
  return {
    baseUrl: (env.FB_BASE_URL ?? 'https://www.facebook.com').replace(/\/$/, ''),
    profilesRoot: env.FB_PROFILES_DIR ?? join(homedir(), 'seedingsys-profiles'),
    headless: !['0', 'false', 'no'].includes((env.FB_HEADLESS ?? 'true').toLowerCase()),
    channel: env.FB_BROWSER_CHANNEL || undefined,
    executablePath: env.FB_BROWSER_PATH || undefined,
    enabledFormats: formats,
    stepTimeoutMs: Number(env.FB_STEP_TIMEOUT_MS ?? 20_000),
    uploadTimeoutMs: Number(env.FB_UPLOAD_TIMEOUT_MS ?? 10 * 60_000),
    screenshotDir: env.FB_SCREENSHOT_DIR || undefined,
    verifyMode: (['caption', 'strict', 'off'].includes((env.FB_VERIFY ?? '').toLowerCase()) ? env.FB_VERIFY!.toLowerCase() : 'caption') as 'caption' | 'strict' | 'off',
  };
}
