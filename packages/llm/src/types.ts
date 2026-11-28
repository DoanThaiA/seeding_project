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

export const CommentPlanSchema = z.object({
  name: z.string(),
  steps: z.array(z.object({
    persona: z.string().describe('One of the supplied persona codes'),
    text: z.string(),
    replyTo: z.number().int().nullable().describe('Zero-based index of an earlier step, or null for a top-level comment'),
  })),
});
export type CommentPlan = z.infer<typeof CommentPlanSchema>;

export const PersonaInsightSchema = z.object({
  occupation: z.string().nullable().describe('Main job or role in Vietnamese, null when the material does not show it'),
  gender: z.enum(['MALE', 'FEMALE', 'UNKNOWN']),
  ageRange: z.string().nullable().describe('Age band such as "25-35", null when unclear'),
  location: z.string().nullable().describe('Where they live or work, null when unclear'),
  interests: z.array(z.string()).describe('Observable interests in Vietnamese, a few words each'),
  traits: z.array(z.string()).describe('Observable personality traits in Vietnamese, a few words each'),
  voice: z.string().nullable().describe('How this account writes: tone, emoji, sentence length'),
  topics: z.array(z.string()).describe('What this account can credibly comment on'),
  avoid: z.array(z.string()).describe('What it must not claim as its own experience'),
  summary: z.string().describe('2 to 3 Vietnamese sentences about this person'),
  confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
});
export type PersonaInsight = z.infer<typeof PersonaInsightSchema>;

export interface PersonaInsightInput {
  code: string;
  name: string;
  bio: string | null;
  intro: string[];
  about: { label: string; values: string[] }[];
  posts: { caption: string; postedAt: string | null; contentType: string }[];
}

/** Kiểu ảnh Claude nhận trực tiếp. */
export type PostImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface CommentPlanInput {
  request: string;
  post: { caption: string; author: string | null; images?: Array<{ mime: PostImageMime; data: string }> };
  personas: { code: string; name: string; bio: string | null; intro: string[]; posts: string[];
    profile: PersonaInsight | null }[];
}

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
  planComments?(input: CommentPlanInput): Promise<{ output: CommentPlan; usage: Usage[] }>;
  summarizePersona?(input: PersonaInsightInput): Promise<{ output: PersonaInsight; usage: Usage[] }>;
}

export class LlmRefusalError extends Error {}
export class LlmBudgetExceededError extends Error {}
export class LlmUnavailableError extends Error {}
