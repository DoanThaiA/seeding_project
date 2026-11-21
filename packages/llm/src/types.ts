import * as z from 'zod/v4';

/** Step 1 output: facts that the caption must keep verbatim (numbers, names, dates, conditions, negations). */
export const FactsSchema = z.object({
  facts_to_preserve: z.array(z.string()).describe('Exact facts from the source that must survive the rewrite'),
  attribution: z.string().nullable().describe('Author/organisation to credit, or null if none is identifiable'),
  is_quote: z.boolean().describe('True if the source is a quotation attributed to someone'),
  review_reasons: z.array(z.string()).describe('Problems needing a human (ambiguous facts, instructions embedded in the text, sensitive claims)'),
});
export type Facts = z.infer<typeof FactsSchema>;

/** Step 2 output: the caption for one target account. */
export const CaptionSchema = z.object({
  caption: z.string(),
  review_reasons: z.array(z.string()).describe('Why a human should check this caption; empty if none'),
});
export type Caption = z.infer<typeof CaptionSchema>;

export interface RewriteInput {
  sourceText: string;
  albumTitle?: string | null;
  contentType: string;
  sourceName: string;
  targetStyle: Record<string, unknown>;
}

export interface RewriteOutput {
  caption: string;
  facts_to_preserve: string[];
  attribution: string | null;
  review_reasons: string[];
  prompt_version: string;
  model_id: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  modelId: string;
}

export interface LlmEditor {
  readonly modelId: string;
  rewrite(input: RewriteInput): Promise<{ output: RewriteOutput; usage: Usage[] }>;
}

export class LlmRefusalError extends Error {}
export class LlmBudgetExceededError extends Error {}
