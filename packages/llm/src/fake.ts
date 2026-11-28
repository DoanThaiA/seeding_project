import { extractNumericTokens } from '@seedingsys/domain';
import { PROMPT_VERSION } from './prompts';
import type { LlmEditor, PersonaInsight, PersonaInsightInput, RewriteInput, RewriteOutput, Usage } from './types';

/**
 * Deterministic offline editor for local dev and CI. It keeps the source text and wraps it with
 * the target's style prefix/suffix, so validation passes and tests are reproducible.
 * Add "[[llm:fail]]" / "[[llm:flag]]" to a source text to simulate failures.
 */
export class FakeEditor implements LlmEditor {
  readonly modelId = 'fake-editor';
  calls = 0;

  /** Bản tóm tắt giả: chỉ lặp lại dữ liệu có thật để test không phụ thuộc mạng. */
  async summarizePersona(input: PersonaInsightInput): Promise<{ output: PersonaInsight; usage: Usage[] }> {
    this.calls++;
    const lines = [input.bio, ...input.intro, ...input.about.flatMap(item => item.values)].filter((item): item is string => !!item);
    const summary = `Hồ sơ ${input.name} (${input.code}): ${lines.slice(0, 3).join(' · ') || 'chưa có thông tin đã lưu'}.`;
    return {
      output: {
        occupation: lines[0]?.slice(0, 120) ?? null,
        gender: 'UNKNOWN',
        ageRange: null,
        location: null,
        interests: [],
        traits: [],
        voice: null,
        topics: input.posts.length ? ['bài đã đăng của chính nhân vật'] : [],
        avoid: [],
        summary: summary.slice(0, 1400),
        confidence: lines.length ? 'MEDIUM' : 'LOW',
      },
      usage: [{ inputTokens: Math.ceil(summary.length / 3), outputTokens: Math.ceil(summary.length / 3), modelId: this.modelId }],
    };
  }

  async rewrite(input: RewriteInput): Promise<{ output: RewriteOutput; usage: Usage[] }> {
    this.calls++;
    if (input.sourceText.includes('[[llm:fail]]')) throw new Error('fake LLM failure');
    const style = input.targetStyle as { prefix?: string; suffix?: string };
    const body = input.sourceText.replace('[[llm:flag]]', '').trim();
    const caption = [style.prefix, body, style.suffix, `(Nguồn: ${input.sourceName})`].filter(Boolean).join('\n\n');
    return {
      output: {
        caption,
        facts_to_preserve: extractNumericTokens(body),
        attribution: input.sourceName,
        review_reasons: input.sourceText.includes('[[llm:flag]]') ? ['flagged_by_fake_llm'] : [],
        prompt_version: PROMPT_VERSION,
        model_id: this.modelId,
      },
      usage: [{ inputTokens: Math.ceil(body.length / 3), outputTokens: Math.ceil(caption.length / 3), modelId: this.modelId }],
    };
  }
}
