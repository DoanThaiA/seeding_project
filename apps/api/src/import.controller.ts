import { BadRequestException, Body, ConflictException, Controller, Inject, NotFoundException, Param, ParseUUIDPipe, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { manualStagingKey, sniffMime } from '@seedingsys/connectors-manual';
import type { ContentType, IncompleteFlag } from '@seedingsys/contracts';
import { ingestPost, tx, type Db, type IngestPost } from '@seedingsys/db';
import { contentKey, isFacebookTimelineReader, sha256, type Clock } from '@seedingsys/domain';
import { assetObjectKey, type ObjectStore } from '@seedingsys/storage';
import { Roles, type Principal } from './auth';
import { CLOCK, DB, STORE } from './tokens';
import { Actor, out, parse } from './util';

/** Shape of an in-memory multer upload (we avoid the global Express.Multer typings). */
interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}

const MAX_FILE = 120 * 1024 * 1024;
const MAX_FILES = 10;

const Body_ = z.object({
  text: z.string().max(20_000).default(''),
  albumTitle: z.string().max(300).optional(),
  /** Where the content comes from and why the organisation may reuse it. Required, kept on the post. */
  origin: z.string().min(3).max(500),
  rightsConfirmed: z.literal('true', { errorMap: () => ({ message: 'Phải xác nhận quyền sử dụng nội dung' }) }),
});

/**
 * Manual import for sources whose connector is "manual": the operator pastes text and uploads
 * media the organisation is entitled to reuse. Goes through the same ingest as polled posts.
 */
