import { z } from 'zod';

export const COMMENT_PREVIEW_KIND = 'comment-post-preview';
export const COMMENT_PREVIEW_MS = 4 * 60_000;
export const COMMENT_GENERATION_MS = 8 * 60_000;
/** Số ảnh của bài gửi kèm cho LLM, và kích thước tối đa mỗi ảnh (byte gốc). */
export const COMMENT_POST_IMAGES = 3;
export const COMMENT_POST_IMAGE_BYTES = 900_000;
export const COMMENT_POST_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** Ảnh của bài, lưu base64 để gửi thẳng cho LLM cùng với caption. */
export const CommentPostImage = z.object({
  mime: z.enum(COMMENT_POST_IMAGE_MIME),
  data: z.string().min(1).max(1_400_000),
});
export type CommentPostImage = z.infer<typeof CommentPostImage>;

export const CommentPostSnapshot = z.object({
  previewId: z.string().uuid().optional(),
  url: z.string().url(),
  caption: z.string().max(65_536),
  author: z.string().max(250).nullable(),
  // Bản lấy bài cũ không có ảnh, nên mặc định rỗng để vẫn đọc lại được.
  images: z.array(CommentPostImage).max(COMMENT_POST_IMAGES).default([]),
  capturedAt: z.string().datetime(),
});
export type CommentPostSnapshot = z.infer<typeof CommentPostSnapshot>;

export const GeneratedCommentDraft = z.object({
  name: z.string().trim().min(1).max(120),
  steps: z.array(z.object({
    targetId: z.string().uuid(),
    text: z.string().trim().min(1).max(8000),
    replyTo: z.number().int().min(0).nullable(),
  })).min(1).max(50),
});
export type GeneratedCommentDraft = z.infer<typeof GeneratedCommentDraft>;
