import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualReadConnector, manualStagingKey, sniffMime } from '@seedingsys/connectors-manual';
import { ingestPost, tx } from '@seedingsys/db';
import { createHarness, cycle, MIN, pubsOf, type Harness } from '../helpers/harness';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]);

describe('sniffMime', () => {
  it('identifies media by content, not by name', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(JPG)).toBe('image/jpeg');
    expect(sniffMime(MP4)).toBe('video/mp4');
    expect(sniffMime(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffMime(Buffer.from('MZ\u0090\u0000\u0003\u0000\u0000\u0000\u0004\u0000\u0000\u0000'))).toBeNull();
  });
});

describe('manual source → READY → published', () => {
  let h: Harness;
  let sourceId: string;
  beforeEach(async () => {
    h = await createHarness({ codes: [1] });
    h.browser.registry.addReader(new ManualReadConnector(h.browser.store));
    const src = await h.db.source.create({ data: { code: 'A9', name: 'Nhập tay', externalRef: 'manual', connector: 'manual' } });
    await h.db.sourceTargetMapping.create({ data: { sourceId: src.id, targetId: h.ids.targets.B1 } });
    sourceId = src.id;
  });
  afterEach(() => h.close());

  async function importPost(text: string, files: Buffer[], batch = 'b1') {
    const media: Array<{ kind: 'image' | 'video'; ref: string; mime: string }> = [];
    for (const [i, f] of files.entries()) {
      const mime = sniffMime(f)!;
      const ref = manualStagingKey(batch, i, mime);
      await h.browser.store.put(ref, f, mime);
      media.push({ kind: mime.startsWith('video') ? 'video' : 'image', ref, mime });
    }
    return tx(h.db, (t) =>
      ingestPost(t, {
        sourceId,
        connector: 'manual',
        baseline: false,
        now: h.clock.now(),
        actor: 'test',
        post: {
          externalId: `manual-${batch}`,
          identityConfidence: 'HIGH',
          postedAt: h.clock.now(),
          text,
          contentType: files.length > 1 ? 'MULTI_PHOTO' : files.length === 1 ? 'SINGLE_PHOTO' : 'TEXT',
          isPinned: false,
          isShared: false,
          media,
          incomplete: [],
          raw: { origin: 'test', rightsConfirmed: true },
        },
      }),
    );
  }

  it('an imported album goes through media fetch and editing, then posts as one album', async () => {
    expect(await importPost('Ảnh sự kiện do phòng truyền thông chụp', [PNG, JPG])).toBe('NEW_POST'); // not a baseline
    await h.drain();
    const v = await h.db.contentVariant.findFirstOrThrow({ where: { target: { code: 'B1' }, revision: { post: { source: { code: 'A9' } } } } });
    expect(v.status).toBe('READY');
    expect((v.snapshot as { media: unknown[] }).media).toHaveLength(2);
    expect(h.failures).toEqual([]);

    h.setTime('2026-11-20T03:00:10.000Z');
    await cycle(h);
    const [p] = await pubsOf(h, 'B1');
    expect(p.status).toBe('PUBLISHED_VERIFIED');
    expect(h.platform.timeline('fb-B1')[0].mediaChecksums).toHaveLength(2);
  });

  it('importing the identical post again changes nothing', async () => {
    expect(await importPost('Nội dung giống nhau', [], 'same')).toBe('NEW_POST');
    expect(await importPost('Nội dung giống nhau', [], 'same')).toBe('UNCHANGED');
    expect(await h.db.sourcePost.count({ where: { externalId: 'manual-same' } })).toBe(1);
    expect(await h.db.sourcePostRevision.count()).toBe(1);
    h.advance(MIN);
  });
});