@Controller()
export class ImportController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORE) private readonly store: ObjectStore,
  ) {}

  @Post('sources/:id/manual-posts')
  @Roles('reviewer', 'operator')
  @UseInterceptors(FilesInterceptor('media', MAX_FILES, { limits: { fileSize: MAX_FILE, files: MAX_FILES, fields: 10 } }))
  async create(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @UploadedFiles() files: UploadedFile[] | undefined, @Actor() a: Principal) {
    const d = parse(Body_, body ?? {});
    const source = await this.db.source.findUnique({ where: { id } });
    if (!source) throw new NotFoundException('Không có nguồn này');
    if (source.connector !== 'manual') throw new ConflictException('Nguồn này không phải nguồn nhập tay');
    if (!source.enabled) throw new ConflictException('Nguồn đang tắt');

    const list = files ?? [];
    if (!d.text.trim() && list.length === 0) throw new BadRequestException('Cần có nội dung chữ hoặc media');

    const sniffed = list.map((f) => ({ f, mime: sniffMime(f.buffer) }));
    const bad = sniffed.find((s) => !s.mime);
    if (bad) throw new BadRequestException(`Tệp “${bad.f.originalname}” không phải ảnh/video được hỗ trợ (JPG, PNG, WebP, GIF, MP4, MOV)`);
    const images = sniffed.filter((s) => s.mime!.startsWith('image/'));
    const videos = sniffed.filter((s) => s.mime!.startsWith('video/'));
    if (videos.length > 1 || (videos.length === 1 && images.length > 0)) throw new BadRequestException('Chỉ nhận một video, hoặc nhiều ảnh — không trộn lẫn');
    const contentType: ContentType = videos.length ? 'VIDEO' : images.length > 1 ? 'MULTI_PHOTO' : images.length === 1 ? 'SINGLE_PHOTO' : 'TEXT';

    // Importing the same caption + files again (double submit, re-import) would collect the post twice.
    const checksums = sniffed.map((s) => sha256(s.f.buffer));
    const key = contentKey({ text: d.text.trim(), albumTitle: d.albumTitle?.trim() || undefined, checksums });
    await this.rejectImportedCopy(this.db, source, key);

    const batch = randomUUID();
    const media: Array<{ kind: 'image' | 'video'; ref: string; mime: string; expectedChecksum: string }> = [];
    for (const [i, s] of sniffed.entries()) {
      const ref = manualStagingKey(batch, i, s.mime!);
      await this.store.put(ref, s.f.buffer, s.mime!);
      media.push({ kind: s.mime!.startsWith('video/') ? 'video' : 'image', ref, mime: s.mime!, expectedChecksum: checksums[i] });
    }

    const now = this.clock.now();
    const outcome = await tx(this.db, async (t) => {
      await t.$queryRaw`SELECT id FROM sources WHERE id = ${source.id}::uuid FOR UPDATE`; // serialise concurrent imports
      const current = await t.source.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Không có nguồn này');
      if (current.connector !== 'manual' || !current.enabled) throw new ConflictException('Nguồn nhập tay đã đổi cấu hình hoặc đang tắt.');
      await this.rejectImportedCopy(t, source, key);
      return ingestPost(t, {
        sourceId: source.id,
        connector: 'manual',
        baseline: false, // an explicit import is never a "first sync" baseline
        now,
        actor: a.actor,
        post: {
          externalId: `manual-${batch}`,
          identityConfidence: 'HIGH',
          postedAt: now,
          text: d.text.trim(),
          albumTitle: d.albumTitle?.trim() || undefined,
          contentType,
          isPinned: false,
          isShared: false,
          media,
          incomplete: [],
          raw: { origin: d.origin, importedBy: a.actor, rightsConfirmed: true },
        },
      });
    });
    return out({ ok: true, outcome, externalId: `manual-${batch}`, contentType, files: media.length });
  }

  /** Refuse content this source already has (same caption + same files), including posts in the trash. */
  private async rejectImportedCopy(q: Pick<Db, '$queryRaw'>, source: { id: string; code: string }, key: string) {
    if (!key) return;
    const [copy] = await q.$queryRaw<Array<{ archived: boolean }>>`
      SELECT sp.archived_at IS NOT NULL AS archived FROM source_posts sp
      JOIN source_post_revisions r ON r.id = sp.latest_revision_id
      WHERE sp.source_id = ${source.id}::uuid AND r.content_key = ${key}
      ORDER BY sp.archived_at NULLS FIRST LIMIT 1`;
    if (!copy) return;
    throw new ConflictException(copy.archived
      ? `Nội dung này đã có trong thùng rác của nguồn ${source.code}. Khôi phục bài cũ thay vì nhập lại.`
      : `Nội dung này đã được nhập vào nguồn ${source.code}. Không nhập lại để tránh đăng trùng.`);
  }

  @Post('review/:id/media')
  @Roles('reviewer')
  @UseInterceptors(FilesInterceptor('media', MAX_FILES, { limits: { fileSize: MAX_FILE, files: MAX_FILES, fields: 2 } }))
  async supplyMedia(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @UploadedFiles() files: UploadedFile[] | undefined, @Actor() a: Principal) {
    parse(z.object({ completeOriginal: z.literal('true') }), body);
    const v = await this.db.contentVariant.findUnique({
      where: { id },
      include: { revision: { include: { post: { include: { source: true } }, assets: true } } },
    });
    if (!v || v.status !== 'NEEDS_REVIEW' || v.revision.post.archivedAt || v.revision.post.latestRevisionId !== v.revisionId) {
      throw new ConflictException('Bài đã đổi trạng thái.');
    }
    const r = v.revision;
    const post = r.post;
    const flags = r.incomplete as IncompleteFlag[];
    const missing = flags.includes('MEDIA_COUNT_UNKNOWN') || flags.includes('MEDIA_UNAVAILABLE');
    if (!isFacebookTimelineReader(post.source.connector) || (!missing && r.mediaStatus !== 'FAILED')) {
      throw new ConflictException('Chỉ bổ sung media cho bài đã quét từ Facebook còn thiếu tệp.');
    }
    const isVideo = v.contentType === 'VIDEO' || v.contentType === 'REEL';
    if (!isVideo && v.contentType !== 'SINGLE_PHOTO' && v.contentType !== 'MULTI_PHOTO') {
      throw new ConflictException('Định dạng này cần xử lý riêng.');
    }
    const list = files ?? [];
    const raw = r.raw as { expectedPhotoCount?: number } | null;
    const knownCount = raw?.expectedPhotoCount;
    const minimum = v.contentType === 'MULTI_PHOTO' ? Math.max(2, r.assets.length + (flags.includes('MEDIA_COUNT_UNKNOWN') ? 1 : 0)) : 1;
    const wrongCount = isVideo || v.contentType === 'SINGLE_PHOTO' ? list.length !== 1
      : knownCount ? list.length !== knownCount : list.length < minimum;
    if (wrongCount) throw new BadRequestException(isVideo ? 'Chọn một video gốc.' : 'Chọn đủ ảnh gốc và theo đúng thứ tự.');
    if (list.reduce((size, file) => size + file.buffer.length, 0) > MAX_FILE) throw new BadRequestException('Tổng dung lượng media tối đa 120 MB.');
    const uploads = list.map(file => ({ file, mime: sniffMime(file.buffer) }));
    if (uploads.some(({ mime }) => !mime?.startsWith(isVideo ? 'video/' : 'image/'))) {
      throw new BadRequestException(isVideo ? 'Chọn video MP4 hoặc MOV hợp lệ.' : 'Chọn các tệp ảnh JPG, PNG, WebP hoặc GIF hợp lệ.');
    }
    const media: IngestPost['media'] = [];
    for (const { file, mime } of uploads) {
      const checksum = sha256(file.buffer);
      const objectKey = assetObjectKey(checksum, mime!);
      if (!(await this.store.exists(objectKey))) await this.store.put(objectKey, file.buffer, mime!);
      media.push({ kind: isVideo ? 'video' : 'image', ref: 'supplied:' + checksum, mime: mime!, stored: { objectKey, checksum, bytes: file.buffer.length } });
    }
    const now = this.clock.now();
    const outcome = await tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM sources WHERE id = ${post.sourceId}::uuid FOR UPDATE`;
      await t.$queryRaw`SELECT id FROM source_posts WHERE id = ${post.id}::uuid FOR UPDATE`;
      const current = await t.contentVariant.findUnique({ where: { id }, include: { revision: { include: { post: { include: { source: true } } } } } });
      if (!current || current.status !== 'NEEDS_REVIEW' || current.revision.post.archivedAt || current.revision.post.latestRevisionId !== r.id
        || !isFacebookTimelineReader(current.revision.post.source.connector) || (current.expiresAt && current.expiresAt <= now)) {
        throw new ConflictException('Bài gốc vừa thay đổi hoặc hết hiệu lực. Tải lại trang trước khi bổ sung.');
      }
      return ingestPost(t, {
        sourceId: post.sourceId, connector: current.revision.post.source.connector, baseline: false, now, actor: a.actor,
        draftCaption: current.caption ? { targetId: current.targetId, value: current.caption } : undefined,
        post: {
          externalId: post.externalId, identityConfidence: post.identityConfidence, permalink: post.permalink ?? undefined, postedAt: post.postedAt ?? undefined,
          text: r.text, albumTitle: r.albumTitle ?? undefined, contentType: v.contentType,
          isPinned: post.isPinned, isShared: post.isShared, media,
          incomplete: flags.filter(flag => flag !== 'MEDIA_COUNT_UNKNOWN' && flag !== 'MEDIA_UNAVAILABLE'),
          raw: { reader: current.revision.post.source.connector, suppliedBy: a.actor, suppliedMediaCount: media.length },
        },
      });
    });
    return { ok: true, outcome };
  }
}
