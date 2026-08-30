-- CreateEnum
CREATE TYPE "env_target" AS ENUM ('PRODUCTION', 'PREVIEW', 'ALL');

-- CreateEnum
CREATE TYPE "deployment_status" AS ENUM ('QUEUED', 'INITIALIZING', 'CLONING', 'BUILDING', 'UPLOADING', 'DEPLOYING', 'READY', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "deployment_trigger" AS ENUM ('WEBHOOK_PUSH', 'MANUAL', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "log_stream" AS ENUM ('STDOUT', 'STDERR');

-- CreateTable
CREATE TABLE IF NOT EXISTS "users" (
    "id" UUID NOT NULL,
    "github_id" VARCHAR(64) NOT NULL,
    "username" VARCHAR(128) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "avatar_url" TEXT,
    "encrypted_access_token" TEXT,
    "access_token_iv" VARCHAR(64),
    "access_token_tag" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "projects" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "slug" VARCHAR(128) NOT NULL,
    "repo_name" VARCHAR(255) NOT NULL,
    "repo_url" TEXT NOT NULL,
    "branch" VARCHAR(128) NOT NULL DEFAULT 'main',
    "root_directory" VARCHAR(255) NOT NULL DEFAULT '/',
    "build_command" VARCHAR(255) NOT NULL DEFAULT 'npm run build',
    "output_directory" VARCHAR(255) NOT NULL DEFAULT 'dist',
    "install_command" VARCHAR(255) NOT NULL DEFAULT 'npm install',
    "framework" VARCHAR(64) NOT NULL DEFAULT 'auto',
    "current_deployment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "project_env_vars" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "encrypted_value" TEXT NOT NULL,
    "iv" VARCHAR(64) NOT NULL,
    "target" "env_target" NOT NULL DEFAULT 'ALL',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_env_vars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "deployments" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "deployment_status" NOT NULL DEFAULT 'QUEUED',
    "trigger" "deployment_trigger" NOT NULL DEFAULT 'WEBHOOK_PUSH',
    "commit_hash" VARCHAR(64),
    "commit_message" TEXT,
    "sender_username" VARCHAR(128),
    "branch" VARCHAR(128) NOT NULL,
    "s3_prefix" TEXT,
    "preview_url" TEXT,
    "build_duration_ms" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "deployment_events" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "from_status" "deployment_status",
    "to_status" "deployment_status" NOT NULL,
    "event_message" TEXT,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "deployment_logs" (
    "id" BIGSERIAL NOT NULL,
    "deployment_id" UUID NOT NULL,
    "log_chunk" TEXT NOT NULL,
    "stream" "log_stream" NOT NULL DEFAULT 'STDOUT',
    "sequence" INTEGER NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "users_github_id_key" ON "users"("github_id");
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "projects_slug_key" ON "projects"("slug");
CREATE INDEX IF NOT EXISTS "idx_projects_user_id" ON "projects"("user_id");
CREATE INDEX IF NOT EXISTS "idx_projects_slug" ON "projects"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "projects_user_id_name_key" ON "projects"("user_id", "name");
CREATE INDEX IF NOT EXISTS "idx_env_vars_project_target" ON "project_env_vars"("project_id", "target");
CREATE UNIQUE INDEX IF NOT EXISTS "project_env_vars_project_id_key_target_key" ON "project_env_vars"("project_id", "key", "target");
CREATE INDEX IF NOT EXISTS "idx_deployments_project_created" ON "deployments"("project_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_deployments_status" ON "deployments"("status");
CREATE INDEX IF NOT EXISTS "idx_deployment_events_time" ON "deployment_events"("deployment_id", "timestamp" ASC);
CREATE INDEX IF NOT EXISTS "idx_deployment_logs_seq" ON "deployment_logs"("deployment_id", "sequence" ASC);
CREATE UNIQUE INDEX IF NOT EXISTS "deployment_logs_deployment_id_sequence_key" ON "deployment_logs"("deployment_id", "sequence");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_user_id_fkey') THEN
        ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_current_deployment_id_fkey') THEN
        ALTER TABLE "projects" ADD CONSTRAINT "projects_current_deployment_id_fkey" FOREIGN KEY ("current_deployment_id") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_env_vars_project_id_fkey') THEN
        ALTER TABLE "project_env_vars" ADD CONSTRAINT "project_env_vars_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployments_project_id_fkey') THEN
        ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployment_events_deployment_id_fkey') THEN
        ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployment_logs_deployment_id_fkey') THEN
        ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- 8. Add Audit Operation Enum, Project Version & Deployment Audits Table
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'audit_operation') THEN
        CREATE TYPE "audit_operation" AS ENUM ('PROMOTE', 'ROLLBACK');
    END IF;
END $$;

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS "deployment_audits" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "actor_id" VARCHAR(128) NOT NULL,
    "operation" "audit_operation" NOT NULL,
    "old_deployment_id" UUID,
    "new_deployment_id" UUID NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_deployment_audits_project_time" ON "deployment_audits"("project_id", "timestamp" DESC);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deployment_audits_project_id_fkey') THEN
        ALTER TABLE "deployment_audits" ADD CONSTRAINT "deployment_audits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- 9. Add GitHub App Models & Webhook Deliveries Table
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "installation_id" UUID;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "github_repo_id" BIGINT;

CREATE TABLE IF NOT EXISTS "github_installations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "installation_id" BIGINT NOT NULL,
    "account_login" VARCHAR(128) NOT NULL,
    "account_id" BIGINT NOT NULL,
    "account_type" VARCHAR(32) NOT NULL DEFAULT 'User',
    "user_id" UUID NOT NULL,
    "permissions" TEXT,
    "status" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "github_app_repositories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "installation_id" UUID NOT NULL,
    "github_repo_id" BIGINT NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "full_name" VARCHAR(255) NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "default_branch" VARCHAR(128) NOT NULL DEFAULT 'main',
    "clone_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_app_repositories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "delivery_id" VARCHAR(128) NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "repo_full_name" VARCHAR(255),
    "status" VARCHAR(32) NOT NULL DEFAULT 'PROCESSED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "github_installations_installation_id_key" ON "github_installations"("installation_id");
CREATE INDEX IF NOT EXISTS "idx_github_installations_user" ON "github_installations"("user_id");
CREATE INDEX IF NOT EXISTS "idx_github_installations_id" ON "github_installations"("installation_id");

CREATE UNIQUE INDEX IF NOT EXISTS "github_app_repositories_installation_id_github_repo_id_key" ON "github_app_repositories"("installation_id", "github_repo_id");
CREATE INDEX IF NOT EXISTS "idx_github_app_repos_full_name" ON "github_app_repositories"("full_name");

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_delivery_id_key" ON "webhook_deliveries"("delivery_id");
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_delivery_id" ON "webhook_deliveries"("delivery_id");

CREATE INDEX IF NOT EXISTS "idx_projects_installation_id" ON "projects"("installation_id");

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_installation_id_fkey') THEN
        ALTER TABLE "projects" ADD CONSTRAINT "projects_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_installations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'github_installations_user_id_fkey') THEN
        ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'github_app_repositories_installation_id_fkey') THEN
        ALTER TABLE "github_app_repositories" ADD CONSTRAINT "github_app_repositories_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
