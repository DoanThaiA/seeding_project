CREATE TABLE "profile_artwork" (
  "mapping_id" UUID PRIMARY KEY REFERENCES "source_target_mappings"("id") ON DELETE CASCADE,
  "request_id" UUID NOT NULL,
  "source_ref" TEXT NOT NULL,
  "source_connector" TEXT NOT NULL,
  "target_external_id" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('QUEUED','READING','READY','FAILED')),
  "images" JSONB NOT NULL DEFAULT '{}',
  "error" TEXT,
  "updated_at" TIMESTAMPTZ(3) NOT NULL
);
