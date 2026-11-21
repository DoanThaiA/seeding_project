import { extractNumericTokens } from '@seedingsys/domain';
import { PROMPT_VERSION } from './prompts';
import type { LlmEditor, RewriteInput, RewriteOutput, Usage } from './types';

/**
 * Deterministic offline editor for local dev and CI. It keeps the source text and wraps it with
 * the target's style prefix/suffix, so validation passes and tests are reproducible.
 * Add "[[llm:fail]]" / "[[llm:flag]]" to a source text to simulate failures.
 */
export class FakeEditor implements LlmEditor {
  readonly modelId = 'fake-editor';
  calls = 0;

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
