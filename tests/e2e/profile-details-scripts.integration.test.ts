import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@seedingsys/config';
import { PROFILE_ABOUT_SECTIONS, Q, type JobPayload } from '@seedingsys/contracts';
import { LlmGateway, type CommentPlanInput } from '@seedingsys/llm';
import { CommentPreviewsController } from '../../apps/api/src/comment-previews.controller';
import { CommentScriptsController } from '../../apps/api/src/comment-scripts.controller';
import { ConfigController } from '../../apps/api/src/config.controller';
import { ProfileDetailsController } from '../../apps/api/src/profile-details.controller';
import { PersonasController } from '../../apps/api/src/personas.controller';
import { handleCommentScriptStep } from '../../apps/worker-browser/src/handlers/comment-script';
import { handleApplyProfileBio, handleProfileDetails } from '../../apps/worker-browser/src/handlers/profile-details';
import { handleTargetBrowser } from '../../apps/worker-browser/src/handlers/target-browser';
import { handleCommentScriptGeneration } from '../../apps/worker-core/src/handlers/comment-script-generate';
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

  it('scans each A, stores the correct snapshot on its B and exposes the right persona context', async () => {
    const details = new ProfileDetailsController(h.db, h.clock);
    const personas = new PersonasController(h.db, h.clock);
    const savedBios: string[] = [];
    const reads: string[] = [];
    let failSource: string | undefined;
    for (const [position, code] of ['A1', 'A2'].entries()) {
      await h.db.source.update({ where: { id: h.ids.sources[code] }, data: { connector: position ? 'fb-session' : 'fb-public',
        externalRef: `https://www.facebook.com/profile.php?id=${position + 90}` } });
    }
    const fakeReader = h.browser.registry.reader('fake');
    for (const connector of ['fb-public', 'fb-session']) h.browser.registry.addReader({ ...fakeReader,
      key: connector, version: 'test', readSince: fakeReader.readSince.bind(fakeReader), fetchMedia: fakeReader.fetchMedia.bind(fakeReader),
      async readProfileDetails(source) {
        reads.push(`${source.code}:${source.readAccount?.code ?? 'public'}`);
        if (source.code === failSource) throw new Error('Nguồn không khả dụng.');
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
    const alternate = await h.db.sourceTargetMapping.create({ data: { sourceId: h.ids.sources.A2, targetId: b1 } });
    for (const mapping of mappings) {
      expect(await details.scan(mapping.id, admin)).toEqual({ queued: true });
      expect(await details.scan(mapping.id, admin)).toEqual({ queued: false });
    }
    await expect(details.scan(alternate.id, admin)).rejects.toThrow('đang nhận dữ liệu từ một nguồn khác');
    for (const payload of await jobs(Q.ProfileDetails)) await handleProfileDetails(h.browser, payload);
    for (const mapping of mappings) {
      const state = await details.get(mapping.id);
      expect(state.scan).toMatchObject({ status: 'READY', snapshot: { name: `Tên ${mapping.source.code}` } });
      expect(state.synced).toMatchObject({ sourceCode: mapping.source.code, requestId: state.scan!.requestId });
    }
    expect(reads).toEqual(['A1:public', 'A2:B2']);
    expect(await jobs(Q.ApplyProfileBio)).toHaveLength(0);
    const b1Scan = (await details.get(mappings[0].id)).scan!;
    await details.sync(mappings[0].id, { requestId: b1Scan.requestId, applyBio: true }, admin);
    for (const payload of await jobs(Q.ApplyProfileBio)) await handleApplyProfileBio(h.browser, payload);
    expect(savedBios).toEqual(['B1 Giới thiệu A1']);
    expect((await details.get(mappings[0].id)).scan?.bioStatus).toBe('DONE');
    expect((await personas.list(admin)).map(({ code, sourceCode }) => [code, sourceCode])).toEqual([['B1','A1'], ['B2','A2']]);
    expect(await personas.detail(b1, undefined, admin)).toMatchObject({ canComment: true, sourceProfile: { sourceCode: 'A1' } });
    expect(await personas.detail(b2, undefined, operator)).toMatchObject({ sourceProfile: null, context: { name: 'Tên A2', bio: 'Giới thiệu A2' } });
    await h.db.targetAccount.update({ where: { id: b2 }, data: { enabled: false } });
    await details.scan(mappings[1].id, admin);
    const publicJob = (await jobs(Q.ProfileDetails)).at(-1)!;
    await handleProfileDetails(h.browser, publicJob);
    expect(reads.at(-1)).toBe('A2:public');
    expect((await details.get(mappings[1].id)).synced?.requestId).toBe(publicJob.requestId);
    failSource = 'A2';
    await details.scan(mappings[1].id, admin);
    await handleProfileDetails(h.browser, (await jobs(Q.ProfileDetails)).at(-1)!);
    const failed = await details.get(mappings[1].id);
    expect(failed.scan?.status).toBe('FAILED');
    expect(failed.synced?.requestId).toBe(publicJob.requestId);
    await h.db.targetAccount.update({ where: { id: b1 }, data: { externalId: 'changed' } });
    expect(await personas.detail(b1, undefined, admin)).toMatchObject({ sourceProfile: null });
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

  it('reads the pasted post, generates editable assignments and only queues sending on explicit start', async () => {
    const previews = new CommentPreviewsController(h.db, h.clock, loadConfig({ DATABASE_URL: inject('pgAdminUrl'), LLM_MODE: 'claude' }));
    const scripts = new CommentScriptsController(h.db, h.clock);
    const postUrl = 'https://www.facebook.com/share/p/ReadMe/';
    const post = { url: photo, author: 'Tác giả thử nghiệm', caption: 'Hội sách ở Huế cuối tuần này.',
      capturedAt: h.clock.now().toISOString(), images: [] };
    const profile = { url: 'https://www.facebook.com/profile.php?id=20', name: 'Bạn đọc ở Huế',
      bio: 'Thích đọc và trao đổi sách', intro: ['Sống tại Huế'], sections: [], capturedAt: post.capturedAt };
    await h.db.targetAccount.update({ where: { id: b2 }, data: { profileDetails: {
      sourceCode: 'A2', targetExternalId: 'fb-B2', requestId: randomUUID(), syncedAt: post.capturedAt, snapshot: profile,
    } } });
    await h.db.targetBrowserRun.create({ data: { targetId: b2, kind: 'persona', status: 'DONE', results: {
      targetExternalId: 'fb-B2', profile, postWarning: null,
      posts: [{ id: '1', permalink: photo, caption: 'Một cuốn sách mới đọc', contentType: 'TEXT', postedAt: null, incomplete: [] }],
    } } });
    const read = vi.fn(async () => post);
    const send = vi.fn();
    h.browser.registry.addPublisher({ key: 'fb-web', version: 'test', capabilities: () => ({}), openSession: async target => {
      const session = await h.browser.registry.publisher('fake').openSession(target);
      session.readCommentPost = read;
      session.postComment = send;
      return session;
    } });
    const plan = vi.fn(async (_input: CommentPlanInput) => ({
      output: { name: 'Hội sách Huế', steps: [
        { persona: 'B2', text: 'Hội sách mở cửa lúc mấy giờ nhỉ?', replyTo: null },
        { persona: 'B1', text: 'Mình cũng đang tìm giờ mở cửa.', replyTo: 0 },
      ] },
      usage: [{ modelId: 'claude-test', inputTokens: 200, outputTokens: 60 }],
    }));
    const core = { ...h.core, llm: new LlmGateway(h.db, { modelId: 'claude-test', rewrite: h.editor.rewrite.bind(h.editor), planComments: plan },
      h.clock, { dailyBudgetUsd: 1, maxConcurrency: 1 }) };
    const { id } = await previews.create({ targetId: b1, postUrl });
    expect(await previews.create({ targetId: b1, postUrl })).toEqual({ id });
    expect(await previews.get(id)).toEqual({ status: 'QUEUED' });
    await expect(previews.generate(id, { request: 'Một bình luận và một phản hồi' })).rejects.toThrow('lấy nội dung bài');
    const [job] = await jobs(Q.TargetBrowser);
    await handleTargetBrowser(h.browser, job.runId, 'test-node', 0);
    await handleTargetBrowser(h.browser, job.runId, 'test-node', 1);
    expect(read).toHaveBeenCalledWith(new URL(postUrl));
    expect(read).toHaveBeenCalledTimes(1);
    const { images, ...text } = post;
    expect(await previews.get(id)).toEqual({ status: 'DONE', post: { ...text, previewId: id, imageCount: images.length } });

    const request = 'Một bình luận và một phản hồi';
    const generation = await previews.generate(id, { request });
    expect(await previews.generate(id, { request })).toEqual(generation);
    const [generate] = await jobs(Q.CommentScriptGenerate);
    await handleCommentScriptGeneration(core, generate.generationId);
    expect(plan).toHaveBeenCalledWith({ request, post: { caption: post.caption, author: post.author, images: [] },
      personas: [expect.objectContaining({ code: 'B1' }), { code: 'B2', name: profile.name, bio: profile.bio,
        intro: profile.intro, posts: ['Một cuốn sách mới đọc'], profile: null }] });
    const result = await previews.getGeneration(id, generation.id);
    expect(result).toMatchObject({ status: 'DONE', draft: { steps: [{ targetId: b2, replyTo: null }, { targetId: b1, replyTo: 0 }] } });
    expect(await h.db.llmUsage.count({ where: { refId: generation.id } })).toBe(1);
    const invalid = await previews.generate(id, { request: 'Một yêu cầu mới' });
    plan.mockResolvedValueOnce({ output: { name: 'Sai', steps: [{ persona: 'B99', text: 'Bình luận', replyTo: 0 }] }, usage: [] });
    await handleCommentScriptGeneration(core, invalid.id);
    expect(await previews.getGeneration(id, invalid.id)).toMatchObject({ status: 'FAILED' });

    if (!('draft' in result) || !result.draft) throw new Error('Expected generated draft');
    const input = { ...result.draft, postUrl, previewId: id };
    await expect(scripts.create({ ...input, postUrl: 'https://www.facebook.com/posts/987' }, operator)).rejects.toThrow('đúng liên kết');
    const { id: scriptId } = await scripts.create(input, operator);
    await scripts.edit(scriptId, { ...input, name: 'Hội sách cuối tuần', version: 1, previewId: undefined }, operator);
    expect(await scripts.get(scriptId)).toMatchObject({ postSnapshot: { ...post, previewId: id }, resolvedUrl: photo, startedAt: null,
      steps: [{ status: 'DRAFT', targetId: b2 }, { status: 'DRAFT', targetId: b1 }] });
    expect(await jobs(Q.CommentScriptStep)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
});
