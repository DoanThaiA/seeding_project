import { FbWebPublishConnector, fbWebOptionsFromEnv } from '@seedingsys/connectors-fb-web';
import { COMMENT_PREVIEW_KIND, COMMENT_PREVIEW_MS, CommentPostSnapshot, Q, TARGET_HEALTH_KIND, TARGET_HEALTH_TEXT,
  type TargetHealthResult, type TargetHealthState } from '@seedingsys/contracts';
import { accountResource, acquireLease, activeKillSwitch, audit, enqueue, json, releaseLease, tx } from '@seedingsys/db';
import { facebookScriptPost } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';
import { withTimeout } from '../runtime/timeout';

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
  const preview = run.kind === COMMENT_PREVIEW_KIND;
  const lease = await acquireLease(db, { resource: accountResource(target.id), holder: ctx.workerId, now: clock.now(),
    ttlMs: preview ? COMMENT_PREVIEW_MS : 55 * 60_000 });
  try {
    if (+clock.now() - +run.createdAt >= (preview ? COMMENT_PREVIEW_MS : 60 * 60_000)) throw new Error('Yêu cầu đã hết thời gian.');
    if (!lease) {
      await tx(db, async t => {
        const queued = await t.targetBrowserRun.updateMany({ where: { ...where, status: 'RUNNING' },
          data: { status: 'QUEUED', message: 'Đang chờ phiên trình duyệt xử lý xong lượt trước.' } });
        if (queued.count) await enqueue(t, Q.TargetBrowser, { runId }, { startAfter: new Date(+clock.now() + 30_000) });
      });
      return;
    }
    if (target.connector !== 'fb-web' || (target.profile?.workerNodeId && target.profile.workerNodeId !== nodeId))
      throw new Error('Cần chạy trên máy worker đang giữ hồ sơ Facebook của tài khoản này.');
    if (preview) {
      const post = facebookScriptPost(run.profileUrl ?? '');
      if (!post || !target.profile) throw new Error('Cần liên kết bài viết và hồ sơ Facebook đã cấu hình.');
      if (!target.enabled || await activeKillSwitch(db, { targetId: target.id, connector: target.connector })) {
        throw new Error('Tài khoản đang tạm dừng.');
      }
      const session = await withTimeout(ctx.registry.publisher(target.connector).openSession({ ...target, profileDir: target.profile.profileDir }),
        35_000, 'mở hồ sơ lấy bài', late => late.close());
      try {
        const snapshot = await withTimeout((async () => {
          if (!session.readCommentPost || !(await session.checkIdentity(target.externalId)).ok) {
            throw new Error('Chọn hồ sơ B đã đăng nhập đúng tài khoản Facebook.');
          }
          const result = CommentPostSnapshot.parse(await session.readCommentPost(post.url));
          const resolved = facebookScriptPost(result.url);
          if (!resolved?.id || (post.id && post.id !== resolved.id)) throw new Error('Liên kết đọc được thuộc bài Facebook khác.');
          return { ...result, url: resolved.url.href, capturedAt: clock.now().toISOString() };
        })(), 75_000, 'lấy nội dung bài');
        await db.targetBrowserRun.update({ where, data: { status: 'DONE', results: json(snapshot) } });
      } finally {
        await session.close().catch(() => undefined);
      }
      return;
    }
    const opts = fbWebOptionsFromEnv();
    const browserOptions = { ...opts, channel: opts.channel ?? (!opts.executablePath && process.platform === 'win32' ? 'chrome' : undefined) };
    const connector = new FbWebPublishConnector(browserOptions);
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
    } else if (run.kind === 'scan') {
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
    } else if (run.kind === TARGET_HEALTH_KIND) {
      // Chỉ mở phiên để xem tài khoản còn dùng được không; hỏng thì tắt nguồn B ngay.
      if (await activeKillSwitch(db, { targetId: target.id, connector: target.connector })) throw new Error('Đang bật công tắc dừng cho tài khoản này.');
      const session = await withTimeout(connector.openSession(ref), 60_000, 'mở hồ sơ kiểm tra', late => late.close());
      let state: TargetHealthState;
      let observed: string | null = null;
      try {
        const checked = await withTimeout((async () => {
          const live = await session.sessionState();
          if (live !== 'OK') return { state: live, observed: null };
          const identity = await session.checkIdentity(target.externalId);
          return { state: identity.ok ? 'OK' as const : 'WRONG_ACCOUNT' as const, observed: identity.observed ?? null };
        })(), 150_000, 'kiểm tra phiên Facebook');
        state = checked.state;
        observed = checked.observed;
      } finally {
        await session.close().catch(() => undefined);
      }
      const result: TargetHealthResult = { ok: state === 'OK', state, observed, disabled: false, checkedAt: clock.now().toISOString() };
      if (!result.ok && target.enabled) {
        await db.targetAccount.update({ where: { id: target.id }, data: { enabled: false } });
        await audit(db, { entityType: 'target', entityId: target.id, action: 'disabled', from: 'enabled', to: 'disabled',
          actor: 'kiểm tra tài khoản', data: { health: result }, at: clock.now() });
        result.disabled = true;
      }
      const text = TARGET_HEALTH_TEXT[state] + (state === 'WRONG_ACCOUNT' && observed ? ` (${observed})` : '');
      await db.targetBrowserRun.update({ where, data: { status: 'DONE', results: json(result),
        message: result.disabled ? `${text} · đã tắt nguồn ${target.code}` : text } });
    } else throw new Error('Loại yêu cầu trình duyệt không hợp lệ.');
  } catch (e) {
    const message = e instanceof Error ? e.message.split('\n')[0] : 'Không thể mở trình duyệt.';
    await db.targetBrowserRun.update({ where, data: { status: 'FAILED', message } });
  } finally {
    if (lease) await releaseLease(db, lease, clock.now());
  }
}
