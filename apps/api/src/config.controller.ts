import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Q } from '@seedingsys/contracts';
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
  overlapCount: z.number().int().min(0).max(50).optional(),
  collectComments: z.boolean().optional(),
});

function publicSourceRef(ref: string): string {
  const url = facebookSourceUrl(ref);
  if (!url) throw new BadRequestException('Nhập URL trang cá nhân hoặc fanpage trên facebook.com.');
  return url.href;
}
const TargetIn = z.object({
  code: z.string().regex(/^B\d+$/),
  name: z.string().min(1),
  externalId: z.string().min(1),
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
    const data = parse(SourceIn, body);
    if (isFacebookTimelineReader(data.connector)) data.externalRef = publicSourceRef(data.externalRef);
    const s = await this.db.source.create({ data });
    await audit(this.db, { entityType: 'source', entityId: s.id, action: 'created', actor: a.actor, at: this.clock.now() });
    return out(s);
  }
  @Patch('sources/:id')
  @Roles('admin')
  async updateSource(@Param('id') id: string, @Body() body: unknown, @Actor() a: Principal) {
    const data = parse(SourceIn.partial(), body);
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
    return out(await this.db.targetAccount.findMany({ orderBy: { code: 'asc' }, include: { profile: true } }));
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
        createdAt: { gt: new Date(this.clock.now().getTime() - 60 * 60_000) } } });
      if (busy) throw new ConflictException('Tài khoản đang bận. Đóng cửa sổ đăng nhập hoặc chờ lượt quét hoàn tất.');
      const run = await t.targetBrowserRun.create({ data: { targetId: id, kind: input.kind, profileUrl, limit: input.kind === 'scan' ? input.limit : 0 } });
      await enqueue(t, Q.TargetBrowser, { runId: run.id });
      return out(run);
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
