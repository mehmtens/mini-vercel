#!/usr/bin/env bash
# ==============================================================================
# Mini-Vercel PostgreSQL Automated Backup & Retention Script
# Supports --dry-run for non-destructive pre-flight verification
# ==============================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/mini-vercel/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/mini_vercel_${TIMESTAMP}.sql.gz"
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
IS_DRY_RUN=false

for arg in "$@"; do
  if [ "$arg" == "--dry-run" ]; then
    IS_DRY_RUN=true
  fi
done

if [ "$IS_DRY_RUN" = true ]; then
  echo "[$(date -Iseconds)] [DRY-RUN] Executing PostgreSQL backup simulation..."
  echo "[$(date -Iseconds)] [DRY-RUN] Target database: ${POSTGRES_DB:-mini_vercel} on ${POSTGRES_HOST:-localhost}:${POSTGRES_PORT:-5432}"
  echo "[$(date -Iseconds)] [DRY-RUN] Planned output destination: ${BACKUP_FILE}"
  echo "[$(date -Iseconds)] [DRY-RUN] Retention policy: ${RETENTION_DAYS} days"
  echo "[$(date -Iseconds)] [DRY-RUN] Backup simulation completed cleanly. No files were written or deleted."
  exit 0
fi

mkdir -p "${BACKUP_DIR}"

echo "[$(date -Iseconds)] [BACKUP] Starting PostgreSQL database backup..."

# Execute compressed pg_dump
PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}" \
pg_dump -h "${POSTGRES_HOST:-localhost}" \
        -p "${POSTGRES_PORT:-5432}" \
        -U "${POSTGRES_USER:-postgres}" \
        -d "${POSTGRES_DB:-mini_vercel}" \
        --format=plain \
        --no-owner \
        --no-privileges \
        | gzip -9 > "${BACKUP_FILE}"

# Generate SHA256 verification checksum
sha256sum "${BACKUP_FILE}" > "${CHECKSUM_FILE}"

FILE_SIZE="$(du -h "${BACKUP_FILE}" | cut -f1)"
echo "[$(date -Iseconds)] [BACKUP] Backup completed successfully: ${BACKUP_FILE} (${FILE_SIZE})"

# Enforce retention policy (delete backups older than RETENTION_DAYS)
echo "[$(date -Iseconds)] [RETENTION] Cleaning up backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name "mini_vercel_*.sql.gz*" -type f -mtime +"${RETENTION_DAYS}" -delete

# Export metric to Prometheus Node Exporter textfile collector
METRICS_DIR="${METRICS_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
if mkdir -p "${METRICS_DIR}" 2>/dev/null; then
  echo "mini_vercel_backup_last_success_timestamp_seconds{target=\"postgres\"} $(date +%s)" > "${METRICS_DIR}/mini_vercel_backup_postgres.prom.$$" 2>/dev/null || true
  mv "${METRICS_DIR}/mini_vercel_backup_postgres.prom.$$" "${METRICS_DIR}/mini_vercel_backup_postgres.prom" 2>/dev/null || true
fi

echo "[$(date -Iseconds)] [BACKUP] Retention policy applied and metrics recorded."
