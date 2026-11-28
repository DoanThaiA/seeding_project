import { randomUUID } from 'node:crypto';
import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { PROFILE_SCAN_TIMEOUT_MS, ProfileDetailsSnapshot, Q, SyncedProfileDetails } from '@seedingsys/contracts';
import { Prisma, activeKillSwitch, audit, enqueue, tx, type Db, type Tx } from '@seedingsys/db';
import { isFacebookTimelineReader, type Clock } from '@seedingsys/domain';
import { Roles, type Principal } from './auth';
import { CLOCK, DB } from './tokens';
import { Actor, parse } from './util';

const withDetails = { source: true, target: { include: { profile: true } }, details: true } as const;
type Mapping = Prisma.SourceTargetMappingGetPayload<{ include: typeof withDetails }>;
const reading = ['QUEUED', 'READING'];
const applying = ['QUEUED', 'RUNNING', 'COMMITTING'];
const fresh = (updatedAt: Date | null, now: Date) => !!updatedAt && +updatedAt > +now - PROFILE_SCAN_TIMEOUT_MS;

function matchingScan(mapping: Mapping) {
  const scan = mapping.details;
  return scan && scan.sourceRef === mapping.source.externalRef && scan.sourceConnector === mapping.source.connector
    && scan.targetExternalId === mapping.target.externalId ? scan : null;
}

