import type { ConnectorRegistry } from '@seedingsys/connectors-core';
import { advanceRevisionMedia, tx, type Db } from '@seedingsys/db';
import { sha256, type Clock } from '@seedingsys/domain';
import type { Logger } from '@seedingsys/observability';
import { assetObjectKey, type ObjectStore } from '@seedingsys/storage';

export interface MediaCtx {
  db: Db;
  clock: Clock;
  log: Logger;
  actor: string;
  registry: ConnectorRegistry;
  store: ObjectStore;
  maxFetchAttempts: number;
}

/**
 * asset.fetch — copy permitted media into managed storage (never rely on expiring source URLs),
 * verify checksum, then let the revision move on once its whole media set is settled.
 * Runs in its own job so slow media never holds a poll.
 */
export async function handleAssetFetch(ctx: MediaCtx, p: { assetId: string }): Promise<'STORED' | 'FAILED' | 'SKIPPED'> {
  const asset = await ctx.db.asset.findUnique({ where: { id: p.assetId }, include: { posts: true } });
  if (!asset) return 'SKIPPED';

  let outcome: 'STORED' | 'FAILED' | 'SKIPPED' = 'SKIPPED';
  if (asset.status === 'PENDING') {
    const attempts = asset.fetchAttempts + 1;
    const current = { id: asset.id, status: 'PENDING' as const, sourceUrl: asset.sourceUrl };
    const started = await ctx.db.asset.updateMany({
      where: { ...current, fetchAttempts: asset.fetchAttempts },
      data: { fetchAttempts: attempts },
    });
    if (!started.count) return 'SKIPPED';
    const attempt = { ...current, fetchAttempts: attempts };
    try {
      const reader = ctx.registry.reader(asset.connector);
      const { bytes, mime } = await reader.fetchMedia({ ref: asset.sourceRef ?? '', sourceUrl: asset.sourceUrl });
      const sum = sha256(bytes);
      if (asset.expectedChecksum && asset.expectedChecksum !== sum) throw new Error(`checksum mismatch (expected ${asset.expectedChecksum.slice(0, 12)}, got ${sum.slice(0, 12)})`);
      const key = assetObjectKey(sum, mime);
      if (!(await ctx.store.exists(key))) await ctx.store.put(key, bytes, mime);
      const stored = await ctx.db.asset.updateMany({
        where: attempt,
        data: { status: 'STORED', checksum: sum, objectKey: key, mime, bytes: BigInt(bytes.length), lastError: null },
      });
      if (!stored.count) return 'SKIPPED';
      outcome = 'STORED';
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 500);
      if (attempts < ctx.maxFetchAttempts) {
        const retry = await ctx.db.asset.updateMany({ where: attempt, data: { lastError: msg } });
        if (retry.count) throw e; // queue retries with backoff
        return 'SKIPPED';
      }
      const failed = await ctx.db.asset.updateMany({ where: attempt, data: { status: 'FAILED', lastError: msg } });
      if (!failed.count) return 'SKIPPED';
      ctx.log.warn({ asset_id: asset.id, err: msg }, 'asset fetch failed permanently');
      outcome = 'FAILED';
    }
  }

  const now = ctx.clock.now();
  await tx(ctx.db, async (t) => {
    for (const pa of asset.posts) await advanceRevisionMedia(t, pa.revisionId, now, ctx.actor);
  });
  return outcome;
}
