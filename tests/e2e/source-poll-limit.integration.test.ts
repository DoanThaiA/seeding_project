import { FbGraphReadConnector } from '@seedingsys/connectors-fb-graph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigController } from '../../apps/api/src/config.controller';
import { handleSourcePoll } from '../../apps/worker-browser/src/handlers/source-poll';
import { createHarness, MIN, type Harness } from '../helpers/harness';

const admin = { role: 'admin', actor: 'admin:poll-limit' } as const;

describe('per-source scan limit', () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness({ codes: [1] }); });
  afterEach(async () => { await h.close(); });

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
