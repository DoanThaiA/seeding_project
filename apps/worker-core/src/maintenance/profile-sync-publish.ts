import { ACTIVE, SUCCESS, UNRESOLVED, FB_WEB_PUBLISH_FORMATS, hasReviewPublishChoice, needsPublishChoice, workflowFor } from '@seedingsys/contracts';
import { BacklogDispatchError, SnapshotBlockedError, closeVariantReviewTasks, contentHolder, dispatchBacklogItem,
  freezeSnapshot, revisionContentKey, tx } from '@seedingsys/db';
import type { CoreCtx } from '../ctx';

const waitReasons = new Set(['ACCOUNT_BUSY', 'UNRESOLVED_PUBLICATION', 'PUBLISH_INTERVAL_NOT_ELAPSED',
  'KILL_SWITCH_GLOBAL', 'KILL_SWITCH_CONNECTOR', 'KILL_SWITCH_TARGET', 'KILL_SWITCH_CONTENT',
  'NO_WORKER', 'TARGET_DISABLED', 'NO_CONNECTOR_RELEASE', 'RACE']);

async function prepare(ctx: CoreCtx, key: { syncId: string; sourcePostId: string }) {
  return tx(ctx.db, async t => {
    const pending = await t.$queryRaw<Array<{ sync_id: string }>>`SELECT sync_id FROM profile_sync_items
      WHERE sync_id=${key.syncId}::uuid AND source_post_id=${key.sourcePostId}::uuid AND publish_status='PENDING' FOR UPDATE`;
    if (!pending.length) return;
    await t.$queryRaw`SELECT id FROM source_posts WHERE id=${key.sourcePostId}::uuid FOR SHARE`;
    const item = await t.profileSyncItem.findUnique({ where: { syncId_sourcePostId: key }, include: {
      post: true, sync: { include: { mapping: { include: { target: true } } } },
    } });
    if (!item || item.publishStatus !== 'PENDING' || item.sync.phase !== 'PREPARED') return;
    const { post, sync } = item;
    const { mapping } = sync;
    const record = (publishStatus: string, publishDetail: string | null) => t.profileSyncItem.updateMany({
      where: { ...key, publishStatus: 'PENDING' }, data: { publishStatus, publishDetail },
    });
    const block = async (detail: string) => { await record('BLOCKED', detail); };
    if (!mapping.enabled || post.archivedAt || !post.latestRevisionId) return block('ITEM_UNAVAILABLE');
    const previous = await t.publication.findUnique({ where: { targetId_sourcePostId: { targetId: mapping.targetId, sourcePostId: post.id } } });
    if (previous && ['QUEUED', ...ACTIVE, ...SUCCESS, ...UNRESOLVED].includes(previous.status)) {
      await record('TRACKED', null);
      return;
    }
    const revision = await t.sourcePostRevision.findUniqueOrThrow({ where: { id: post.latestRevisionId } });
    const current = await t.contentVariant.findUnique({ where: { revisionId_targetId: { revisionId: revision.id, targetId: mapping.targetId } } });
    const now = ctx.clock.now();
    const holder = await contentHolder(t, { targetId: mapping.targetId, sourcePostId: post.id,
      contentKey: await revisionContentKey(t, revision.id), now, publicationsOnly: true });
    if (holder) {
      const match = await t.publication.findUnique({ where: { targetId_sourcePostId: { targetId: mapping.targetId, sourcePostId: holder } } });
      if (match && SUCCESS.includes(match.status)) {
        await record('DUPLICATE', null);
        if (current?.status === 'NEEDS_REVIEW') await closeVariantReviewTasks(t, current.id, ctx.actor, now, 'duplicate_content');
        return;
      }
      if (match && !['CANCELLED', 'FAILED_CONFIRMED'].includes(match.status)) {
        await record('PENDING', 'DUPLICATE_PENDING');
        return 'WAIT' as const;
      }
    }
    const approvedSelection = current?.status === 'READY' && hasReviewPublishChoice(current.snapshot, current.reviewedBy);
    const contentType = approvedSelection ? current.contentType : post.contentType;
    if (needsPublishChoice(contentType)) return block('REVIEW_REQUIRED');
    if (!workflowFor(contentType) || (mapping.target.connector === 'fb-web' && !FB_WEB_PUBLISH_FORMATS.includes(contentType))) {
      return block('FORMAT_UNSUPPORTED');
    }
    if ((revision.raw as { sharedPermalink?: string } | null)?.sharedPermalink) return block('NATIVE_SHARE_REQUIRED');
    if (!approvedSelection && revision.mediaStatus === 'PENDING') {
      await record('PENDING', 'MEDIA_PENDING');
      return 'WAIT' as const;
    }
    if (!approvedSelection && revision.mediaStatus === 'FAILED') return block('MEDIA_INCOMPLETE');
    if (!approvedSelection && (!Array.isArray(revision.incomplete) || revision.incomplete.length > 0 || post.identityConfidence !== 'HIGH')) {
      return block('SOURCE_INCOMPLETE');
    }
    if (!current || (current.expiresAt && current.expiresAt <= now)) return block('SOURCE_REVISION_CHANGED');
    if (['FETCHING_MEDIA', 'REWRITING', 'VALIDATING'].includes(current.status)) {
      await record('PENDING', 'CONTENT_PENDING');
      return 'WAIT' as const;
    }
    if (current.status !== 'READY') {
      if (current.status !== 'NEEDS_REVIEW' || mapping.reviewMode === 'MANUAL' || current.caption !== revision.text
        || !Array.isArray(current.reviewReasons) || current.reviewReasons.length !== 1 || current.reviewReasons[0] !== 'PROFILE_SYNC_REVIEW') {
        return block('REVIEW_REQUIRED');
      }
      try {
        const frozen = await freezeSnapshot(t, { variantId: current.id, from: 'NEEDS_REVIEW', now,
          actor: sync.requestedBy, reviewedBy: sync.requestedBy, caption: revision.text });
        if (!frozen) return block('SOURCE_REVISION_CHANGED');
      } catch (error) {
        if (error instanceof SnapshotBlockedError) return block(error.message);
        throw error;
      }
      await closeVariantReviewTasks(t, current.id, ctx.actor, now, 'profile_sync_publish');
    }
    await t.profileSyncItem.updateMany({ where: { ...key, publishStatus: 'PENDING' }, data: { preparedVariantId: current.id } });
    return { variantId: current.id, actor: sync.requestedBy };
  });
}

