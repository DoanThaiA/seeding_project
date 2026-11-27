import type { ProfileImage } from '@seedingsys/connectors-core';
import { sniffMime } from '@seedingsys/connectors-manual';
import { accountResource, acquireLease, activeKillSwitch, assertLeaseHeld, audit, releaseLease, tx } from '@seedingsys/db';
import { RetryLaterError, sha256 } from '@seedingsys/domain';
import { assetObjectKey } from '@seedingsys/storage';
import type { BrowserCtx } from '../ctx';

export async function handleProfileArtwork(ctx: BrowserCtx, key: { mappingId: string; requestId: string }, retryCount = 0) {
  const artwork = await ctx.db.profileArtwork.findFirst({
    where: { ...key, status: 'QUEUED' },
    include: { mapping: { include: { source: true, target: { include: { profile: { include: { workerNode: true } } } } } } },
  });
  if (!artwork) return;
  const { source, target, enabled } = artwork.mapping;
  let lease: Awaited<ReturnType<typeof acquireLease>> = null;
  try {
    if (!enabled || source.externalRef !== artwork.sourceRef || source.connector !== artwork.sourceConnector
      || target.externalId !== artwork.targetExternalId || target.connector !== 'fb-web') {
      throw new Error('Luồng đã đổi cấu hình. Hãy lấy lại ảnh của nguồn đang chọn.');
    }
    if (await activeKillSwitch(ctx.db, { sourceId: source.id, targetId: target.id, connector: source.connector })
      || await activeKillSwitch(ctx.db, { targetId: target.id, connector: target.connector })) {
      throw new Error('Nguồn hoặc hồ sơ Facebook đang bị tạm dừng.');
    }
    const reader = ctx.registry.reader(source.connector);
    if (!reader.readProfileArtwork) throw new Error('Cách quét này chưa hỗ trợ lấy ảnh trang cá nhân.');
    if (source.connector === 'fb-session') {
      if (!target.profile) throw new Error('Đích cần hồ sơ Facebook đã đăng nhập để đọc ảnh nguồn.');
      if (target.profile.workerNode && target.profile.workerNode.name !== ctx.actor) throw new RetryLaterError('Đang chờ worker quản lý hồ sơ.');
      lease = await acquireLease(ctx.db, { resource: accountResource(target.id), holder: ctx.workerId + ':artwork',
        ttlMs: 180_000, now: ctx.clock.now(), purpose: 'profile-artwork' });
      if (!lease) throw new RetryLaterError('Hồ sơ Facebook đang bận. Worker sẽ thử lại.');
    }
    if (!(await ctx.db.profileArtwork.updateMany({ where: { ...key, status: 'QUEUED' }, data: { status: 'READING' } })).count) return;
    const images = await reader.readProfileArtwork({
      id: source.id, code: source.code, externalRef: source.externalRef,
      readAccount: target.profile ? { code: target.code, externalId: target.externalId, profileDir: target.profile.profileDir } : undefined,
    });
    const save = async ({ bytes, mime, photoId, width, height }: ProfileImage) => {
      if (!/^image\/(?:jpeg|png|webp|gif)$/.test(mime) || sniffMime(bytes) !== mime) {
        throw new Error('Tệp Facebook trả về không phải ảnh hợp lệ.');
      }
      const checksum = sha256(bytes);
      const objectKey = assetObjectKey(checksum, mime);
      await ctx.store.put(objectKey, bytes, mime);
      return { objectKey, mime, checksum, photoId, width, height, size: bytes.byteLength };
    };
    const [avatar, cover] = await Promise.all([save(images.avatar), save(images.cover)]);
    if (avatar.photoId === cover.photoId || avatar.checksum === cover.checksum) throw new Error('Facebook trả về cùng một ảnh cho hai vị trí.');
    await tx(ctx.db, async t => {
      const now = ctx.clock.now();
      if (lease && !await assertLeaseHeld(t, lease, now)) throw new Error('Phiên đọc hết hiệu lực.');
      const updated = await t.profileArtwork.updateMany({
        where: { ...key, status: 'READING', mapping: { enabled: true,
          source: { externalRef: artwork.sourceRef, connector: artwork.sourceConnector },
          target: { externalId: artwork.targetExternalId, connector: 'fb-web' } } },
        data: { status: 'READY', images: { avatar, cover }, error: null },
      });
      if (!updated.count) throw new Error('Luồng đã đổi cấu hình trong lúc lấy ảnh.');
      await audit(t, { entityType: 'profile_artwork', entityId: key.mappingId, action: 'artwork_read', actor: ctx.actor,
        at: now, data: { avatarId: avatar.photoId, coverId: cover.photoId } });
    });
  } catch (error) {
    if (error instanceof RetryLaterError && retryCount < 3) throw error;
    const detail = error instanceof Error ? error.message.split('\n')[0].slice(0, 250) : 'Không lấy được ảnh nguồn.';
    await ctx.db.profileArtwork.updateMany({
      where: { ...key, status: { in: ['QUEUED', 'READING'] } }, data: { status: 'FAILED', error: detail },
    });
    ctx.log.warn({ mappingId: key.mappingId }, 'profile artwork read failed');
  } finally {
    if (lease) await releaseLease(ctx.db, lease, ctx.clock.now());
  }
}
