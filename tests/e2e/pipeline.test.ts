import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, cycle, MIN, pubsOf, type Harness } from '../helpers/harness';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const slotsAt = (iso: string) => h.db.publicationSlot.findMany({ where: { slotAt: new Date(iso) }, include: { target: true } });

describe('M1 — end-to-end on FakeConnector', () => {
  it('poll → READY → hourly slot → PUBLISHED_VERIFIED, baseline never published', async () => {
    // Existing post before the first sync → BASELINE, never auto-eligible.
    h.platform.addSourcePost('A1', { text: 'Bài cũ trước khi hệ thống chạy', contentType: 'TEXT', media: [] });
    await cycle(h); // 09:50 first sync
    expect(await h.db.sourcePost.count({ where: { isBaseline: true } })).toBe(1);
    expect(await h.db.contentVariant.count()).toBe(0);

    h.platform.addSourcePost('A1', { text: 'Ưu đãi giảm 30% đến hết 25/11. Không áp dụng cùng khuyến mãi khác.', contentType: 'TEXT', media: [] });
    h.platform.addSourcePost('A2', {
      text: 'Bộ ảnh sự kiện 3 tấm',
      contentType: 'MULTI_PHOTO',
      media: [1, 2, 3].map((i) => ({ kind: 'image' as const, ref: `A2-img-${i}` })),
    });
    h.platform.addSourcePost('A4', { text: 'Video giới thiệu sản phẩm mới', contentType: 'VIDEO', media: [{ kind: 'video', ref: 'A4-video-1' }] });

    h.advance(5 * MIN); // 09:55 poll
    await cycle(h);
    const ready = await h.db.contentVariant.findMany({ where: { status: 'READY' }, include: { target: true } });
    expect(ready.map((v) => v.target.code).sort()).toEqual(['B1', 'B2', 'B4']);
    expect(h.failures).toEqual([]);

    h.setTime('2026-11-20T03:00:20.000Z'); // 10:00:20 VN
    await cycle(h);

    for (const code of ['B1', 'B2', 'B4']) {
      const [p] = await pubsOf(h, code);
      expect(p.status, code).toBe('PUBLISHED_VERIFIED');
      expect(p.permalink).toMatch(/^fake:\/\//);
      expect(h.platform.timeline(`fb-${code}`)).toHaveLength(1);
    }
    expect(h.platform.timeline('fb-B1')[0].caption).toContain('30%');
    expect(h.platform.timeline('fb-B1')[0].caption).toContain('25/11');
    expect(h.platform.timeline('fb-B2')[0].mediaChecksums).toHaveLength(3);
    const video = (await pubsOf(h, 'B4'))[0];
    expect(video.workflow).toBe('VIDEO');

    const slots = await slotsAt('2026-11-20T03:00:00.000Z');
    expect(slots).toHaveLength(5);
    const byCode = Object.fromEntries(slots.map((s) => [s.target.code, s.status]));
    expect(byCode).toEqual({ B1: 'DONE', B2: 'DONE', B3: 'SKIPPED_NO_CONTENT', B4: 'DONE', B5: 'SKIPPED_NO_CONTENT' });
    // the baseline post was never published
    expect(h.platform.timeline('fb-B1').some((p) => p.caption.includes('Bài cũ'))).toBe(false);
    expect(h.failures).toEqual([]);
  });

  it('backlog drains one post per hour, oldest first, no catch-up burst', async () => {
    await cycle(h); // baseline (empty)
    for (const n of [1, 2, 3]) {
      h.platform.addSourcePost('A3', { text: `Tin số ${n}`, contentType: 'TEXT', media: [] });
      h.advance(MIN);
    }
    h.setTime('2026-11-20T02:56:00.000Z');
    await cycle(h);
    expect(await h.db.contentVariant.count({ where: { status: 'READY' } })).toBe(3);

    const published: string[] = [];
    for (const hour of ['03', '04', '05', '06']) {
      h.setTime(`2026-11-20T${hour}:00:30.000Z`);
      await cycle(h);
      published.splice(0, published.length, ...h.platform.timeline('fb-B3').map((p) => p.caption));
    }
    expect(published).toHaveLength(3);
    expect(published.map((c) => c.match(/Tin số (\d)/)![1])).toEqual(['1', '2', '3']);
    const slot13 = await h.db.publicationSlot.findFirst({ where: { targetId: h.ids.targets.B3, slotAt: new Date('2026-11-20T06:00:00.000Z') } });
    expect(slot13?.status).toBe('SKIPPED_NO_CONTENT');
  });

  it('an edited source post after publishing creates a revision but no second post', async () => {
    await cycle(h);
    const post = h.platform.addSourcePost('A1', { text: 'Thông báo lịch nghỉ 1/12', contentType: 'TEXT', media: [] });
    h.advance(5 * MIN);
    await cycle(h);
    h.setTime('2026-11-20T03:00:10.000Z');
    await cycle(h);
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);

    h.platform.editSourcePost('A1', post.id, 'Thông báo lịch nghỉ 1/12 (cập nhật giờ mở cửa)');
    h.advance(5 * MIN);
    await cycle(h);
    expect(await h.db.sourcePostRevision.count()).toBe(2);
    h.setTime('2026-11-20T04:00:10.000Z');
    await cycle(h);
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
    expect(await h.db.publication.count({ where: { targetId: h.ids.targets.B1 } })).toBe(1);
  });

  it('manual review mode holds content until a reviewer approves', async () => {
    await h.db.sourceTargetMapping.updateMany({ where: { targetId: h.ids.targets.B5 }, data: { reviewMode: 'MANUAL' } });
    await cycle(h);
    h.platform.addSourcePost('A5', { text: 'Bài cần duyệt', contentType: 'TEXT', media: [] });
    h.advance(5 * MIN);
    await cycle(h);
    const v = await h.db.contentVariant.findFirstOrThrow({ where: { targetId: h.ids.targets.B5 } });
    expect(v.status).toBe('NEEDS_REVIEW');
    expect(await h.db.operatorTask.count({ where: { kind: 'REVIEW_CONTENT', variantId: v.id, status: 'OPEN' } })).toBe(1);
    h.setTime('2026-11-20T03:00:10.000Z');
    await cycle(h);
    expect(h.platform.timeline('fb-B5')).toHaveLength(0);
  });
});
