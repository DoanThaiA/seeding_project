import { ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ProfileDetailsSnapshot, Q, SOURCE_PROFILE_SCAN_SETTLE_MS, SOURCE_PROFILE_SCAN_STEP_MS, SourceProfileArtwork } from '@seedingsys/contracts';
import { activeKillSwitch, audit, enqueue, releaseFinishedProfileScanAccount, tx, type Db, type SourceProfileScan, type Tx } from '@seedingsys/db';
import { isFacebookTimelineReader, type Clock } from '@seedingsys/domain';
import { Roles, type Principal } from './auth';
import { CLOCK, DB } from './tokens';
import { Actor } from './util';

async function scanProgress(t: Db | Tx, run: SourceProfileScan, now: Date) {
  const [counts] = await t.$queryRaw<Array<{
    posts: number; comments: number; commentsComplete: number; commentsPending: number;
    images: number; videos: number; mediaPending: number; mediaMissing: number; captionsMissing: number; lastActivity: Date | null;
  }>>`
    SELECT count(*)::int AS posts, coalesce(sum(cs.read_count) FILTER (WHERE cs.status IN ('COMPLETE', 'PARTIAL')),0)::int AS comments,
      count(*) FILTER (WHERE cs.status='COMPLETE')::int AS "commentsComplete",
      count(*) FILTER (WHERE cs.status IN ('QUEUED','RUNNING'))::int AS "commentsPending",
      coalesce(sum(media.images),0)::int AS images, coalesce(sum(media.videos),0)::int AS videos,
      count(*) FILTER (WHERE r.media_status='PENDING')::int AS "mediaPending",
      count(*) FILTER (WHERE r.media_status='FAILED' OR r.incomplete ?| ARRAY['MEDIA_COUNT_UNKNOWN','MEDIA_UNAVAILABLE'])::int AS "mediaMissing",
      count(*) FILTER (WHERE r.incomplete ? 'CAPTION_TRUNCATED')::int AS "captionsMissing",
      max(cs.updated_at) AS "lastActivity"
    FROM comment_scans cs
    JOIN source_posts sp ON sp.id=cs.source_post_id
    LEFT JOIN source_post_revisions r ON r.id=sp.latest_revision_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE a.kind='image') AS images, count(*) FILTER (WHERE a.kind='video') AS videos
      FROM post_assets pa JOIN assets a ON a.id=pa.asset_id
      WHERE pa.revision_id=r.id AND a.status='STORED'
    ) media ON true
    WHERE cs.source_profile_scan_id=${run.id}::uuid AND sp.archived_at IS NULL`;
  const { lastActivity, ...stats } = counts;
  const reading = run.phase === 'PROFILE' || run.phase === 'POSTS';
  const collecting = run.phase === 'COLLECTING' && !!(stats.commentsPending || stats.mediaPending);
  const stalled = (reading && +now - +run.updatedAt >= SOURCE_PROFILE_SCAN_STEP_MS)
    || (collecting && +now - Math.max(+run.updatedAt, +(lastActivity ?? run.updatedAt)) >= SOURCE_PROFILE_SCAN_SETTLE_MS);
  const snapshot = ProfileDetailsSnapshot.safeParse(run.snapshot).data;
  const partial = !run.historyComplete || !snapshot || snapshot.sections.some(section => section.status === 'UNAVAILABLE')
    || !!run.artworkIssue || !!stats.mediaMissing || !!stats.captionsMissing || stats.commentsComplete !== stats.posts;
  const status = stalled ? 'STALLED' : reading || collecting || run.phase === 'FAILED' ? run.phase : partial ? 'PARTIAL' : 'COMPLETE';
  return { status, stats, active: !stalled && (reading || collecting) };
}

@Controller('sources/:sourceId/profile-scan')
export class SourceProfileScanController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock) {}

  @Get()
  @Roles('admin', 'operator')
  async get(@Param('sourceId', ParseUUIDPipe) sourceId: string) {
    const source = await this.db.source.findUnique({ where: { id: sourceId } });
    if (!source) throw new NotFoundException('Không tìm thấy hồ sơ A.');
    const key = { sourceId, sourceRef: source.externalRef, connector: source.connector, resetGeneration: source.resetGeneration };
    const run = await this.db.sourceProfileScan.findFirst({ where: key, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (!run) return { scan: null };
    const saved = run.snapshot ? run : await this.db.sourceProfileScan.findFirst({ where: { ...key, snapshot: { path: ['name'], not: '' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const artwork = SourceProfileArtwork.safeParse(run.artwork).data;
    const lastArtwork = await Promise.all((['avatar', 'cover'] as const).map(async kind => {
      if (artwork?.[kind]) return [kind, artwork[kind]] as const;
      const previous = await this.db.sourceProfileScan.findFirst({ where: { ...key, artwork: { path: [kind], not: '' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { artwork: true } });
      return [kind, SourceProfileArtwork.safeParse(previous?.artwork).data?.[kind]] as const;
    }));
    return { scan: {
      id: run.id,
      createdAt: run.createdAt,
      ...await scanProgress(this.db, run, this.clock.now()),
      snapshot: ProfileDetailsSnapshot.safeParse(saved?.snapshot).data ?? null,
      artwork: Object.fromEntries(lastArtwork),
      issues: [run.profileIssue, run.artworkIssue, run.historyIssue].filter((issue): issue is string => !!issue),
    } };
  }

  @Post()
  @Roles('admin')
  async start(@Param('sourceId', ParseUUIDPipe) sourceId: string, @Actor() actor: Principal) {
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM sources WHERE id=${sourceId}::uuid FOR UPDATE`;
      const source = await t.source.findUnique({ where: { id: sourceId } });
      if (!source) throw new NotFoundException('Không tìm thấy hồ sơ A.');
      if (!isFacebookTimelineReader(source.connector)) throw new ConflictException('Cần chọn Facebook công khai hoặc Facebook qua tài khoản đích để quét hồ sơ A.');
      if (await activeKillSwitch(t, { sourceId, connector: source.connector })) throw new ConflictException('Nguồn đang bị tạm dừng bởi công tắc dừng.');
      const now = this.clock.now();
      const key = { sourceId, sourceRef: source.externalRef, connector: source.connector, resetGeneration: source.resetGeneration };
      const previous = await t.sourceProfileScan.findFirst({ where: key, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (previous) {
        const progress = await scanProgress(t, previous, now);
        if (progress.active) return { scanId: previous.id, queued: false };
        if (progress.status === 'STALLED') {
          await t.commentScan.updateMany({ where: { sourceProfileScanId: previous.id, status: { in: ['QUEUED', 'RUNNING'] } }, data: {
            status: 'FAILED', detail: 'Lượt quét hồ sơ đã gián đoạn. Đã yêu cầu quét lại.', updatedAt: now,
          } });
          await t.sourceProfileScan.update({ where: { id: previous.id }, data: {
            phase: 'FAILED', historyIssue: 'Lượt quét trước đã hết thời gian chờ.', updatedAt: now,
          } });
          await releaseFinishedProfileScanAccount(t, previous.id, now);
        }
      }
      const run = await t.sourceProfileScan.create({ data: { ...key, requestedBy: actor.actor, createdAt: now, updatedAt: now } });
      await enqueue(t, Q.SourceProfileScan, { scanId: run.id, phase: 'PROFILE' }, { singletonKey: run.id });
      await audit(t, { entityType: 'source', entityId: sourceId, action: 'profile_archive_requested', actor: actor.actor, at: now });
      return { scanId: run.id, queued: true };
    });
  }
}
