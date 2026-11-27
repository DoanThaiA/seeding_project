import { z } from 'zod';

export const ProfilePhotoKind = z.enum(['avatar', 'cover']);
export type ProfilePhotoKind = z.infer<typeof ProfilePhotoKind>;

export const ArtworkImage = z.object({
  objectKey: z.string().regex(/^assets\/original\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/),
  mime: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
  photoId: z.string().regex(/^\d+$/),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  size: z.number().int().positive().max(25 * 1024 * 1024),
});

export const ArtworkImages = z.object({ avatar: ArtworkImage, cover: ArtworkImage });
export const ARTWORK_IMAGE_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' } as const;
