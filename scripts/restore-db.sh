#!/usr/bin/env bash
# ==============================================================================
# Doplo PostgreSQL Disaster Recovery & Restore Script
# ==============================================================================
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <path_to_backup_file.sql.gz>"
    exit 1
fi

BACKUP_FILE="$1"
CHECKSUM_FILE="${BACKUP_FILE}.sha256"

if [ ! -f "${BACKUP_FILE}" ]; then
    echo "Error: Backup file '${BACKUP_FILE}' does not exist!"
    exit 1
fi

# Validate SHA256 Checksum if present
if [ -f "${CHECKSUM_FILE}" ]; then
    echo "[$(date -Iseconds)] [VERIFY] Verifying SHA256 integrity checksum..."
    sha256sum -c "${CHECKSUM_FILE}"
else
    echo "[$(date -Iseconds)] [WARN] No .sha256 checksum file found. Proceeding with caution..."
fi

echo "[$(date -Iseconds)] [RESTORE] Restoring database '${POSTGRES_DB:-doplo}' from '${BACKUP_FILE}'..."

PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}" \
gunzip -c "${BACKUP_FILE}" | \
psql -h "${POSTGRES_HOST:-localhost}" \
     -p "${POSTGRES_PORT:-5432}" \
     -U "${POSTGRES_USER:-postgres}" \
     -d "${POSTGRES_DB:-doplo}" \
     --single-transaction

echo "[$(date -Iseconds)] [RESTORE] Database restored successfully."
