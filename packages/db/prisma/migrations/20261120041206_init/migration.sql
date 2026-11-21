-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('TEXT', 'QUOTE_IMAGE', 'SINGLE_PHOTO', 'MULTI_PHOTO', 'NAMED_ALBUM', 'VIDEO', 'REEL', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "Workflow" AS ENUM ('STANDARD', 'ALBUM', 'VIDEO');

-- CreateEnum
CREATE TYPE "IdentityConfidence" AS ENUM ('HIGH', 'LOW');

-- CreateEnum
CREATE TYPE "ReviewMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('PENDING', 'STORED', 'FAILED');

-- CreateEnum
CREATE TYPE "VariantStatus" AS ENUM ('BASELINE', 'FETCHING_MEDIA', 'REWRITING', 'VALIDATING', 'READY', 'NEEDS_REVIEW', 'REJECTED', 'UNSUPPORTED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('PLANNED', 'RESERVED', 'DISPATCHED', 'STARTED', 'DONE', 'SKIPPED_NO_CONTENT', 'DEFERRED', 'MISSED');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('QUEUED', 'PREPARING', 'UPLOADING_DRAFT', 'READY_TO_SUBMIT', 'COMMITTING', 'PLATFORM_PROCESSING', 'VERIFYING', 'PUBLISHED_VERIFIED', 'FAILED_CONFIRMED', 'UNKNOWN', 'RECONCILING', 'NEEDS_OPERATOR', 'OPERATOR_CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED_PRE_COMMIT', 'FAILED_CONFIRMED', 'UNKNOWN', 'ABANDONED', 'NEEDS_OPERATOR');

-- CreateEnum
CREATE TYPE "OperatorTaskKind" AS ENUM ('REVIEW_CONTENT', 'TAKEOVER_ACCOUNT', 'CONFIRM_RESULT');

-- CreateEnum
CREATE TYPE "OperatorTaskStatus" AS ENUM ('OPEN', 'CLAIMED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ControlScope" AS ENUM ('GLOBAL', 'SOURCE', 'TARGET', 'FORMAT', 'CONNECTOR');

-- CreateEnum
CREATE TYPE "WorkerKind" AS ENUM ('CORE', 'BROWSER', 'MEDIA');

-- CreateTable
CREATE TABLE "sources" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "external_ref" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "poll_interval_sec" INTEGER NOT NULL DEFAULT 300,
    "overlap_count" INTEGER NOT NULL DEFAULT 5,
    "watermark" JSONB,
    "baseline_done" BOOLEAN NOT NULL DEFAULT false,
    "last_poll_at" TIMESTAMPTZ(3),
    "last_success_at" TIMESTAMPTZ(3),
    "last_error_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "last_incomplete" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "target_accounts" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "connector" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'ONLY_ME',
    "ui_locale" TEXT NOT NULL DEFAULT 'vi-VN',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "style_profile" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "target_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_target_mappings" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "content_ttl_hours" INTEGER NOT NULL DEFAULT 72,
    "late_window_min" INTEGER NOT NULL DEFAULT 15,
    "strict_order" BOOLEAN NOT NULL DEFAULT false,
    "review_mode" "ReviewMode" NOT NULL DEFAULT 'AUTO',
    "max_publish_tries" INTEGER NOT NULL DEFAULT 2,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "source_target_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_nodes" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "WorkerKind" NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "last_heartbeat_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_profiles" (
    "id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "worker_node_id" UUID,
    "profile_dir" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "browser_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_releases" (
    "id" UUID NOT NULL,
    "connector" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "released_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_checks" (
    "id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "content_type" "ContentType" NOT NULL,
    "connector" TEXT NOT NULL,
    "connector_version" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "cases" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capability_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_posts" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "identity_confidence" "IdentityConfidence" NOT NULL,
    "permalink" TEXT,
    "content_type" "ContentType" NOT NULL,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "is_baseline" BOOLEAN NOT NULL DEFAULT false,
    "posted_at" TIMESTAMPTZ(3),
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "latest_revision_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_post_revisions" (
    "id" UUID NOT NULL,
    "source_post_id" UUID NOT NULL,
    "content_hash" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "album_title" TEXT,
    "incomplete" JSONB NOT NULL DEFAULT '[]',
    "raw" JSONB,
    "media_status" "MediaStatus" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_post_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source_url" TEXT,
    "source_ref" TEXT,
    "connector" TEXT NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'PENDING',
    "checksum" TEXT,
    "expected_checksum" TEXT,
    "object_key" TEXT,
    "mime" TEXT,
    "bytes" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "fetch_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_assets" (
    "revision_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "asset_id" UUID NOT NULL,

    CONSTRAINT "post_assets_pkey" PRIMARY KEY ("revision_id","position")
);

-- CreateTable
CREATE TABLE "content_variants" (
    "id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "source_post_id" UUID NOT NULL,
    "content_type" "ContentType" NOT NULL,
    "status" "VariantStatus" NOT NULL,
    "caption" TEXT,
    "facts_to_preserve" JSONB,
    "attribution" TEXT,
    "review_reasons" JSONB NOT NULL DEFAULT '[]',
    "prompt_version" TEXT,
    "model_id" TEXT,
    "cache_key" TEXT,
    "rewrite_tries" INTEGER NOT NULL DEFAULT 0,
    "snapshot" JSONB,
    "snapshot_hash" TEXT,
    "ready_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "reviewed_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_checks" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_slots" (
    "id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "slot_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "SlotStatus" NOT NULL DEFAULT 'PLANNED',
    "reason" TEXT,
    "publication_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "publication_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publications" (
    "id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "source_post_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "slot_id" UUID,
    "workflow" "Workflow" NOT NULL,
    "content_type" "ContentType" NOT NULL,
    "status" "PublicationStatus" NOT NULL,
    "job_version" INTEGER NOT NULL DEFAULT 1,
    "snapshot_hash" TEXT NOT NULL,
    "permalink" TEXT,
    "external_post_id" TEXT,
    "committed_at" TIMESTAMPTZ(3),
    "verified_at" TIMESTAMPTZ(3),
    "reconcile_tries" INTEGER NOT NULL DEFAULT 0,
    "publish_tries" INTEGER NOT NULL DEFAULT 0,
    "last_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_attempts" (
    "id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'publish',
    "connector" TEXT NOT NULL,
    "connector_version" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "fencing_token" BIGINT NOT NULL,
    "outcome" "AttemptOutcome" NOT NULL DEFAULT 'RUNNING',
    "stage" TEXT,
    "error_class" TEXT,
    "error_message" TEXT,
    "evidence" JSONB,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "committing_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "publication_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" BIGSERIAL NOT NULL,
    "queue" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "singleton_key" TEXT,
    "start_after" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_leases" (
    "resource" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "fencing_token" BIGINT NOT NULL,
    "purpose" TEXT,
    "acquired_at" TIMESTAMPTZ(3) NOT NULL,
    "heartbeat_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "released_at" TIMESTAMPTZ(3),

    CONSTRAINT "account_leases_pkey" PRIMARY KEY ("resource")
);

-- CreateTable
CREATE TABLE "operator_tasks" (
    "id" UUID NOT NULL,
    "kind" "OperatorTaskKind" NOT NULL,
    "status" "OperatorTaskStatus" NOT NULL DEFAULT 'OPEN',
    "target_id" UUID,
    "publication_id" UUID,
    "variant_id" UUID,
    "reason" TEXT NOT NULL,
    "details" JSONB,
    "claimed_by" TEXT,
    "resolved_by" TEXT,
    "resolution" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "operator_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" BIGSERIAL NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT,
    "actor" TEXT NOT NULL,
    "data" JSONB,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "controls" (
    "id" UUID NOT NULL,
    "scope" "ControlScope" NOT NULL,
    "scope_key" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "set_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "controls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_usage" (
    "id" BIGSERIAL NOT NULL,
    "profile" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cost_micro_usd" BIGINT NOT NULL,
    "ref_type" TEXT,
    "ref_id" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "llm_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_cache" (
    "cache_key" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "model_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_cache_pkey" PRIMARY KEY ("cache_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "sources_code_key" ON "sources"("code");

-- CreateIndex
CREATE UNIQUE INDEX "target_accounts_code_key" ON "target_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "source_target_mappings_source_id_target_id_key" ON "source_target_mappings"("source_id", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "worker_nodes_name_key" ON "worker_nodes"("name");

-- CreateIndex
CREATE UNIQUE INDEX "browser_profiles_target_id_key" ON "browser_profiles"("target_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_releases_connector_version_key" ON "connector_releases"("connector", "version");

-- CreateIndex
CREATE UNIQUE INDEX "capability_checks_target_id_content_type_connector_connecto_key" ON "capability_checks"("target_id", "content_type", "connector", "connector_version");

-- CreateIndex
CREATE UNIQUE INDEX "source_posts_source_id_external_id_key" ON "source_posts"("source_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_post_revisions_source_post_id_content_hash_key" ON "source_post_revisions"("source_post_id", "content_hash");

-- CreateIndex
CREATE INDEX "content_variants_target_id_status_ready_at_idx" ON "content_variants"("target_id", "status", "ready_at");

-- CreateIndex
CREATE UNIQUE INDEX "content_variants_revision_id_target_id_key" ON "content_variants"("revision_id", "target_id");

-- CreateIndex
CREATE INDEX "publication_slots_status_slot_at_idx" ON "publication_slots"("status", "slot_at");

-- CreateIndex
CREATE UNIQUE INDEX "publication_slots_target_id_slot_at_key" ON "publication_slots"("target_id", "slot_at");

-- CreateIndex
CREATE INDEX "publications_target_id_status_idx" ON "publications"("target_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "publications_target_id_source_post_id_key" ON "publications"("target_id", "source_post_id");

-- CreateIndex
CREATE UNIQUE INDEX "publication_attempts_publication_id_attempt_no_key" ON "publication_attempts"("publication_id", "attempt_no");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_id_idx" ON "outbox_events"("published_at", "id");

-- CreateIndex
CREATE INDEX "operator_tasks_status_created_at_idx" ON "operator_tasks"("status", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_idx" ON "audit_events"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "controls_scope_scope_key_key" ON "controls"("scope", "scope_key");

-- CreateIndex
CREATE INDEX "llm_usage_profile_day_idx" ON "llm_usage"("profile", "day");

-- AddForeignKey
ALTER TABLE "source_target_mappings" ADD CONSTRAINT "source_target_mappings_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_target_mappings" ADD CONSTRAINT "source_target_mappings_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "target_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "target_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_worker_node_id_fkey" FOREIGN KEY ("worker_node_id") REFERENCES "worker_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_checks" ADD CONSTRAINT "capability_checks_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "target_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_posts" ADD CONSTRAINT "source_posts_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_post_revisions" ADD CONSTRAINT "source_post_revisions_source_post_id_fkey" FOREIGN KEY ("source_post_id") REFERENCES "source_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_assets" ADD CONSTRAINT "post_assets_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "source_post_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_assets" ADD CONSTRAINT "post_assets_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_variants" ADD CONSTRAINT "content_variants_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "source_post_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_variants" ADD CONSTRAINT "content_variants_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "target_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_checks" ADD CONSTRAINT "content_checks_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "content_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_slots" ADD CONSTRAINT "publication_slots_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "target_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "target_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_source_post_id_fkey" FOREIGN KEY ("source_post_id") REFERENCES "source_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "content_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_attempts" ADD CONSTRAINT "publication_attempts_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── extra constraints (not expressible in Prisma) ─────────────

-- Fencing tokens are globally monotonic.
CREATE SEQUENCE "fencing_token_seq" AS BIGINT START 1;

-- Slots are always at the top of an hour (UTC instant).
ALTER TABLE "publication_slots"
  ADD CONSTRAINT "publication_slots_top_of_hour" CHECK (date_trunc('hour', "slot_at") = "slot_at");

-- Defence in depth for the account lock: at most one publication per account may be
-- in an active (browser-side) state at any time, across standard/album/video workflows.
CREATE UNIQUE INDEX "publications_one_active_per_target" ON "publications" ("target_id")
  WHERE "status" IN ('PREPARING','UPLOADING_DRAFT','READY_TO_SUBMIT','COMMITTING','PLATFORM_PROCESSING','VERIFYING');

-- A committed publication must carry its commit timestamp.
ALTER TABLE "publications"
  ADD CONSTRAINT "publications_committed_has_ts" CHECK (
    "status" NOT IN ('PLATFORM_PROCESSING','VERIFYING','PUBLISHED_VERIFIED') OR "committed_at" IS NOT NULL
  );

-- Pending outbox rows are scanned constantly.
CREATE INDEX "outbox_events_pending" ON "outbox_events" ("id") WHERE "published_at" IS NULL;

-- Only one open operator task of a kind per publication / target / variant.
CREATE UNIQUE INDEX "operator_tasks_one_open" ON "operator_tasks" ("kind", COALESCE("publication_id"::text, ''), COALESCE("target_id"::text, ''), COALESCE("variant_id"::text, ''))
  WHERE "status" IN ('OPEN','CLAIMED');
