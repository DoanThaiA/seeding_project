ALTER TABLE "comment_scripts" ADD COLUMN "post_snapshot" JSONB;

CREATE TABLE "comment_script_generations" (
    "id" UUID NOT NULL,
    "preview_id" UUID NOT NULL,
    "request" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "comment_script_generations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "comment_script_generations_preview_id_fkey" FOREIGN KEY ("preview_id") REFERENCES "target_browser_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "comment_script_generations_preview_id_created_at_idx" ON "comment_script_generations"("preview_id", "created_at");
