ALTER TABLE "profile_artwork"
  ADD COLUMN "apply_id" UUID,
  ADD COLUMN "apply_status" TEXT NOT NULL DEFAULT 'IDLE'
    CHECK ("apply_status" IN ('IDLE','QUEUED','RUNNING','COMMITTING','DONE','FAILED','NEEDS_CHECK')),
  ADD COLUMN "apply_updated_at" TIMESTAMPTZ(3),
  ADD COLUMN "apply_error" TEXT,
  ADD COLUMN "apply_kind" TEXT CHECK ("apply_kind" IN ('avatar','cover')),
  ADD COLUMN "prior_photo_id" TEXT,
  ADD COLUMN "applied_avatar_id" TEXT,
  ADD COLUMN "applied_cover_id" TEXT;
