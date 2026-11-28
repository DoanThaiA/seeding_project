import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { MAX_POLL_POSTS, Q, TARGET_HEALTH_KIND, TARGET_HEALTH_MS, TargetHealthResult } from '@seedingsys/contracts';
import { activeKillSwitch, activeLease, audit, enqueue, Prisma, sourceResource, tx, type Db } from '@seedingsys/db';
import { facebookSourceUrl, isFacebookTimelineReader, type Clock } from '@seedingsys/domain';
import { Roles, type Principal } from './auth';
import { CLOCK, DB } from './tokens';
import { Actor, out, parse } from './util';

const SourceIn = z.object({
  code: z.string().regex(/^A\d+$/),
  name: z.string().min(1),
  externalRef: z.string().min(1),
  connector: z.enum(['fake', 'manual', 'fb-graph', 'fb-web', 'fb-public', 'fb-session']),
  enabled: z.boolean().optional(),
  pollIntervalSec: z.number().int().min(60).optional(),
  pollPostLimit: z.number().int().min(1).max(MAX_POLL_POSTS).nullable().optional(),
  overlapCount: z.number().int().min(0).max(50).optional(),
  collectComments: z.boolean().optional(),
  publishComments: z.boolean().optional(),
  publishIntervalMin: z.number().int().min(1).max(1440).nullable().optional(),
  runStartMinute: z.number().int().min(0).max(1439).nullable().optional(),
  runEndMinute: z.number().int().min(0).max(1439).nullable().optional(),
});

function hasValidRunWindow({ runStartMinute: start, runEndMinute: end }: Pick<z.infer<typeof SourceIn>, 'runStartMinute' | 'runEndMinute'>) {
  return (start === undefined && end === undefined) || (start === null && end === null)
    || (typeof start === 'number' && typeof end === 'number' && start !== end);
}

const RUN_WINDOW_ERROR = 'Nhập đủ giờ bắt đầu và giờ kết thúc khác nhau, hoặc chọn Cả ngày.';

function publicSourceRef(ref: string): string {
  const url = facebookSourceUrl(ref);
  if (!url) throw new BadRequestException('Nhập URL trang cá nhân hoặc fanpage trên facebook.com.');
  return url.href;
}
const TargetIn = z.object({
  code: z.string().regex(/^B\d+$/),
  name: z.string().min(1),
  externalId: z.string().trim().min(1),
  connector: z.enum(['fake', 'fb-web']),
  audience: z.enum(['ONLY_ME', 'FRIENDS', 'PUBLIC']).optional(),
  uiLocale: z.string().optional(),
  enabled: z.boolean().optional(),
  styleProfile: z.record(z.unknown()).optional(),
});
const MappingIn = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  enabled: z.boolean().optional(),
  contentTtlHours: z.number().int().min(1).optional(),
  lateWindowMin: z.number().int().min(1).max(59).optional(),
  strictOrder: z.boolean().optional(),
  reviewMode: z.enum(['AUTO', 'MANUAL']).optional(),
  maxPublishTries: z.number().int().min(1).max(5).optional(),
});

