import { Q, REVIEW_REASONS } from '@seedingsys/contracts';
import { closeVariantReviewTasks, enqueue, moveVariant, tx } from '@seedingsys/db';
import type { CoreCtx } from '../ctx';

/** Revisit only still-live guest posts stranded by the retired caption check. */
export async function requeueReviewedCopies(ctx: CoreCtx): Promise<number> {
  const now = ctx.clock.now();
  return tx(ctx.db, async t => {
    const items = await t.$queryRaw<Array<{ id: string; edited: boolean }>>`
      SELECT v.id, EXISTS (
        SELECT 1 FROM audit_events a WHERE a.entity_type = 'variant'
          AND a.entity_id = v.id::text AND a.action = 'caption_edited'
      ) AS edited FROM content_variants v
      JOIN source_posts sp ON sp.id = v.source_post_id
      JOIN sources s ON s.id = sp.source_id
      JOIN source_post_revisions r ON r.id = v.revision_id
      JOIN source_target_mappings m ON m.source_id = sp.source_id AND m.target_id = v.target_id AND m.enabled
      WHERE v.status = 'NEEDS_REVIEW' AND s.enabled
        AND COALESCE(r.raw->>'reader', s.connector) IN ('fb-public','fb-session')
        AND v.review_reasons ? ${REVIEW_REASONS.TOO_SIMILAR}
        AND (v.expires_at IS NULL OR v.expires_at > ${now})
      ORDER BY v.created_at
      LIMIT 50 FOR UPDATE OF v SKIP LOCKED`;
    for (const item of items) {
      const ok = await moveVariant(t, {
        id: item.id, from: 'NEEDS_REVIEW', to: 'REWRITING', actor: ctx.actor, now,
        reason: 'legacy_similarity_check_retired', data: { reviewReasons: [], caption: item.edited ? undefined : null },
      });
      if (!ok) continue;
      await closeVariantReviewTasks(t, item.id, ctx.actor, now, 'rechecking_caption');
      await enqueue(t, Q.ContentRewrite, { variantId: item.id });
    }
    return items.length;
  });
}
