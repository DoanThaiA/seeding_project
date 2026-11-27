import { expect, it } from 'vitest';
import { dispatchBacklogItem } from '@seedingsys/db';
import { resetSourceArchive } from '../../packages/db/src/reset-source-archive';
import { LibraryController } from '../../apps/api/src/library.controller';
import { handleSourcePoll } from '../../apps/worker-browser/src/handlers/source-poll';
import { createHarness, MIN } from '../helpers/harness';

it('archives A and clears its scan while still accepting the same post on a fresh, explicitly reset run', async () => {
  const h = await createHarness({ codes: [1, 2] });
  try {
    const sourceId = h.ids.sources.A1;
    const targetId = h.ids.targets.B1;
    const library = new LibraryController(h.db, h.clock);
    const admin = { role: 'admin', actor: 'test-reset' } as const;
    await h.db.source.update({ where: { id: sourceId }, data: { baselineDone: true, pollPostLimit: 3, collectComments: true, publishComments: true } });
    h.platform.addSourcePost('A1', { text: 'Thông báo ngày khai trương 12 tháng 12 tại Hà Nội.', contentType: 'TEXT', media: [] });
    expect(await handleSourcePoll(h.browser, { sourceId })).toMatchObject({ counts: { NEW_POST: 1 } });
    await h.drain();
    const original = await h.db.sourcePost.findFirstOrThrow({ where: { sourceId } });
    const variant = await h.db.contentVariant.findFirstOrThrow({ where: { sourcePostId: original.id, status: 'READY' } });
    const earlier = await dispatchBacklogItem(h.core, variant.id);
    await h.drain();
    const comment = await h.db.sourceComment.create({ data: { sourcePostId: original.id, externalId: 'before-reset', text: 'Bình luận', position: 0, lastSeenAt: h.clock.now() } });
    await h.db.publicationComment.create({ data: { destinationId: targetId, sourceCommentId: comment.id, text: comment.text, status: 'UNKNOWN' } });

    await expect(resetSourceArchive(h.db, ['A1'], admin.actor, h.clock.now())).rejects.toThrow('đang bật quét');
    await h.db.source.update({ where: { id: sourceId }, data: { enabled: false } });
    expect(await resetSourceArchive(h.db, ['A1'], admin.actor, h.clock.now())).toEqual({ sources: 1, archived: 1 });
    expect(await h.db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({ enabled: false, baselineDone: false,
      resetGeneration: 1, watermark: null, lastSuccessAt: null, pollPostLimit: 3, collectComments: true, publishComments: true });
    expect((await library.posts('A1', '1', '')).posts).toEqual([]);
    expect((await library.posts('A1', '1', '', '1')).posts[0]?.id).toBe(original.id);
    expect((await library.detail(original.id)).post.retiredByReset).toBe(true);
    expect((await library.posts('B1', '1', '')).posts[0]?.id).toBe(original.id);
    expect(await h.db.publicationComment.findFirst()).toMatchObject({ status: 'UNKNOWN' });
    await expect(library.archive(original.id, { archived: false }, admin)).rejects.toThrow('trước lần làm lại');

    h.advance(60 * MIN);
    await h.workerHeartbeat();
    await h.db.source.update({ where: { id: sourceId }, data: { enabled: true } });
    expect(await handleSourcePoll(h.browser, { sourceId })).toMatchObject({ outcome: 'OK', counts: { NEW_POST: 1 } });
    await h.drain();
    const fresh = await h.db.sourcePost.findFirstOrThrow({ where: { sourceId, archivedAt: null } });
    expect(fresh).toMatchObject({ externalId: original.externalId, resetGeneration: 1, isBaseline: false });
    const next = await h.db.contentVariant.findFirstOrThrow({ where: { sourcePostId: fresh.id, status: 'READY' } });
    const repeat = await dispatchBacklogItem(h.core, next.id);
    await h.drain();
    expect(await h.db.publication.count({ where: { id: { in: [earlier, repeat] }, status: 'PUBLISHED_VERIFIED' } })).toBe(2);
    expect(h.platform.timeline('fb-B1')).toHaveLength(2);
  } finally { await h.close(); }
}, 45_000);
