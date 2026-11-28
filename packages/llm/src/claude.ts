import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { CAPTION_SYSTEM, COMMENT_PLAN_SYSTEM, EXTRACT_SYSTEM, PERSONA_INSIGHT_SYSTEM, PROMPT_VERSION, renderSource } from './prompts';
import { CaptionSchema, CommentPlanSchema, FactsSchema, LlmRefusalError, PersonaInsightSchema, type CommentPlan, type CommentPlanInput,
  type LlmEditor, type PersonaInsight, type PersonaInsightInput, type RewriteInput, type RewriteOutput, type Usage } from './types';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Two-step editor on the Claude API: extract facts, then write the caption.
 * - Structured outputs (output_config.format) so responses always match the schema.
 * - Server-side refusal fallback enabled ("default" routing); a final refusal → NEEDS_REVIEW.
 * - Adaptive thinking is always on for Claude Opus 5.5; depth is controlled with `effort`.
 */
export class ClaudeEditor implements LlmEditor {
  private readonly client: Anthropic;

  constructor(
    readonly modelId: string,
    private readonly opts: { apiKey?: string; maxTokens: number; effort: Effort },
  ) {
    // Without an explicit key the SDK resolves ANTHROPIC_API_KEY / auth token / `ant auth login` profile.
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), maxRetries: 2, timeout: 120_000 });
  }

  private async call<T>(system: string, user: Anthropic.MessageParam['content'],
    format: ReturnType<typeof betaZodOutputFormat<any>>): Promise<{ parsed: T; usage: Usage }> {
    const res = await this.client.beta.messages.parse({
      model: this.modelId,
      max_tokens: this.opts.maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      output_config: { effort: this.opts.effort, format },
      messages: [{ role: 'user', content: user }],
    });
    const usage: Usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, modelId: res.model };
    if (res.stop_reason === 'refusal') {
      throw new LlmRefusalError(`model declined (${res.stop_details?.category ?? 'unknown'})`);
    }
    if (res.stop_reason === 'max_tokens' || res.parsed_output == null) {
      throw new Error(`LLM output not parseable (stop_reason=${res.stop_reason})`);
    }
    return { parsed: res.parsed_output as T, usage };
  }

  async planComments(input: CommentPlanInput) {
    // Ảnh của bài đi kèm dạng khối ảnh; JSON chỉ chứa chữ nên không phình ra vì base64.
    const { images = [], ...post } = input.post;
    const content: Anthropic.MessageParam['content'] = [
      ...images.map(image => ({ type: 'image' as const,
        source: { type: 'base64' as const, media_type: image.mime, data: image.data } })),
      { type: 'text' as const, text: JSON.stringify({ ...input, post: { ...post, imageCount: images.length } }) },
    ];
    const { parsed, usage } = await this.call<CommentPlan>(COMMENT_PLAN_SYSTEM, content, betaZodOutputFormat(CommentPlanSchema));
    return { output: parsed, usage: [usage] };
  }

  async summarizePersona(input: PersonaInsightInput) {
    const { parsed, usage } = await this.call<PersonaInsight>(PERSONA_INSIGHT_SYSTEM, JSON.stringify(input), betaZodOutputFormat(PersonaInsightSchema));
    return { output: parsed, usage: [usage] };
  }

  async rewrite(input: RewriteInput): Promise<{ output: RewriteOutput; usage: Usage[] }> {
    const src = renderSource(input);
    const step1 = await this.call<{ facts_to_preserve: string[]; attribution: string | null; is_quote: boolean; review_reasons: string[] }>(
      EXTRACT_SYSTEM,
      src,
      betaZodOutputFormat(FactsSchema),
    );
    const step2 = await this.call<{ caption: string; review_reasons: string[] }>(
      CAPTION_SYSTEM,
      [
        src,
        `<facts_to_preserve>${JSON.stringify(step1.parsed.facts_to_preserve)}</facts_to_preserve>`,
        `<attribution>${step1.parsed.attribution ?? ''}</attribution>`,
        `<is_quote>${step1.parsed.is_quote}</is_quote>`,
        `<target_style>${JSON.stringify(input.targetStyle)}</target_style>`,
      ].join('\n'),
      betaZodOutputFormat(CaptionSchema),
    );
    return {
      output: {
        caption: step2.parsed.caption,
        facts_to_preserve: step1.parsed.facts_to_preserve,
        attribution: step1.parsed.attribution,
        review_reasons: [...step1.parsed.review_reasons, ...step2.parsed.review_reasons],
        prompt_version: PROMPT_VERSION,
        model_id: step2.usage.modelId,
      },
      usage: [step1.usage, step2.usage],
    };
  }
}
