import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ACTIVE, Q, SUCCESS } from '@seedingsys/contracts';
import { audit, enqueue, movePublication, moveSlot, tx, type Db, type SlotStatus } from '@seedingsys/db';
import { MIN, type Clock } from '@seedingsys/domain';
import { z } from 'zod';
import { Roles, type Principal } from './auth';
import { CLOCK, DB } from './tokens';
import { Actor, parse } from './util';

const ScheduleIn = z.object({
  sourceIds: z.array(z.string().uuid()).max(50).default([]),
  variantIds: z.array(z.string().uuid()).max(200).default([]),
  startsAt: z.string().optional(),
  intervalMinutes: z.number().int().min(1).max(1440),
  limit: z.number().int().min(1).max(50),
}).refine(input => !!input.sourceIds.length !== !!input.variantIds.length, 'Chọn nguồn hoặc chọn bài trong backlog.');

const waitingSlots: SlotStatus[] = ['PLANNED', 'DEFERRED', 'RESERVED'];
const activeSlots: SlotStatus[] = ['DISPATCHED', 'STARTED'];
const stoppedReason = 'SCHEDULE_STOPPED';

function scheduleStart(value: string | undefined, now: Date): Date {
  if (value === undefined) return now;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::00(?:\.000)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) throw new BadRequestException('Nhập ngày và giờ bắt đầu theo phút.');
  const wallTime = new Date(`${match[1]}:00Z`);
  const when = new Date(`${match[1]}:00${match[2] ?? '+07:00'}`);
  if (!Number.isFinite(+when) || !Number.isFinite(+wallTime) || wallTime.toISOString().slice(0, 16) !== match[1]) {
    throw new BadRequestException('Ngày hoặc giờ bắt đầu không hợp lệ.');
  }
  if (+when < Math.floor(+now / MIN) * MIN) throw new BadRequestException('Giờ bắt đầu đã qua.');
  return when;
}

