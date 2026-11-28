CREATE TABLE "source_profile_scans" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "source_ref" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "reset_generation" INTEGER NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'PROFILE',
    "snapshot" JSONB,
    "artwork" JSONB,
    "profile_issue" TEXT,
    "artwork_issue" TEXT,
    "history_complete" BOOLEAN NOT NULL DEFAULT false,
    "history_issue" TEXT,
    "requested_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "source_profile_scans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "source_profile_scans_source_id_fkey" FOREIGN KEY ("source_id")
        REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "source_profile_scans_source_id_created_at_idx" ON "source_profile_scans"("source_id", "created_at");
ALTER TABLE "comment_scans" ADD COLUMN "source_profile_scan_id" UUID;
ALTER TABLE "comment_scans" ADD CONSTRAINT "comment_scans_source_profile_scan_id_fkey"
    FOREIGN KEY ("source_profile_scan_id") REFERENCES "source_profile_scans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "comment_scans_source_profile_scan_id_source_post_id_key"
    ON "comment_scans"("source_profile_scan_id", "source_post_id");
ALTER TABLE "source_comments" ADD COLUMN "archive_only" BOOLEAN NOT NULL DEFAULT false;
