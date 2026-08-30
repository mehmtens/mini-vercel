-- AlterTable projects
ALTER TABLE "projects" ADD COLUMN "installation_id" UUID;
ALTER TABLE "projects" ADD COLUMN "github_repo_id" BIGINT;

-- CreateTable github_installations
CREATE TABLE "github_installations" (
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

-- CreateTable github_app_repositories
CREATE TABLE "github_app_repositories" (
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

-- CreateTable webhook_deliveries
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "delivery_id" VARCHAR(128) NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "repo_full_name" VARCHAR(255),
    "status" VARCHAR(32) NOT NULL DEFAULT 'PROCESSED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_installations_installation_id_key" ON "github_installations"("installation_id");
CREATE INDEX "idx_github_installations_user" ON "github_installations"("user_id");
CREATE INDEX "idx_github_installations_id" ON "github_installations"("installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_app_repositories_installation_id_github_repo_id_key" ON "github_app_repositories"("installation_id", "github_repo_id");
CREATE INDEX "idx_github_app_repos_full_name" ON "github_app_repositories"("full_name");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_delivery_id_key" ON "webhook_deliveries"("delivery_id");
CREATE INDEX "idx_webhook_deliveries_delivery_id" ON "webhook_deliveries"("delivery_id");

-- CreateIndex on projects.installation_id
CREATE INDEX "idx_projects_installation_id" ON "projects"("installation_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_installations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_app_repositories" ADD CONSTRAINT "github_app_repositories_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
