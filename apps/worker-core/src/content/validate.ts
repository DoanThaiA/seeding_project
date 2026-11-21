import { REVIEW_REASONS } from '@seedingsys/contracts';
import { freezeSnapshot, moveVariant, openOperatorTask, tx } from '@seedingsys/db';
import { runCaptionChecks } from '@seedingsys/domain';
import type { CoreCtx } from '../ctx';

const CHECK_REASON: Record<string, string> = {
  length: REVIEW_REASONS.TOO_LONG,
  facts_preserved: REVIEW_REASONS.FACT_MISSING,
  negation_kept: REVIEW_REASONS.NEGATION_LOST,
};

/**
 * content.validate — deterministic checks are signals; any failure, incomplete source, missing
 * media, LLM flag or manual review mode sends the variant to NEEDS_REVIEW. Only a clean variant
 * is frozen as READY.
 */
export async function handleContentValidate(ctx: CoreCtx, p: { variantId: string }): Promise<void> {
  const v = await ctx.db.contentVariant.findUnique({
    where: { id: p.variantId },
    include: { revision: { include: { post: true } } },
  });
  if (!v || v.status !== 'VALIDATING') return;

  const caption = v.caption ?? '';
  const checks = runCaptionChecks({ source: v.revision.text, caption, facts: (v.factsToPreserve as string[] | null) ?? [] });
  const reasons = new Set<string>();
  for (const c of checks) if (!c.passed) reasons.add(c.kind === 'length' && caption.trim().length === 0 ? REVIEW_REASONS.EMPTY : CHECK_REASON[c.kind]);
  if ((v.revision.incomplete as string[]).length) reasons.add(REVIEW_REASONS.INCOMPLETE);
  if (v.revision.mediaStatus === 'FAILED' || v.revision.mediaStatus === 'PENDING') reasons.add(REVIEW_REASONS.MEDIA_FAILED);
  if (v.revision.post.isShared) reasons.add('SHARED_POST_RIGHTS_CHECK');
  if (v.revision.post.identityConfidence === 'LOW') reasons.add('LOW_IDENTITY_CONFIDENCE');
  const editorReasons = (v.reviewReasons as string[]).filter(reason => reason !== REVIEW_REASONS.TOO_SIMILAR);
  if (editorReasons.length) reasons.add(REVIEW_REASONS.LLM_FLAGGED);

  const mapping = await ctx.db.sourceTargetMapping.findUnique({ where: { sourceId_targetId: { sourceId: v.revision.post.sourceId, targetId: v.targetId } } });
  if (mapping?.reviewMode === 'MANUAL') reasons.add(REVIEW_REASONS.MANUAL_MODE);

  const now = ctx.clock.now();
  await tx(ctx.db, async (t) => {
    await t.contentCheck.createMany({
      data: checks.map((c) => ({ variantId: v.id, kind: c.kind, passed: c.passed, details: (c.details ?? {}) as object })),
    });
    if (reasons.size) {
      const list = [...reasons, ...editorReasons];
      const ok = await moveVariant(t, { id: v.id, from: 'VALIDATING', to: 'NEEDS_REVIEW', actor: ctx.actor, now, reason: [...reasons].join(','), data: { reviewReasons: list } });
      if (ok) await openOperatorTask(t, { kind: 'REVIEW_CONTENT', reason: [...reasons].join(','), targetId: v.targetId, variantId: v.id, now });
      return;
    }
    await freezeSnapshot(t, { variantId: v.id, from: 'VALIDATING', now, actor: ctx.actor });
  });
}
