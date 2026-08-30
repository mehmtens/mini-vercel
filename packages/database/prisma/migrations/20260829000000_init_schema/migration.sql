-- CreateEnum
CREATE TYPE "env_target" AS ENUM ('PRODUCTION', 'PREVIEW', 'ALL');

-- CreateEnum
CREATE TYPE "deployment_status" AS ENUM ('QUEUED', 'INITIALIZING', 'CLONING', 'BUILDING', 'UPLOADING', 'DEPLOYING', 'READY', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "deployment_trigger" AS ENUM ('WEBHOOK_PUSH', 'MANUAL', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "log_stream" AS ENUM ('STDOUT', 'STDERR');

-- CreateTable
CREATE TABLE "users" (
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
CREATE TABLE "projects" (
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
CREATE TABLE "project_env_vars" (
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
CREATE TABLE "deployments" (
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
CREATE TABLE "deployment_events" (
    "id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "from_status" "deployment_status",
    "to_status" "deployment_status" NOT NULL,
    "event_message" TEXT,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_logs" (
    "id" BIGSERIAL NOT NULL,
    "deployment_id" UUID NOT NULL,
    "log_chunk" TEXT NOT NULL,
    "stream" "log_stream" NOT NULL DEFAULT 'STDOUT',
    "sequence" INTEGER NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "idx_projects_user_id" ON "projects"("user_id");

-- CreateIndex
CREATE INDEX "idx_projects_slug" ON "projects"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "projects_user_id_name_key" ON "projects"("user_id", "name");

-- CreateIndex
CREATE INDEX "idx_env_vars_project_target" ON "project_env_vars"("project_id", "target");

-- CreateIndex
CREATE UNIQUE INDEX "project_env_vars_project_id_key_target_key" ON "project_env_vars"("project_id", "key", "target");

-- CreateIndex
CREATE INDEX "idx_deployments_project_created" ON "deployments"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_deployments_status" ON "deployments"("status");

-- CreateIndex
CREATE INDEX "idx_deployment_events_time" ON "deployment_events"("deployment_id", "timestamp" ASC);

-- CreateIndex
CREATE INDEX "idx_deployment_logs_seq" ON "deployment_logs"("deployment_id", "sequence" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "deployment_logs_deployment_id_sequence_key" ON "deployment_logs"("deployment_id", "sequence");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_current_deployment_id_fkey" FOREIGN KEY ("current_deployment_id") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_env_vars" ADD CONSTRAINT "project_env_vars_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
