ALTER TABLE "sources"
  ADD COLUMN "publish_interval_min" INTEGER CHECK ("publish_interval_min" BETWEEN 1 AND 1440),
  ADD COLUMN "run_now_from" TIMESTAMPTZ(3),
  ADD COLUMN "run_now_until" TIMESTAMPTZ(3),
  ADD COLUMN "run_now_limit" INTEGER CHECK ("run_now_limit" BETWEEN 1 AND 10),
  ADD COLUMN "run_now_variant_ids" UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN "publish_comments" BOOLEAN NOT NULL DEFAULT true,
  ALTER COLUMN "collect_comments" SET DEFAULT true;

UPDATE "sources" SET "collect_comments" = true
WHERE "connector" IN ('fb-public', 'fb-session', 'fb-graph');

ALTER TABLE "publications" ADD COLUMN "auto_replay_comments" BOOLEAN NOT NULL DEFAULT false;
