ALTER TABLE "source_posts"
  ADD COLUMN "archived_at" TIMESTAMPTZ(3),
  ADD COLUMN "archived_by" TEXT;

CREATE TYPE "ProfileSyncPhase" AS ENUM ('DISCOVERING', 'PREPARING', 'PREPARED', 'FAILED');

CREATE TABLE "profile_syncs" (
  "id" UUID NOT NULL PRIMARY KEY,
  "mapping_id" UUID NOT NULL REFERENCES "source_target_mappings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "phase" "ProfileSyncPhase" NOT NULL,
  "step" INTEGER NOT NULL DEFAULT 0,
  "history" BOOLEAN NOT NULL,
  "history_done" BOOLEAN NOT NULL DEFAULT false,
  "history_cursor" TEXT,
  "archive_cursor" UUID,
  "captured_until" TIMESTAMPTZ(3) NOT NULL,
  "detail" TEXT,
  "requested_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "profile_syncs_mapping_id_created_at_idx" ON "profile_syncs"("mapping_id","created_at");
CREATE UNIQUE INDEX "profile_syncs_one_active_per_mapping" ON "profile_syncs"("mapping_id")
  WHERE "phase" IN ('DISCOVERING','PREPARING');

CREATE TABLE "profile_sync_items" (
  "sync_id" UUID NOT NULL REFERENCES "profile_syncs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "source_post_id" UUID NOT NULL REFERENCES "source_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "prepared_variant_id" UUID REFERENCES "content_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "comment_scan_id" UUID REFERENCES "comment_scans"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  PRIMARY KEY ("sync_id","source_post_id")
);
