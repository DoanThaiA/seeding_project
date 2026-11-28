import { isConnectorError, type PublishSession } from '@seedingsys/connectors-core';
import { PROFILE_SCAN_TIMEOUT_MS, ProfileDetailsSnapshot, Q, type JobPayload, type SyncedProfileDetails } from '@seedingsys/contracts';
import { accountResource, acquireLease, activeKillSwitch, assertLeaseHeld, audit, releaseLease, tx, type Prisma, type Tx } from '@seedingsys/db';
import { RetryLaterError } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';
import { withTimeout } from '../runtime/timeout';

const include = { mapping: { include: { source: true, target: { include: { profile: { include: { workerNode: true } } } } } } } as const;
type Scan = Prisma.ProfileDetailsScanGetPayload<{ include: typeof include }>;

const detailOf = (error: unknown) => error instanceof Error ? error.message.split('\n')[0].slice(0, 250) : 'Không hoàn tất được thao tác hồ sơ.';
const scope = (scan: Scan) => ({ sourceId: scan.mapping.sourceId, targetId: scan.mapping.targetId });

function matchingMapping(scan: Scan, needsSession: boolean, bioJob = false) {
  const { source, target } = scan.mapping;
  return { enabled: true, source: { externalRef: scan.sourceRef, connector: scan.sourceConnector },
    target: { externalId: scan.targetExternalId, connector: 'fb-web', ...(needsSession && {
      enabled: true, profile: { is: { id: target.profile?.id, profileDir: target.profile?.profileDir, workerNodeId: target.profile?.workerNodeId } },
    }), ...(bioJob && { profileDetails: { path: ['requestId'], equals: scan.requestId } }) },
    sourceId: source.id, targetId: target.id } satisfies Prisma.SourceTargetMappingWhereInput;
}

async function claimAccount(ctx: BrowserCtx, scan: Scan, purpose: string) {
  const { target } = scan.mapping;
  if (!target.enabled || !target.profile) throw new Error('Hồ sơ B cần phiên Facebook đang hoạt động.');
  if (target.profile.workerNode && target.profile.workerNode.name !== ctx.actor) throw new RetryLaterError('Đang chờ worker quản lý hồ sơ.');
  const lease = await acquireLease(ctx.db, { resource: accountResource(target.id), holder: ctx.workerId + ':' + purpose,
    purpose, ttlMs: 200_000, now: ctx.clock.now() });
  if (!lease) throw new RetryLaterError('Hồ sơ đang bận. Worker sẽ thử lại.');
  return lease;
}

export async function handleProfileDetails(ctx: BrowserCtx, key: JobPayload<typeof Q.ProfileDetails>, retryCount = 0) {
  const scan = await ctx.db.profileDetailsScan.findFirst({ where: { ...key, status: 'QUEUED' }, include });
  if (!scan) return;
  const { source, target } = scan.mapping;
  let lease: Awaited<ReturnType<typeof acquireLease>> = null;
  try {
    if (+scan.updatedAt + PROFILE_SCAN_TIMEOUT_MS <= +ctx.clock.now()) throw new Error('Hết thời gian chờ quét.');
    if (await activeKillSwitch(ctx.db, { sourceId: source.id, connector: source.connector })) throw new Error('Nguồn hồ sơ đang tạm dừng.');
    const profile = target.profile;
    let withSession = source.connector === 'fb-session' && target.enabled && !!profile
      && !await activeKillSwitch(ctx.db, { ...scope(scan), connector: target.connector });
    if (withSession) lease = await claimAccount(ctx, scan, 'profile-details');
    const started = await ctx.db.profileDetailsScan.updateMany({ where: { ...key, status: 'QUEUED', mapping: matchingMapping(scan, withSession) },
      data: { status: 'READING', updatedAt: ctx.clock.now() } });
    if (!started.count) throw new Error('Lượt quét hoặc cấu hình hồ sơ đã thay đổi.');
    const read = async () => {
      const connector = withSession ? source.connector : 'fb-public';
      if (await activeKillSwitch(ctx.db, { sourceId: source.id, connector })) throw new Error('Kết nối quét nguồn đang tạm dừng.');
      const reader = ctx.registry.reader(connector);
      if (!reader.readProfileDetails) throw new Error('Kết nối nguồn chưa hỗ trợ quét thông tin hồ sơ.');
      return reader.readProfileDetails({ id: source.id, code: source.code, externalRef: scan.sourceRef,
        readAccount: withSession && profile ? { code: target.code, externalId: target.externalId, profileDir: profile.profileDir } : undefined });
    };
    let data;
    try {
      data = await read();
    } catch (error) {
      if (!withSession || !isConnectorError(error) || !['CHECKPOINT', 'SESSION_LOGGED_OUT', 'WRONG_IDENTITY'].includes(error.kind)) throw error;
      withSession = false;
      try { data = await read(); }
      catch { throw new Error(`${detailOf(error)} Trang A cũng chưa đọc được ở chế độ công khai.`); }
    }
    const snapshot = ProfileDetailsSnapshot.parse({ ...data, capturedAt: ctx.clock.now().toISOString() });
    await tx(ctx.db, async t => {
      await t.$queryRaw`SELECT id FROM target_accounts WHERE id=${target.id}::uuid FOR UPDATE`;
      const now = ctx.clock.now();
      if (lease && !await assertLeaseHeld(t, lease, now)) throw new Error('Phiên quét đã hết hiệu lực.');
      const saved = await t.profileDetailsScan.updateMany({ where: { ...key, status: 'READING', mapping: matchingMapping(scan, withSession),
        updatedAt: { gt: new Date(+now - PROFILE_SCAN_TIMEOUT_MS) } },
        data: { status: 'READY', snapshot, error: null, updatedAt: now } });
      if (!saved.count) throw new Error('Lượt quét hết hiệu lực hoặc hồ sơ đã đổi cấu hình.');
      const details: SyncedProfileDetails = { sourceCode: source.code, targetExternalId: scan.targetExternalId,
        requestId: key.requestId, syncedAt: now.toISOString(), snapshot };
      await t.targetAccount.update({ where: { id: target.id }, data: { profileDetails: details } });
      await audit(t, { entityType: 'profile_details', entityId: key.mappingId, action: 'profile_scan_saved', actor: ctx.actor, at: now,
        data: { requestId: key.requestId, targetId: target.id, sections: snapshot.sections.map(({ key, status }) => ({ key, status })) } });
    });
  } catch (error) {
    if (error instanceof RetryLaterError && !lease && retryCount < 3) throw error;
    await ctx.db.profileDetailsScan.updateMany({ where: { ...key, status: { in: ['QUEUED', 'READING'] } },
      data: { status: 'FAILED', error: detailOf(error), updatedAt: ctx.clock.now() } });
    ctx.log.warn({ mappingId: key.mappingId }, 'profile details scan stopped');
  } finally {
    if (lease) await releaseLease(ctx.db, lease, ctx.clock.now());
  }
}

