ALTER TABLE "publication_slots"
  ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false,
  DROP CONSTRAINT "publication_slots_top_of_hour",
  ADD CONSTRAINT "publication_slots_scheduled_top_of_hour"
    CHECK ("manual" OR date_trunc('hour', "slot_at") = "slot_at");