@Controller('profile-details')
@Roles('admin')
export class ProfileDetailsController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock) {}

  @Get(':mappingId')
  async get(@Param('mappingId', ParseUUIDPipe) mappingId: string) {
    const mapping = await this.db.sourceTargetMapping.findUnique({ where: { id: mappingId }, include: withDetails });
    if (!mapping) throw new NotFoundException('Không tìm thấy luồng hồ sơ.');
    const scan = matchingScan(mapping);
    const now = this.clock.now();
    const stalled = scan && reading.includes(scan.status) && !fresh(scan.updatedAt, now);
    const stalledBio = scan && applying.includes(scan.bioStatus) && !fresh(scan.bioUpdatedAt, now);
    const synced = SyncedProfileDetails.safeParse(mapping.target.profileDetails);
    return {
      scan: scan && {
        requestId: scan.requestId, status: stalled ? 'FAILED' : scan.status,
        error: stalled ? 'Hết thời gian quét. Có thể quét lại.' : scan.error,
        snapshot: ProfileDetailsSnapshot.safeParse(scan.snapshot).data ?? null,
        bioStatus: stalledBio ? scan.bioStatus === 'COMMITTING' ? 'NEEDS_CHECK' : 'FAILED' : scan.bioStatus,
        bioError: stalledBio ? 'Lượt cập nhật bị gián đoạn. Có thể đối chiếu lại tiểu sử.' : scan.bioError,
      },
      synced: synced.success && synced.data.targetExternalId === mapping.target.externalId ? synced.data : null,
      canApplyBio: mapping.target.enabled && !!mapping.target.profile,
    };
  }

  @Post(':mappingId/scan')
  async scan(@Param('mappingId', ParseUUIDPipe) mappingId: string, @Actor() actor: Principal) {
    return tx(this.db, async t => {
      const mapping = await this.lockMapping(t, mappingId);
      const { source, target } = mapping;
      await t.$queryRaw`SELECT id FROM target_accounts WHERE id=${target.id}::uuid FOR UPDATE`;
      const now = this.clock.now();
      const previous = matchingScan(mapping);
      if (previous && applying.includes(previous.bioStatus) && fresh(previous.bioUpdatedAt, now)) {
        throw new ConflictException('Đang cập nhật tiểu sử Facebook.');
      }
      if (previous && reading.includes(previous.status) && fresh(previous.updatedAt, now)) return { queued: false };
      const cutoff = new Date(+now - PROFILE_SCAN_TIMEOUT_MS);
      const other = await t.profileDetailsScan.findFirst({ where: { mappingId: { not: mappingId }, mapping: { targetId: target.id },
        targetExternalId: target.externalId, OR: [
          { status: { in: reading }, updatedAt: { gt: cutoff } },
          { bioStatus: { in: applying }, bioUpdatedAt: { gt: cutoff } },
        ] }, select: { mappingId: true } });
      if (other) throw new ConflictException('Hồ sơ B đang nhận dữ liệu từ một nguồn khác. Hãy chờ lượt đó hoàn tất.');
      const requestId = randomUUID();
      const values = { requestId, sourceRef: source.externalRef, sourceConnector: source.connector, targetExternalId: target.externalId,
        status: 'QUEUED', snapshot: Prisma.DbNull, error: null, updatedAt: now,
        bioJobId: null, bioStatus: 'IDLE', bioUpdatedAt: null, bioError: null };
      await t.profileDetailsScan.upsert({ where: { mappingId }, create: { mappingId, ...values }, update: values });
      await enqueue(t, Q.ProfileDetails, { mappingId, requestId });
      await audit(t, { entityType: 'profile_details', entityId: mappingId, action: 'profile_scan_requested', actor: actor.actor, at: now });
      return { queued: true };
    });
  }

  @Post(':mappingId/sync')
  async sync(@Param('mappingId', ParseUUIDPipe) mappingId: string, @Body() body: unknown, @Actor() actor: Principal) {
    const { requestId, applyBio } = parse(z.object({ requestId: z.string().uuid(), applyBio: z.boolean().default(false) }), body);
    return tx(this.db, async t => {
      const mapping = await this.lockMapping(t, mappingId);
      const { source, target } = mapping;
      const scan = matchingScan(mapping);
      const snapshot = ProfileDetailsSnapshot.safeParse(scan?.snapshot);
      if (!scan || scan.requestId !== requestId || scan.status !== 'READY' || !snapshot.success) {
        throw new ConflictException('Bản quét đã thay đổi. Hãy mở lại thông tin để đối chiếu.');
      }
      const now = this.clock.now();
      if (applyBio) {
        if (!snapshot.data.bio || !target.enabled || !target.profile) {
          throw new ConflictException('Cần có tiểu sử đã quét và hồ sơ B đang bật, đã cấu hình phiên Facebook.');
        }
        if (await activeKillSwitch(t, { sourceId: source.id, targetId: target.id, connector: 'fb-web' })) {
          throw new ConflictException('Hồ sơ Facebook đang tạm dừng.');
        }
        if (applying.includes(scan.bioStatus) && fresh(scan.bioUpdatedAt, now)) {
          throw new ConflictException('Đang cập nhật tiểu sử Facebook.');
        }
      }
      const details: SyncedProfileDetails = { sourceCode: source.code, targetExternalId: target.externalId,
        requestId, syncedAt: now.toISOString(), snapshot: snapshot.data };
      const bioQueued = applyBio && (scan.bioStatus !== 'DONE' || SyncedProfileDetails.safeParse(target.profileDetails).data?.requestId !== requestId);
      const saved = await t.targetAccount.updateMany({ where: { id: target.id, externalId: target.externalId, connector: 'fb-web' },
        data: { profileDetails: details } });
      if (!saved.count) throw new ConflictException('Hồ sơ B đã đổi cấu hình.');
      if (bioQueued) {
        const bioJobId = randomUUID();
        await t.profileDetailsScan.update({ where: { mappingId },
          data: { bioJobId, bioStatus: 'QUEUED', bioUpdatedAt: now, bioError: null } });
        await enqueue(t, Q.ApplyProfileBio, { mappingId, requestId, bioJobId });
      }
      await audit(t, { entityType: 'profile_details', entityId: mappingId, action: 'profile_details_synced', actor: actor.actor, at: now,
        data: { requestId, targetId: target.id, applyBio } });
      return { saved: true, bioQueued };
    });
  }

  private async lockMapping(t: Tx, id: string) {
    await t.$queryRaw`SELECT id FROM source_target_mappings WHERE id=${id}::uuid FOR UPDATE`;
    const mapping = await t.sourceTargetMapping.findUnique({ where: { id }, include: withDetails });
    if (!mapping) throw new NotFoundException('Không tìm thấy luồng hồ sơ.');
    await t.$queryRaw`SELECT id FROM sources WHERE id=${mapping.sourceId}::uuid FOR SHARE`;
    const current = await t.sourceTargetMapping.findUniqueOrThrow({ where: { id }, include: withDetails });
    if (!current.enabled || !isFacebookTimelineReader(current.source.connector) || current.target.connector !== 'fb-web') {
      throw new ConflictException('Cần một luồng Facebook nguồn → đích đang bật.');
    }
    return current;
  }
}
