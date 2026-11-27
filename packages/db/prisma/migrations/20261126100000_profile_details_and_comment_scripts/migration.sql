ALTER TABLE "target_accounts" ADD COLUMN "profile_details" JSONB;

CREATE TABLE "profile_details_scans" (
    "mapping_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "source_ref" TEXT NOT NULL,
    "source_connector" TEXT NOT NULL,
    "target_external_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "snapshot" JSONB,
    "error" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "bio_job_id" UUID,
    "bio_status" TEXT NOT NULL DEFAULT 'IDLE',
    "bio_updated_at" TIMESTAMPTZ(3),
    "bio_error" TEXT,
    CONSTRAINT "profile_details_scans_pkey" PRIMARY KEY ("mapping_id"),
    CONSTRAINT "profile_details_scans_mapping_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "source_target_mappings"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "profile_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "profile_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "profile_groups_name_key" ON "profile_groups"("name");

CREATE TABLE "_ProfileGroupSources" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,
    CONSTRAINT "_ProfileGroupSources_AB_pkey" PRIMARY KEY ("A", "B"),
    CONSTRAINT "_ProfileGroupSources_A_fkey" FOREIGN KEY ("A") REFERENCES "profile_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_ProfileGroupSources_B_fkey" FOREIGN KEY ("B") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "_ProfileGroupSources_B_index" ON "_ProfileGroupSources"("B");

CREATE TABLE "_ProfileGroupTargets" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,
    CONSTRAINT "_ProfileGroupTargets_AB_pkey" PRIMARY KEY ("A", "B"),
    CONSTRAINT "_ProfileGroupTargets_A_fkey" FOREIGN KEY ("A") REFERENCES "profile_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_ProfileGroupTargets_B_fkey" FOREIGN KEY ("B") REFERENCES "target_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "_ProfileGroupTargets_B_index" ON "_ProfileGroupTargets"("B");

CREATE TYPE "CommentScriptStepStatus" AS ENUM ('DRAFT', 'QUEUED', 'SENDING', 'FAILED', 'UNKNOWN', 'POSTED');

CREATE TABLE "comment_scripts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "post_url" TEXT NOT NULL,
    "resolved_url" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    CONSTRAINT "comment_scripts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "comment_scripts_created_at_idx" ON "comment_scripts"("created_at");

CREATE TABLE "comment_script_steps" (
    "id" UUID NOT NULL,
    "script_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "reply_to" INTEGER,
    "reply_url" TEXT,
    "text" TEXT NOT NULL,
    "status" "CommentScriptStepStatus" NOT NULL DEFAULT 'DRAFT',
    "send_version" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "external_id" TEXT,
    "permalink" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "comment_script_steps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "comment_script_steps_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "comment_scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "comment_script_steps_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "target_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "comment_script_steps_script_id_position_key" ON "comment_script_steps"("script_id", "position");
CREATE UNIQUE INDEX "comment_script_steps_script_id_external_id_key" ON "comment_script_steps"("script_id", "external_id");
CREATE INDEX "comment_script_steps_status_updated_at_idx" ON "comment_script_steps"("status", "updated_at");
