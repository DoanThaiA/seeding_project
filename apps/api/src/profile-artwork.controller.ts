import { randomUUID } from 'node:crypto';
import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, StreamableFile } from '@nestjs/common';
import { z } from 'zod';
import { ARTWORK_IMAGE_EXTENSIONS, ArtworkImage, ArtworkImages, ProfilePhotoKind, Q } from '@seedingsys/contracts';
import { activeKillSwitch, audit, enqueue, tx, type Db } from '@seedingsys/db';
import { isFacebookTimelineReader, type Clock } from '@seedingsys/domain';
import type { ObjectStore } from '@seedingsys/storage';
import { Roles, type Principal } from './auth';
import { CLOCK, DB, STORE } from './tokens';
import { Actor, parse } from './util';

const timeoutMs = 5 * 60_000;
const applyTimeoutMs = 8 * 60_000;

function current(row: {
  sourceRef: string; sourceConnector: string; targetExternalId: string;
  mapping: { enabled: boolean; source: { externalRef: string; connector: string }; target: { externalId: string; connector: string } };
}) {
  return row.mapping.enabled && row.sourceRef === row.mapping.source.externalRef && row.sourceConnector === row.mapping.source.connector
    && row.targetExternalId === row.mapping.target.externalId && row.mapping.target.connector === 'fb-web';
}

