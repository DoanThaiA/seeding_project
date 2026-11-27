import { Q } from '@seedingsys/contracts';
import { activeKillSwitch, enqueue, tx } from '@seedingsys/db';
import { sourceScheduleOpen } from '@seedingsys/domain';
import type { CoreCtx } from '../ctx';

/**
 * Every tick: enqueue source.poll for each enabled source whose interval has elapsed.
 * The queue is "stately" with singletonKey = sourceId, so a source never has more than one
 * queued + one running poll; a slow source is reported as lagging instead of piling up.
 */
export async function dispatchDuePolls(ctx: CoreCtx): Promise<number> {
  const now = ctx.clock.now();
  const sources = await ctx.db.source.findMany({ where: { enabled: true, connector: { not: 'manual' } } });
  let n = 0;
  for (const s of sources) {
    const due = !s.lastPollAt || s.lastPollAt.getTime() + s.pollIntervalSec * 1000 <= now.getTime();
    if (!due || !sourceScheduleOpen(s, now)) continue;
    const kill = await activeKillSwitch(ctx.db, { sourceId: s.id, connector: s.connector });
    if (kill) continue;
    await tx(ctx.db, async (t) => {
      const r = await t.source.updateMany({
        where: { id: s.id, enabled: true, connector: s.connector, lastPollAt: s.lastPollAt,
          runStartMinute: s.runStartMinute, runEndMinute: s.runEndMinute, runNowUntil: s.runNowUntil },
        data: { lastPollAt: now },
      });
      if (r.count === 1) {
        await enqueue(t, Q.SourcePoll, { sourceId: s.id, scheduled: true }, { singletonKey: s.id });
        n++;
      }
    });
  }
  return n;
}
