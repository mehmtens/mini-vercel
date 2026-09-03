#!/usr/bin/env bash
# ==============================================================================
# Doplo MinIO / S3 Artifacts Restore Script
# Includes SHA256 integrity verification before archive extraction
# ==============================================================================
set -euo pipefail

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 <path_to_minio_backup.tar.gz> [--skip-checksum]"
    exit 1
fi

ARCHIVE_FILE="$1"
BUCKET_NAME="${MINIO_BUCKET_BUILDS:-doplo-builds}"
CHECKSUM_FILE="${ARCHIVE_FILE}.sha256"
SKIP_CHECKSUM=false

if [ "${2:-}" == "--skip-checksum" ]; then
  SKIP_CHECKSUM=true
fi

if [ ! -f "${ARCHIVE_FILE}" ]; then
    echo "Error: Archive file '${ARCHIVE_FILE}' does not exist!"
    exit 1
fi

# Step 1: Verify SHA256 Checksum
if [ -f "${CHECKSUM_FILE}" ]; then
    echo "[$(date -Iseconds)] [VERIFY] Verifying SHA256 integrity checksum for '${ARCHIVE_FILE}'..."
    sha256sum -c "${CHECKSUM_FILE}" || {
      echo "[$(date -Iseconds)] [FATAL] SHA256 checksum verification failed! Archive may be corrupted or tampered with."
      exit 1
    }
    echo "[$(date -Iseconds)] [VERIFY] Checksum verified successfully."
elif [ "$SKIP_CHECKSUM" = false ]; then
    echo "[$(date -Iseconds)] [WARN] No .sha256 file found for '${ARCHIVE_FILE}'. Proceeding with caution..."
fi

TEMP_RESTORE_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_RESTORE_DIR}"' EXIT

echo "[$(date -Iseconds)] [RESTORE] Extracting MinIO backup..."
tar -xzf "${ARCHIVE_FILE}" -C "${TEMP_RESTORE_DIR}"

mc alias set current "http://${MINIO_ENDPOINT:-localhost}:${MINIO_PORT:-9000}" \
    "${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY is required}" \
    "${MINIO_SECRET_KEY:?MINIO_SECRET_KEY is required}"

echo "[$(date -Iseconds)] [RESTORE] Mirroring restored objects to bucket '${BUCKET_NAME}'..."
mc mb --ignore-existing "current/${BUCKET_NAME}"
mc mirror "${TEMP_RESTORE_DIR}/" "current/${BUCKET_NAME}/"

echo "[$(date -Iseconds)] [RESTORE] MinIO artifacts restored successfully."
