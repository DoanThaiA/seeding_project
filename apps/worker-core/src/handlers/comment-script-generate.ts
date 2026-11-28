import { COMMENT_GENERATION_MS, COMMENT_PREVIEW_KIND, CommentPostSnapshot, GeneratedCommentDraft, PERSONA_INSIGHT_KIND,
  PersonaInsightRecord, PersonaWallSnapshot, SUCCESS, SyncedProfileDetails } from '@seedingsys/contracts';
import { json } from '@seedingsys/db';
import { LlmBudgetExceededError, LlmRefusalError, LlmUnavailableError } from '@seedingsys/llm';
import type { CoreCtx } from '../ctx';

export async function handleCommentScriptGeneration({ db, clock, llm, log }: CoreCtx, id: string, retryCount = 0) {
  if (retryCount) {
    await db.commentScriptGeneration.updateMany({ where: { id, status: 'RUNNING' },
      data: { status: 'FAILED', error: 'Lượt tạo bằng AI bị gián đoạn. Bạn có thể thử lại.' } });
  }
  const claimed = await db.commentScriptGeneration.updateMany({ where: { id, status: 'QUEUED' }, data: { status: 'RUNNING' } });
  if (!claimed.count) return;
  const finish = (data: { status: string; error?: string; result?: ReturnType<typeof json> }) =>
    db.commentScriptGeneration.updateMany({ where: { id, status: 'RUNNING' }, data });
  try {
    const generation = await db.commentScriptGeneration.findUniqueOrThrow({ where: { id }, include: { preview: true } });
    if (+clock.now() - +generation.createdAt >= COMMENT_GENERATION_MS) {
      await finish({ status: 'FAILED', error: 'Lượt tạo kịch bản đã hết thời gian.' });
      return;
    }
    const { preview, request } = generation;
    const post = CommentPostSnapshot.safeParse(preview.results).data;
    if (!post || preview.kind !== COMMENT_PREVIEW_KIND || preview.status !== 'DONE') {
      await finish({ status: 'FAILED', error: 'Hãy lấy lại nội dung bài Facebook.' });
      return;
    }
    const targets = await db.targetAccount.findMany({
      where: { enabled: true, connector: 'fb-web', profile: { isNot: null } },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, externalId: true, profileDetails: true,
        browserRuns: { where: { kind: { in: ['persona', PERSONA_INSIGHT_KIND] }, status: 'DONE' },
          orderBy: { createdAt: 'desc' }, take: 10, select: { kind: true, results: true } },
        publications: { where: { status: { in: [...SUCCESS] } }, orderBy: { createdAt: 'desc' }, take: 2,
          select: { variant: { select: { caption: true } } } },
      },
    });
    if (!targets.length) {
      await finish({ status: 'FAILED', error: 'Cần ít nhất một hồ sơ B đang bật và đã cấu hình phiên Facebook.' });
      return;
    }
    const personas = targets.map(target => {
      const saved = SyncedProfileDetails.safeParse(target.profileDetails).data;
      const profile = saved?.targetExternalId === target.externalId ? saved.snapshot : null;
      const wall = target.browserRuns.filter(run => run.kind === 'persona')
        .map(run => PersonaWallSnapshot.safeParse(run.results).data)
        .find(snapshot => snapshot?.targetExternalId === target.externalId && snapshot.posts.length);
      // Bản tóm tắt AI giúp AI chọn đúng nhân vật cho từng bình luận.
      const insight = target.browserRuns.filter(run => run.kind === PERSONA_INSIGHT_KIND)
        .map(run => PersonaInsightRecord.safeParse(run.results).data)
        .find(record => record?.targetExternalId === target.externalId) ?? null;
      const posts = wall?.posts.map(post => post.caption) ?? target.publications.map(row => row.variant.caption ?? '');
      return { code: target.code, name: (profile?.name ?? target.name).slice(0, 160),
        bio: profile?.bio?.slice(0, 300) ?? null, intro: profile?.intro.slice(0, 3).map(item => item.slice(0, 160)) ?? [],
        posts: posts.filter(caption => caption.trim()).slice(0, 2).map(caption => caption.slice(0, 400)),
        profile: insight ? { occupation: insight.occupation, gender: insight.gender, ageRange: insight.ageRange,
          location: insight.location, interests: insight.interests, traits: insight.traits, voice: insight.voice,
          topics: insight.topics, avoid: insight.avoid, summary: insight.summary, confidence: insight.confidence } : null,
      };
    });
    const output = await llm.planComments({ request,
      post: { caption: post.caption, author: post.author, images: post.images }, personas }, id);
    const targetIds = new Map(targets.map(target => [target.code, target.id]));
    const draft = GeneratedCommentDraft.safeParse({ name: output.name,
      steps: output.steps.map(step => ({ targetId: targetIds.get(step.persona), text: step.text, replyTo: step.replyTo })) }).data;
    if (!draft || draft.steps.some((step, index) => step.replyTo !== null && step.replyTo >= index) ||
      new Set(draft.steps.map(step => step.text.normalize('NFC').replace(/\s+/g, ' ').toLowerCase())).size !== draft.steps.length) {
      await finish({ status: 'FAILED', error: 'AI trả về nhân vật, nội dung hoặc nhánh trả lời không hợp lệ. Hãy thử tạo lại.' });
      return;
    }
    await finish({ status: 'DONE', result: json(draft) });
  } catch (error) {
    const message = error instanceof LlmBudgetExceededError ? 'Đã hết ngân sách AI hôm nay.'
      : error instanceof LlmRefusalError ? 'AI từ chối yêu cầu này. Hãy điều chỉnh yêu cầu hoặc soạn thủ công.'
      : error instanceof LlmUnavailableError ? 'Worker-core chưa được cấu hình LLM thật.'
      : 'AI chưa tạo được bản nháp. Kiểm tra kết nối Claude trên worker-core hoặc thử lại.';
    log.warn({ generationId: id, errorType: error instanceof Error ? error.name : 'Unknown' }, 'comment script generation failed');
    await finish({ status: 'FAILED', error: message });
  }
}
