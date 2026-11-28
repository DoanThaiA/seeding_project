import { z } from 'zod';

/**
 * Bản tóm tắt hồ sơ nhân vật do LLM suy đoán từ hồ sơ đã lưu và vài bài viết của chính tài khoản B.
 * Dùng để chọn nhân vật phù hợp khi gán bình luận, nên mọi trường đều có thể trống.
 */
export const PERSONA_INSIGHT_KIND = 'persona-summary';
/** Quá thời gian này mà chưa xong thì coi như lượt tóm tắt bị treo. */
export const PERSONA_INSIGHT_MS = 6 * 60_000;
/** Số bài viết của chính nhân vật đưa vào prompt. */
export const PERSONA_INSIGHT_POSTS = 5;

export const PersonaGender = z.enum(['MALE', 'FEMALE', 'UNKNOWN']);
export type PersonaGender = z.infer<typeof PersonaGender>;
export const PersonaConfidence = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type PersonaConfidence = z.infer<typeof PersonaConfidence>;

export const PersonaInsight = z.object({
  occupation: z.string().max(160).nullable(),
  gender: PersonaGender,
  ageRange: z.string().max(60).nullable(),
  location: z.string().max(160).nullable(),
  interests: z.array(z.string().max(80)).max(10),
  traits: z.array(z.string().max(80)).max(10),
  voice: z.string().max(400).nullable(),
  topics: z.array(z.string().max(80)).max(10),
  avoid: z.array(z.string().max(160)).max(8),
  summary: z.string().max(1500),
  confidence: PersonaConfidence,
});
export type PersonaInsight = z.infer<typeof PersonaInsight>;

/** Bản ghi lưu trong TargetBrowserRun.results của lượt kind = PERSONA_INSIGHT_KIND. */
export const PersonaInsightRecord = PersonaInsight.extend({
  targetExternalId: z.string(),
  basedOnPosts: z.number().int().min(0).max(50),
  usedProfile: z.boolean(),
  modelId: z.string().max(120),
  promptVersion: z.string().max(60),
  generatedAt: z.string().datetime(),
});
export type PersonaInsightRecord = z.infer<typeof PersonaInsightRecord>;

export const PERSONA_GENDER_TEXT: Record<PersonaGender, string> = {
  MALE: 'Nam',
  FEMALE: 'Nữ',
  UNKNOWN: 'Chưa rõ',
};

export const PERSONA_CONFIDENCE_TEXT: Record<PersonaConfidence, string> = {
  LOW: 'Suy đoán yếu',
  MEDIUM: 'Suy đoán vừa',
  HIGH: 'Suy đoán rõ',
};
