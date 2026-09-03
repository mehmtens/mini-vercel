#!/usr/bin/env bash
# ==============================================================================
# Doplo Automated Backup & Retention Scheduler Installer
# Supports --dry-run for non-destructive pre-flight verification
# ==============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/doplo}"
LOG_DIR="${LOG_DIR:-/var/log/doplo}"
IS_DRY_RUN=false

for arg in "$@"; do
  if [ "$arg" == "--dry-run" ] || [ "$arg" == "--verify-only" ]; then
    IS_DRY_RUN=true
  fi
done

echo "=============================================================================="
echo " Doplo Scheduled Backup Setup (DryRun: ${IS_DRY_RUN})"
echo "=============================================================================="

CRON_ENTRIES=(
  "# [Doplo] PostgreSQL Automated Backup (Every 6 hours)"
  "0 */6 * * * cd ${INSTALL_DIR} && bash scripts/backup-db.sh >> ${LOG_DIR}/backup-db.log 2>&1"
  ""
  "# [Doplo] MinIO S3 Artifacts Automated Backup (Daily at 02:00 UTC)"
  "0 2 * * * cd ${INSTALL_DIR} && bash scripts/backup-minio.sh >> ${LOG_DIR}/backup-minio.log 2>&1"
  ""
  "# [Doplo] Resource Garbage Collection & Orphan Pruning (Daily at 04:00 UTC)"
  "0 4 * * * cd ${INSTALL_DIR} && pnpm tsx scripts/cleanup-orphan-resources.ts >> ${LOG_DIR}/cleanup.log 2>&1"
)

if [ "$IS_DRY_RUN" = true ]; then
  echo "[DRY-RUN] Target crontab configuration plan:"
  for line in "${CRON_ENTRIES[@]}"; do
    echo "  $line"
  done
  echo ""
  echo "[DRY-RUN] Log directory plan: ${LOG_DIR}"
  echo "[DRY-RUN] Systemd units available in: ${INSTALL_DIR}/deploy/systemd/"
  echo "[DRY-RUN] Simulation complete. No crontab or system configuration was modified."
  exit 0
fi

# Ensure log directory exists
mkdir -p "${LOG_DIR}"

# Append cron entries if not already present
TEMP_CRON="$(mktemp)"
crontab -l 2>/dev/null > "${TEMP_CRON}" || true

if grep -q "Doplo" "${TEMP_CRON}"; then
  echo "[SETUP] Doplo backup jobs already exist in crontab. Updating..."
  grep -v "Doplo" "${TEMP_CRON}" | grep -v "backup-db.sh" | grep -v "backup-minio.sh" | grep -v "cleanup-orphan-resources.ts" > "${TEMP_CRON}.clean"
  mv "${TEMP_CRON}.clean" "${TEMP_CRON}"
fi

for line in "${CRON_ENTRIES[@]}"; do
  echo "$line" >> "${TEMP_CRON}"
done

crontab "${TEMP_CRON}"
rm -f "${TEMP_CRON}"

echo "[SETUP] Crontab successfully installed with automated backup & cleanup jobs."
echo "[SETUP] Log outputs directed to: ${LOG_DIR}/"
