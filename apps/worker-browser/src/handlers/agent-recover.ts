import { openOperatorTask } from '@seedingsys/db';
import type { BrowserCtx } from '../ctx';

/**
 * agent.recover — PLACEHOLDER (phase 5). The UI-exception agent (Claude API with the limited tools
 * observe_screen, inspect_ui, select_element, fill_approved_caption, attach_job_media,
 * request_publish, report_unresolved; budget 8 steps / 90 s) is not released yet, so every request
 * is handed to an operator. It never runs for checkpoints or logins.
 */
export async function handleAgentRecover(ctx: BrowserCtx, p: { publicationId: string; attemptId: string; reason: string }): Promise<void> {
  const pub = await ctx.db.publication.findUnique({ where: { id: p.publicationId } });
  if (!pub) return;
  await openOperatorTask(ctx.db, {
    kind: 'TAKEOVER_ACCOUNT',
    reason: `AGENT_UNAVAILABLE:${p.reason}`,
    targetId: pub.targetId,
    publicationId: pub.id,
    details: { attemptId: p.attemptId },
    now: ctx.clock.now(),
  });
}
