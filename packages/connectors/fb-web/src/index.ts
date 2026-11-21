import { chromium } from 'playwright-core';
import {
  ConnectorError,
  type CapabilitySet,
  type PublishConnector,
  type PublishSession,
  type ReadConnector,
  type ReadResult,
  type TargetRef,
} from '@seedingsys/connectors-core';
import { IMPLEMENTED_FORMATS, fbTargetProfilePath, fbWebOptionsFromEnv, type FbWebOptions } from './config';
import { SELECTORS_VERSION } from './selectors';
import { FbWebSession } from './session';

export * from './config';
export { SELECTORS_VERSION, AUDIENCE_LABEL, sel } from './selectors';
export { parseViTime } from './vi-time';
export { FbWebSession } from './session';
export * from './capability';

import { FB_WEB_VERSION } from './version';

export { FB_WEB_VERSION } from './version';
export { FbWebReadConnector, profileKey } from './read';
export { FbPublicReadConnector } from './public-read';

/**
 * Publish connector: drives a dedicated Chromium persistent profile per target account that a
 * person logged into by hand (`pnpm fb:login <B>`). It never types passwords, never solves
 * checkpoints, and advertises only formats listed in FB_ENABLED_FORMATS (empty by default).
 */
export class FbWebPublishConnector implements PublishConnector {
  readonly key = 'fb-web';
  readonly version = FB_WEB_VERSION;
  private readonly opts: FbWebOptions;

  constructor(opts: FbWebOptions = fbWebOptionsFromEnv()) {
    this.opts = opts;
  }

  capabilities(_t: TargetRef): CapabilitySet {
    const caps: CapabilitySet = {};
    for (const f of IMPLEMENTED_FORMATS) caps[f] = this.opts.enabledFormats.includes(f);
    return caps;
  }

  /** Profile directory under profilesRoot; only the final path segment of the DB value is used. */
  profilePath(t: TargetRef): string {
    return fbTargetProfilePath(this.opts.profilesRoot, t);
  }

  /**
   * Open a VISIBLE browser on the target's profile so a person can log in themselves (password,
   * 2-step, any checkpoint). Nothing here types credentials or automates the login.
   * `closed` resolves when the person closes the window. The profile must not be in use.
   */
  async openForManualLogin(target: TargetRef): Promise<{ closed: Promise<void> }> {
    const ctx = await chromium.launchPersistentContext(this.profilePath(target), {
      headless: false,
      channel: this.opts.channel,
      executablePath: this.opts.executablePath,
      locale: 'vi-VN',
      timezoneId: 'Asia/Ho_Chi_Minh',
      viewport: null,
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(this.opts.baseUrl).catch(() => undefined);
    return { closed: new Promise<void>((resolve) => ctx.on('close', () => resolve())) };
  }

  async openSession(target: TargetRef): Promise<PublishSession> {
    let ctx;
    try {
      ctx = await chromium.launchPersistentContext(this.profilePath(target), {
        headless: this.opts.headless,
        channel: this.opts.channel,
        executablePath: this.opts.executablePath,
        locale: 'vi-VN',
        timezoneId: 'Asia/Ho_Chi_Minh',
        viewport: { width: 1280, height: 900 },
      });
    } catch (e) {
      // Most common cause: the profile is already open (another process / a person logged in).
      throw new ConnectorError('TRANSIENT', `cannot open browser profile for ${target.code}: ${(e as Error).message.split('\n')[0]}`);
    }
    return new FbWebSession(ctx, this.opts, target.code, this.opts.now).init();
  }
}
