import { isConnectorError, type ConnectorError, type SourceRef } from '@seedingsys/connectors-core';
import { ProfileDetailsSnapshot, Q, SOURCE_PROFILE_SCAN_STEP_MS, type JobPayload } from '@seedingsys/contracts';
import { activeKillSwitch, assertLeaseHeld, enqueue, releaseFinishedProfileScanAccount, releaseLease, tx } from '@seedingsys/db';
import { RetryLaterError, sha256 } from '@seedingsys/domain';
import { assetObjectKey } from '@seedingsys/storage';
import type { BrowserCtx } from '../ctx';
import { SourceReadAccountBusy, claimSourceReadAccount } from '../runtime/source-read-account';
import { handleSourcePoll } from './source-poll';

const errorDetail = (error: unknown) => isConnectorError(error) ? error.message.slice(0, 400) : 'Kết nối bị gián đoạn khi đọc hồ sơ Facebook.';
const transient = (error: unknown): error is ConnectorError => isConnectorError(error) && ['TRANSIENT', 'RATE_LIMITED'].includes(error.kind);

export async function handleSourceProfileScan(ctx: BrowserCtx, job: JobPayload<typeof Q.SourceProfileScan>, retryCount = 0) {
  const { scanId, phase, readTargetId } = job;
  const run = await ctx.db.sourceProfileScan.findUnique({ where: { id: scanId }, include: { source: true } });
  if (!run || run.phase !== phase) return;
  const where = { id: run.id, phase };
  const sourceKey = { id: run.sourceId, externalRef: run.sourceRef, connector: run.connector, resetGeneration: run.resetGeneration };
  const defer = () => tx(ctx.db, async t => {
    const now = ctx.clock.now();
    const updated = await t.sourceProfileScan.updateMany({ where, data: { updatedAt: now } });
    if (updated.count) await enqueue(t, Q.SourceProfileScan, job, { singletonKey: scanId, startAfter: new Date(+now + 30_000) });
  });
  try {
    if (+ctx.clock.now() - +run.updatedAt >= SOURCE_PROFILE_SCAN_STEP_MS) throw new Error('Lượt quét đã hết thời gian chờ.');
    if (run.source.externalRef !== run.sourceRef || run.source.connector !== run.connector || run.source.resetGeneration !== run.resetGeneration) {
      throw new Error('Nguồn A đã thay đổi cấu hình hoặc đã làm lại kho.');
    }
    if (phase === 'POSTS') {
      const result = await handleSourcePoll(ctx, { sourceId: run.sourceId, profileScanId: run.id, profileReadTargetId: readTargetId });
      if (result.outcome === 'OK' || result.outcome === 'OBSOLETE') return;
      if (result.outcome === 'WAITING_FOR_ACCOUNT' || result.outcome === 'ALREADY_RUNNING') {
        await defer();
        return;
      }
      if (retryCount < 8 && (result.outcome === 'FENCED' || /^(TRANSIENT|RATE_LIMITED):/.test(result.error ?? ''))) {
        throw new RetryLaterError(result.error ?? 'Đang chờ phiên đọc của nguồn A.');
      }
      throw new Error(result.error ?? 'Nguồn đang tạm dừng hoặc đã thay đổi.');
    }

    if (await activeKillSwitch(ctx.db, { sourceId: run.sourceId, connector: run.connector })) throw new Error('Nguồn đang tạm dừng.');
    const claim = run.connector === 'fb-session'
      ? await claimSourceReadAccount(ctx, run.sourceId, 'source-profile-scan', ctx.leaseTtlMs.POLL, readTargetId, scanId).catch(error => {
        if (error instanceof SourceReadAccountBusy) throw error;
        if (transient(error) && retryCount < 8) throw new RetryLaterError(error.message);
        throw error;
      }) : undefined;
    try {
      if (!await ctx.db.sourceProfileScan.findFirst({ where, select: { id: true } })) return;
      const sourceRef: SourceRef = { ...sourceKey, code: run.source.code, readAccount: claim?.account };
      const reader = ctx.registry.reader(run.connector);
      let profileIssue: string | null = null;
      let artworkIssue: string | null = null;
      const snapshot = await (async () => {
        try {
          if (!reader.readProfileDetails) throw new Error();
          const details = await reader.readProfileDetails(sourceRef);
          return ProfileDetailsSnapshot.parse({ ...details, capturedAt: ctx.clock.now().toISOString() });
        } catch (error) {
          if (transient(error) && retryCount < 8) throw new RetryLaterError(error.message);
          profileIssue = errorDetail(error);
        }
      })();

      const photos = await reader.readArchiveProfileArtwork?.(sourceRef).catch(error => {
        artworkIssue = errorDetail(error);
        return undefined;
      });
      const stored = await Promise.all((['avatar', 'cover'] as const).map(async kind => {
        const photo = photos?.[kind];
        if (!photo) return;
        const { bytes, mime, photoId, width, height } = photo;
        const checksum = sha256(bytes);
        const objectKey = assetObjectKey(checksum, mime);
        try {
          if (!await ctx.store.exists(objectKey)) await ctx.store.put(objectKey, bytes, mime);
          return { kind, data: { kind: 'image', connector: run.connector, sourceRef: photoId, mime, objectKey, width, height,
            bytes: BigInt(bytes.length), checksum, status: 'STORED' as const } };
        } catch {
          artworkIssue = 'Chưa lưu được tệp ảnh hồ sơ vào kho.';
        }
      }));
      const missing = (['avatar', 'cover'] as const).filter((_, index) => !stored[index]);
      if (missing.length && !artworkIssue) {
        artworkIssue = 'Chưa đọc được ' + missing.map(kind => kind === 'avatar' ? 'ảnh đại diện' : 'ảnh bìa').join(' và ') + '.';
      }
      await tx(ctx.db, async t => {
        await t.$queryRaw`SELECT id FROM sources WHERE id=${run.sourceId}::uuid FOR UPDATE`;
        const now = ctx.clock.now();
        if (!await t.source.findFirst({ where: sourceKey, select: { id: true } })) throw new Error('Nguồn A đã thay đổi.');
        if (claim && !await assertLeaseHeld(t, claim.lease, now)) throw new RetryLaterError('Phiên đọc đã hết hiệu lực.');
        if (claim?.reservation && !await assertLeaseHeld(t, claim.reservation, now)) throw new RetryLaterError('Phiên quét hồ sơ đã hết hiệu lực.');
        if (await activeKillSwitch(t, { sourceId: run.sourceId, targetId: claim?.targetId, connector: run.connector })
          || (claim && await activeKillSwitch(t, { targetId: claim.targetId, connector: 'fb-web' }))) throw new Error('Nguồn hoặc phiên đọc đang tạm dừng.');
        const active = await t.sourceProfileScan.updateMany({ where, data: { phase: 'POSTS', snapshot, profileIssue, artworkIssue, updatedAt: now } });
        if (!active.count) return;
        const artwork: Record<string, string> = {};
        for (const image of stored) {
          if (!image) continue;
          const previous = await t.asset.findFirst({ where: {
            connector: run.connector, sourceRef: image.data.sourceRef, checksum: image.data.checksum, status: 'STORED',
          }, select: { id: true } });
          const asset = previous ?? await t.asset.create({ data: image.data, select: { id: true } });
          artwork[image.kind] = asset.id;
        }
        await t.sourceProfileScan.update({ where: { id: run.id }, data: { artwork, updatedAt: now } });
        await enqueue(t, Q.SourceProfileScan, { scanId, phase: 'POSTS', readTargetId: claim?.targetId }, { singletonKey: scanId });
      });
    } finally {
      if (claim) await releaseLease(ctx.db, claim.lease, ctx.clock.now());
    }
  } catch (error) {
    if (error instanceof SourceReadAccountBusy) {
      await defer();
      return;
    }
    if (error instanceof RetryLaterError && retryCount < 8) throw error;
    const issue = error instanceof Error ? error.message.split('\n')[0].slice(0, 400) : 'Lượt quét bị gián đoạn.';
    await ctx.db.sourceProfileScan.updateMany({ where, data: phase === 'PROFILE'
      ? { phase: 'FAILED', profileIssue: issue, updatedAt: ctx.clock.now() }
      : { phase: 'FAILED', historyIssue: issue, updatedAt: ctx.clock.now() } });
  } finally {
    await releaseFinishedProfileScanAccount(ctx.db, scanId, ctx.clock.now());
  }
}
