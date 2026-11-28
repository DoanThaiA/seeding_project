import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PERSONA_INSIGHT_KIND, PERSONA_INSIGHT_MS, PersonaInsightRecord, PersonaWallSnapshot, Q, SUCCESS,
  SyncedProfileDetails } from '@seedingsys/contracts';
import { audit, enqueue, tx, type Db } from '@seedingsys/db';
import { facebookPostLink, facebookSourceUrl, type Clock } from '@seedingsys/domain';
import { Roles, type Principal } from './auth';
import { CLOCK, DB } from './tokens';
import { Actor, parse } from './util';

const pageSize = 15;
const fields = { id: true, code: true, name: true, enabled: true, connector: true, externalId: true, profileDetails: true,
  profile: { select: { id: true } } } as const;
const accountCanBeUsed = (target: { enabled: boolean; connector: string; profile: unknown }) =>
  target.enabled && target.connector === 'fb-web' && !!target.profile;

function savedSource(value: unknown, externalId: string) {
  const parsed = SyncedProfileDetails.safeParse(value).data;
  return parsed?.targetExternalId === externalId ? parsed : null;
}

function profileUrl(externalId: string) {
  const key = externalId.trim().replace(/^@/, '');
  return (facebookSourceUrl(key) ?? facebookSourceUrl(/^\d+$/.test(key)
    ? `https://www.facebook.com/profile.php?id=${key}` : `https://www.facebook.com/${key}`))?.href ?? null;
}

