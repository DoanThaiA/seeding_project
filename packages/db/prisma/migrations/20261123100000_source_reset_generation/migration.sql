ALTER TABLE "sources" ADD COLUMN "reset_generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "source_posts" ADD COLUMN "reset_generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "source_post_aliases" ADD COLUMN "reset_generation" INTEGER NOT NULL DEFAULT 0;

DROP INDEX "source_posts_source_id_external_id_key";
CREATE UNIQUE INDEX "source_posts_source_id_reset_generation_external_id_key" ON "source_posts"("source_id", "reset_generation", "external_id");
CREATE INDEX "source_posts_reset_generation_idx" ON "source_posts"("source_id", "reset_generation", "first_seen_at", "id");

ALTER TABLE "source_post_aliases" DROP CONSTRAINT "source_post_aliases_pkey";
ALTER TABLE "source_post_aliases" ADD CONSTRAINT "source_post_aliases_pkey" PRIMARY KEY ("source_id", "reset_generation", "external_id");
