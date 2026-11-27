import { z } from 'zod';

export const PROFILE_SCAN_TIMEOUT_MS = 5 * 60_000;
export const PROFILE_ABOUT_SECTIONS = [
  'overview', 'work_and_education', 'places', 'contact_and_basic_info', 'family_and_relationships', 'details', 'life_events',
] as const;

const aboutSection = z.object({
  key: z.enum(PROFILE_ABOUT_SECTIONS),
  status: z.enum(['VISIBLE', 'UNAVAILABLE']),
  categories: z.array(z.object({ label: z.string().min(1).max(250), values: z.array(z.string().min(1).max(2000)).max(100) })).max(30),
});

export const ProfileDetailsSnapshot = z.object({
  url: z.string().url(),
  name: z.string().min(1).max(250),
  facebookId: z.string().regex(/^\d+$/).optional(),
  bio: z.string().min(1).max(2000).optional(),
  intro: z.array(z.string().min(1).max(2000)).max(40),
  sections: z.array(aboutSection).max(PROFILE_ABOUT_SECTIONS.length),
  capturedAt: z.string().datetime(),
});
export type ProfileDetailsSnapshot = z.infer<typeof ProfileDetailsSnapshot>;

export const SyncedProfileDetails = z.object({
  sourceCode: z.string(),
  targetExternalId: z.string(),
  requestId: z.string().uuid(),
  syncedAt: z.string().datetime(),
  snapshot: ProfileDetailsSnapshot,
});
export type SyncedProfileDetails = z.infer<typeof SyncedProfileDetails>;
