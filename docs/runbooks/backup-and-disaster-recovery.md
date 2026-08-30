# Backup & Disaster Recovery Runbook

This runbook outlines automated backup policies, retention, integrity verification, dry-run simulation, and disaster recovery procedures for Mini-Vercel PostgreSQL and MinIO storage layers.

---

## 💾 1. Backup Schedule & Architecture

| Component | Target Location | Frequency | Retention | Script / Mode |
|---|---|---|---|---|
| **PostgreSQL DB** | `/var/backups/mini-vercel/postgres` | Every 6 hours | 7 Days | `scripts/backup-db.sh` (`--dry-run` supported) |
| **MinIO Artifacts** | `/var/backups/mini-vercel/minio` | Daily (02:00 UTC) | 14 Days | `scripts/backup-minio.sh` (`--dry-run` supported) |
| **Resource Cleanup** | Host temp / MinIO unlinked | Daily (04:00 UTC) | N/A | `scripts/cleanup-orphan-resources.ts` (`--dry-run` supported) |
| **DR Drill** | Ephemeral test containers | Monthly / On-Demand | N/A | `scripts/backup-restore-drill.sh` |

---

## ⚙️ 2. Setting Up Automated Scheduling

### Option A: Systemd Timers (Recommended for Linux hosts)
```bash
cp deploy/systemd/mini-vercel-backup-*.service /etc/systemd/system/
cp deploy/systemd/mini-vercel-backup-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mini-vercel-backup-db.timer
systemctl enable --now mini-vercel-backup-minio.timer
```

### Option B: Automated Crontab Installer
```bash
# Preview crontab changes without writing:
bash scripts/setup-backup-cron.sh --dry-run

# Install crontab entries:
bash scripts/setup-backup-cron.sh
```

---

## 🔍 3. Pre-Flight Verification & Dry-Run
Before executing live backup or cleanup operations, test them using `--dry-run`:
```bash
# Simulate DB backup
bash scripts/backup-db.sh --dry-run

# Simulate MinIO backup
bash scripts/backup-minio.sh --dry-run

# Simulate resource garbage collection
pnpm tsx scripts/cleanup-orphan-resources.ts --dry-run
```

---

## 🆘 4. Disaster Recovery & Restoration Procedures

### Restoring PostgreSQL Database
1. Stop API and Worker to prevent writes during restore:
   ```bash
   docker compose -f deploy/docker-compose.production.yml stop api worker
   ```
2. Run restore script (SHA256 verified automatically):
   ```bash
   ./scripts/restore-db.sh /var/backups/mini-vercel/postgres/mini_vercel_20260830_060000.sql.gz
   ```
3. Restart services:
   ```bash
   docker compose -f deploy/docker-compose.production.yml start api worker
   ```

### Restoring MinIO Artifacts
1. Run restore script:
   ```bash
   ./scripts/restore-minio.sh /var/backups/mini-vercel/minio/mini-vercel-builds_20260830_020000.tar.gz
   ```
2. Verify objects presence:
   ```bash
   mc ls current/mini-vercel-builds/
   ```

---

## 🧪 5. Automated Disaster Recovery Drill
To run a clean-slate backup-and-restore simulation on temporary ephemeral containers:
```bash
bash scripts/backup-restore-drill.sh
```
Check generated drill results in [`docs/runbooks/restore-drill-report.md`](file:///c:/mini-vercel/docs/runbooks/restore-drill-report.md).
