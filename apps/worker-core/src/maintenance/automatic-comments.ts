import { Q, type PublishSnapshot } from '@seedingsys/contracts';
import { activeKillSwitch, calendarForPublicationSlot, enqueue, prepareCommentDrafts, tx } from '@seedingsys/db';
import { commentReplayBody, facebookPostLink } from '@seedingsys/domain';
import type { CoreCtx } from '../ctx';

/** Replay one comment at a time on each verified post, after the source scan completes. */
export async function dispatchAutomaticComments(ctx: CoreCtx): Promise<number> {
  const candidates = await ctx.db.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM publications p
    JOIN source_posts sp ON sp.id=p.source_post_id AND sp.archived_at IS NULL
    JOIN sources s ON s.id=sp.source_id AND s.publish_comments
    JOIN source_target_mappings m ON m.source_id=s.id AND m.target_id=p.target_id AND m.enabled
    JOIN target_accounts t ON t.id=p.target_id AND t.enabled AND t.connector='fb-web'
    LEFT JOIN publication_slots slot ON slot.id=p.slot_id
    LEFT JOIN publication_schedules calendar ON calendar.id=slot.schedule_id
    LEFT JOIN LATERAL (
      SELECT status FROM comment_scans WHERE source_post_id=sp.id ORDER BY created_at DESC,id DESC LIMIT 1
    ) scan ON true
    WHERE p.status='PUBLISHED_VERIFIED' AND p.auto_replay_comments AND p.permalink IS NOT NULL
      AND calendar.stopped_at IS NULL AND (s.enabled OR (calendar.id IS NOT NULL AND scan.status='COMPLETE'))
      AND ((scan.status IS NULL AND s.collect_comments) OR (scan.status='COMPLETE' AND EXISTS (
        SELECT 1 FROM source_comments c
        LEFT JOIN publication_comments r ON r.source_comment_id=c.id AND r.destination_id=p.target_id
        WHERE c.source_post_id=sp.id AND length(trim(c.text))>0
          AND (r.id IS NULL OR (r.status='DRAFT' AND (r.author_target_id IS NULL OR r.auto_author) AND r.text=c.text))
          AND (c.parent_external_id IS NULL OR EXISTS (
            SELECT 1 FROM source_comments parent
            JOIN publication_comments receipt ON receipt.source_comment_id=parent.id AND receipt.destination_id=p.target_id
            WHERE parent.source_post_id=sp.id AND parent.external_id=c.parent_external_id
              AND receipt.status='POSTED' AND receipt.permalink IS NOT NULL
          ))
      )))
      AND NOT EXISTS (
        SELECT 1 FROM publication_comments active JOIN source_comments c ON c.id=active.source_comment_id
        WHERE c.source_post_id=sp.id AND active.destination_id=p.target_id
          AND active.status IN ('QUEUED','SENDING','UNKNOWN')
      )
    ORDER BY p.verified_at ASC, p.id LIMIT 50`;
  let queued = 0;
  for (const { id } of candidates) {
    queued += await tx(ctx.db, async t => {
      const p = await t.publication.findUnique({ where: { id }, include: {
        post: { select: { sourceId: true } },
        target: { select: { audience: true } },
        variant: { select: { snapshot: true } },
      } });
      if (!p?.autoReplayComments || p.status !== 'PUBLISHED_VERIFIED' || !facebookPostLink(p.permalink)) return 0;
      const calendar = await calendarForPublicationSlot(t, p.slotId);
      if (calendar?.stoppedAt) return 0;
      await t.$queryRaw`SELECT id FROM source_posts WHERE id=${p.sourcePostId}::uuid FOR UPDATE`;
      const source = await t.source.findFirst({ where: {
        id: p.post.sourceId, publishComments: true,
        mappings: { some: { targetId: p.targetId, enabled: true, target: { enabled: true, connector: 'fb-web', profile: { isNot: null } } } },
      } });
      if (!source || await activeKillSwitch(t, { sourceId: source.id, targetId: p.targetId, connector: 'fb-web' })) return 0;
      const current = await t.sourcePost.findUnique({ where: { id: p.sourcePostId }, select: { archivedAt: true, permalink: true } });
      if (!current || current.archivedAt || (!current.permalink && source.connector !== 'fb-graph')) return 0;
      const scan = await t.commentScan.findFirst({ where: { sourcePostId: p.sourcePostId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (!source.enabled && (!calendar || scan?.status !== 'COMPLETE')) return 0;
      const now = ctx.clock.now();
      if (!scan) {
        if (!source.collectComments) return 0;
        const created = await t.commentScan.create({ data: { sourcePostId: p.sourcePostId, requestedBy: ctx.actor } });
        await enqueue(t, Q.CommentScan, { scanId: created.id });
        return 1;
      }
      if (scan.status !== 'COMPLETE') return 0;
      await prepareCommentDrafts(t, p.sourcePostId, [p.targetId], now);
      const rows = await t.publicationComment.findMany({
        where: { destinationId: p.targetId, source: { sourcePostId: p.sourcePostId } },
        include: { source: true }, orderBy: [{ source: { position: 'asc' } }, { id: 'asc' }],
      });
      if (rows.some(r => r.status === 'QUEUED' || r.status === 'SENDING' || r.status === 'UNKNOWN')) return 0;
      const postedParents = new Set(rows.filter(r => r.status === 'POSTED' && r.permalink).map(r => r.source.externalId));
      const audience = (p.variant.snapshot as PublishSnapshot | null)?.audience ?? p.target.audience;
      for (const row of rows) {
        if (row.status !== 'DRAFT' || !row.authorTargetId || !row.autoAuthor || row.text !== row.source.text) continue;
        if (row.source.parentExternalId && !postedParents.has(row.source.parentExternalId)) continue;
        const text = commentReplayBody(row.text, row.source.text);
        if (!text) continue;
        const authorTargetId = audience === 'PUBLIC' ? row.authorTargetId : p.targetId;
        if (await activeKillSwitch(t, { sourceId: source.id, targetId: authorTargetId, connector: 'fb-web' })) continue;
        const changed = await t.publicationComment.updateMany({
          where: { id: row.id, status: 'DRAFT', text: row.text, authorTargetId: row.authorTargetId,
            autoAuthor: true, sendVersion: row.sendVersion },
          data: { status: 'QUEUED', authorTargetId, text, sendVersion: { increment: 1 }, updatedAt: now },
        });
        if (!changed.count) return 0;
        await enqueue(t, Q.CommentPublish, { replayId: row.id, sendVersion: row.sendVersion + 1, automatic: true });
        return 1;
      }
      return 0;
    });
  }
  return queued;
}