@Controller('publication-schedules')
export class ScheduleController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock) {}

  @Get()
  async list() {
    const sort = { createdAt: 'desc' as const };
    const include = { slots: { orderBy: { slotAt: 'asc' as const }, select: { id: true, slotAt: true, status: true,
      reason: true, publicationId: true, target: { select: { code: true } } } } };
    const [running, recent] = await Promise.all([
      this.db.publicationSchedule.findMany({ where: { stoppedAt: null, slots: { some: { status: { in: [...waitingSlots, ...activeSlots] } } } }, orderBy: sort, include }),
      this.db.publicationSchedule.findMany({ orderBy: sort, take: 50, include }),
    ]);
    const schedules = [...new Map([...running, ...recent].map(schedule => [schedule.id, schedule])).values()]
      .sort((left, right) => +right.createdAt - +left.createdAt);
    const sourceIds = [...new Set(schedules.flatMap(schedule => schedule.sourceIds))];
    const publicationIds = [...new Set(schedules.flatMap(schedule => schedule.slots.flatMap(slot => slot.publicationId ?? [])))];
    const [sources, publications] = await Promise.all([
      this.db.source.findMany({ where: { id: { in: sourceIds } }, select: { id: true, code: true } }),
      this.db.publication.findMany({ where: { id: { in: publicationIds } }, select: { id: true, status: true, slotId: true, lastReason: true } }),
    ]);
    const sourceCodes = new Map(sources.map(source => [source.id, source.code]));
    const assigned = new Map(publications.map(publication => [publication.id, publication]));
    const now = this.clock.now();
    return schedules.map(schedule => {
      const totals = { waiting: 0, active: 0, posted: 0, failed: 0, stopped: 0 };
      let nextAt: Date | null = null;
      let reason: string | null = null;
      for (const slot of schedule.slots) {
        const linked = slot.publicationId ? assigned.get(slot.publicationId) : null;
        const publication = linked?.slotId === slot.id ? linked : null;
        if (waitingSlots.includes(slot.status)) {
          totals.waiting++;
          nextAt ??= slot.slotAt;
          reason ??= slot.reason;
        } else if (publication && SUCCESS.includes(publication.status)) {
          totals.posted++;
        } else if (publication && (publication.status === 'QUEUED' || ACTIVE.includes(publication.status) || publication.status === 'RECONCILING')) {
          totals.active++;
        } else if (slot.reason === stoppedReason || publication?.lastReason === stoppedReason) {
          totals.stopped++;
        } else {
          totals.failed++;
          reason ??= publication?.lastReason ?? slot.reason ?? (slot.status === 'SKIPPED_NO_CONTENT' ? 'SKIPPED_NO_CONTENT' : null);
        }
      }
      const status = schedule.stoppedAt ? 'STOPPED' : totals.waiting || totals.active
        ? schedule.startsAt > now && !totals.active ? 'SCHEDULED' : 'RUNNING' : 'COMPLETED';
      return { id: schedule.id, startsAt: schedule.startsAt, intervalMinutes: schedule.intervalMinutes, limit: schedule.limit,
        createdAt: schedule.createdAt, stoppedAt: schedule.stoppedAt, status, nextAt, reason, total: schedule.slots.length, ...totals,
        sourceCodes: schedule.sourceIds.flatMap(id => sourceCodes.get(id) ?? []).sort(),
        targetCodes: [...new Set(schedule.slots.map(slot => slot.target.code))].sort(),
      };
    });
  }

  @Post()
  @Roles('operator')
  async create(@Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(ScheduleIn, body);
    const now = this.clock.now();
    const startsAt = scheduleStart(input.startsAt, now);
    return tx(this.db, async t => {
      const variantIds = [...new Set(input.variantIds)];
      const variants = variantIds.length ? await t.contentVariant.findMany({
        where: { id: { in: variantIds }, status: 'READY', snapshotHash: { not: null }, revision: { post: { archivedAt: null } } },
        select: { id: true, targetId: true, expiresAt: true, revisionId: true, revision: { select: { post: {
          select: { id: true, sourceId: true, latestRevisionId: true, postedAt: true, firstSeenAt: true },
        } } } },
      }) : [];
      if (variants.length !== variantIds.length || variants.some(v => v.revisionId !== v.revision.post.latestRevisionId)) {
        throw new ConflictException('Có bài không còn sẵn sàng hoặc nguồn đã đổi phiên bản.');
      }
      const sourceIds = [...new Set([...input.sourceIds, ...variants.map(v => v.revision.post.sourceId)])];
      const mappings = await t.sourceTargetMapping.findMany({ where: { sourceId: { in: sourceIds }, enabled: true,
        target: { enabled: true } }, select: { sourceId: true, targetId: true } });
      if (new Set(mappings.map(mapping => mapping.sourceId)).size !== sourceIds.length) {
        throw new ConflictException('Mỗi nguồn được chọn cần một luồng đang bật đến tài khoản đích đang bật.');
      }
      const byTarget = new Map<string, string[]>();
      for (const mapping of mappings) {
        const destination = byTarget.get(mapping.targetId) ?? [];
        destination.push(mapping.sourceId);
        byTarget.set(mapping.targetId, destination);
      }
      if (variants.some(v => !byTarget.get(v.targetId)?.includes(v.revision.post.sourceId))) {
        throw new ConflictException('Có bài thuộc luồng hoặc đích đang tắt.');
      }
      const targetIds = variants.length ? [...new Set(variants.map(v => v.targetId))] : [...byTarget.keys()];
      await t.$queryRaw`SELECT id FROM target_accounts WHERE id=ANY(${targetIds}::uuid[]) ORDER BY id FOR UPDATE`;
      if (variants.length) {
        const reserved = await t.publicationSlot.findFirst({ where: { scheduledVariantId: { in: variantIds },
          status: { in: [...waitingSlots, ...activeSlots] }, schedule: { stoppedAt: null } }, select: { id: true } });
        const assigned = await t.publication.findFirst({ where: { OR: variants.map(v => ({ targetId: v.targetId, sourcePostId: v.revision.post.id })),
          status: { notIn: ['FAILED_CONFIRMED', 'CANCELLED'] } }, select: { id: true } });
        if (reserved || assigned) throw new ConflictException('Có bài đã được đặt lịch hoặc đã giao cho worker.');
      }
      const slots = targetIds.flatMap(targetId => {
        const selected = variants.filter(v => v.targetId === targetId).sort((a, b) =>
          +(a.revision.post.postedAt ?? a.revision.post.firstSeenAt) - +(b.revision.post.postedAt ?? b.revision.post.firstSeenAt) || a.id.localeCompare(b.id));
        if (selected.length > input.limit) throw new ConflictException('Số bài được chọn vượt giới hạn của một đích.');
        return Array.from({ length: variants.length ? selected.length : input.limit }, (_, i) => {
          const variant = selected[i];
          const slotAt = new Date(+startsAt + i * input.intervalMinutes * MIN);
          if (variant?.expiresAt && variant.expiresAt <= slotAt) throw new ConflictException('Có bài sẽ hết hạn trước giờ đăng đã chọn.');
          return { targetId, slotAt, scheduledVariantId: variant?.id,
            scheduleSourceIds: variant ? [variant.revision.post.sourceId] : byTarget.get(targetId)! };
        });
      });
      if (!slots.length || slots.length > 2500) throw new ConflictException('Chọn tối đa 2.500 lượt đăng cho một lịch.');
      const schedule = await t.publicationSchedule.create({ data: { startsAt, intervalMinutes: input.intervalMinutes,
        limit: input.limit, sourceIds, createdBy: actor.actor, createdAt: now } });
      // The unique (target, time) key protects against simultaneous schedules and legacy ticks.
      const created = await t.publicationSlot.createMany({ data: slots.map(slot => ({ ...slot, scheduleId: schedule.id })), skipDuplicates: true });
      if (created.count !== slots.length) throw new ConflictException('Có đích đã có lượt khác ở cùng thời điểm. Hãy chọn giờ bắt đầu khác.');
      await audit(t, { entityType: 'publication_schedule', entityId: schedule.id, action: 'created', actor: actor.actor, at: now,
        data: { sourceIds, targets: targetIds, slots: slots.length } });
      await enqueue(t, Q.SchedulerTick, {}, { startAfter: startsAt });
      return { id: schedule.id, startsAt, total: slots.length };
    });
  }

  @Post(':id/stop')
  @Roles('operator')
  async stop(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return tx(this.db, async t => {
      const [schedule] = await t.$queryRaw<Array<{ stopped_at: Date | null }>>`
        SELECT stopped_at FROM publication_schedules WHERE id=${id}::uuid FOR UPDATE`;
      if (!schedule) throw new NotFoundException('Không tìm thấy lịch đăng.');
      if (schedule.stopped_at) return { ok: true };
      const open = await t.publicationSlot.findMany({ where: { scheduleId: id, status: { in: [...waitingSlots, ...activeSlots] } },
        select: { id: true, status: true, publicationId: true } });
      if (!open.length) return { ok: true };
      const now = this.clock.now();
      await t.publicationSchedule.update({ where: { id }, data: { stoppedAt: now } });
      await t.publicationSlot.updateMany({ where: { scheduleId: id, status: { in: [...waitingSlots] } },
        data: { status: 'MISSED', reason: stoppedReason } });
      for (const slot of open.filter(slot => slot.publicationId && activeSlots.includes(slot.status))) {
        const publication = await t.publication.findUnique({ where: { id: slot.publicationId! }, select: { slotId: true, jobVersion: true } });
        if (publication?.slotId !== slot.id) continue;
        const cancelled = await movePublication(t, { id: slot.publicationId!, from: 'QUEUED', to: 'CANCELLED', expectedJobVersion: publication.jobVersion,
          now, actor: actor.actor, reason: stoppedReason });
        if (cancelled) await moveSlot(t, { id: slot.id, from: slot.status, to: slot.status === 'STARTED' ? 'DONE' : 'MISSED',
          now, actor: actor.actor, reason: stoppedReason });
      }
      await audit(t, { entityType: 'publication_schedule', entityId: id, action: 'stopped', actor: actor.actor, at: now });
      return { ok: true };
    });
  }
}
