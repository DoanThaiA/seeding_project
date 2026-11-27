import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Q } from '@seedingsys/contracts';
import { dispatchBacklogItem, freezeSnapshot, ingestPost, listBacklog, tx } from '@seedingsys/db';
import { ScheduleController } from '../../apps/api/src/schedule.controller';
import { handlePublish } from '../../apps/worker-browser/src';
import { handleCommentPublish } from '../../apps/worker-browser/src/handlers/comment-publish';
import { dispatchAutomaticComments } from '../../apps/worker-core/src/maintenance/automatic-comments';
import { createHarness, MIN, pubsOf, type Harness } from '../helpers/harness';

const principal = { role: 'operator', actor: 'test-scheduler' } as const;

describe('publication schedules', () => {
  let h: Harness;
  let schedules: ScheduleController;
  beforeEach(async () => {
    h = await createHarness({ codes: [1, 2] });
    h.core.allowImplicitSlots = false;
    schedules = new ScheduleController(h.db, h.clock);
  });
  afterEach(() => h.close());

  async function ready(sourceId: string, targetId: string, id: string, caption: string, minutesAgo: number) {
    return tx(h.db, async t => {
      const now = h.clock.now();
      await ingestPost(t, { sourceId, connector: 'fake', now, baseline: false, actor: principal.actor, archiveOnly: true,
        post: { externalId: id, contentType: 'TEXT', text: caption, postedAt: new Date(+now - minutesAgo * MIN),
          identityConfidence: 'HIGH', isPinned: false, isShared: false, incomplete: [], media: [] } });
      const post = await t.sourcePost.findUniqueOrThrow({ where: { sourceId_resetGeneration_externalId: { sourceId, resetGeneration: 0, externalId: id } } });
      const variant = await t.contentVariant.create({ data: { revisionId: post.latestRevisionId!, targetId, sourcePostId: post.id,
        contentType: 'TEXT', status: 'NEEDS_REVIEW', caption } });
      await freezeSnapshot(t, { variantId: variant.id, from: 'NEEDS_REVIEW', now, actor: principal.actor });
      return variant.id;
    });
  }

  it('publishes at an odd Vietnam minute at the chosen interval, scoped to the selected source', async () => {
    const sourceId = h.ids.sources.A1;
    const targetId = h.ids.targets.B1;
    await h.db.source.update({ where: { id: sourceId }, data: { enabled: false, collectComments: true, publishComments: true,
      runStartMinute: 800, runEndMinute: 820, publishIntervalMin: 60 } });
    await h.db.sourceTargetMapping.create({ data: { sourceId: h.ids.sources.A2, targetId } });
    await ready(h.ids.sources.A2, targetId, 'unselected', 'Thông báo ngoài phạm vi nguồn đã chọn', 40);
    await ready(sourceId, targetId, 'oldest', 'Thông báo học bổng của tháng này', 25);
    await ready(sourceId, targetId, 'newer', 'Lịch hoạt động chi nhánh mới sáng nay', 10);

    const schedule = await schedules.create({ sourceIds: [sourceId], startsAt: '2026-11-20T10:07:00+07:00', intervalMinutes: 7, limit: 2 }, principal);
    expect(schedule.startsAt.toISOString()).toBe('2026-11-20T03:07:00.000Z');
    expect((await schedules.list())[0]).toMatchObject({ status: 'SCHEDULED', waiting: 2, sourceCodes: ['A1'], targetCodes: ['B1'] });
    h.setTime('2026-11-20T03:00:00.000Z');
    await h.tick();
    await h.drain();
    expect(h.platform.timeline('fb-B1')).toEqual([]);
    expect(await h.db.publicationSlot.count({ where: { scheduleId: null } })).toBe(0);

    h.setTime('2026-11-20T03:07:00.000Z');
    await h.tick();
    expect((await schedules.list())[0]).toMatchObject({ status: 'RUNNING', waiting: 1, active: 1 });
    await h.drain();
    h.setTime('2026-11-20T03:14:00.000Z');
    await h.tick();
    await h.drain();

    const sent = await h.db.publication.findMany({ where: { targetId }, orderBy: { committedAt: 'asc' }, include: { post: true } });
    expect(sent.map(p => [p.post.externalId, p.status, p.committedAt?.toISOString()])).toEqual([
      ['oldest', 'PUBLISHED_VERIFIED', '2026-11-20T03:07:00.000Z'], ['newer', 'PUBLISHED_VERIFIED', '2026-11-20T03:14:00.000Z'],
    ]);
    expect(await h.db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({ enabled: false, lastPollAt: null,
      collectComments: true, publishComments: true, publishIntervalMin: 60 });
    expect((await schedules.list())[0]).toMatchObject({ status: 'COMPLETED', posted: 2 });
  });

  it('reserves exact backlog posts and cancels a queued job when the schedule is stopped', async () => {
    const sourceId = h.ids.sources.A1;
    const targetId = h.ids.targets.B1;
    await ready(sourceId, targetId, 'older-not-selected', 'Bản tin cũ không nằm trong lịch', 25);
    const variantId = await ready(sourceId, targetId, 'selected', 'Bản tin đã chọn cho khung giờ mới', 5);
    const input = { variantIds: [variantId], startsAt: '2026-11-20T10:03', intervalMinutes: 3, limit: 1 };
    const schedule = await schedules.create(input, principal);
    expect(await listBacklog(h.db, h.clock.now())).toContainEqual(expect.objectContaining({ id: variantId, blockReason: 'SCHEDULE_RESERVED' }));
    await expect(dispatchBacklogItem(h.core, variantId)).rejects.toMatchObject({ reason: 'SCHEDULE_RESERVED' });
    await expect(schedules.create(input, principal)).rejects.toThrow('đã được đặt lịch');

    h.setTime('2026-11-20T03:03:00.000Z');
    await h.tick();
    await schedules.stop(schedule.id, principal);
    await schedules.stop(schedule.id, principal);
    await h.drain();

    expect(await pubsOf(h, 'B1')).toMatchObject([{ variantId, status: 'CANCELLED', lastReason: 'SCHEDULE_STOPPED' }]);
    expect(h.platform.timeline('fb-B1')).toEqual([]);
    expect((await schedules.list())[0]).toMatchObject({ status: 'STOPPED', stopped: 1, active: 0 });
    expect(await listBacklog(h.db, h.clock.now())).toContainEqual(expect.objectContaining({ id: variantId, blockReason: null }));
  });

  it('prevents the final publish click when the schedule is stopped during draft preparation', async () => {
    const sourceId = h.ids.sources.A1;
    const variantId = await ready(sourceId, h.ids.targets.B1, 'scheduled', 'Bài đã hẹn cần dừng trước khi đăng', 1);
    const schedule = await schedules.create({ variantIds: [variantId], intervalMinutes: 5, limit: 1 }, principal);
    await h.tick();
    const job = await h.db.outboxEvent.findFirstOrThrow({ where: { queue: Q.PublishStandard } });
    let release!: () => void;
    let entered!: () => void;
    const gated = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    h.platform.inject({ stage: 'prepare', action: { kind: 'gate', wait: gated, onEnter: entered }, match: 'fb-B1' });
    const running = handlePublish(h.browser, job.payload as { publicationId: string; jobVersion: number });
    await Promise.race([reached, running.then(() => { throw new Error('Worker finished before preparing a draft.'); })]);
    try {
      expect((await schedules.list())[0]).toMatchObject({ status: 'RUNNING', active: 1 });
      await schedules.stop(schedule.id, principal);
    } finally {
      release();
    }
    expect(await running).toBe('CANCELLED');
    expect(h.platform.timeline('fb-B1')).toEqual([]);
    expect((await schedules.list())[0]).toMatchObject({ status: 'STOPPED', stopped: 1, active: 0 });
  });

  it('keeps tracking a submission that crossed the commit boundary before the stop', async () => {
    const sourceId = h.ids.sources.A1;
    const variantId = await ready(sourceId, h.ids.targets.B1, 'in-flight', 'Bài đang qua bước xác nhận bên đích', 1);
    const schedule = await schedules.create({ variantIds: [variantId], intervalMinutes: 5, limit: 1 }, principal);
    await h.tick();
    const job = await h.db.outboxEvent.findFirstOrThrow({ where: { queue: Q.PublishStandard } });
    let release!: () => void;
    let entered!: () => void;
    const gated = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    h.platform.inject({ stage: 'commit.before', action: { kind: 'gate', wait: gated, onEnter: entered }, match: 'fb-B1' });
    const running = handlePublish(h.browser, job.payload as { publicationId: string; jobVersion: number });
    await Promise.race([reached, running.then(() => { throw new Error('Worker finished before the commit boundary.'); })]);
    try {
      await schedules.stop(schedule.id, principal);
      expect((await schedules.list())[0]).toMatchObject({ status: 'STOPPED', active: 1 });
    } finally {
      release();
    }
    expect(await running).toBe('PUBLISHED_VERIFIED');
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
    expect((await schedules.list())[0]).toMatchObject({ status: 'STOPPED', active: 0, posted: 1 });
  });

  it('replays only already scanned comments when the source scanner is disabled, and stops queued replay', async () => {
    const sourceId = h.ids.sources.A1;
    const targetId = h.ids.targets.B1;
    await h.db.source.update({ where: { id: sourceId }, data: { enabled: false, collectComments: true, publishComments: true } });
    await ready(sourceId, targetId, 'archived-comments', 'Bài đăng từ kho có bình luận đã lưu', 1);
    const schedule = await schedules.create({ sourceIds: [sourceId], intervalMinutes: 5, limit: 2 }, principal);
    await h.tick();
    await h.drain();

    const [published] = await pubsOf(h, 'B1');
    await h.db.targetAccount.update({ where: { id: targetId }, data: { connector: 'fb-web' } });
    await h.db.source.update({ where: { id: sourceId }, data: { connector: 'fb-public' } });
    await h.db.sourcePost.update({ where: { id: published.sourcePostId }, data: { permalink: 'https://www.facebook.com/100/posts/400' } });
    await h.db.publication.update({ where: { id: published.id }, data: {
      autoReplayComments: true, permalink: 'https://www.facebook.com/100/posts/500',
    } });
    expect(await dispatchAutomaticComments(h.core)).toBe(0);
    expect(await h.db.outboxEvent.count({ where: { queue: Q.CommentScan } })).toBe(0);

    await h.db.commentScan.create({ data: {
      sourcePostId: published.sourcePostId, requestedBy: principal.actor, status: 'COMPLETE', readCount: 2,
    } });
    await h.db.sourceComment.createMany({ data: [0, 1].map(position => ({
      sourcePostId: published.sourcePostId, externalId: String(800 + position), position,
      text: `Bình luận đã lưu ${position}`, lastSeenAt: h.clock.now(),
    })) });
    const fake = h.browser.registry.publisher('fake');
    const sent: string[] = [];
    h.browser.registry.addPublisher({ key: 'fb-web', version: 'test', capabilities: () => ({}), openSession: async target => {
      const session = await fake.openSession(target);
      session.postComment = async ({ post, text }, beforeSubmit) => {
        await beforeSubmit();
        sent.push(text);
        post.searchParams.set('comment_id', '900');
        return { externalId: '900', permalink: post.href };
      };
      return session;
    } });
    const readCommentJob = async () => {
      const event = await h.db.outboxEvent.findFirstOrThrow({ where: { queue: Q.CommentPublish }, orderBy: { id: 'desc' } });
      return event.payload as { replayId: string; sendVersion: number; automatic: boolean };
    };
    const browser = { ...h.browser, actor: 'browser:test' };
    expect(await dispatchAutomaticComments(h.core)).toBe(1);
    await handleCommentPublish(browser, await readCommentJob());
    expect(sent).toEqual(['Bình luận đã lưu 0']);
    expect(await h.db.publicationComment.count({ where: { status: 'POSTED' } })).toBe(1);

    expect(await dispatchAutomaticComments(h.core)).toBe(1);
    const pending = await readCommentJob();
    await schedules.stop(schedule.id, principal);
    await handleCommentPublish(browser, pending);
    expect(sent).toHaveLength(1);
    expect(await h.db.publicationComment.findUniqueOrThrow({ where: { id: pending.replayId } })).toMatchObject({ status: 'FAILED', sendDetail: 'Lịch đăng đã dừng.' });
    expect(await dispatchAutomaticComments(h.core)).toBe(0);
  });
});