@Controller('personas')
export class PersonasController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock) {}

  /** Bản tóm tắt AI mới nhất của mỗi nhân vật, đã lọc theo đúng tài khoản Facebook. */
  private async insights() {
    const runs = await this.db.targetBrowserRun.findMany({ where: { kind: PERSONA_INSIGHT_KIND, status: 'DONE' },
      orderBy: { createdAt: 'desc' }, take: 400, select: { targetId: true, results: true, createdAt: true } });
    const latest = new Map<string, { record: PersonaInsightRecord; at: Date }>();
    for (const run of runs) {
      const record = PersonaInsightRecord.safeParse(run.results).data;
      if (record && !latest.has(run.targetId)) latest.set(run.targetId, { record, at: run.createdAt });
    }
    return latest;
  }

  @Get()
  async list(@Actor() actor: Principal) {
    const [targets, insights] = await Promise.all([
      this.db.targetAccount.findMany({ orderBy: { code: 'asc' }, select: { ...fields,
        _count: { select: { publications: { where: { status: { in: [...SUCCESS] } } } } },
      } }),
      this.insights(),
    ]);
    return targets.map(({ id, code, name, enabled, connector, externalId, profileDetails, profile, _count }) => {
      const saved = savedSource(profileDetails, externalId);
      const canUseContext = actor.role === 'admin' || actor.role === 'operator';
      const insight = canUseContext ? insights.get(id)?.record ?? null : null;
      return { id, code, name, enabled, connector, canComment: accountCanBeUsed({ enabled, connector, profile }),
        sourceCode: saved?.sourceCode ?? null, publishedCount: _count.publications,
        description: canUseContext ? saved?.snapshot.bio ?? saved?.snapshot.intro[0] ?? null : null,
        insight: insight && { occupation: insight.occupation, gender: insight.gender, ageRange: insight.ageRange,
          location: insight.location, topics: insight.topics, confidence: insight.confidence } };
    });
  }

  /** Trạng thái tóm tắt hồ sơ của mọi nhân vật: cái nào đã có, cái nào cần chạy lại. */
  @Get('summaries')
  @Roles('admin', 'operator')
  async summaries() {
    const [targets, insights, runs] = await Promise.all([
      this.db.targetAccount.findMany({ orderBy: { code: 'asc' },
        select: { id: true, code: true, name: true, enabled: true, externalId: true, profileDetails: true } }),
      this.insights(),
      this.db.targetBrowserRun.findMany({ where: { kind: PERSONA_INSIGHT_KIND }, orderBy: { createdAt: 'desc' }, take: 400,
        select: { targetId: true, status: true, message: true, createdAt: true } }),
    ]);
    const latestRun = new Map<string, (typeof runs)[number]>();
    for (const run of runs) if (!latestRun.has(run.targetId)) latestRun.set(run.targetId, run);
    const now = this.clock.now().getTime();
    return targets.map(target => {
      const run = latestRun.get(target.id);
      const stuck = !!run && ['QUEUED', 'RUNNING'].includes(run.status) && now - run.createdAt.getTime() >= PERSONA_INSIGHT_MS;
      const saved = savedSource(target.profileDetails, target.externalId);
      return {
        id: target.id, code: target.code, name: target.name, enabled: target.enabled,
        hasProfile: !!saved,
        status: stuck ? 'FAILED' : run?.status ?? null,
        message: stuck ? 'Lượt tóm tắt đã hết thời gian. Bạn có thể thử lại.' : run?.message ?? null,
        runAt: run?.createdAt ?? null,
        insight: insights.get(target.id)?.record ?? null,
      };
    });
  }

  /** Xếp lượt tóm tắt bằng AI: không truyền targetId thì chạy cho mọi nhân vật đang bật. */
  @Post('summaries')
  @Roles('admin', 'operator')
  async summarize(@Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(z.object({ targetId: z.string().uuid().optional() }), body ?? {});
    const now = this.clock.now();
    return tx(this.db, async t => {
      const targets = await t.targetAccount.findMany({ orderBy: { code: 'asc' },
        where: input.targetId ? { id: input.targetId } : { enabled: true },
        select: { id: true, code: true } });
      if (!targets.length) throw new NotFoundException('Không có nhân vật nào để tóm tắt.');
      const started: string[] = [];
      const skipped: Array<{ code: string; reason: string }> = [];
      for (const target of targets) {
        const busy = await t.targetBrowserRun.findFirst({ where: { targetId: target.id, kind: PERSONA_INSIGHT_KIND,
          status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { gt: new Date(now.getTime() - PERSONA_INSIGHT_MS) } } });
        if (busy) {
          skipped.push({ code: target.code, reason: 'đang tóm tắt' });
          continue;
        }
        const run = await t.targetBrowserRun.create({ data: { targetId: target.id, kind: PERSONA_INSIGHT_KIND, createdAt: now } });
        await enqueue(t, Q.PersonaSummary, { runId: run.id });
        started.push(target.code);
      }
      if (!started.length) {
        throw new ConflictException('Chưa xếp được lượt nào: ' + skipped.map(item => `${item.code} (${item.reason})`).join(', '));
      }
      await audit(t, { entityType: 'target', entityId: input.targetId ?? 'all', action: 'persona-summary', actor: actor.actor,
        data: { started, skipped }, at: now });
      return { started, skipped };
    });
  }

  @Get(':id')
  async detail(@Param('id', ParseUUIDPipe) id: string, @Query('page') pageValue: string | undefined, @Actor() actor: Principal) {
    const target = await this.db.targetAccount.findUnique({ where: { id }, select: fields });
    if (!target) throw new NotFoundException('Không tìm thấy nhân vật.');
    const requestedPage = Number(pageValue);
    const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, 100_000) : 1;
    const canUseContext = actor.role === 'admin' || actor.role === 'operator';
    const ownLogs = { targetId: id, kind: 'persona', results: { path: ['targetExternalId'], equals: target.externalId } };
    const [mappings, rows, runs, insights, insightRun] = await Promise.all([
      this.db.sourceTargetMapping.findMany({ where: { targetId: id, enabled: true }, orderBy: { source: { code: 'asc' } },
        select: { id: true, source: { select: { code: true, name: true, connector: true } } } }),
      this.db.publication.findMany({ where: { targetId: id, status: { in: [...SUCCESS] } },
        orderBy: [{ verifiedAt: { sort: 'desc', nulls: 'last' } }, { committedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        skip: (page - 1) * pageSize, take: pageSize + 1, select: { id: true, sourcePostId: true, contentType: true,
          permalink: true, verifiedAt: true, committedAt: true, createdAt: true, variant: { select: { caption: true } },
          post: { select: { source: { select: { code: true } } } },
        } }),
      canUseContext ? this.db.targetBrowserRun.findMany({ where: { ...ownLogs, status: 'DONE' }, orderBy: { createdAt: 'desc' },
        take: 5, select: { results: true } }) : [],
      canUseContext ? this.insights() : new Map<string, { record: PersonaInsightRecord; at: Date }>(),
      canUseContext ? this.db.targetBrowserRun.findFirst({ where: { targetId: id, kind: PERSONA_INSIGHT_KIND },
        orderBy: { createdAt: 'desc' }, select: { status: true, message: true, createdAt: true } }) : null,
    ]);
    const { code, name, enabled, connector, externalId, profileDetails } = target;
    const saved = savedSource(profileDetails, externalId);
    const snapshots = runs.flatMap(run => {
      const result = PersonaWallSnapshot.safeParse(run.results);
      return result.success ? [result.data] : [];
    });
    const own = snapshots[0];
    const wall = own?.posts.length || !own?.postWarning ? own : snapshots.find(snapshot => snapshot.posts.length > 0) ?? own;
    return {
      id, code, name, enabled, connector, canComment: accountCanBeUsed(target),
      profileUrl: connector === 'fb-web' ? profileUrl(externalId) : null,
      sourceProfile: actor.role === 'admin' ? saved : null,
      context: canUseContext ? { name: saved?.snapshot.name ?? null,
        bio: saved?.snapshot.bio ?? null, sourceCode: saved?.sourceCode ?? null } : null,
      wall: wall ? { capturedAt: wall.profile.capturedAt, warning: own?.postWarning ?? null,
        posts: wall.posts.flatMap(post => {
          const link = facebookPostLink(post.permalink);
          return link ? [{ ...post, permalink: link.url.href }] : [];
        }) } : null,
      mappings,
      insight: insights.get(id)?.record ?? null,
      insightRun: insightRun && { ...insightRun,
        status: ['QUEUED', 'RUNNING'].includes(insightRun.status)
          && +this.clock.now() - +insightRun.createdAt >= PERSONA_INSIGHT_MS ? 'FAILED' : insightRun.status },
      publications: rows.slice(0, pageSize).map(({ post, variant, verifiedAt, committedAt, createdAt, permalink, ...row }) => ({
        ...row, caption: variant.caption ?? '', sourceCode: post.source.code, recordedAt: verifiedAt ?? committedAt ?? createdAt,
        permalink: facebookPostLink(permalink)?.url.href ?? null,
      })),
      postPage: page, more: rows.length > pageSize,
    };
  }
}