@Controller()
export class ConfigController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('sources')
  async sources() {
    return out(await this.db.source.findMany({ orderBy: { code: 'asc' } }));
  }
  @Post('sources')
  @Roles('admin')
  async createSource(@Body() body: unknown, @Actor() a: Principal) {
    const data = parse(SourceIn.refine(hasValidRunWindow, RUN_WINDOW_ERROR), body);
    if (isFacebookTimelineReader(data.connector)) data.externalRef = publicSourceRef(data.externalRef);
    const s = await this.db.source.create({ data });
    await audit(this.db, { entityType: 'source', entityId: s.id, action: 'created', actor: a.actor, at: this.clock.now() });
    return out(s);
  }
  @Patch('sources/:id')
  @Roles('admin')
  async updateSource(@Param('id') id: string, @Body() body: unknown, @Actor() a: Principal) {
    const data = parse(SourceIn.partial().refine(hasValidRunWindow, RUN_WINDOW_ERROR), body);
    const s = await tx(this.db, async (t) => {
      const current = await t.source.findUniqueOrThrow({ where: { id } });
      const connector = data.connector ?? current.connector;
      if (isFacebookTimelineReader(connector)) data.externalRef = publicSourceRef(data.externalRef ?? current.externalRef);
      const reset = (isFacebookTimelineReader(connector) || isFacebookTimelineReader(current.connector))
        && (connector !== current.connector || (data.externalRef !== undefined && data.externalRef !== current.externalRef));
      const changed = await t.source.updateMany({
        where: { id, connector: current.connector, externalRef: current.externalRef },
        data: {
          ...data,
          ...(data.enabled === false && { runNowFrom: null, runNowUntil: null, runNowLimit: null, runNowVariantIds: [] }),
          ...(reset && {
            watermark: Prisma.DbNull, baselineDone: false, lastPollAt: null, lastSuccessAt: null,
            lastError: null, lastErrorAt: null, lastIncomplete: Prisma.DbNull,
          }),
        },
      });
      if (!changed.count) throw new ConflictException('Nguồn vừa thay đổi. Tải lại cấu hình và lưu lại.');
      await audit(t, { entityType: 'source', entityId: id, action: 'updated', actor: a.actor, data, at: this.clock.now() });
      return t.source.findUniqueOrThrow({ where: { id } });
    });
    return out(s);
  }

  @Post('source-runs')
  @Roles('admin')
  async startSourceRun(@Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(z.object({
      sourceIds: z.array(z.string().uuid()).max(50).default([]),
      variantIds: z.array(z.string().uuid()).max(200).default([]),
      durationMinutes: z.number().int().min(5).max(1440),
      limit: z.number().int().min(1).max(10),
    }).refine(value => !!value.sourceIds.length !== !!value.variantIds.length, 'Chọn nguồn hoặc chọn bài cần chạy.'), body);
    const now = this.clock.now();
    const from = new Date(Math.floor(+now / 60_000) * 60_000);
    const until = new Date(+now + input.durationMinutes * 60_000);
    return tx(this.db, async t => {
      const variantIds = [...new Set(input.variantIds)];
      const variants = variantIds.length ? await t.contentVariant.findMany({
        where: { id: { in: variantIds }, status: 'READY', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          revision: { post: { archivedAt: null } } }, select: {
          id: true, targetId: true, revision: { select: { post: { select: { sourceId: true } } } },
        },
      }) : [];
      if (variants.length !== variantIds.length) throw new ConflictException('Có bài vừa đổi trạng thái hoặc đã hết hạn.');
      const perTarget = new Map<string, number>();
      for (const variant of variants) {
        const count = (perTarget.get(variant.targetId) ?? 0) + 1;
        if (count > input.limit) throw new ConflictException('Số bài đã chọn cho một đích vượt giới hạn lượt của đợt.');
        perTarget.set(variant.targetId, count);
      }
      const sourceIds = [...new Set([...input.sourceIds, ...variants.map(v => v.revision.post.sourceId)])];
      await t.$queryRaw`SELECT id FROM sources WHERE id=ANY(${sourceIds}::uuid[]) ORDER BY id FOR UPDATE`;
      const sources = await t.source.findMany({ where: { id: { in: sourceIds }, mappings: { some: { enabled: true, target: { enabled: true } } } } });
      if (sources.length !== sourceIds.length) throw new ConflictException('Mỗi nguồn phải có luồng và đích đang bật.');
      for (const source of sources) {
        const continuing = source.runNowUntil && source.runNowUntil > now;
        const canScan = source.connector !== 'manual' && !await activeLease(t, sourceResource(source.id), now);
        await t.source.update({ where: { id: source.id }, data: {
          enabled: true, runNowFrom: continuing ? source.runNowFrom : from, runNowUntil: until, runNowLimit: input.limit,
          runNowVariantIds: variants.filter(v => v.revision.post.sourceId === source.id).map(v => v.id),
          lastPollAt: canScan ? null : undefined,
        } });
        await audit(t, { entityType: 'source', entityId: source.id, action: 'run_started', actor: actor.actor, at: now,
          data: { until: until.toISOString(), limit: input.limit } });
      }
      return { started: sources.length, until };
    });
  }

  @Post('sources/:id/stop-run')
  @Roles('admin')
  async stopSourceRun(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    const now = this.clock.now();
    await tx(this.db, async t => {
      await t.source.update({ where: { id }, data: { runNowFrom: null, runNowUntil: null, runNowLimit: null, runNowVariantIds: [] } });
      await audit(t, { entityType: 'source', entityId: id, action: 'run_stopped', actor: actor.actor, at: now });
    });
    return { ok: true };
  }

  @Post('sources/:id/poll')
  @Roles('admin')
  async pollSource(@Param('id', ParseUUIDPipe) id: string, @Actor() a: Principal) {
    return tx(this.db, async (t) => {
      // Serialize manual requests against other requests and the scheduler's source update.
      const locked = await t.$queryRaw<Array<{ id: string }>>`SELECT id FROM sources WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw new NotFoundException('Không tìm thấy nguồn.');
      const now = this.clock.now();
      const source = await t.source.findUniqueOrThrow({ where: { id } });
      if (!source.enabled) throw new ConflictException('Bật nguồn trước khi quét.');
      if (source.connector === 'manual') throw new ConflictException('Nguồn này nhận nội dung từ trang Nhập bài.');
      if (await activeKillSwitch(t, { sourceId: id, connector: source.connector })) {
        throw new ConflictException('Nguồn đang bị tạm dừng bởi công tắc dừng.');
      }
      const pending = await t.outboxEvent.findFirst({ where: { queue: Q.SourcePoll, singletonKey: id, publishedAt: null }, select: { id: true } });
      if (pending || await activeLease(t, sourceResource(id), now)) return { queued: false };

      await t.source.update({ where: { id }, data: { lastPollAt: now } });
      await enqueue(t, Q.SourcePoll, { sourceId: id, collectComments: source.collectComments }, { singletonKey: id });
      await audit(t, { entityType: 'source', entityId: id, action: 'poll_requested', actor: a.actor, at: now });
      return { queued: true };
    });
  }

  @Get('targets')
  async targets() {
    return out(await this.db.targetAccount.findMany({ orderBy: { code: 'asc' }, include: { profile: true }, omit: { profileDetails: true } }));
  }
  @Post('targets')
  @Roles('admin')
  async createTarget(@Body() body: unknown, @Actor() a: Principal) {
    const d = parse(TargetIn, body);
    const t = await this.db.targetAccount.create({ data: { ...d, styleProfile: (d.styleProfile ?? {}) as object } });
    await audit(this.db, { entityType: 'target', entityId: t.id, action: 'created', actor: a.actor, at: this.clock.now() });
    return out(t);
  }
  @Patch('targets/:id')
  @Roles('admin')
  async updateTarget(@Param('id') id: string, @Body() body: unknown, @Actor() a: Principal) {
    const d = parse(TargetIn.partial(), body);
    const t = await this.db.targetAccount.update({ where: { id }, data: { ...d, styleProfile: d.styleProfile as object | undefined } });
    await audit(this.db, { entityType: 'target', entityId: id, action: 'updated', actor: a.actor, data: body, at: this.clock.now() });
    return out(t);
  }

  @Get('targets/:id/browser')
  @Roles('admin')
  async browserRuns(@Param('id', ParseUUIDPipe) id: string) {
    const latest = (kind: string) => this.db.targetBrowserRun.findFirst({ where: { targetId: id, kind }, orderBy: { createdAt: 'desc' } });
    const [login, scan] = await Promise.all([latest('login'), latest('scan')]);
    const visible = (run: typeof scan) => run && ['QUEUED', 'RUNNING', 'OPEN'].includes(run.status)
      && this.clock.now().getTime() - run.createdAt.getTime() >= 60 * 60_000
      ? { ...run, status: 'FAILED', message: 'Lượt xử lý đã hết thời gian. Bạn có thể chạy lại.' } : run;
    return out({ login: visible(login), scan: visible(scan) });
  }

  @Post('targets/:id/browser')
  @Roles('admin')
  async browserAction(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('login') }),
      z.object({ kind: z.literal('scan'), profile: z.string().trim().min(1), limit: z.number().int().min(1).max(100) }),
    ]), body);
    const profileUrl = input.kind === 'scan' ? publicSourceRef(/^\d+$/.test(input.profile)
      ? 'https://www.facebook.com/profile.php?id=' + input.profile : input.profile) : null;
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM target_accounts WHERE id = ${id}::uuid FOR UPDATE`;
      const target = await t.targetAccount.findUnique({ where: { id } });
      if (!target || target.connector !== 'fb-web') throw new BadRequestException('Chọn tài khoản Facebook đã lưu.');
      const busy = await t.targetBrowserRun.findFirst({ where: { targetId: id, status: { in: ['QUEUED', 'RUNNING', 'OPEN'] },
        kind: { in: ['login', 'scan'] },
        createdAt: { gt: new Date(this.clock.now().getTime() - 60 * 60_000) } } });
      if (busy) throw new ConflictException('Tài khoản đang bận. Đóng cửa sổ đăng nhập hoặc chờ lượt quét hoàn tất.');
      const run = await t.targetBrowserRun.create({ data: { targetId: id, kind: input.kind, profileUrl, limit: input.kind === 'scan' ? input.limit : 0 } });
      await enqueue(t, Q.TargetBrowser, { runId: run.id });
      return out(run);
    });
  }

  /** Kết quả kiểm tra gần nhất của từng tài khoản B, kèm việc nguồn B còn bật hay đã bị tắt. */
  @Get('targets/health')
  @Roles('admin')
  async targetHealth() {
    const [targets, runs] = await Promise.all([
      this.db.targetAccount.findMany({ orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true, enabled: true, connector: true, profile: { select: { id: true } } } }),
      this.db.targetBrowserRun.findMany({ where: { kind: TARGET_HEALTH_KIND }, orderBy: { createdAt: 'desc' }, take: 500,
        select: { targetId: true, status: true, message: true, results: true, createdAt: true } }),
    ]);
    const latest = new Map<string, (typeof runs)[number]>();
    for (const run of runs) if (!latest.has(run.targetId)) latest.set(run.targetId, run);
    const now = this.clock.now().getTime();
    return out(targets.map(target => {
      const run = latest.get(target.id);
      const stuck = !!run && ['QUEUED', 'RUNNING', 'OPEN'].includes(run.status) && now - run.createdAt.getTime() >= TARGET_HEALTH_MS;
      return {
        id: target.id, code: target.code, name: target.name, enabled: target.enabled, connector: target.connector,
        checkable: target.connector === 'fb-web' && !!target.profile,
        status: stuck ? 'FAILED' : run?.status ?? null,
        message: stuck ? 'Lượt kiểm tra đã hết thời gian. Bạn có thể chạy lại.' : run?.message ?? null,
        checkedAt: run?.createdAt ?? null,
        result: run ? TargetHealthResult.safeParse(run.results).data ?? null : null,
      };
    }));
  }

  /** Mở phiên trình duyệt của từng B để xem còn hoạt động không; worker tự tắt nguồn B hỏng. */
  @Post('targets/health-check')
  @Roles('admin')
  async checkTargetHealth(@Body() body: unknown, @Actor() a: Principal) {
    const input = parse(z.object({ targetId: z.string().uuid().optional() }), body ?? {});
    const now = this.clock.now();
    return tx(this.db, async t => {
      const targets = await t.targetAccount.findMany({ orderBy: { code: 'asc' },
        where: { connector: 'fb-web', ...(input.targetId ? { id: input.targetId } : { enabled: true }) },
        select: { id: true, code: true, profile: { select: { id: true } } } });
      if (!targets.length) throw new BadRequestException('Không có tài khoản B nào để kiểm tra.');
      const started: string[] = [];
      const skipped: Array<{ code: string; reason: string }> = [];
      for (const target of targets) {
        if (!target.profile) {
          skipped.push({ code: target.code, reason: 'chưa đăng nhập trình duyệt' });
          continue;
        }
        if (await activeKillSwitch(t, { targetId: target.id, connector: 'fb-web' })) {
          skipped.push({ code: target.code, reason: 'đang bật công tắc dừng' });
          continue;
        }
        const busy = await t.targetBrowserRun.findFirst({ where: { targetId: target.id, status: { in: ['QUEUED', 'RUNNING', 'OPEN'] },
          createdAt: { gt: new Date(now.getTime() - 60 * 60_000) } } });
        if (busy) {
          skipped.push({ code: target.code, reason: 'tài khoản đang bận' });
          continue;
        }
        const run = await t.targetBrowserRun.create({ data: { targetId: target.id, kind: TARGET_HEALTH_KIND, createdAt: now } });
        await enqueue(t, Q.TargetBrowser, { runId: run.id });
        started.push(target.code);
      }
      if (!started.length) {
        throw new ConflictException('Chưa kiểm tra được: ' + skipped.map(item => `${item.code} (${item.reason})`).join(', '));
      }
      await audit(t, { entityType: 'target', entityId: input.targetId ?? 'all', action: 'health-check', actor: a.actor,
        data: { started, skipped }, at: now });
      return out({ started, skipped });
    });
  }

  @Get('mappings')
  async mappings() {
    return out(await this.db.sourceTargetMapping.findMany({ include: { source: { select: { code: true } }, target: { select: { code: true } } } }));
  }
  @Post('mappings')
  @Roles('admin')
  async createMapping(@Body() body: unknown, @Actor() a: Principal) {
    const m = await this.db.sourceTargetMapping.create({ data: parse(MappingIn, body) });
    await audit(this.db, { entityType: 'mapping', entityId: m.id, action: 'created', actor: a.actor, at: this.clock.now() });
    return out(m);
  }
  @Patch('mappings/:id')
  @Roles('admin')
  async updateMapping(@Param('id') id: string, @Body() body: unknown, @Actor() a: Principal) {
    const m = await this.db.sourceTargetMapping.update({ where: { id }, data: parse(MappingIn.partial().omit({ sourceId: true, targetId: true }), body) });
    await audit(this.db, { entityType: 'mapping', entityId: id, action: 'updated', actor: a.actor, data: body, at: this.clock.now() });
    return out(m);
  }
}
