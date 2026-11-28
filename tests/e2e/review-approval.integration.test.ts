import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchBacklogItem, ingestPost, listBacklog, tx, type IngestPost } from '@seedingsys/db';
import { sha256 } from '@seedingsys/domain';
import { LibraryController } from '../../apps/api/src/library.controller';
import { OpsController } from '../../apps/api/src/ops.controller';
import { handleProfileSync } from '../../apps/worker-browser/src/handlers/profile-sync';
import { handlePublish } from '../../apps/worker-browser/src/handlers/publish';
import { expireContent } from '../../apps/worker-core/src/maintenance/lease-sweeper';
import { createHarness, MIN, type Harness } from '../helpers/harness';

const actor = { actor: 'test-reviewer', role: 'reviewer' } as const;
const video: IngestPost['media'][number] = {
  kind: 'video', ref: 'test-reel.mp4', mime: 'video/mp4',
  stored: { objectKey: 'test-reel.mp4', checksum: 'd'.repeat(64), bytes: 48 },
};

describe('review approval', () => {
  let h: Harness;
  let library: LibraryController;
  let ops: OpsController;

  beforeEach(async () => {
    h = await createHarness({ codes: [1] });
    library = new LibraryController(h.db, h.clock);
    ops = new OpsController(h.db, h.clock, h.browser.store);
  });

  afterEach(() => h.close());

  async function stage(...posts: Array<Pick<IngestPost, 'externalId' | 'text' | 'contentType' | 'media'> & Partial<Pick<IngestPost, 'incomplete' | 'raw'>>>) {
    await tx(h.db, async t => {
      for (const post of posts) await ingestPost(t, {
        sourceId: h.ids.sources.A1, connector: 'fake', now: h.clock.now(), baseline: false,
        archiveOnly: true, actor: actor.actor,
        post: { incomplete: [], ...post, identityConfidence: 'HIGH', isPinned: false, isShared: false },
      });
    });
    const { syncId } = await library.queueProfileSync('A1', { targetId: h.ids.targets.B1, history: false }, actor);
    await handleProfileSync(h.browser, { syncId, step: 0 });
    return syncId;
  }

  it('publishes the intentionally selected image when a mixed source has other unavailable attachments', async () => {
    const bytes = Buffer.from('stored image fixture');
    const objectKey = 'fixture/source-image.png';
    await h.browser.store.put(objectKey, bytes, 'image/png');
    await stage({ externalId: 'mixed-partial', text: 'Bài gốc có một ảnh đã lưu', contentType: 'UNSUPPORTED',
      incomplete: ['MEDIA_UNAVAILABLE'], raw: { expectedPhotoCount: 2 },
      media: [{ kind: 'image', ref: 'source-image', mime: 'image/png', stored: { objectKey, checksum: sha256(bytes), bytes: bytes.length } }] });
    const variant = await h.db.contentVariant.findFirstOrThrow();
    await expect(ops.approve(variant.id, {}, actor)).rejects.toThrow('Chọn nội dung bản đăng');
    await expect(ops.approve(variant.id, { publishAs: 'video' }, actor)).rejects.toThrow('đúng một video');
    await ops.approve(variant.id, { publishAs: 'photos' }, actor);
    expect(await h.db.contentVariant.findUnique({ where: { id: variant.id } })).toMatchObject({ status: 'READY', contentType: 'SINGLE_PHOTO',
      snapshot: { publishAs: 'photos', media: [expect.objectContaining({ kind: 'image', position: 0 })] } });
    expect(await h.db.sourcePostRevision.findUnique({ where: { id: variant.revisionId } })).toMatchObject({ incomplete: ['MEDIA_UNAVAILABLE'] });
    expect(await listBacklog(h.db, h.clock.now())).toContainEqual(expect.objectContaining({ id: variant.id, blockReason: null }));
    const publicationId = await dispatchBacklogItem(h.core, variant.id);
    expect(await handlePublish(h.browser, { publicationId, jobVersion: 1 })).toBe('PUBLISHED_VERIFIED');
  });

  it('approves a captionless reel with a stored video and skips an invalid manifest in the same batch', async () => {
    const syncId = await stage(
      { externalId: 'reel-no-video', text: 'Video thiếu tệp nguồn', contentType: 'REEL', media: [] },
      { externalId: 'reel-valid', text: '', contentType: 'REEL', media: [video] },
    );
    expect(await library.approveProfileSync(syncId, actor)).toEqual({ approved: 1 });
    const valid = await h.db.contentVariant.findFirstOrThrow({ where: { revision: { post: { externalId: 'reel-valid' } } } });
    expect(valid).toMatchObject({ status: 'READY', caption: '', snapshot: { caption: '', media: [{ kind: 'video' }] } });
    const invalid = await h.db.contentVariant.findFirstOrThrow({ where: { revision: { post: { externalId: 'reel-no-video' } } } });
    expect(invalid.status).toBe('NEEDS_REVIEW');
    await expect(ops.approve(invalid.id, { caption: '' }, actor)).rejects.toThrow('Chưa tải được video của bài');
  });

  it('rejects expired and superseded source reviews before creating a snapshot', async () => {
    await stage({ externalId: 'edited-post', text: 'Caption trước khi chỉnh sửa', contentType: 'TEXT', media: [] });
    const variant = await h.db.contentVariant.findFirstOrThrow();
    await h.db.contentVariant.update({ where: { id: variant.id }, data: { expiresAt: new Date(+h.clock.now() - MIN) } });
    await expect(ops.approve(variant.id, {}, actor)).rejects.toThrow('hết hiệu lực');
    await h.db.contentVariant.update({ where: { id: variant.id }, data: { expiresAt: null } });
    await tx(h.db, t => ingestPost(t, {
      sourceId: h.ids.sources.A1, connector: 'fake', now: h.clock.now(), baseline: false,
      archiveOnly: true, actor: actor.actor,
      post: { externalId: 'edited-post', text: 'Caption mới từ nguồn', contentType: 'TEXT', media: [],
        identityConfidence: 'HIGH', isPinned: false, isShared: false, incomplete: [] },
    }));
    await expect(ops.approve(variant.id, {}, actor)).rejects.toThrow('đã thay đổi');
    expect(await h.db.contentVariant.findUnique({ where: { id: variant.id } })).toMatchObject({ snapshot: null });
  });

  it('closes review tasks for newly expired and previously expired content', async () => {
    await stage(
      { externalId: 'just-expired', text: 'Bài vừa đến hạn', contentType: 'TEXT', media: [] },
      { externalId: 'stale-review', text: 'Bài và việc duyệt hết hạn từ trước', contentType: 'TEXT', media: [] },
      { externalId: 'still-open', text: 'Bài vẫn còn hiệu lực', contentType: 'TEXT', media: [] },
    );
    const variantFor = (externalId: string) => h.db.contentVariant.findFirstOrThrow({ where: { revision: { post: { externalId } } } });
    const [expired, stale, active] = await Promise.all(['just-expired', 'stale-review', 'still-open'].map(variantFor));
    const now = h.clock.now();
    await h.db.contentVariant.update({ where: { id: expired.id }, data: { expiresAt: now } });
    await h.db.contentVariant.update({ where: { id: stale.id }, data: { status: 'EXPIRED' } });
    await h.db.operatorTask.updateMany({ where: { variantId: stale.id }, data: { status: 'CLAIMED', claimedBy: actor.actor } });
    const queue = await ops.reviewQueue();
    expect(queue).toEqual([expect.objectContaining({ id: active.id })]);

    expect(await expireContent(h.core)).toBe(1);
    expect(await expireContent(h.core)).toBe(0);
    expect(await h.db.contentVariant.findUnique({ where: { id: expired.id } })).toMatchObject({ status: 'EXPIRED' });
    for (const variantId of [expired.id, stale.id]) {
      const task = await h.db.operatorTask.findFirstOrThrow({ where: { variantId } });
      expect(task).toMatchObject({ status: 'DONE', closedAt: now, resolution: { reason: 'content_expired' } });
    }
    expect(await h.db.operatorTask.findFirstOrThrow({ where: { variantId: active.id } })).toMatchObject({ status: 'OPEN' });
  });
});
