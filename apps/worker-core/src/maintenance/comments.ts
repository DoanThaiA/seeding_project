import { COMMENT_QUEUE_MS, COMMENT_STALL_MS } from '@seedingsys/contracts';
import type { CoreCtx } from '../ctx';

export async function settleStalledComments(ctx: CoreCtx) {
  const now = ctx.clock.now();
  const stale = { lte: new Date(+now - COMMENT_STALL_MS) };
  const scans = await ctx.db.commentScan.updateMany({
    where: { status: 'RUNNING', updatedAt: stale },
    data: { status: 'FAILED', detail: 'Lượt quét bị gián đoạn. Có thể quét lại.', updatedAt: now },
  });
  const queued = await ctx.db.publicationComment.updateMany({
    where: { status: 'QUEUED', updatedAt: { lte: new Date(+now - COMMENT_QUEUE_MS) } },
    data: { status: 'FAILED', sendDetail: 'Hết thời gian chờ worker. Có thể gửi lại.', updatedAt: now },
  });
  const sending = await ctx.db.publicationComment.updateMany({
    where: { status: 'SENDING', updatedAt: stale },
    data: { status: 'UNKNOWN', sendDetail: 'Chưa rõ kết quả. Đối chiếu trên Facebook.', updatedAt: now },
  });
  return { scans: scans.count, queued: queued.count, sending: sending.count };
}
