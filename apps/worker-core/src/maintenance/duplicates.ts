import { backfillContentKeys, retireDuplicateVariants, tx } from '@seedingsys/db';
import type { CoreCtx } from '../ctx';

const BATCH = 200;
const MAX_BATCHES = 20;

/**
 * Keep every target free of duplicate content: give settled revisions their content key (also the
 * ones stored before keys existed), then move waiting copies of content another source post already
 * holds for the same target to DUPLICATE. Runs before slots are dispatched.
 */
export async function settleDuplicates(ctx: CoreCtx): Promise<{ keyed: number; duplicates: number }> {
  let keyed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await tx(ctx.db, t => backfillContentKeys(t, BATCH), 60_000);
    keyed += n;
    if (n < BATCH) break;
  }
  const duplicates = await tx(ctx.db, t => retireDuplicateVariants(t, { now: ctx.clock.now(), actor: ctx.actor }), 60_000);
  if (duplicates) ctx.log.info({ duplicates }, 'duplicate content retired');
  return { keyed, duplicates };
}
