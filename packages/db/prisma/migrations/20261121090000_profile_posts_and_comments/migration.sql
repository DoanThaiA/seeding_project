CREATE TYPE "CommentScanStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED');
CREATE TYPE "CommentReplayStatus" AS ENUM ('DRAFT', 'APPROVED', 'POSTED', 'OMITTED');
ALTER TABLE "sources" ADD COLUMN "collect_comments" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "source_posts_source_id_first_seen_at_id_idx" ON "source_posts" ("source_id", "first_seen_at", "id");
CREATE INDEX "content_variants_source_post_target_created_idx" ON "content_variants" ("source_post_id", "target_id", "created_at" DESC);

CREATE TABLE "comment_scans" (
    "id" UUID NOT NULL PRIMARY KEY,
    "source_post_id" UUID NOT NULL REFERENCES "source_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "status" "CommentScanStatus" NOT NULL DEFAULT 'QUEUED',
    "read_count" INTEGER NOT NULL DEFAULT 0,
    "expected_count" INTEGER,
    "detail" TEXT,
    "requested_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "comment_scans_source_post_id_created_at_idx" ON "comment_scans" ("source_post_id", "created_at");

CREATE TABLE "source_comments" (
    "id" UUID NOT NULL PRIMARY KEY,
    "source_post_id" UUID NOT NULL REFERENCES "source_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "external_id" TEXT NOT NULL,
    "parent_external_id" TEXT,
    "text" TEXT NOT NULL,
    "author_name" TEXT,
    "permalink" TEXT,
    "posted_at" TIMESTAMPTZ(3),
    "position" INTEGER NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE UNIQUE INDEX "source_comments_source_post_id_external_id_key" ON "source_comments" ("source_post_id", "external_id");
CREATE INDEX "source_comments_source_post_id_position_id_idx" ON "source_comments" ("source_post_id", "position", "id");

CREATE TABLE "publication_comments" (
    "id" UUID NOT NULL PRIMARY KEY,
    "destination_id" UUID NOT NULL REFERENCES "target_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "source_comment_id" UUID NOT NULL REFERENCES "source_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "author_target_id" UUID REFERENCES "target_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    "text" TEXT NOT NULL,
    "status" "CommentReplayStatus" NOT NULL DEFAULT 'DRAFT',
    "external_id" TEXT,
    "permalink" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE UNIQUE INDEX "publication_comments_destination_id_source_comment_id_key" ON "publication_comments" ("destination_id", "source_comment_id");
CREATE UNIQUE INDEX "publication_comments_destination_id_external_id_key" ON "publication_comments" ("destination_id", "external_id");
CREATE INDEX "publication_comments_destination_id_status_idx" ON "publication_comments" ("destination_id", "status");
