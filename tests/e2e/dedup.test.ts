import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BacklogDispatchError, dispatchBacklogItem, ingestPost, tx, type IngestPost } from '@seedingsys/db';
import { sha256 } from '@seedingsys/domain';
import { ImportController } from '../../apps/api/src/import.controller';
import { uniqueReads } from '../../apps/worker-browser/src/handlers/source-poll';
import { createHarness, cycle, MIN, pubsOf, type Harness } from '../helpers/harness';

let h: Harness;
beforeEach(async () => {
  h = await createHarness({ codes: [1, 2] });
});
afterEach(async () => {
  await h.close();
});

const read = (over: Partial<IngestPost> & { externalId: string }): IngestPost => ({
  identityConfidence: 'HIGH', text: '', contentType: 'TEXT', isPinned: false, isShared: false, media: [], incomplete: [], ...over,
});
const ingest = (source: string, post: IngestPost, connector = 'fb-public') =>
  tx(h.db, t => ingestPost(t, { sourceId: h.ids.sources[source], connector, post, baseline: false, now: h.clock.now(), actor: 'test' }));

async function storedPhoto(name: string) {
  const bytes = Buffer.from('photo:' + name);
  const checksum = sha256(bytes);
  const objectKey = `assets/test/${checksum}.jpg`;
  await h.media.store.put(objectKey, bytes, 'image/jpeg');
  return { objectKey, checksum, bytes: bytes.length };
}

const variantsOf = (target: string) => h.db.contentVariant.findMany({
  where: { targetId: h.ids.targets[target] }, orderBy: { createdAt: 'asc' }, include: { revision: { include: { post: true } } },
});

describe('one source post is collected once', () => {
  it('recognises a post read again under a rotated pfbid, also after it was trashed', async () => {
    const stored = await storedPhoto('777');
    const photo = (id: string) => ({ kind: 'image' as const, ref: `fb-public:${id}:image:777`, sourceUrl: 'https://cdn.example/777.jpg', mime: 'image/jpeg', stored });
    const caption = 'C89 xin mời các doanh nhân tham dự sự kiện B2B matching';
    const exact = new Date('2026-11-08T05:07:00Z');

    expect(await ingest('A1', read({ externalId: 'pfbidAAA', text: caption, contentType: 'SINGLE_PHOTO', media: [photo('pfbidAAA')] }))).toBe('NEW_POST');
    // Another session: Facebook shows the same post under another pfbid (now with its exact time).
    const rotated = read({ externalId: 'pfbidBBB', text: caption, contentType: 'SINGLE_PHOTO', media: [photo('pfbidBBB')], postedAt: exact, raw: { postedAtExact: true } });
    expect(await ingest('A1', rotated)).toBe('UNCHANGED');
    expect(await ingest('A1', rotated)).toBe('UNCHANGED'); // the alias now maps straight to the record

    const [post] = await h.db.sourcePost.findMany();
    expect(post).toMatchObject({ externalId: 'pfbidAAA', postedAt: exact });
    expect(await h.db.sourcePostAlias.findMany({ select: { externalId: true, sourcePostId: true } })).toEqual([{ externalId: 'pfbidBBB', sourcePostId: post.id }]);
    expect(await h.db.sourcePostRevision.count()).toBe(1);
    expect(await h.db.contentVariant.count()).toBe(1);

    // A trashed post does not come back under a third id.
    await h.db.sourcePost.update({ where: { id: post.id }, data: { archivedAt: h.clock.now(), archivedBy: 'test' } });
    expect(await ingest('A1', read({ ...rotated, externalId: 'pfbidCCC', media: [photo('pfbidCCC')] }))).toBe('UNCHANGED');
    expect(await h.db.sourcePost.count()).toBe(1);

    // Same caption with another photo is another post.
    const other = await storedPhoto('888');
    expect(await ingest('A1', read({ externalId: 'pfbidDDD', text: caption, contentType: 'SINGLE_PHOTO',
      media: [{ ...photo('pfbidDDD'), ref: 'fb-public:pfbidDDD:image:888', stored: other }] }))).toBe('NEW_POST');
    expect(await h.db.sourcePost.count()).toBe(2);
  });

  it('keeps one record and one revision when a later read misses the link preview', async () => {
    const when = { postedAt: new Date('2026-11-13T01:50:00Z') };
    const text = 'Anh Jesen mới quit NVIDIA rồi, có nên mời a ấy về làm COO cho LeadScan.net ko nhờ?';
    expect(await ingest('A1', read({ externalId: 'pfbid02PR', text: text + '\n\nhttp://leadscan.net/', ...when,
      raw: { postedAtExact: true, linkPreviews: ['http://leadscan.net/'] } }))).toBe('NEW_POST');
    expect(await ingest('A1', read({ externalId: 'pfbid02PR', text, ...when, raw: { postedAtExact: true } }))).toBe('UNCHANGED');
    expect(await ingest('A1', read({ externalId: 'pfbid0KPm', text, ...when, raw: { postedAtExact: true } }))).toBe('UNCHANGED');
    expect(await h.db.sourcePost.count()).toBe(1);
    expect(await h.db.sourcePostRevision.count()).toBe(1);
    expect(await h.db.contentVariant.count()).toBe(1);
  });

  it('keeps the most complete read when a feed returns one id twice', () => {
    const cut = read({ externalId: 'p1', text: 'Khai trương', incomplete: ['CAPTION_TRUNCATED'] });
    const full = read({ externalId: 'p1', text: 'Khai trương chi nhánh mới' });
    const other = read({ externalId: 'p2', text: 'Bài khác' });
    expect(uniqueReads([cut, other, full])).toEqual([full, other]);
  });
});

