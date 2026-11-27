ALTER TABLE "sources" ADD COLUMN "poll_post_limit" INTEGER;

ALTER TABLE "sources" ADD CONSTRAINT "sources_poll_post_limit_check"
  CHECK ("poll_post_limit" IS NULL OR "poll_post_limit" BETWEEN 1 AND 100);
