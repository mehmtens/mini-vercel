ALTER TABLE "users"
  ALTER COLUMN "github_id" DROP NOT NULL,
  ADD COLUMN "google_id" VARCHAR(128),
  ADD COLUMN "password_hash" TEXT,
  ADD COLUMN "email_verified" BOOLEAN NOT NULL DEFAULT false;

UPDATE "users"
SET "email_verified" = true
WHERE "github_id" IS NOT NULL;

CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");
