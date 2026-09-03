# Production Deployment, Observability & Rollback Runbook

This document details standard operating procedures for deploying, monitoring, and rolling back Doplo in production environments.

---

## 🚀 1. Production Deployment & Upgrade Procedure

### Prerequisites
1. Dedicated Ubuntu 24.04 LTS VM or bare-metal host with at least 8 vCPU, 16 GB RAM, 160 GB NVMe, Docker 24+, and Docker Compose v2.
2. Wildcard DNS records configured:
   - `*.doplo.dev` -> Host IPv4 / IPv6
   - `doplo.dev` -> Host IPv4 / IPv6
3. Ports `80` and `443` open in security groups / firewall.
4. GitHub authentication or a read-only deploy key configured for the private repository.

### Step-by-Step Deployment
1. **Clone repository and configure environment**:
   ```bash
   git clone https://github.com/mehmtens/mini-vercel.git /opt/doplo
   cd /opt/doplo
   cp deploy/production.env.example .env
   # Edit .env with real credentials generated via password managers / Vault
   # Set DOCKER_GID to the output of:
   stat -c '%g' /var/run/docker.sock
   docker run --rm -v "$PWD:/workspace:ro" -w /workspace node:22-alpine \
     node scripts/production-preflight.mjs .env
   ```

2. **Validate configuration & healthcheck syntax**:
   ```bash
   docker compose --env-file .env -f deploy/docker-compose.production.yml config
   ```

3. **Deploy production stack**:
   ```bash
   docker compose --env-file .env -f deploy/docker-compose.production.yml up -d --build
   ```

4. **Verify container health & initialization states**:
   ```bash
   # Daemon services (postgres, redis, minio, api, worker, web, caddy) must be healthy
   docker compose --env-file .env -f deploy/docker-compose.production.yml ps

   # Initialization containers (db-migrate, minio-init) must show Exited (0)
   ```

5. **Verify Health & Readiness**:
   ```bash
   curl -i https://doplo.dev/ready
   curl -i https://doplo.dev/metrics
   ```

6. **Verify on-demand TLS authorization**:
   ```bash
   # The management hostname is allowed.
   curl -i "https://doplo.dev/api/tls/ask?domain=doplo.dev"

   # An unregistered wildcard hostname must be denied with HTTP 403.
   curl -i "https://doplo.dev/api/tls/ask?domain=random-unregistered.doplo.dev"
   ```

   Doplo only authorizes certificates for the management hostname, an active
   project hostname, or a `READY` immutable preview. Arbitrary wildcard and
   external custom domains remain fail-closed until domain ownership verification
   and an explicit custom-domain registry are implemented.

---

## 📈 2. Observability & Monitoring Stack (Prometheus + Grafana)

Doplo exposes standard Prometheus metrics from Fastify API (`:8080/metrics`) and the BullMQ Worker process (`:9090/metrics` over internal container network).

### Validating Prometheus Configuration & Alert Rules
- **Linux / Bash**:
  ```bash
  docker run --rm --entrypoint /bin/promtool -v $(pwd)/deploy/observability:/etc/prometheus prom/prometheus:v2.54.1 check config /etc/prometheus/prometheus.yml
  docker run --rm --entrypoint /bin/promtool -v $(pwd)/deploy/observability:/etc/prometheus prom/prometheus:v2.54.1 check rules /etc/prometheus/alert_rules.yml
  ```
- **Windows PowerShell**:
  ```powershell
  docker run --rm --entrypoint /bin/promtool -v ${PWD}/deploy/observability:/etc/prometheus prom/prometheus:v2.54.1 check config /etc/prometheus/prometheus.yml
  docker run --rm --entrypoint /bin/promtool -v ${PWD}/deploy/observability:/etc/prometheus prom/prometheus:v2.54.1 check rules /etc/prometheus/alert_rules.yml
  ```

### Launching Observability Services
```bash
docker compose --env-file .env -f deploy/docker-compose.production.yml -f deploy/docker-compose.observability.yml up -d prometheus grafana
```

---

## 🔄 3. Zero-Downtime Rollback Procedure

Doplo uses immutable content-addressed storage in MinIO and atomic database pointer swaps.

### A. Application Rollback (User Project Deployment)
If a user deploys a broken build to production:
1. Open the project dashboard at `https://doplo.dev/projects/:id`.
2. Locate the previous `READY` deployment in the deployment history list.
3. Click the **Rollback** button (or call `POST /api/deployments/:id/rollback`).
4. **Guarantees**:
   - Zero new build jobs or compilation required.
   - Atomic database pointer swap on `project.currentDeploymentId`.
   - Audit trail recorded in `DeploymentEvent`.
   - Execution completes in $\le 1.0$s.

### B. Platform Infrastructure Rollback
If a new release of the Doplo platform itself introduces a regression:
1. Identify the previous stable Git commit or tag:
   ```bash
   cd /opt/doplo
   git log -n 5 --oneline
   ```
2. Checkout the previous release:
   ```bash
   git checkout v1.0.0
   ```
3. Rebuild and restart the container services:
   ```bash
   docker compose --env-file .env -f deploy/docker-compose.production.yml up -d --build --force-recreate api worker web
   ```
4. Confirm health:
   ```bash
   docker compose --env-file .env -f deploy/docker-compose.production.yml ps
   curl -f https://doplo.dev/ready
   ```
