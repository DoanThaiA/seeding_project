CREATE TABLE "publication_schedules" (
    "id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "interval_minutes" INTEGER NOT NULL,
    "limit" INTEGER NOT NULL,
    "source_ids" UUID[] NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stopped_at" TIMESTAMPTZ(3),
    CONSTRAINT "publication_schedules_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "publication_slots"
    ADD COLUMN "schedule_id" UUID,
    ADD COLUMN "scheduled_variant_id" UUID,
    ADD COLUMN "schedule_source_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    ADD CONSTRAINT "publication_slots_schedule_id_fkey" FOREIGN KEY ("schedule_id")
        REFERENCES "publication_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "publication_schedules_created_at_idx" ON "publication_schedules"("created_at");
CREATE INDEX "publication_slots_schedule_id_slot_at_idx" ON "publication_slots"("schedule_id", "slot_at");
CREATE INDEX "publication_slots_scheduled_variant_id_status_idx" ON "publication_slots"("scheduled_variant_id", "status");
