import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_ABOUT_SECTIONS, Q, type JobPayload } from '@seedingsys/contracts';
import { CommentScriptsController } from '../../apps/api/src/comment-scripts.controller';
import { ConfigController } from '../../apps/api/src/config.controller';
import { ProfileDetailsController } from '../../apps/api/src/profile-details.controller';
import { ProfileGroupsController } from '../../apps/api/src/profile-groups.controller';
import { handleCommentScriptStep } from '../../apps/worker-browser/src/handlers/comment-script';
import { handleApplyProfileBio, handleProfileDetails } from '../../apps/worker-browser/src/handlers/profile-details';
import { createHarness, type Harness } from '../helpers/harness';

const admin = { actor: 'test-admin', role: 'admin' } as const;
const operator = { actor: 'test-operator', role: 'operator' } as const;
const photo = 'https://www.facebook.com/photo?fbid=12345';

describe('profile details and scripted comments across two A/B pairs', () => {
  let h: Harness;
  let b1: string;
  let b2: string;
  const jobs = async <N extends typeof Q[keyof typeof Q]>(queue: N) =>
    (await h.db.outboxEvent.findMany({ where: { queue }, orderBy: { id: 'asc' } })).map(row => row.payload as JobPayload<N>);

  beforeEach(async () => {
    h = await createHarness({ codes: [1, 2] });
    b1 = h.ids.targets.B1;
    b2 = h.ids.targets.B2;
    await h.db.targetAccount.updateMany({ data: { connector: 'fb-web' } });
    await h.db.browserProfile.updateMany({ data: { workerNodeId: null } });
  });
  afterEach(async () => { await h.close(); });

  it('scans each A, stores the correct snapshot on its B, verifies bio and preserves manual group membership', async () => {
    const details = new ProfileDetailsController(h.db, h.clock);
    const groups = new ProfileGroupsController(h.db, h.clock);
    const savedBios: string[] = [];
    for (const [position, code] of ['A1', 'A2'].entries()) {
      await h.db.source.update({ where: { id: h.ids.sources[code] }, data: { connector: position ? 'fb-session' : 'fb-public',
        externalRef: `https://www.facebook.com/profile.php?id=${position + 90}` } });
    }
    const fakeReader = h.browser.registry.reader('fake');
    for (const connector of ['fb-public', 'fb-session']) h.browser.registry.addReader({ ...fakeReader,
      key: connector, version: 'test', readSince: fakeReader.readSince.bind(fakeReader), fetchMedia: fakeReader.fetchMedia.bind(fakeReader),
      async readProfileDetails(source) {
        expect(source.readAccount?.code).toBe(source.code === 'A2' ? 'B2' : undefined);
        return { url: source.externalRef, name: `Tên ${source.code}`, bio: `Giới thiệu ${source.code}`, intro: ['Đang học'],
          capturedAt: h.clock.now().toISOString(), sections: PROFILE_ABOUT_SECTIONS.map(key => ({ key, status: 'UNAVAILABLE', categories: [] })) };
      },
    });
    h.browser.registry.addPublisher({ key: 'fb-web', version: 'test', capabilities: () => ({}), openSession: async target => {
      const session = await h.browser.registry.publisher('fake').openSession(target);
      session.replaceProfileBio = async ({ externalId, bio, beforeSave }) => {
        expect(externalId).toBe(target.externalId);
        await beforeSave();
        savedBios.push(`${target.code} ${bio}`);
      };
      return session;
    } });
    const mappings = await h.db.sourceTargetMapping.findMany({ include: { source: true }, orderBy: { source: { code: 'asc' } } });
    for (const mapping of mappings) {
      expect(await details.scan(mapping.id, admin)).toEqual({ queued: true });
      expect(await details.scan(mapping.id, admin)).toEqual({ queued: false });
    }
    for (const payload of await jobs(Q.ProfileDetails)) await handleProfileDetails(h.browser, payload);
    for (const [position, mapping] of mappings.entries()) {
      const state = await details.get(mapping.id);
      expect(state.scan).toMatchObject({ status: 'READY', snapshot: { name: `Tên ${mapping.source.code}` } });
      await details.sync(mapping.id, { requestId: state.scan!.requestId, applyBio: position === 0 }, admin);
    }
    for (const payload of await jobs(Q.ApplyProfileBio)) await handleApplyProfileBio(h.browser, payload);
    expect(savedBios).toEqual(['B1 Giới thiệu A1']);
    expect((await details.get(mappings[0].id)).scan?.bioStatus).toBe('DONE');
    const first = await groups.create({ name: 'Nhóm một', sourceIds: [h.ids.sources.A1], targetIds: [b1, b2] }, operator);
    await groups.create({ name: 'Nhóm hai', sourceIds: [h.ids.sources.A2], targetIds: [b2] }, operator);
    await groups.update(first.id, { name: first.name, sourceIds: [h.ids.sources.A1, h.ids.sources.A1], targetIds: [b1] }, operator);
    expect((await groups.list(admin)).groups).toEqual([
      expect.objectContaining({ name: 'Nhóm hai', targetIds: [b2] }), expect.objectContaining({ name: 'Nhóm một', sourceIds: [h.ids.sources.A1], targetIds: [b1] }),
    ]);
    expect((await groups.list(admin)).targets.map(({ code, details }) => [code, details?.sourceCode])).toEqual([['B1','A1'], ['B2','A2']]);
    expect((await groups.list(operator)).targets.every(target => target.details === null)).toBe(true);
    expect((await new ConfigController(h.db, h.clock).targets()).every(target => !Object.hasOwn(target, 'profileDetails'))).toBe(true);
  });

  it('sends an assigned comment and reply in order, stopping at an ambiguous receipt', async () => {
    const scripts = new CommentScriptsController(h.db, h.clock);
    const seen: Array<{ code: string; text: string; parentId?: string; href: string }> = [];
    h.browser.registry.addPublisher({ key: 'fb-web', version: 'test', capabilities: () => ({}), openSession: async target => {
      const session = await h.browser.registry.publisher('fake').openSession(target);
      session.resolveCommentPost = async () => new URL(photo);
      session.postComment = async ({ post, parentId, text }, beforeSubmit) => {
        await beforeSubmit();
        seen.push({ code: target.code, text, parentId, href: post.href });
        if (text === 'Phản hồi chưa có receipt') return null;
        const externalId = String(540 + seen.length);
        post.searchParams.set(parentId ? 'reply_comment_id' : 'comment_id', externalId);
        return { externalId, permalink: post.href };
      };
      return session;
    } });
    const steps = [
      { targetId: b1, text: 'Bình luận gốc' }, { targetId: b2, text: 'Phản hồi chưa có receipt', replyTo: 0 },
      { targetId: b1, text: 'Phản hồi cho bình luận có sẵn', replyUrl: `${photo}&comment_id=99` },
    ];
    const { id } = await scripts.create({ name: 'Hai hồ sơ B', postUrl: 'https://www.facebook.com/share/p/AbC/', steps }, operator);
    await expect(scripts.create({ name: 'Sai bài', postUrl: photo, steps: [{ ...steps[2], replyUrl: 'https://www.facebook.com/photo?fbid=22&comment_id=99' }] }, operator)).rejects.toThrow('phải thuộc bài');
    const edited = await scripts.edit(id, { version: 1, name: 'Luồng ảnh', postUrl: 'https://www.facebook.com/share/p/AbC/', steps }, operator);
    await expect(scripts.start(id, { version: 1 }, operator)).rejects.toThrow('đã thay đổi');
    await scripts.start(id, { version: edited.version }, operator);
    const [first] = await jobs(Q.CommentScriptStep);
    await handleCommentScriptStep(h.browser, first);
    await handleCommentScriptStep(h.browser, first);
    const [, second] = await jobs(Q.CommentScriptStep);
    await handleCommentScriptStep(h.browser, second);
    const halted = await scripts.get(id);
    expect(halted.steps.map(step => step.status)).toEqual(['POSTED', 'UNKNOWN', 'DRAFT']);
    expect(seen).toMatchObject([{ code: 'B1', text: 'Bình luận gốc', href: photo },
      { code: 'B2', text: 'Phản hồi chưa có receipt', parentId: '541', href: `${photo}&comment_id=541` }]);
    await expect(scripts.resolve(id, second.stepId, { action: 'confirm', sendVersion: 1, permalink: `${photo}&comment_id=999&reply_comment_id=542` }, operator)).rejects.toThrow('đúng nhánh');
    await scripts.resolve(id, second.stepId, { action: 'confirm', sendVersion: 1, permalink: `${photo}&comment_id=541&reply_comment_id=542` }, operator);
    const [, , third] = await jobs(Q.CommentScriptStep);
    await handleCommentScriptStep(h.browser, third);
    expect((await scripts.get(id)).steps.map(step => step.status)).toEqual(['POSTED', 'POSTED', 'POSTED']);
    expect(seen[2]).toMatchObject({ code: 'B1', parentId: '99', href: `${photo}&comment_id=99` });
  });
});
