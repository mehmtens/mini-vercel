# PulseOps

PulseOps, GitHub depolarındaki statik web uygulamalarını izole Docker sandbox'larında derleyen, canlı log yayınlayan, MinIO üzerinde immutable artifact saklayan ve hızlı promote/rollback sağlayan tek sunuculu bir PaaS'tır.

İlk MVP; Vite, React, Vue, Astro, düz statik siteler ve Next.js static export akışlarını hedefler. Node.js SSR, Kubernetes, multi-region ve serverless runtime bu sürümün kapsamı dışındadır.

## Teknoloji yığını

- Monorepo: pnpm 11 workspaces + Turborepo
- Dashboard: Next.js 16, React 19, TypeScript, Tailwind CSS
- API: Node.js 22, Fastify 5, Prisma
- Worker: Node.js 22, BullMQ, Nixpacks planlama, Docker Engine API
- Veri: PostgreSQL 16, Redis 7, MinIO
- Edge ve TLS: Caddy 2
- Test: Vitest, Playwright ve gerçek Docker build pipeline testleri

## Sistem akışı

```text
GitHub / Dashboard
        │
        ▼
Fastify API ──► PostgreSQL
        │
        ▼
Redis / BullMQ ──► Worker ──► izole Docker build
                                  │
                                  ▼
                              MinIO artifact
                                  │
                                  ▼
                         Caddy preview domain
```

Worker yaşam döngüsü:

```text
QUEUED → INITIALIZING → CLONING → BUILDING → UPLOADING → DEPLOYING → READY
```

Başarısız veya kullanıcı tarafından durdurulan işler `FAILED` / `CANCELLED` terminal durumlarına geçer. Promote ve rollback işlemleri yeni build oluşturmadan atomik deployment pointer değişimi yapar.

## Repository yapısı

```text
apps/api       Fastify API, GitHub OAuth/webhook, SSE, artifact gateway
apps/web       PulseOps yönetim paneli
apps/worker    BullMQ worker, Docker sandbox, artifact yükleme
packages       config, crypto, database ve ortak tip paketleri
deploy         local/production Compose, Caddy ve observability tanımları
scripts        preflight, smoke test, backup ve restore araçları
docs           mimari, API ve operasyon runbook'ları
```

## Yerel çalıştırma

Gereksinimler: Docker Desktop, Node.js `22.13+ <23` ve pnpm `11.22.0`.

```bash
git clone https://github.com/mehmtens/mini-vercel.git
cd mini-vercel
cp .env.example .env
pnpm install --frozen-lockfile
pnpm docker:up
```

Servisler hazır olduğunda:

- Dashboard: `http://localhost:3000`
- API: `http://localhost:8081`
- API readiness: `http://localhost:8081/ready`
- MinIO console: `http://localhost:9001`
- Caddy dashboard: `http://app.localhost`

Yerel geliştirmede `.env.example` içindeki `DEV_AUTH_BYPASS=true` demo kullanıcı oluşturur. Production'da bu değer kesinlikle `false` olmalıdır.

## Doğrulama

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --prod
docker compose -f deploy/docker-compose.yml config
```

`pnpm test`, `mini_vercel_test` adında izole bir veritabanı oluşturur, migration'ları uygular ve test sonunda veritabanını kaldırır. Normal `mini_vercel` veritabanına test verisi yazmaz.

## Temel API yolları

- `GET /health`: process liveness
- `GET /ready`: PostgreSQL, Redis ve MinIO readiness
- `GET|POST /api/projects`: proje yönetimi
- `GET|POST /api/deployments`: deployment yönetimi
- `GET /api/deployments/:id/logs/stream`: canlı SSE log akışı
- `POST /api/deployments/:id/promote`: production'a promote
- `POST /api/deployments/:id/rollback`: önceki artifact'a rollback
- `GET /metrics`: Prometheus metrikleri

Tam sözleşme için [`docs/api.md`](docs/api.md) dosyasına bakın.

## Production kurulumu

Production kurulumu gerçek domain, GitHub OAuth/Webhook bilgileri ve güçlü secret'lar gerektirir.

```bash
cp deploy/production.env.example .env
# .env içindeki tüm placeholder değerleri değiştirin
node scripts/production-preflight.mjs .env
docker compose --env-file .env -f deploy/docker-compose.production.yml config
docker compose --env-file .env -f deploy/docker-compose.production.yml up -d --build
```

Ayrıntılı sunucu, DNS, TLS, backup ve rollback adımları için [`docs/runbooks/production-deployment-and-rollback.md`](docs/runbooks/production-deployment-and-rollback.md) dosyasını kullanın. Gerçek `.env`, token, private key ve backup dosyaları Git'e eklenmemelidir.
