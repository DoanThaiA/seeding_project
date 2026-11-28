import { FbGraphReadConnector } from '@seedingsys/connectors-fb-graph';
import { Q } from '@seedingsys/contracts';
import { accountResource, acquireLease, activeLease, releaseLease, SOURCE_PROFILE_ACCOUNT_PURPOSE, sourceProfileStepResource } from '@seedingsys/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigController } from '../../apps/api/src/config.controller';
import { SourceProfileScanController } from '../../apps/api/src/source-profile-scan.controller';
import { handleCommentScan } from '../../apps/worker-browser/src/handlers/comment-scan';
import { handleSourcePoll } from '../../apps/worker-browser/src/handlers/source-poll';
import { handleSourceProfileScan } from '../../apps/worker-browser/src/handlers/source-profile-scan';
import { handleTargetBrowser } from '../../apps/worker-browser/src/handlers/target-browser';
import { dispatchDuePolls } from '../../apps/worker-core/src/scheduler/poll-dispatcher';
import { createHarness, MIN, type Harness } from '../helpers/harness';

const admin = { role: 'admin', actor: 'admin:poll-limit' } as const;

describe('per-source scan limit', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness({ codes: [1] }); });
  afterEach(async () => { await h.close(); });

  it('holds the same B session from profile information through the last comment job', async () => {
    const sourceId = h.ids.sources.A1, targetId = h.ids.targets.B1;
    const sourceRef = 'https://www.facebook.com/source-one';
    const config = new ConfigController(h.db, h.clock);
    const archive = new SourceProfileScanController(h.db, h.clock);
    await h.db.source.update({ where: { id: sourceId }, data: { connector: 'fb-session', externalRef: sourceRef } });
    await h.db.targetAccount.update({ where: { id: targetId }, data: { connector: 'fb-web' } });
    await h.db.browserProfile.update({ where: { targetId }, data: { workerNodeId: null } });
    const calls: string[] = [];
    h.browser.registry.addReader({
      key: 'fb-session', version: 'test',
      async readProfileDetails() {
        calls.push('profile');
        return { url: sourceRef, name: 'A1', intro: [], sections: [], capturedAt: h.clock.now().toISOString() };
      },
      async readSince(source) {
        calls.push(source.history ? 'posts' : 'poll');
        return { posts: ['11', '12'].map(externalId => ({
          externalId, permalink: sourceRef + '/posts/' + externalId, text: externalId, media: [], incomplete: [],
          contentType: 'TEXT', identityConfidence: 'HIGH', isPinned: false, isShared: false,
        })), nextWatermark: {}, incomplete: [], history: { complete: true } };
      },
      async readComments() {
        calls.push('comments');
        return { comments: [], complete: true, expectedCount: 0 };
      },
      async fetchMedia() { throw new Error('Unexpected media'); },
    });
    const { scanId } = await archive.start(sourceId, admin);
    const opening = { scanId, phase: 'PROFILE' as const };
    const previous = await acquireLease(h.db, { resource: accountResource(targetId), holder: 'older-job', now: h.clock.now(), ttlMs: MIN });
    expect(previous).toBeTruthy();
    expect(await dispatchDuePolls(h.core)).toBe(0);
    await handleSourceProfileScan(h.browser, opening);
    expect(calls).toEqual([]);
    expect(await h.db.outboxEvent.count({ where: { queue: Q.SourceProfileScan, startAfter: { not: null } } })).toBe(1);
    await releaseLease(h.db, previous!, h.clock.now());
    h.advance(30_000);
    await handleSourceProfileScan(h.browser, opening);

    const held = () => activeLease(h.db, accountResource(targetId), h.clock.now());
    expect(await held()).toMatchObject({ purpose: SOURCE_PROFILE_ACCOUNT_PURPOSE });
    expect(await activeLease(h.db, sourceProfileStepResource(targetId), h.clock.now())).toBeNull();
    const other = await h.db.source.create({ data: { code: 'A2', name: 'Nguồn dùng chung B', externalRef: 'https://www.facebook.com/source-two', connector: 'fb-session' } });
    await h.db.sourceTargetMapping.create({ data: { sourceId: other.id, targetId } });
    expect(await dispatchDuePolls(h.core)).toBe(0);
    expect(await acquireLease(h.db, { resource: accountResource(targetId), holder: 'other-job', now: h.clock.now(), ttlMs: MIN })).toBeNull();
    expect(await acquireLease(h.db, { resource: accountResource('different-account'), holder: 'other-job', now: h.clock.now(), ttlMs: MIN })).toBeTruthy();
    const login = await h.db.targetBrowserRun.create({ data: { targetId, kind: 'login', createdAt: h.clock.now() } });
    await handleTargetBrowser(h.browser, login.id, 'unused', 0);
    expect(await h.db.targetBrowserRun.findUniqueOrThrow({ where: { id: login.id } })).toMatchObject({ status: 'QUEUED' });

    expect(await config.pollSource(sourceId, admin)).toEqual({ queued: true });
    const manual = { sourceId, requestedAt: h.clock.now().toISOString() };
    expect(await handleSourcePoll(h.browser, manual, 0)).toMatchObject({ outcome: 'WAITING_FOR_ACCOUNT' });
    expect(await h.db.outboxEvent.count({ where: { queue: Q.SourcePoll, startAfter: { not: null } } })).toBe(1);
    await handleSourceProfileScan(h.browser, { scanId, phase: 'POSTS', readTargetId: targetId });
    expect(await held()).toMatchObject({ purpose: SOURCE_PROFILE_ACCOUNT_PURPOSE });
    const scans = await h.db.commentScan.findMany({ where: { sourceProfileScanId: scanId }, orderBy: { id: 'asc' } });
    expect(scans).toHaveLength(2);
    await handleCommentScan(h.browser, { scanId: scans[0].id, readTargetId: targetId, manual: true });
    expect(await held()).toMatchObject({ purpose: SOURCE_PROFILE_ACCOUNT_PURPOSE });
    await handleCommentScan(h.browser, { scanId: scans[1].id, readTargetId: targetId, manual: true });
    expect(await held()).toBeNull();
    expect(await handleSourcePoll(h.browser, manual, 0)).toMatchObject({ outcome: 'OK' });
    expect(calls).toEqual(['profile', 'posts', 'comments', 'comments', 'poll']);
    expect(await dispatchDuePolls(h.core)).toBe(1);
  });

  it('stores a nullable post limit in the source configuration and rejects out-of-range values', async () => {
    const config = new ConfigController(h.db, h.clock);
    const id = h.ids.sources.A1;
    await expect(config.updateSource(id, { pollPostLimit: 2.5 }, admin)).rejects.toThrow();
    await expect(config.updateSource(id, { pollPostLimit: 0 }, admin)).rejects.toThrow();
    await expect(config.updateSource(id, { pollPostLimit: 101 }, admin)).rejects.toThrow();
    expect(await config.updateSource(id, { pollPostLimit: 8 }, admin)).toMatchObject({ pollPostLimit: 8 });
    expect(await config.updateSource(id, { name: 'A1 mới' }, admin)).toMatchObject({ pollPostLimit: 8 });
    expect(await config.updateSource(id, { pollPostLimit: null }, admin)).toMatchObject({ pollPostLimit: null });
  });

  it('applies the same saved limit to scheduled and manual Graph polls without resetting the cursor', async () => {
    const sourceId = h.ids.sources.A1;
    const anchor = +h.clock.now() - 10 * MIN;
    const requests: [number, number][] = [];
    h.browser.registry.addReader(new FbGraphReadConnector({ tokens: { A1: 'test' }, fetch: async input => {
      const url = new URL(String(input));
      const cursor = Number(url.searchParams.get('after') ?? 0);
      requests.push([cursor, Number(url.searchParams.get('limit'))]);
      return Response.json({
        data: [{ id: `100_${cursor}`, message: `Bài nguồn ${cursor}`, created_time: new Date(anchor + (4 - cursor) * MIN).toISOString() }],
        ...(cursor < 3 && { paging: { next: 'https://graph.facebook.com/next', cursors: { after: String(cursor + 1) } } }),
      });
    } }));
    await h.db.source.update({ where: { id: sourceId }, data: {
      connector: 'fb-graph', externalRef: '100', baselineDone: true, watermark: { newest: anchor }, pollPostLimit: 2, collectComments: false,
    } });

    expect(await handleSourcePoll(h.browser, { sourceId, scheduled: true })).toMatchObject({ outcome: 'OK', counts: { NEW_POST: 2 } });
    expect(await h.db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({
      watermark: { newest: anchor, nextCursor: '2', lastReadCount: 2 },
    });
    expect(await handleSourcePoll(h.browser, { sourceId, collectComments: true })).toMatchObject({ outcome: 'OK', counts: { NEW_POST: 2 } });
    expect(await h.db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({
      watermark: { newest: anchor + 4 * MIN, lastReadCount: 2 }, lastIncomplete: [],
    });
    expect(requests).toEqual([[0, 2], [1, 1], [2, 2], [3, 1]]);
    expect(await h.db.sourcePost.count({ where: { sourceId } })).toBe(4);
  });

  it('leaves newer mock-platform posts for the next poll instead of advancing past them', async () => {
    const sourceId = h.ids.sources.A1;
    await h.db.source.update({ where: { id: sourceId }, data: { pollPostLimit: 2, overlapCount: 5 } });
    await handleSourcePoll(h.browser, { sourceId });
    const input = [1, 2, 3].map(n => h.platform.addSourcePost('A1', { text: `Bài thử ${n}`, contentType: 'TEXT', media: [] }));
    expect(await handleSourcePoll(h.browser, { sourceId })).toMatchObject({ outcome: 'OK', counts: { NEW_POST: 2 } });
    const ids = async () => (await h.db.sourcePost.findMany({ where: { sourceId }, select: { externalId: true } })).map(row => row.externalId).sort();
    expect(await ids()).toEqual(input.slice(0, 2).map(post => post.id).sort());
    expect(await handleSourcePoll(h.browser, { sourceId })).toMatchObject({ outcome: 'OK', counts: { NEW_POST: 1 } });
    expect(await ids()).toEqual(input.map(post => post.id).sort());
    expect(await h.db.source.findUniqueOrThrow({ where: { id: sourceId } })).toMatchObject({ watermark: { lastReadCount: 2 } });
  });
});