@Controller('profile-artwork')
@Roles('admin')
export class ProfileArtworkController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORE) private readonly store: ObjectStore) {}

  @Get()
  async list() {
    const rows = await this.db.profileArtwork.findMany({ include: { mapping: { include: { source: true, target: true } } } });
    return rows.filter(current).map(row => {
      const images = ArtworkImages.safeParse(row.images);
      const stale = (row.status === 'QUEUED' || row.status === 'READING') && +row.updatedAt + timeoutMs < +this.clock.now();
      const applyExpired = row.applyUpdatedAt && +row.applyUpdatedAt + applyTimeoutMs < +this.clock.now();
      const applyStatus = applyExpired && ['QUEUED', 'RUNNING', 'COMMITTING'].includes(row.applyStatus)
        ? row.applyStatus === 'COMMITTING' ? 'NEEDS_CHECK' : 'FAILED' : row.applyStatus;
      const preview = (image: z.infer<typeof ArtworkImage>) => {
        const { photoId, width, height, mime } = image;
        return { photoId, width, height, extension: ARTWORK_IMAGE_EXTENSIONS[mime] };
      };
      return {
        mappingId: row.mappingId, requestId: row.requestId, updatedAt: row.updatedAt,
        status: stale ? 'FAILED' : row.status,
        error: stale ? 'Lượt lấy ảnh hết thời gian chờ. Hãy thử lại.' : row.error,
        apply: { status: applyStatus, error: row.applyError, kind: row.applyKind,
          avatarId: row.appliedAvatarId, coverId: row.appliedCoverId },
        images: row.status === 'READY' && images.success
          ? { avatar: preview(images.data.avatar), cover: preview(images.data.cover) } : null,
      };
    });
  }

  @Post(':mappingId/read')
  async read(@Param('mappingId', ParseUUIDPipe) mappingId: string, @Actor() actor: Principal) {
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM source_target_mappings WHERE id=${mappingId}::uuid FOR UPDATE`;
      const mapping = await t.sourceTargetMapping.findUnique({ where: { id: mappingId },
        include: { source: true, target: { include: { profile: true } }, artwork: true } });
      if (!mapping) throw new NotFoundException('Không tìm thấy luồng.');
      if (!mapping.enabled || !isFacebookTimelineReader(mapping.source.connector) || mapping.target.connector !== 'fb-web'
        || (mapping.source.connector === 'fb-session' && !mapping.target.profile)) {
        throw new ConflictException('Cần luồng Facebook đã cấu hình và có hồ sơ đọc nếu nguồn dùng phiên đăng nhập.');
      }
      const now = this.clock.now();
      if (mapping.artwork && (['COMMITTING', 'NEEDS_CHECK'].includes(mapping.artwork.applyStatus)
        || (['QUEUED', 'RUNNING'].includes(mapping.artwork.applyStatus)
          && +mapping.artwork.applyUpdatedAt! + applyTimeoutMs >= +now)
        || (mapping.artwork.applyStatus !== 'DONE' && (mapping.artwork.appliedAvatarId || mapping.artwork.appliedCoverId)))) {
        throw new ConflictException('Cần hoàn tất hoặc kiểm tra lượt đồng bộ đang dở trước khi lấy cặp ảnh mới.');
      }
      if (mapping.artwork && ['QUEUED', 'READING'].includes(mapping.artwork.status)
        && +mapping.artwork.updatedAt + timeoutMs >= +now) return { queued: false };
      const requestId = randomUUID();
      const values = { requestId, sourceRef: mapping.source.externalRef, sourceConnector: mapping.source.connector,
        targetExternalId: mapping.target.externalId, status: 'QUEUED', images: {}, error: null, updatedAt: now,
        applyId: null, applyStatus: 'IDLE', applyUpdatedAt: null, applyError: null, applyKind: null,
        priorPhotoId: null, appliedAvatarId: null, appliedCoverId: null };
      await t.profileArtwork.upsert({ where: { mappingId }, create: { mappingId, ...values }, update: values });
      await enqueue(t, Q.ProfileArtwork, { mappingId, requestId });
      await audit(t, { entityType: 'profile_artwork', entityId: mappingId, action: 'artwork_requested', actor: actor.actor, at: now });
      return { queued: true };
    });
  }

  @Post(':mappingId/apply')
  async apply(@Param('mappingId', ParseUUIDPipe) mappingId: string, @Body() body: unknown, @Actor() actor: Principal) {
    const { requestId } = parse(z.object({ requestId: z.string().uuid() }), body);
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM source_target_mappings WHERE id=${mappingId}::uuid FOR UPDATE`;
      await t.$queryRaw`SELECT mapping_id FROM profile_artwork WHERE mapping_id=${mappingId}::uuid FOR UPDATE`;
      const row = await t.profileArtwork.findFirst({ where: { mappingId, requestId, status: 'READY' },
        include: { mapping: { include: { source: true, target: { include: { profile: true } } } } } });
      if (!row || !current(row) || !ArtworkImages.safeParse(row.images).success) {
        throw new ConflictException('Cặp ảnh đã thay đổi. Hãy xem lại ảnh nguồn trước khi đồng bộ.');
      }
      const { source, target } = row.mapping;
      if (!target.profile) throw new ConflictException('Hồ sơ đích cần đăng nhập Facebook trước.');
      if (await activeKillSwitch(t, { sourceId: source.id, targetId: target.id, connector: 'fb-web' })) {
        throw new ConflictException('Luồng hoặc hồ sơ Facebook đang tạm dừng.');
      }
      const now = this.clock.now();
      if (['COMMITTING', 'NEEDS_CHECK'].includes(row.applyStatus)) {
        throw new ConflictException('Cần đối chiếu lượt lưu trước trên Facebook trước khi thực hiện lượt mới.');
      }
      if (row.applyStatus === 'DONE') return { queued: false };
      if (['QUEUED', 'RUNNING'].includes(row.applyStatus) && +row.applyUpdatedAt! + applyTimeoutMs >= +now) {
        return { queued: false };
      }
      const applyId = randomUUID();
      await t.profileArtwork.update({ where: { mappingId }, data: {
        applyId, applyStatus: 'QUEUED', applyError: null, applyKind: null, priorPhotoId: null, applyUpdatedAt: now,
      } });
      await enqueue(t, Q.ApplyProfileArtwork, { mappingId, requestId, applyId });
      await audit(t, { entityType: 'profile_artwork', entityId: mappingId, action: 'artwork_apply_requested', actor: actor.actor,
        at: now, data: { requestId, targetId: target.id } });
      return { queued: true };
    });
  }

  @Get(':mappingId/:kind')
  async media(@Param('mappingId', ParseUUIDPipe) mappingId: string, @Param('kind') value: string,
    @Query('request') requestInput: string, @Query('download') download?: string) {
    const kind = parse(ProfilePhotoKind, value);
    const requestId = parse(z.string().uuid(), requestInput);
    const row = await this.db.profileArtwork.findFirst({ where: { mappingId, requestId, status: 'READY' },
      include: { mapping: { include: { source: true, target: true } } } });
    if (!row || !current(row)) throw new NotFoundException('Ảnh không còn khớp với luồng.');
    const result = ArtworkImages.safeParse(row.images);
    if (!result.success) throw new NotFoundException('Không tìm thấy ảnh đã lưu.');
    const image = result.data[kind];
    const filename = kind + '.' + ARTWORK_IMAGE_EXTENSIONS[image.mime];
    return new StreamableFile(await this.store.open(image.objectKey), {
      type: image.mime, length: image.size,
      disposition: (download === '1' ? 'attachment' : 'inline') + '; filename="' + filename + '"',
    });
  }
}
