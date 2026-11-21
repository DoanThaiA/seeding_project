import { Q, REVIEW_REASONS } from '@seedingsys/contracts';
import { enqueue, moveVariant, openOperatorTask, tx } from '@seedingsys/db';
import { LlmBudgetExceededError, LlmRefusalError } from '@seedingsys/llm';
import { isFacebookTimelineReader } from '@seedingsys/domain';
import type { CoreCtx } from '../ctx';

const MAX_REWRITE_TRIES = 2;

/** content.rewrite — LLM editing for one (revision, target). Never loops: failures end in NEEDS_REVIEW. */
export async function handleContentRewrite(ctx: CoreCtx, p: { variantId: string; useAi?: boolean }): Promise<void> {
  const v = await ctx.db.contentVariant.findUnique({
    where: { id: p.variantId },
    include: { target: true, revision: { include: { post: { include: { source: true } } } } },
  });
  if (!v || v.status !== 'REWRITING') return; // stale / duplicate delivery

  const raw = v.revision.raw as { reader?: string } | null;
  if (!p.useAi && isFacebookTimelineReader(raw?.reader ?? v.revision.post.source.connector)) {
    await tx(ctx.db, async (t) => {
      const ok = await moveVariant(t, {
        id: v.id, from: 'REWRITING', to: 'VALIDATING', actor: ctx.actor, now: ctx.clock.now(),
        data: { caption: v.caption ?? v.revision.text, factsToPreserve: [], reviewReasons: [] },
      });
      if (ok) await enqueue(t, Q.ContentValidate, { variantId: v.id });
    });
    return;
  }

  const toReview = async (reason: string, extra: string[] = []) => {
    const now = ctx.clock.now();
    await tx(ctx.db, async (t) => {
      const ok = await moveVariant(t, { id: v.id, from: 'REWRITING', to: 'NEEDS_REVIEW', actor: ctx.actor, now, reason, data: { reviewReasons: [reason, ...extra] } });
      if (ok) await openOperatorTask(t, { kind: 'REVIEW_CONTENT', reason, targetId: v.targetId, variantId: v.id, now });
    });
  };

  await ctx.db.contentVariant.update({ where: { id: v.id }, data: { rewriteTries: { increment: 1 } } });
  try {
    const { output, cacheKey } = await ctx.llm.rewrite({
      revisionId: v.revisionId,
      variantId: v.id,
      sourceText: v.revision.text,
      albumTitle: v.revision.albumTitle,
      contentType: v.contentType,
      sourceName: v.revision.post.source.name,
      targetStyle: v.target.styleProfile as Record<string, unknown>,
    });
    const now = ctx.clock.now();
    await tx(ctx.db, async (t) => {
      const ok = await moveVariant(t, {
        id: v.id,
        from: 'REWRITING',
        to: 'VALIDATING',
        actor: ctx.actor,
        now,
        data: {
          caption: output.caption,
          factsToPreserve: output.facts_to_preserve,
          attribution: output.attribution,
          reviewReasons: output.review_reasons,
          promptVersion: output.prompt_version,
          modelId: output.model_id,
          cacheKey,
        },
      });
      if (ok) await enqueue(t, Q.ContentValidate, { variantId: v.id });
    });
  } catch (e) {
    if (e instanceof LlmBudgetExceededError) return toReview(REVIEW_REASONS.BUDGET);
    if (e instanceof LlmRefusalError) return toReview(REVIEW_REASONS.LLM_FAILED, [String(e.message)]);
    if (v.rewriteTries + 1 >= MAX_REWRITE_TRIES) return toReview(REVIEW_REASONS.LLM_FAILED, [String((e as Error).message)]);
    throw e; // let the queue retry once more
  }
}
