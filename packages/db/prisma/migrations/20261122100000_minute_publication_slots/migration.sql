ALTER TABLE "publication_slots"
  DROP CONSTRAINT "publication_slots_scheduled_top_of_hour",
  ADD CONSTRAINT "publication_slots_scheduled_minute"
    CHECK ("manual" OR date_trunc('minute', "slot_at") = "slot_at");
