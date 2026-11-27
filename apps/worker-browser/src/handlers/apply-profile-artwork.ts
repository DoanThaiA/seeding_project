import { ARTWORK_IMAGE_EXTENSIONS, ArtworkImages, type ProfilePhotoKind } from '@seedingsys/contracts';
import type { PublishSession } from '@seedingsys/connectors-core';
import { accountResource, acquireLease, activeKillSwitch, assertLeaseHeld, audit, heartbeatLease, releaseLease, tx } from '@seedingsys/db';
import { RetryLaterError, sha256 } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';

export async function handleApplyProfileArtwork(ctx: BrowserCtx,
  key: { mappingId: string; requestId: string; applyId: string }, retryCount = 0) {
  const job = await ctx.db.profileArtwork.findFirst({
    where: { ...key, status: 'READY', applyStatus: 'QUEUED' },
    include: { mapping: { include: { source: true, target: { include: { profile: { include: { workerNode: true } } } } } } },
  });
  if (!job) return;
  const { source, target, enabled } = job.mapping;
  const { profile } = target;
  const ttl = 150_000;
  let session: PublishSession | undefined;
  let lease: Awaited<ReturnType<typeof acquireLease>> = null;
  let renewal: ReturnType<typeof setInterval> | undefined;
  try {
    if (!enabled || !profile || target.connector !== 'fb-web' || target.externalId !== job.targetExternalId
      || source.connector !== job.sourceConnector || source.externalRef !== job.sourceRef) {
      throw new Error('Luồng hoặc hồ sơ Facebook đã thay đổi. Hãy xem lại cặp ảnh nguồn.');
    }
    if (profile.workerNode && profile.workerNode.name !== ctx.actor) throw new RetryLaterError('Đang chờ worker quản lý hồ sơ.');
    if (await activeKillSwitch(ctx.db, { sourceId: source.id, targetId: target.id, connector: target.connector })) {
      throw new Error('Luồng hoặc hồ sơ Facebook đang bị tạm dừng.');
    }
    const images = ArtworkImages.parse(job.images);
    lease = await acquireLease(ctx.db, { resource: accountResource(target.id), holder: ctx.workerId + ':apply-artwork',
      purpose: 'apply-profile-artwork', ttlMs: ttl, now: ctx.clock.now() });
    if (!lease) throw new RetryLaterError('Hồ sơ Facebook đang bận. Worker sẽ thử lại.');
    const fence = lease;
    renewal = setInterval(() => {
      void heartbeatLease(ctx.db, fence, ttl, ctx.clock.now()).catch(() => undefined);
    }, 30_000);
    renewal.unref();
    const started = await ctx.db.profileArtwork.updateMany({
      where: { ...key, status: 'READY', applyStatus: 'QUEUED' },
      data: { applyStatus: 'RUNNING', applyUpdatedAt: ctx.clock.now() },
    });
    if (!started.count) return;
    session = await ctx.registry.publisher(target.connector).openSession({ ...target, profileDir: profile.profileDir });
    if (!session.replaceProfilePhoto || await session.sessionState() !== 'OK' || !(await session.checkIdentity(target.externalId)).ok) {
      throw new Error('Không xác nhận được phiên Facebook đích. Kiểm tra đăng nhập hoặc yêu cầu xác minh trên Facebook.');
    }
    for (const kind of ['avatar', 'cover'] as ProfilePhotoKind[]) {
      if (kind === 'avatar' ? job.appliedAvatarId : job.appliedCoverId) continue;
      const image = images[kind];
      const buffer = await ctx.store.get(image.objectKey);
      if (buffer.length !== image.size || sha256(buffer) !== image.checksum) throw new Error('Tệp ảnh đã thay đổi. Hãy lấy lại ảnh nguồn.');
      const result = await session.replaceProfilePhoto({
        kind, externalId: target.externalId,
        file: { name: kind + '.' + ARTWORK_IMAGE_EXTENSIONS[image.mime], mimeType: image.mime, buffer },
        beforeSave: async priorPhotoId => {
          await tx(ctx.db, async t => {
            const now = ctx.clock.now();
            if (!await assertLeaseHeld(t, fence, now, 40_000)) throw new Error('Phiên thao tác không còn hiệu lực.');
            if (await activeKillSwitch(t, { sourceId: source.id, targetId: target.id, connector: target.connector })) {
              throw new Error('Luồng hoặc hồ sơ vừa được tạm dừng.');
            }
            const changed = await t.profileArtwork.updateMany({
              where: { ...key, status: 'READY', applyStatus: 'RUNNING', mapping: {
                enabled: true, source: { externalRef: job.sourceRef, connector: job.sourceConnector },
                target: { externalId: job.targetExternalId, connector: 'fb-web',
                  profile: { is: { id: profile.id, profileDir: profile.profileDir, workerNodeId: profile.workerNodeId } } },
              } },
              data: { applyStatus: 'COMMITTING', applyKind: kind, priorPhotoId, applyUpdatedAt: now },
            });
            if (!changed.count) throw new Error('Lượt đồng bộ vừa thay đổi.');
          });
        },
      });
      await tx(ctx.db, async t => {
        const now = ctx.clock.now();
        if (!/^\d+$/.test(result.photoId) || !await assertLeaseHeld(t, fence, now)) {
          throw new Error('Phiên hết hiệu lực trước khi lưu kết quả xác minh.');
        }
        const updated = await t.profileArtwork.updateMany({
          where: { ...key, applyStatus: 'COMMITTING', applyKind: kind },
          data: { applyStatus: 'RUNNING', applyKind: null, priorPhotoId: null, applyUpdatedAt: now,
            ...(kind === 'avatar' ? { appliedAvatarId: result.photoId } : { appliedCoverId: result.photoId }) },
        });
        if (!updated.count) throw new Error('Không còn giữ được lượt lưu ảnh.');
        await audit(t, { entityType: 'profile_artwork', entityId: key.mappingId, action: 'artwork_photo_verified',
          actor: ctx.actor, at: now, data: { kind, photoId: result.photoId, targetId: target.id, applyId: key.applyId } });
      });
    }
    await ctx.db.profileArtwork.updateMany({
      where: { ...key, applyStatus: 'RUNNING', appliedAvatarId: { not: null }, appliedCoverId: { not: null } },
      data: { applyStatus: 'DONE', applyError: null, applyUpdatedAt: ctx.clock.now() },
    });
  } catch (error) {
    if (error instanceof RetryLaterError && !lease && retryCount < 3) throw error;
    const detail = error instanceof Error ? error.message.split('\n')[0].slice(0, 250) : 'Không đồng bộ được ảnh.';
    const stopped = await ctx.db.profileArtwork.updateMany({
      where: { ...key, applyStatus: 'COMMITTING' },
      data: { applyStatus: 'NEEDS_CHECK', applyError: detail, applyUpdatedAt: ctx.clock.now() },
    });
    if (!stopped.count) await ctx.db.profileArtwork.updateMany({
      where: { ...key, applyStatus: { in: ['QUEUED', 'RUNNING'] } },
      data: { applyStatus: 'FAILED', applyError: detail, applyUpdatedAt: ctx.clock.now() },
    });
    ctx.log.warn({ mappingId: key.mappingId, needsCheck: !!stopped.count }, 'profile artwork apply stopped');
  } finally {
    if (renewal) clearInterval(renewal);
    try { await session?.close(); } finally {
      if (lease) await releaseLease(ctx.db, lease, ctx.clock.now());
    }
  }
}
