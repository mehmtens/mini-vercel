# 🚀 Mini-Vercel Monorepo

Mini-Vercel, modern web uygulamalarını derleyen, paketleyen, nesne deposunda (MinIO S3) saklayan ve dağıtım süreçlerini BullMQ kuyruk mimarisiyle arka planda asenkron olarak yürüten ölçeklenebilir bir mikro platformdur.

---

## 🏗️ Teknoloji Yığını & Mimarisi

- **Paket Yöneticisi:** `pnpm` Workspaces
- **Monorepo Build Sistemi:** `Turborepo`
- **Backend API:** Fastify 4 + TypeScript (`apps/api`)
- **Arka Plan İşleyici:** BullMQ + Redis + MinIO S3 (`apps/worker`)
- **Web Arayüzü:** Next.js 14 (App Router) + Tailwind CSS (`apps/web`)
- **Veritabanı & Önbellek:** PostgreSQL 16 + Redis 7
- **Nesne Depolama:** MinIO S3
- **Ters Proxy:** Caddy 2 (`deploy/caddy/Caddyfile`)
- **Birim & Entegrasyon Testleri:** Vitest

---

## 📂 Dizin Yapısı

```
mini-vercel/
├── apps/
│   ├── api/                 # Fastify REST API (/health, /api/v1/deployments, BullMQ Producer)
│   ├── web/                 # Next.js 14 Durum ve Dağıtım Paneli
│   └── worker/              # BullMQ Background Worker (Derleme Aşamaları, MinIO Yükleme)
├── packages/
│   ├── database/            # PostgreSQL bağlantı havuzu ve DAL
│   ├── crypto/              # SHA-256 hash, ID üretimi, HMAC imzalama
│   ├── types/               # Ortak TypeScript DTO ve arayüz tanımları
│   └── config/              # Ortak .env yapılandırma yöneticisi
├── deploy/
│   ├── docker-compose.yml   # PostgreSQL, Redis, MinIO ve Caddy İskeleti
│   └── caddy/               # Caddyfile yapılandırması
├── migrations/              # PostgreSQL şema dosyaları (000001_init_schema.up.sql)
├── docs/                    # Detaylı Mimari ve API dokümanları
│   ├── architecture.md
│   ├── api.md
│   └── queue.md
├── .eslintrc.json           # Paylaşılan ESLint yapılandırması
├── .prettierrc              # Paylaşılan Prettier biçimlendirme kuralları
├── turbo.json               # Turborepo işlem boru hattı
├── pnpm-workspace.yaml      # pnpm çalışma alanı tanımı
├── .env.example             # Çevre değişkenleri şablonu
└── README.md                # Proje dokümantasyonu
```

---

## 🛠️ Kurulum & Geliştirme

### 1. Bağımlılıkları Yükleme
```bash
pnpm install
```

### 2. Altyapı Servislerini Başlatma (Docker Compose)
PostgreSQL, Redis, MinIO ve Caddy servislerini başlatmak için:
```bash
# Servisleri arka planda başlatır
pnpm docker:up

# Servis durumunu doğrulamak için
pnpm docker:config

# Servisleri durdurmak için
pnpm docker:down
```

### 3. Kod Kalitesi & Test Komutları
```bash
# Tip kontrolü (Tüm paketler için)
pnpm typecheck

# Lint kontrolü
pnpm lint

# Otomatik biçimlendirme (Prettier)
pnpm format

# Birim ve entegrasyon testleri (Vitest)
pnpm test

# Tüm uygulamaları ve paketleri derleme
pnpm build

# Canlı geliştirme modunda çalıştırma
pnpm dev
```

---

## 📡 API Uç Noktaları

| Metod | Uç Nokta | Açıklama |
| :--- | :--- | :--- |
| `GET` | `/health` | API, Veritabanı, Redis ve MinIO sağlık/gecikme durumu |
| `GET` | `/api/v1/health` | Detaylı JSON servis sağlık yanıtı |
| `GET` | `/api/v1/deployments` | Son dağıtımları listeler |
| `POST` | `/api/v1/deployments` | Yeni dağıtım işi oluşturur ve BullMQ kuyruğuna ekler |
| `GET` | `/api/v1/deployments/:id` | Dağıtım detayını ve canlı logları getirir |
| `GET` | `/api/v1/stats` | Toplam proje, dağıtım ve başarı oranları |

---

## ⚙️ Çevre Değişkenleri (.env.example)

```env
NODE_ENV=development
API_PORT=8080
API_HOST=0.0.0.0

POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=mini_vercel
POSTGRES_PORT=5432
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mini_vercel

REDIS_PORT=6379
REDIS_URL=redis://localhost:6379

MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_USE_SSL=false
MINIO_BUCKET_BUILDS=mini-vercel-builds

QUEUE_NAME=deployment-queue
QUEUE_CONCURRENCY=5

NEXT_PUBLIC_API_URL=http://localhost:8080
```
