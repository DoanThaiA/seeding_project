ALTER TABLE "profile_syncs" ADD COLUMN "publish" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "profile_sync_items" ADD COLUMN "publish_status" TEXT, ADD COLUMN "publish_detail" TEXT;
CREATE INDEX "profile_sync_items_sync_id_publish_status_idx" ON "profile_sync_items" ("sync_id", "publish_status");
