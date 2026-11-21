-- Duplicate protection for collected posts.
-- 1. One post can be read under several platform ids (Facebook rotates a post's pfbid): aliases.
-- 2. One content (caption + media bytes) reaches a target account once: revision content keys and
--    a DUPLICATE variant state for copies that another source post already holds.

ALTER TYPE "VariantStatus" ADD VALUE IF NOT EXISTS 'DUPLICATE';

CREATE TABLE "source_post_aliases" (
  "source_id" UUID NOT NULL REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "external_id" TEXT NOT NULL,
  "source_post_id" UUID NOT NULL REFERENCES "source_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("source_id", "external_id")
);
CREATE INDEX "source_post_aliases_source_post_id_idx" ON "source_post_aliases"("source_post_id");

CREATE INDEX "source_posts_source_id_posted_at_idx" ON "source_posts"("source_id", "posted_at");

-- NULL = not computed yet (worker-core fills it in), '' = nothing to compare.
ALTER TABLE "source_post_revisions" ADD COLUMN "content_key" TEXT;
CREATE INDEX "source_post_revisions_content_key_idx" ON "source_post_revisions"("content_key");
-- extra (not expressible in Prisma): finds revisions still waiting for a key.
CREATE INDEX "source_post_revisions_content_key_pending" ON "source_post_revisions"("id")
  WHERE "content_key" IS NULL AND "media_status" IN ('READY', 'NOT_REQUIRED');
