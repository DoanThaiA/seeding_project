import { ACTIVE, UNRESOLVED } from '@seedingsys/contracts';
import { Prisma, type Db } from './index';
import { tx } from './index';
import { audit } from './audit';
import { movePublication, moveSlot } from './transitions';

/** Empty the requested source archives and start an independent scan, retaining past publication receipts. */
export async function resetSourceArchive(db: Db, codes: string[], actor: string, now: Date) {
  return tx(db, async t => {
    const sources = await t.$queryRaw<Array<{ id: string; code: string; enabled: boolean }>>`
      SELECT id,code,enabled FROM sources WHERE code=ANY(${codes}::text[]) ORDER BY id FOR UPDATE`;
    if (!sources.length || sources.length !== new Set(codes).size) throw new Error('Danh sách nguồn đã thay đổi.');
    if (sources.some(source => source.enabled)) throw new Error('Nguồn đang bật quét. Cần dừng quét trước khi làm lại kho.');
    const sourceIds = sources.map(source => source.id);
    const [busy] = await t.$queryRaw<Array<{ active: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM publication_slots ps JOIN publication_schedules sch ON sch.id=ps.schedule_id
        WHERE sch.stopped_at IS NULL AND ps.schedule_source_ids && ${sourceIds}::uuid[]
          AND ps.status IN ('PLANNED','DEFERRED','DISPATCHED','STARTED','RESERVED')
      ) OR EXISTS (
        SELECT 1 FROM profile_syncs ps JOIN source_target_mappings m ON m.id=ps.mapping_id
        WHERE m.source_id=ANY(${sourceIds}::uuid[])
          AND (ps.phase IN ('DISCOVERING','PREPARING') OR (ps.phase='PREPARED' AND ps.publish AND EXISTS (
            SELECT 1 FROM profile_sync_items i WHERE i.sync_id=ps.id AND i.publish_status='PENDING')))
      ) AS active`;
    if (busy.active) throw new Error('Có lịch đăng hoặc lượt đồng bộ chưa xong cho các nguồn này.');

    const posts = await t.$queryRaw<Array<{ id: string; source_id: string; archived_at: Date | null }>>`
      SELECT p.id,p.source_id,p.archived_at FROM source_posts p JOIN sources s ON s.id=p.source_id
      WHERE p.source_id=ANY(${sourceIds}::uuid[]) AND p.reset_generation=s.reset_generation ORDER BY p.id FOR UPDATE OF p`;
    const postIds = posts.map(post => post.id);
    const publications = await t.$queryRaw<Array<{ id: string; status: string; slot_id: string | null }>>`
      SELECT id,status::text,slot_id FROM publications WHERE source_post_id=ANY(${postIds}::uuid[]) ORDER BY id FOR UPDATE`;
    const blocking = new Set<string>([...ACTIVE, ...UNRESOLVED]);
    if (publications.some(p => blocking.has(p.status))) throw new Error('Có bài đang đăng hoặc chưa rõ kết quả.');
    if (await t.publicationComment.findFirst({ where: { source: { sourcePostId: { in: postIds } }, status: 'SENDING' } })) {
      throw new Error('Có bình luận đang gửi.');
    }

    for (const p of publications.filter(p => p.status === 'QUEUED')) {
      if (await movePublication(t, { id: p.id, from: 'QUEUED', to: 'CANCELLED', actor, now, reason: 'SOURCE_ARCHIVE_RESET' }) && p.slot_id) {
        await moveSlot(t, { id: p.slot_id, from: 'DISPATCHED', to: 'MISSED', actor, now, reason: 'SOURCE_ARCHIVE_RESET' });
      }
    }
    await t.commentScan.updateMany({ where: { sourcePostId: { in: postIds }, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'FAILED', detail: 'Kho nguồn đã được làm lại.', updatedAt: now } });
    await t.publicationComment.updateMany({ where: { source: { sourcePostId: { in: postIds } }, status: 'QUEUED' },
      data: { status: 'FAILED', sendDetail: 'Kho nguồn đã được làm lại.', updatedAt: now } });
    await t.$executeRaw`UPDATE operator_tasks SET status='DONE', resolved_by=${actor}, closed_at=${now},
      resolution=jsonb_build_object('reason', 'source_archive_reset')
      WHERE kind='REVIEW_CONTENT' AND status IN ('OPEN','CLAIMED') AND EXISTS (
        SELECT 1 FROM content_variants v WHERE v.id=operator_tasks.variant_id AND v.source_post_id=ANY(${postIds}::uuid[]))`;
    const removed = await t.sourcePost.updateMany({ where: { id: { in: postIds }, archivedAt: null }, data: { archivedAt: now, archivedBy: actor } });
    await t.source.updateMany({ where: { id: { in: sourceIds } }, data: {
      resetGeneration: { increment: 1 }, baselineDone: false, watermark: Prisma.DbNull, lastPollAt: null, lastSuccessAt: null,
      lastErrorAt: null, lastError: null, lastIncomplete: Prisma.DbNull, runNowFrom: null, runNowUntil: null, runNowLimit: null, runNowVariantIds: [],
    } });
    for (const source of sources) await audit(t, { entityType: 'source', entityId: source.id, action: 'source_archive_reset', actor, at: now,
      data: { archived: posts.filter(post => post.source_id === source.id && !post.archived_at).length } });
    return { sources: sources.length, archived: removed.count };
  }, 30_000);
}