describe('one content reaches a target once', () => {
  it('a second source with the same caption and photo is marked DUPLICATE for the shared target and published once', async () => {
    await h.db.sourceTargetMapping.create({ data: { sourceId: h.ids.sources.A2, targetId: h.ids.targets.B1 } });
    await cycle(h); // 09:50 first sync of the fake sources (empty)
    const media = [{ kind: 'image' as const, ref: 'shared-photo-1' }];
    h.platform.addSourcePost('A1', { text: 'Khai trương chi nhánh mới, giảm 20% toàn bộ sản phẩm', contentType: 'SINGLE_PHOTO', media });
    h.setTime('2026-11-20T02:55:00.000Z');
    await cycle(h); // A1 collected → READY for B1
    // A2 reposts it (other case and spacing, same photo bytes) while B1 publishes A1's copy.
    h.platform.addSourcePost('A2', { text: 'KHAI TRƯƠNG chi nhánh mới,  giảm 20% toàn bộ sản phẩm ', contentType: 'SINGLE_PHOTO', media });
    h.setTime('2026-11-20T03:00:30.000Z');
    await cycle(h);

    const b1 = await variantsOf('B1');
    expect(b1.map(v => [v.revision.post.externalId.split('-')[0], v.status])).toEqual([['A1', 'READY'], ['A2', 'DUPLICATE']]);
    expect(b1[1].reviewReasons).toEqual(['DUPLICATE_CONTENT']);
    expect((await variantsOf('B2')).map(v => v.status)).toEqual(['READY']); // B2 gets it once
    expect(h.editor.calls).toBe(2); // the duplicate never went to the editor

    for (const hour of ['04', '05']) {
      h.setTime(`2026-11-20T${hour}:00:30.000Z`);
      await cycle(h);
    }
    expect((await pubsOf(h, 'B1')).map(p => p.status)).toEqual(['PUBLISHED_VERIFIED']);
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
    expect(h.platform.timeline('fb-B2')).toHaveLength(1);
    expect(h.failures).toEqual([]);
  });

  /** Two ready copies stored before content keys existed (the state of an upgraded database). */
  async function legacyCopies() {
    const text = 'May quá, đi làm hay đeo khẩu trang nên không bị phát hiện.';
    await ingest('A1', read({ externalId: 'pfbidOLD', text, postedAt: new Date('2026-11-10T01:00:00Z'), raw: { postedAtExact: true } }));
    await h.db.sourcePostRevision.updateMany({ data: { contentKey: null } });
    h.advance(MIN);
    await ingest('A1', read({ externalId: 'pfbidNEW', text, postedAt: new Date('2026-11-18T16:48:00Z'), raw: { postedAtExact: true } }));
    await h.db.sourcePostRevision.updateMany({ data: { contentKey: null } });
    await h.drain();
    const copies = await variantsOf('B1');
    expect(copies.map(v => v.status)).toEqual(['READY', 'READY']);
    return copies;
  }

  it('retires an existing duplicate in the backlog and publishes the content once', async () => {
    const [first, second] = await legacyCopies();
    h.setTime('2026-11-20T03:00:30.000Z');
    const { tick } = await cycle(h);
    expect(tick.duplicates).toEqual({ keyed: 2, duplicates: 1 });
    expect((await h.db.contentVariant.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('DUPLICATE');
    const pubs = await pubsOf(h, 'B1');
    expect(pubs.map(p => [p.variantId, p.status])).toEqual([[first.id, 'PUBLISHED_VERIFIED']]);
    h.setTime('2026-11-20T04:00:30.000Z');
    await cycle(h);
    expect(h.platform.timeline('fb-B1')).toHaveLength(1);
  });

  it('refuses "publish now" for a copy of content the target already holds', async () => {
    const [first, second] = await legacyCopies();
    await h.workerHeartbeat();
    await expect(dispatchBacklogItem(h.core, second.id)).rejects.toBeInstanceOf(BacklogDispatchError);
    await expect(dispatchBacklogItem(h.core, second.id)).rejects.toMatchObject({ reason: 'DUPLICATE_CONTENT' });
    expect(await h.db.publication.count()).toBe(0);
    await expect(dispatchBacklogItem(h.core, first.id)).resolves.toBeTruthy();
  });
});

describe('manual import', () => {
  it('refuses to import the same caption and files into a source twice', async () => {
    const source = await h.db.source.create({ data: { code: 'A9', name: 'Nhập tay', externalRef: 'manual', connector: 'manual' } });
    await h.db.sourceTargetMapping.create({ data: { sourceId: source.id, targetId: h.ids.targets.B1 } });
    const api = new ImportController(h.db, h.clock, h.browser.store);
    const actor = { role: 'operator', actor: 'tester' } as const;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const file = (buffer: Buffer) => [{ originalname: 'a.png', buffer, mimetype: 'image/png' }];
    const body = { text: 'Ảnh sự kiện do phòng truyền thông chụp', origin: 'Phòng truyền thông', rightsConfirmed: 'true' };

    await expect(api.create(source.id, body, file(png), actor)).resolves.toMatchObject({ outcome: 'NEW_POST' });
    await expect(api.create(source.id, { ...body, text: '  ảnh sự kiện do phòng truyền thông   chụp' }, file(png), actor))
      .rejects.toThrow('đã được nhập vào nguồn A9');
    await expect(api.create(source.id, body, file(Buffer.concat([png, Buffer.from([0])])), actor)).resolves.toMatchObject({ outcome: 'NEW_POST' });
    expect(await h.db.sourcePost.count({ where: { sourceId: source.id } })).toBe(2);

    const [post] = await h.db.sourcePost.findMany({ where: { sourceId: source.id }, orderBy: { firstSeenAt: 'asc' } });
    await h.db.sourcePost.update({ where: { id: post.id }, data: { archivedAt: h.clock.now(), archivedBy: 'tester' } });
    await expect(api.create(source.id, body, file(png), actor)).rejects.toThrow('thùng rác');
  });
});
