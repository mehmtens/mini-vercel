#!/usr/bin/env bash
# ==============================================================================
# Mini-Vercel MinIO / S3 Artifacts Automated Backup & Mirror Script
# Supports --dry-run for non-destructive pre-flight verification
# ==============================================================================
set -euo pipefail

BACKUP_DIR="${MINIO_BACKUP_DIR:-/var/backups/mini-vercel/minio}"
BUCKET_NAME="${MINIO_BUCKET_BUILDS:-mini-vercel-builds}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
TARGET_ARCHIVE="${BACKUP_DIR}/${BUCKET_NAME}_${TIMESTAMP}.tar.gz"
CHECKSUM_FILE="${TARGET_ARCHIVE}.sha256"
IS_DRY_RUN=false

for arg in "$@"; do
  if [ "$arg" == "--dry-run" ]; then
    IS_DRY_RUN=true
  fi
done

if [ "$IS_DRY_RUN" = true ]; then
  echo "[$(date -Iseconds)] [DRY-RUN] Executing MinIO artifact backup simulation..."
  echo "[$(date -Iseconds)] [DRY-RUN] Source bucket: ${BUCKET_NAME} on http://${MINIO_ENDPOINT:-localhost}:${MINIO_PORT:-9000}"
  echo "[$(date -Iseconds)] [DRY-RUN] Planned output destination: ${TARGET_ARCHIVE}"
  echo "[$(date -Iseconds)] [DRY-RUN] Retention policy: ${RETENTION_DAYS} days"
  echo "[$(date -Iseconds)] [DRY-RUN] MinIO backup simulation completed cleanly. No archives were created or deleted."
  exit 0
fi

mkdir -p "${BACKUP_DIR}"

echo "[$(date -Iseconds)] [BACKUP] Starting MinIO storage backup for bucket '${BUCKET_NAME}'..."

# Configure mc alias
mc alias set current "http://${MINIO_ENDPOINT:-localhost}:${MINIO_PORT:-9000}" \
    "${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY is required}" \
    "${MINIO_SECRET_KEY:?MINIO_SECRET_KEY is required}"

# Mirror to temporary sync folder and archive
TEMP_SYNC_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_SYNC_DIR}"' EXIT

mc mirror "current/${BUCKET_NAME}" "${TEMP_SYNC_DIR}/"

tar -czf "${TARGET_ARCHIVE}" -C "${TEMP_SYNC_DIR}" .
sha256sum "${TARGET_ARCHIVE}" > "${CHECKSUM_FILE}"

FILE_SIZE="$(du -h "${TARGET_ARCHIVE}" | cut -f1)"
echo "[$(date -Iseconds)] [BACKUP] MinIO backup created: ${TARGET_ARCHIVE} (${FILE_SIZE})"

# Enforce retention policy (delete archives older than RETENTION_DAYS)
echo "[$(date -Iseconds)] [RETENTION] Cleaning up MinIO backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -type f -name "${BUCKET_NAME}_*.tar.gz*" -mtime "+${RETENTION_DAYS}" -print -delete

# Export metric to Prometheus Node Exporter textfile collector
METRICS_DIR="${METRICS_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
if mkdir -p "${METRICS_DIR}" 2>/dev/null; then
  echo "mini_vercel_backup_last_success_timestamp_seconds{target=\"minio\"} $(date +%s)" > "${METRICS_DIR}/mini_vercel_backup_minio.prom.$$" 2>/dev/null || true
  mv "${METRICS_DIR}/mini_vercel_backup_minio.prom.$$" "${METRICS_DIR}/mini_vercel_backup_minio.prom" 2>/dev/null || true
fi

echo "[$(date -Iseconds)] [BACKUP] MinIO backup process finished and metrics recorded."
