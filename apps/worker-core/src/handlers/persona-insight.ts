import { PERSONA_INSIGHT_KIND, PERSONA_INSIGHT_MS, PERSONA_INSIGHT_POSTS, PersonaInsightRecord, PersonaWallSnapshot,
  SUCCESS, SyncedProfileDetails } from '@seedingsys/contracts';
import { json } from '@seedingsys/db';
import { LlmBudgetExceededError, LlmRefusalError, LlmUnavailableError, PERSONA_PROMPT_VERSION } from '@seedingsys/llm';
import type { CoreCtx } from '../ctx';

/** Mục About đưa vào prompt: đủ để suy đoán nghề nghiệp, nơi sống, hoàn cảnh. */
const ABOUT_SECTIONS = ['overview', 'work_and_education', 'places', 'family_and_relationships', 'details'];

/**
 * Suy đoán hồ sơ nhân vật (nghề nghiệp, giới tính, nơi sống, tính cách…) từ hồ sơ đã lưu và
 * tối đa PERSONA_INSIGHT_POSTS bài của chính tài khoản B. Kết quả nằm trong lượt chạy
 * TargetBrowserRun kind = PERSONA_INSIGHT_KIND để phần gán bình luận đọc lại.
 */
export async function handlePersonaInsight({ db, clock, llm, log }: CoreCtx, runId: string, retryCount = 0) {
  const where = { id: runId };
  if (retryCount) {
    await db.targetBrowserRun.updateMany({ where: { ...where, status: 'RUNNING' },
      data: { status: 'FAILED', message: 'Lượt tóm tắt bị gián đoạn. Bạn có thể thử lại.' } });
  }
  const claimed = await db.targetBrowserRun.updateMany({ where: { ...where, status: 'QUEUED' }, data: { status: 'RUNNING' } });
  if (!claimed.count) return;
  const finish = (data: { status: string; message?: string; results?: ReturnType<typeof json> }) =>
    db.targetBrowserRun.updateMany({ where: { ...where, status: 'RUNNING' }, data });
  try {
    const run = await db.targetBrowserRun.findUniqueOrThrow({ where, include: { target: { select: {
      id: true, code: true, name: true, externalId: true, profileDetails: true,
      browserRuns: { where: { kind: 'persona', status: 'DONE' }, orderBy: { createdAt: 'desc' }, take: 5, select: { results: true } },
      publications: { where: { status: { in: [...SUCCESS] } }, orderBy: { createdAt: 'desc' }, take: PERSONA_INSIGHT_POSTS,
        select: { contentType: true, verifiedAt: true, committedAt: true, variant: { select: { caption: true } } } },
    } } } });
    if (+clock.now() - +run.createdAt >= PERSONA_INSIGHT_MS) {
      await finish({ status: 'FAILED', message: 'Lượt tóm tắt đã hết thời gian.' });
      return;
    }
    const target = run.target;
    const saved = SyncedProfileDetails.safeParse(target.profileDetails).data;
    const profile = saved?.targetExternalId === target.externalId ? saved.snapshot : null;
    const wall = target.browserRuns.map(item => PersonaWallSnapshot.safeParse(item.results).data)
      .find(snapshot => snapshot?.targetExternalId === target.externalId && snapshot.posts.length);
    // Bài của chính nhân vật là bằng chứng tốt nhất; chưa quét được thì dùng bài đã đăng qua SeedingSys.
    const posts = wall
      ? wall.posts.slice(0, PERSONA_INSIGHT_POSTS).map(post => ({ caption: post.caption, postedAt: post.postedAt, contentType: post.contentType }))
      : target.publications.map(post => ({ caption: post.variant.caption ?? '',
        postedAt: (post.verifiedAt ?? post.committedAt)?.toISOString() ?? null, contentType: post.contentType }));
    const usable = posts.filter(post => post.caption.trim()).map(post => ({ ...post, caption: post.caption.slice(0, 1200) }));
    if (!profile && !usable.length) {
      await finish({ status: 'FAILED', message: 'Chưa có hồ sơ đã lưu hay bài viết nào của nhân vật này để suy đoán.' });
      return;
    }
    const about = (profile?.sections ?? [])
      .filter(section => section.status === 'VISIBLE' && ABOUT_SECTIONS.includes(section.key))
      .flatMap(section => section.categories.map(category => ({ label: category.label.slice(0, 120),
        values: category.values.slice(0, 6).map(value => value.slice(0, 300)) })))
      .slice(0, 20);
    const insight = await llm.summarizePersona({
      code: target.code,
      name: (profile?.name ?? target.name).slice(0, 160),
      bio: profile?.bio?.slice(0, 1000) ?? null,
      intro: (profile?.intro ?? []).slice(0, 8).map(item => item.slice(0, 300)),
      about,
      posts: usable,
    }, runId);
    const record = PersonaInsightRecord.safeParse({ ...insight, targetExternalId: target.externalId,
      basedOnPosts: usable.length, usedProfile: !!profile, modelId: llm.modelId ?? 'unknown',
      promptVersion: PERSONA_PROMPT_VERSION, generatedAt: clock.now().toISOString() });
    if (!record.success) {
      await finish({ status: 'FAILED', message: 'AI trả về bản tóm tắt không hợp lệ. Hãy thử lại.' });
      return;
    }
    const parts = [record.data.occupation, record.data.location].filter(Boolean).join(' · ');
    await finish({ status: 'DONE', results: json(record.data),
      message: `Đã tóm tắt từ ${usable.length} bài${profile ? ' và hồ sơ đã lưu' : ''}${parts ? ` · ${parts}` : ''}` });
  } catch (error) {
    const message = error instanceof LlmBudgetExceededError ? 'Đã hết ngân sách AI hôm nay.'
      : error instanceof LlmRefusalError ? 'AI từ chối tóm tắt hồ sơ này.'
      : error instanceof LlmUnavailableError ? 'Worker-core chưa được cấu hình LLM thật.'
      : 'AI chưa tóm tắt được hồ sơ. Kiểm tra kết nối Claude trên worker-core hoặc thử lại.';
    log.warn({ runId, errorType: error instanceof Error ? error.name : 'Unknown' }, 'persona summary failed');
    await finish({ status: 'FAILED', message });
  }
}
