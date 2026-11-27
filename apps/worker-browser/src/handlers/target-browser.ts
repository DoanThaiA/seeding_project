import { FbWebPublishConnector, fbWebOptionsFromEnv } from '@seedingsys/connectors-fb-web';
import { accountResource, acquireLease, activeKillSwitch, json, releaseLease } from '@seedingsys/db';
import type { BrowserCtx } from '../ctx';

export async function handleTargetBrowser(ctx: BrowserCtx, runId: string, nodeId: string, retry: number) {
  const { db, clock } = ctx;
  const where = { id: runId };
  const run = await db.targetBrowserRun.findUnique({ where, include: { target: { include: { profile: true } } } });
  if (!run) return;
  if (retry && ['OPEN', 'RUNNING'].includes(run.status)) {
    await db.targetBrowserRun.update({ where, data: { status: 'FAILED', message: 'Lượt xử lý bị gián đoạn. Bạn có thể chạy lại.' } });
    return;
  }
  const claimed = await db.targetBrowserRun.updateMany({ where: { ...where, status: 'QUEUED' }, data: { status: 'RUNNING' } });
  if (!claimed.count) return;
  const target = run.target;
  const lease = await acquireLease(db, { resource: accountResource(target.id), holder: ctx.workerId, now: clock.now(), ttlMs: 55 * 60_000 });
  try {
    if (clock.now().getTime() - run.createdAt.getTime() >= 60 * 60_000) throw new Error('Yêu cầu đã hết thời gian.');
    if (!lease) throw new Error('Hồ sơ trình duyệt đang được sử dụng. Thử lại sau.');
    if (target.connector !== 'fb-web' || (target.profile?.workerNodeId && target.profile.workerNodeId !== nodeId))
      throw new Error('Cần chạy trên máy worker đang giữ hồ sơ Facebook của tài khoản này.');
    const opts = fbWebOptionsFromEnv();
    const connector = new FbWebPublishConnector({ ...opts, channel: opts.channel ?? (!opts.executablePath && process.platform === 'win32' ? 'chrome' : undefined) });
    const ref = { ...target, profileDir: target.profile?.profileDir ?? target.code };
    if (run.kind === 'login') {
      const browser = await connector.openForManualLogin(ref);
      const timeout = setTimeout(() => void browser.close().catch(() => undefined), 30 * 60_000);
      try {
        await db.browserProfile.upsert({ where: { targetId: target.id }, create: { targetId: target.id, profileDir: ref.profileDir, workerNodeId: nodeId }, update: { workerNodeId: nodeId } });
        await db.targetBrowserRun.update({ where, data: { status: 'OPEN', message: 'Đăng nhập ' + target.externalId + ' trên máy worker, rồi đóng cửa sổ trình duyệt.' } });
        await browser.closed;
      } finally {
        clearTimeout(timeout);
        await browser.close().catch(() => undefined);
      }
      await db.targetBrowserRun.update({ where, data: { status: 'DONE', message: 'Đã đóng cửa sổ đăng nhập.' } });
    } else {
      if (!target.enabled || await activeKillSwitch(db, { targetId: target.id, connector: target.connector })) throw new Error('Tài khoản đang tạm dừng.');
      const session = await connector.openSession(ref);
      const timeout = setTimeout(() => void session.close(), 50 * 60_000);
      try {
        if (!(await session.checkIdentity(target.externalId)).ok) throw new Error('Đăng nhập đúng tài khoản ' + target.externalId + ' trước khi quét.');
        const result = await session.scanFriends(run.profileUrl!, run.limit, async rows => {
          await db.targetBrowserRun.update({ where, data: { results: json(rows) } });
        });
        await db.targetBrowserRun.update({ where, data: result });
      } finally {
        clearTimeout(timeout);
        await session.close();
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message.split('\n')[0] : 'Không thể mở trình duyệt.';
    await db.targetBrowserRun.update({ where, data: { status: 'FAILED', message } });
  } finally {
    if (lease) await releaseLease(db, lease, clock.now());
  }
}