export async function handleApplyProfileBio(ctx: BrowserCtx, key: JobPayload<typeof Q.ApplyProfileBio>, retryCount = 0) {
  const scan = await ctx.db.profileDetailsScan.findFirst({ where: { ...key, status: 'READY', bioStatus: 'QUEUED' }, include });
  if (!scan) return;
  const { target } = scan.mapping;
  const mapping = matchingMapping(scan, true, true);
  const paused = (db: Tx) => activeKillSwitch(db, { ...scope(scan), connector: 'fb-web' });
  let lease: Awaited<ReturnType<typeof acquireLease>> = null;
  let session: PublishSession | undefined;
  try {
    const expiresAt = +(scan.bioUpdatedAt ?? scan.updatedAt) + PROFILE_SCAN_TIMEOUT_MS;
    if (+ctx.clock.now() >= expiresAt) throw new Error('Hết thời gian chờ cập nhật.');
    const bio = ProfileDetailsSnapshot.parse(scan.snapshot).bio;
    const profile = target.profile;
    if (!bio || !profile || await paused(ctx.db)) throw new Error('Luồng tiểu sử hoặc hồ sơ Facebook không khả dụng.');
    lease = await claimAccount(ctx, scan, 'profile-bio');
    const fence = lease;
    const started = await ctx.db.profileDetailsScan.updateMany({ where: { ...key, bioStatus: 'QUEUED', mapping },
      data: { bioStatus: 'RUNNING', bioUpdatedAt: ctx.clock.now() } });
    if (!started.count) throw new Error('Lượt cập nhật hoặc cấu hình hồ sơ đã thay đổi.');
    session = await withTimeout(ctx.registry.publisher('fb-web').openSession({ ...target, profileDir: profile.profileDir }),
      35_000, 'open profile bio session', late => late.close());
    if (!session.replaceProfileBio || await session.sessionState() !== 'OK') throw new Error('Phiên Facebook của B chưa sẵn sàng.');
    await withTimeout(session.replaceProfileBio({ externalId: target.externalId, bio, beforeSave: async () => {
      await tx(ctx.db, async t => {
        const now = ctx.clock.now();
        if (+now >= expiresAt || !await assertLeaseHeld(t, fence, now, 30_000) || await paused(t)) {
          throw new Error('Phiên cập nhật hoặc bản đồng bộ đã thay đổi.');
        }
        const changed = await t.profileDetailsScan.updateMany({ where: { ...key, bioStatus: 'RUNNING', mapping },
          data: { bioStatus: 'COMMITTING', bioUpdatedAt: now } });
        if (!changed.count) throw new Error('Lượt cập nhật không còn hiệu lực.');
      });
    } }), 110_000, 'apply profile bio');
    await tx(ctx.db, async t => {
      const now = ctx.clock.now();
      if (!await assertLeaseHeld(t, fence, now)) throw new Error('Phiên hết hiệu lực trước khi ghi xác nhận.');
      const saved = await t.profileDetailsScan.updateMany({ where: { ...key, mapping, bioStatus: { in: ['RUNNING', 'COMMITTING'] } },
        data: { bioStatus: 'DONE', bioError: null, bioUpdatedAt: now } });
      if (!saved.count) throw new Error('Hồ sơ đã đổi cấu hình.');
      await audit(t, { entityType: 'profile_details', entityId: key.mappingId, action: 'profile_bio_verified', actor: ctx.actor, at: now,
        data: { requestId: key.requestId, targetId: target.id } });
    });
  } catch (error) {
    if (error instanceof RetryLaterError && !lease && retryCount < 3) throw error;
    const bioError = detailOf(error);
    const bioUpdatedAt = ctx.clock.now();
    const failed = await ctx.db.profileDetailsScan.updateMany({ where: { ...key, bioStatus: { in: ['QUEUED', 'RUNNING'] } },
      data: { bioStatus: 'FAILED', bioError, bioUpdatedAt } });
    if (!failed.count) await ctx.db.profileDetailsScan.updateMany({ where: { ...key, bioStatus: 'COMMITTING' },
      data: { bioStatus: 'NEEDS_CHECK', bioError, bioUpdatedAt } });
    ctx.log.warn({ mappingId: key.mappingId }, 'profile bio apply stopped');
  } finally {
    try { await session?.close(); } finally {
      if (lease) await releaseLease(ctx.db, lease, ctx.clock.now());
    }
  }
}
