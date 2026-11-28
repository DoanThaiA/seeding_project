import { ConnectorError, type SourceRef } from '@seedingsys/connectors-core';
import { SOURCE_PROFILE_SCAN_SETTLE_MS } from '@seedingsys/contracts';
import { accountResource, acquireLease, activeKillSwitch, activeLease, heartbeatLease, releaseLease,
  sourceProfileAccountHolder, sourceProfileStepResource, SOURCE_PROFILE_ACCOUNT_PURPOSE, type Lease } from '@seedingsys/db';
import type { BrowserCtx } from '../ctx';

export class SourceReadAccountBusy extends ConnectorError {
  constructor(code: string, readonly waitingForProfileScan = false) {
    super('TRANSIENT', 'Phiên ' + code + ' đang bận. Lượt quét sẽ chờ phiên rảnh.');
  }
}

export async function claimSourceReadAccount(ctx: BrowserCtx, sourceId: string, purpose: string, ttlMs: number, targetId?: string, profileScanId?: string) {
  const now = ctx.clock.now();
  const existing = profileScanId && await ctx.db.accountLease.findFirst({ where: {
    holder: sourceProfileAccountHolder(profileScanId), purpose: SOURCE_PROFILE_ACCOUNT_PURPOSE, releasedAt: null, expiresAt: { gt: now },
  } });
  const reservedTargetId = existing ? existing.resource.slice('account:'.length) : undefined;
  if (reservedTargetId && targetId && targetId !== reservedTargetId) {
    throw new ConnectorError('SOURCE_UNREADABLE', 'Hồ sơ B của lượt quét đã thay đổi.');
  }
  const selectedTargetId = reservedTargetId ?? targetId;
  const mappings = await ctx.db.sourceTargetMapping.findMany({
    where: { sourceId, enabled: true, ...(selectedTargetId && { targetId: selectedTargetId }), target: { enabled: true, connector: 'fb-web' } },
    include: { target: { include: { profile: { include: { workerNode: true } } } } },
    take: 2,
  });
  const target = mappings[0]?.target;
  if (mappings.length !== 1 || !target?.profile) {
    throw new ConnectorError('SOURCE_UNREADABLE', 'Cần một đích Facebook đang bật và đã có hồ sơ trình duyệt trong luồng để đọc nguồn.');
  }
  if (target.profile.workerNode && target.profile.workerNode.name !== ctx.actor) {
    throw new ConnectorError('TRANSIENT', 'Phiên ' + target.code + ' nằm trên worker khác. Hệ thống sẽ thử lại ở lượt sau.');
  }
  if (await activeKillSwitch(ctx.db, { targetId: target.id, connector: target.connector })) {
    throw new ConnectorError('SOURCE_UNREADABLE', 'Phiên ' + target.code + ' đang bị tạm dừng.');
  }
  const resource = accountResource(target.id);
  const reservation: Lease | null = profileScanId
    ? existing ? { resource, holder: existing.holder, token: existing.fencingToken, expiresAt: existing.expiresAt }
      : await acquireLease(ctx.db, { resource, holder: sourceProfileAccountHolder(profileScanId), purpose: SOURCE_PROFILE_ACCOUNT_PURPOSE,
        ttlMs: SOURCE_PROFILE_SCAN_SETTLE_MS, now: ctx.clock.now() })
    : null;
  const busy = async () => new SourceReadAccountBusy(target.code,
    (await activeLease(ctx.db, resource, ctx.clock.now()))?.purpose === SOURCE_PROFILE_ACCOUNT_PURPOSE);
  if (profileScanId && !reservation) throw await busy();
  const lease = await acquireLease(ctx.db, {
    resource: reservation ? sourceProfileStepResource(target.id) : resource,
    holder: ctx.workerId + ':' + purpose, ttlMs, now: ctx.clock.now(), purpose,
  });
  if (!lease) throw await busy();
  try {
    if (reservation && !await heartbeatLease(ctx.db, reservation, SOURCE_PROFILE_SCAN_SETTLE_MS, ctx.clock.now())) {
      throw await busy();
    }
  } catch (error) {
    await releaseLease(ctx.db, lease, ctx.clock.now());
    throw error;
  }
  const account: NonNullable<SourceRef['readAccount']> = { code: target.code, externalId: target.externalId, profileDir: target.profile.profileDir };
  return { lease, reservation, targetId: target.id, account };
}
