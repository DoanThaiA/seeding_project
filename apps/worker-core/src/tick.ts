import type { CoreCtx } from './ctx';
import { expireContent, sweepExpiredLeases } from './maintenance/lease-sweeper';
import { dispatchDuePolls } from './scheduler/poll-dispatcher';
import { dispatchDueSlots, ensureSlots, sweepLateDispatches } from './scheduler/slots';
import { requeueReviewedCopies } from './maintenance/requeue-reviewed-copies';
import { settleDuplicates } from './maintenance/duplicates';

/**
 * One scheduler pass. pg-boss fires it every minute (singleton cron across instances); every
 * step is idempotent, so a duplicate or late tick is harmless.
 */
export async function schedulerTick(ctx: CoreCtx) {
  const leases = await sweepExpiredLeases(ctx);
  const expired = await expireContent(ctx);
  const requeuedCaptions = await requeueReviewedCopies(ctx);
  const duplicates = await settleDuplicates(ctx);
  const polls = await dispatchDuePolls(ctx);
  const created = await ensureSlots(ctx);
  const late = await sweepLateDispatches(ctx);
  const slots = await dispatchDueSlots(ctx);
  return { leases, expired, requeuedCaptions, duplicates, polls, created, late, slots };
}
