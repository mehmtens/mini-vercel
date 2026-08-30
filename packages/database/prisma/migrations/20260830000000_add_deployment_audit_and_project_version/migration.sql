-- CreateEnum
CREATE TYPE "audit_operation" AS ENUM ('PROMOTE', 'ROLLBACK');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "deployment_audits" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "actor_id" VARCHAR(128) NOT NULL,
    "operation" "audit_operation" NOT NULL,
    "old_deployment_id" UUID,
    "new_deployment_id" UUID NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_deployment_audits_project_time" ON "deployment_audits"("project_id", "timestamp" DESC);

-- AddForeignKey
ALTER TABLE "deployment_audits" ADD CONSTRAINT "deployment_audits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