/** One dispatch per run and pass. All remaining items stay owned by the sync, across worker restarts. */
export async function dispatchProfileSync(ctx: CoreCtx, syncId: string): Promise<number> {
  const items = await ctx.db.profileSyncItem.findMany({
    where: { syncId, publishStatus: 'PENDING', sync: { phase: 'PREPARED', publish: true } },
    select: { sourcePostId: true }, take: 25,
    orderBy: [{ post: { postedAt: { sort: 'asc', nulls: 'last' } } }, { post: { firstSeenAt: 'asc' } }, { sourcePostId: 'asc' }],
  });
  for (const { sourcePostId } of items) {
    const key = { syncId, sourcePostId };
    const prepared = await prepare(ctx, key);
    if (prepared === 'WAIT') break;
    if (!prepared) continue;
    try {
      await dispatchBacklogItem({ ...ctx, actor: prepared.actor }, prepared.variantId, key);
      return 1;
    } catch (error) {
      if (!(error instanceof BacklogDispatchError)) throw error;
      const waiting = waitReasons.has(error.reason);
      const concurrent = error.reason === 'ITEM_UNAVAILABLE';
      await ctx.db.profileSyncItem.updateMany({ where: { ...key, publishStatus: 'PENDING' }, data: {
        publishStatus: waiting || concurrent || error.reason === 'DUPLICATE_CONTENT' ? 'PENDING' : 'BLOCKED',
        publishDetail: error.reason,
      } });
      if (waiting || concurrent || error.reason === 'DUPLICATE_CONTENT') break;
    }
  }
  return 0;
}

export async function resumeProfileSyncs(ctx: CoreCtx): Promise<number> {
  const runs = await ctx.db.profileSync.findMany({
    where: { publish: true, phase: 'PREPARED', items: { some: { publishStatus: 'PENDING' } } },
    select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 50,
  });
  let dispatched = 0;
  for (const { id } of runs) dispatched += await dispatchProfileSync(ctx, id);
  return dispatched;
}
