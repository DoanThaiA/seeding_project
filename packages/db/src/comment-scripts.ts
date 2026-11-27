import { Q } from '@seedingsys/contracts';
import { enqueue } from './outbox';
import type { Tx } from './index';

export function lockCommentScript(t: Tx, id: string) {
  return t.$queryRaw`SELECT id FROM comment_scripts WHERE id=${id}::uuid FOR UPDATE`;
}

/** Call with the script row locked. Only the first unconfirmed step can be queued. */
export async function queueCommentScriptStep(t: Tx, scriptId: string, now: Date, retryId?: string) {
  const step = await t.commentScriptStep.findFirst({ where: { scriptId, status: { not: 'POSTED' } }, orderBy: { position: 'asc' } });
  if (!step || (retryId ? step.id !== retryId || !['FAILED', 'UNKNOWN'].includes(step.status) : step.status !== 'DRAFT')) return false;
  const sendVersion = step.sendVersion + 1;
  const changed = await t.commentScriptStep.updateMany({ where: { id: step.id, status: step.status, sendVersion: step.sendVersion },
    data: { status: 'QUEUED', sendVersion, detail: null, updatedAt: now } });
  if (!changed.count) return false;
  await enqueue(t, Q.CommentScriptStep, { stepId: step.id, sendVersion });
  return true;
}
