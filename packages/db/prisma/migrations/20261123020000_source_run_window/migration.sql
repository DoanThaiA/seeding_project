ALTER TABLE "sources"
  ADD COLUMN "run_start_minute" INTEGER,
  ADD COLUMN "run_end_minute" INTEGER,
  ADD CONSTRAINT "sources_run_window_valid" CHECK (
    ("run_start_minute" IS NULL AND "run_end_minute" IS NULL)
    OR ("run_start_minute" IS NOT NULL AND "run_end_minute" IS NOT NULL
      AND "run_start_minute" BETWEEN 0 AND 1439 AND "run_end_minute" BETWEEN 0 AND 1439
      AND "run_start_minute" <> "run_end_minute")
  );
