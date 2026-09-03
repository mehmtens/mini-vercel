# Doplo — Uygulama ve Geliştirme Roadmap'i

> Amaç: GitHub deposundan kaynak kodu alıp güvenli bir sandbox içinde build eden, canlı log gösteren, preview URL üreten ve hızlı rollback sağlayan tek sunuculu bir PaaS geliştirmek.

## 1. Kesin teknoloji kararları

Bu roadmap boyunca teknoloji değiştirilmez:

| Katman | Teknoloji |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Web arayüzü | Next.js + TypeScript + Tailwind CSS |
| API | Node.js + TypeScript + Fastify |
| Worker | Node.js + TypeScript + BullMQ |
| Veritabanı | PostgreSQL 16 |
| Kuyruk / geçici log akışı | Redis 7 |
| ORM | Prisma |
| Build | Nixpacks + Docker Engine API |
| Artifact depolama | MinIO (S3 uyumlu) |
| Reverse proxy / TLS | Caddy v2 |
| Yerel ve ilk production kurulumu | Docker Compose |
| Test | Vitest + Playwright |

### MVP dışında kalanlar

- Kubernetes, Kafka, multi-region ve mikroservis parçalama
- Serverless functions ve edge runtime
- Otomatik ölçeklenen çoklu worker sunucusu
- Faturalandırma ve marketplace
- Her programlama dilini destekleme

İlk MVP statik siteleri destekler: Vite, React, Vue, Astro ve Next.js static export. Node.js SSR desteği, statik deployment akışı kararlı olduktan sonra eklenir.

## 2. Antigravity ve Antigravity IDE ayrımı

### Antigravity ne için kullanılacak?

- Mimariyi ve gereksinimleri düşünmek
- Alternatifleri karşılaştırmak
- Threat model, test planı ve doküman hazırlamak
- Bir sonraki IDE görevine açık kabul kriterleri üretmek
- Tamamlanan fazı denetlemek

### Antigravity IDE ne için kullanılacak?

- Repository içinde klasör ve dosya oluşturmak
- Kod, migration, Docker ve CI dosyalarını yazmak
- Paket kurmak ve komut çalıştırmak
- Testleri çalıştırıp hataları düzeltmek
- Gerçek çalışan çıktıyı doğrulamak

### Her IDE promptuna uygulanacak ortak kural

Her Antigravity IDE promptunun sonuna şu metni ekle:

```text
Mevcut repository'yi önce incele ve çalışan kodu gereksiz yere yeniden yazma.
İstenen değişiklikleri dosyalara gerçekten uygula. Placeholder, TODO veya sahte implementasyon bırakma.
Gerekli lint, typecheck, unit ve integration testlerini çalıştır; oluşan hataları düzelt.
Secret değer üretme veya commit etme; yalnızca .env.example kullan.
Sonunda değişen dosyaları, çalıştırılan kontrolleri, sonuçları ve kalan riskleri özetle.
```

## 3. Fazların genel sırası

- [ ] Faz 0 — Yerel ortam ve boş proje
- [ ] Faz 1 — Monorepo ve çalışan servis iskeleti
- [ ] Faz 2 — PostgreSQL veri modeli ve temel API
- [ ] Faz 3 — Redis, BullMQ ve deployment state machine
- [ ] Faz 4 — GitHub OAuth, GitHub App ve webhook
- [ ] Faz 5 — Güvenli build runner
- [ ] Faz 6 — Artifact yükleme ve preview deployment
- [ ] Faz 7 — Canlı loglar ve dashboard
- [ ] Faz 8 — Production pointer ve rollback
- [ ] Faz 9 — Domain, Caddy ve TLS
- [ ] Faz 10 — Güvenlik sertleştirmesi
- [ ] Faz 11 — Observability, backup ve operasyon
- [ ] Faz 12 — Test, chaos ve production yayını
- [ ] Faz 13 — MVP sonrası geliştirmeler

---

## Faz 0 — Yerel ortam ve boş proje

### Hedef

Antigravity IDE'nin çalışacağı boş ana klasörü oluşturmak ve gerekli araçları doğrulamak.

### Senin yapacağın

- [ ] Bilgisayarda `doplo` isimli boş bir ana klasör oluştur.
- [ ] Bu klasörü Antigravity IDE ile aç.
- [ ] Git, Node.js LTS, pnpm ve Docker Desktop'ın kurulu olduğundan emin ol.
- [ ] Docker Desktop'ı çalıştır.

Alt klasörleri kendin oluşturma; IDE oluşturacak.

### Antigravity promptu

```text
Doplo projesinin yerel geliştirme ön koşulları için kısa bir kontrol listesi hazırla.
Windows üzerinde Git, Node.js LTS, pnpm, Docker Desktop ve WSL2 gereksinimlerini belirt.
Her araç için doğrulama komutunu ve beklenen sonucu yaz. Henüz kod üretme.
```

### Antigravity IDE promptu

```text
Bu boş klasörün Doplo projesi için uygun olup olmadığını kontrol et.
Git, Node.js, pnpm ve Docker sürümlerini doğrula. Eksik araç varsa dosya oluşturmadan önce bildir.
Her şey uygunsa Git repository başlat ve yalnızca temel .gitignore dosyasını oluştur.
```

### Tamamlanma ölçütü

- [ ] IDE doğru klasörü açmış durumda.
- [ ] Git, Node.js, pnpm ve Docker komutları çalışıyor.
- [ ] Repository oluşturuldu.

---

## Faz 1 — Monorepo ve çalışan servis iskeleti

### Hedef

API, web, worker ve altyapı servislerinin aynı repository'de ayağa kalkması.

### Antigravity promptu — proje iskeleti denetimi

```text
Node.js, Fastify, Next.js, BullMQ, PostgreSQL, Redis, MinIO ve Caddy kullanan Doplo için
pnpm workspace ve Turborepo klasör yapısını tasarla. Paket sınırlarını, bağımlılık yönlerini,
portları ve health check'leri belirt. Çıktıyı IDE'nin uygulayabileceği kabul kriterlerine dönüştür.
```

### Antigravity IDE promptu — iskeleti oluştur

```text
Doplo pnpm monorepo'sunu oluştur:

apps/api
apps/web
apps/worker
packages/database
packages/crypto
packages/types
packages/config
deploy/caddy
docs

Turborepo, ortak TypeScript/ESLint/Prettier ayarları ve workspace scriptleri ekle.
Fastify API'de GET /health endpoint'i, Next.js'te basit durum sayfası ve BullMQ worker'da
başlangıç health log'u oluştur. PostgreSQL, Redis ve MinIO için deploy/docker-compose.yml yaz.
Caddy'yi bu fazda yalnızca yapılandırma iskeleti olarak ekle. .env.example ve README oluştur.
pnpm install, lint, typecheck, test ve docker compose config kontrollerini çalıştır.
```

### Tamamlanma ölçütü

- [ ] `pnpm install` çalışıyor.
- [ ] Tüm workspace paketleri build oluyor.
- [ ] PostgreSQL, Redis ve MinIO Docker Compose ile healthy oluyor.
- [ ] API `/health` çağrısı `200` döndürüyor.
- [ ] Web arayüzü açılıyor.
- [ ] Gerçek secret repository'ye yazılmıyor.

---

## Faz 2 — PostgreSQL veri modeli ve temel API

### Hedef

Kullanıcı, proje, environment variable ve deployment kayıtlarının kalıcı yönetimi.

### Antigravity promptu — veri modeli

```text
Doplo MVP için users, projects, project_env_vars, deployments, deployment_events ve
deployment_logs veri modelini incele. UUID anahtarları, foreign key'ler, unique constraint'ler,
indeksler, timestamp'ler ve silme davranışlarını tanımla. Deployment durumlarını ayrıca açıkla.
Prisma şemasının kabul kriterlerini ve riskli migration senaryolarını yaz.
```

### Antigravity IDE promptu — Prisma ve migration

```text
packages/database içinde Prisma'yı PostgreSQL ile kur. User, Project, ProjectEnvVar, Deployment,
DeploymentEvent ve DeploymentLog modellerini oluştur. Uygun relation, unique constraint ve
indeksleri ekle. İlk migration'ı üret. Seed script yalnızca development ortamında örnek veri eklesin.
Migration ve database integration testlerini çalıştır.
```

### Antigravity IDE promptu — proje API'si

```text
Fastify API'ye proje oluşturma, listeleme, görüntüleme, güncelleme ve silme endpoint'leri ekle.
Zod veya Fastify JSON Schema ile request/response validation uygula. Hataları ortak bir formatta
döndür. Pagination ekle. Database erişimini route'lardan ayır ve service/repository katmanı kullan.
Henüz gerçek auth yoksa development-only test kullanıcısını açık biçimde sınırla. API testlerini yaz.
```

### Antigravity IDE promptu — environment variable şifreleme

```text
packages/crypto içinde AES-256-GCM tabanlı encrypt/decrypt modülü oluştur.
Her değer için benzersiz nonce kullan, authentication tag'i sakla ve anahtarı yalnızca ortam
değişkeninden al. API'de project environment variable CRUD ekle; listelerken değerleri asla döndürme.
Loglara secret yazılmadığını test et. Anahtar eksik veya hatalıysa fail-closed davran.
```

### Tamamlanma ölçütü

- [ ] Migration temiz veritabanında uygulanıyor.
- [ ] Proje CRUD endpoint'leri test ediliyor.
- [ ] Environment variable değerleri düz metin saklanmıyor.
- [ ] API validation ve ortak hata formatı mevcut.

---

## Faz 3 — Redis, BullMQ ve deployment state machine

### Hedef

Deployment taleplerinin güvenilir ve tekrarlanabilir biçimde kuyruğa alınması.

### Durumlar

`QUEUED → INITIALIZING → CLONING → BUILDING → UPLOADING → DEPLOYING → READY`

Terminal durumlar: `READY`, `FAILED`, `CANCELLED`.

### Antigravity promptu — state machine

```text
Doplo deployment state machine'ini tasarla. Her durum için izin verilen sonraki durumları,
giriş/çıkış koşullarını, timeout'u, retry politikasını ve hata kodlarını tablo halinde yaz.
Duplicate webhook, worker crash, Redis kesintisi ve aynı job'ın iki kez teslim edilmesi durumlarında
idempotency stratejisini açıkla. IDE için test matrisi üret.
```

### Antigravity IDE promptu — BullMQ kuyruğu

```text
Redis ve BullMQ ile build-queue ve cleanup-queue oluştur. API deployment kaydını transaction içinde
oluştursun ve job'ı benzersiz deployment ID ile kuyruğa eklesin. Worker concurrency, exponential
backoff, maksimum retry, timeout ve failed-job retention ayarlarını ekle. Graceful shutdown uygula.
Duplicate job ve retry davranışları için integration test yaz.
```

### Antigravity IDE promptu — state machine kodu

```text
Deployment state machine'i ortak typed modül olarak uygula. Geçersiz durum geçişlerini reddet.
Her geçişte deployment kaydını optimistic concurrency ile güncelle ve DeploymentEvent oluştur.
Worker yeniden başlasa bile terminal duruma gelmiş deployment tekrar çalışmasın.
Cancel endpoint'i ve stale job reconciliation görevi ekle. Tüm geçişleri unit test ile doğrula.
```

### Tamamlanma ölçütü

- [ ] API deployment oluşturup job kuyruğa alıyor.
- [ ] Worker job'ı yalnızca bir kez etkili biçimde işliyor.
- [ ] Durum geçmişi veritabanında tutuluyor.
- [ ] Retry, cancel ve stale-job testleri geçiyor.

---

## Faz 4 — GitHub OAuth, GitHub App ve webhook

### Hedef

Kullanıcının GitHub ile giriş yapması, repository seçmesi ve push ile build tetiklemesi.

### Senin yapacağın

- [ ] GitHub'da OAuth App veya GitHub App oluştur.
- [ ] Callback ve webhook URL'lerini development ortamına göre tanımla.
- [ ] Client ID, client secret ve webhook secret'ı `.env` içine koy; commit etme.

### Antigravity promptu — GitHub güvenlik planı

```text
Doplo için GitHub App ve OAuth entegrasyon planı hazırla. Gerekli minimum izinleri,
installation akışını, callback güvenliğini, state/PKCE kullanımını, webhook HMAC doğrulamasını,
delivery ID ile replay/duplicate korumasını ve token saklama politikasını tanımla.
```

### Antigravity IDE promptu — OAuth ve session

```text
GitHub OAuth login/callback/logout akışını uygula. State doğrulaması, güvenli HttpOnly/Secure/SameSite
cookie ve server-side session kullan. Kullanıcıyı PostgreSQL'de upsert et. Development ve production
cookie ayarlarını ayır. Auth middleware ve yetkisiz erişim testlerini ekle.
```

### Antigravity IDE promptu — GitHub App ve webhook

```text
GitHub App installation kayıtlarını ve repository listelemeyi uygula. Installation token'larını
kalıcı düz metin saklama; gerektiğinde kısa ömürlü üret. POST /webhooks/github endpoint'inde ham body
üzerinden X-Hub-Signature-256 doğrula. Delivery ID'yi idempotency için kaydet. Yalnızca seçili branch
push event'inden deployment oluştur. Geçersiz imza ve duplicate delivery testlerini yaz.
```

### Tamamlanma ölçütü

- [ ] GitHub login/logout çalışıyor.
- [ ] Kullanıcı yalnızca yetkili repository'leri görüyor.
- [ ] Geçersiz webhook imzası reddediliyor.
- [ ] Aynı delivery iki deployment oluşturmuyor.

---

## Faz 5 — Güvenli build runner

### Hedef

Güvenilmeyen kullanıcı kodunu sınırlı, geçici Docker container içinde build etmek.

### Kritik güvenlik sınırı

Build container'a Docker socket bağlanmaz. Docker socket'e yalnızca ayrı worker erişir. Tek sunuculu Docker socket modeli güçlü bir güvenlik sınırı değildir; public ve düşmanca kod çalıştırılacak production ortamında worker'ı ayrı VM üzerinde çalıştırmak gerekir.

### Antigravity promptu — tehdit modeli

```text
Docker Engine ve Nixpacks kullanan build runner için threat model oluştur. Host escape, Docker socket,
SSRF, cloud metadata, fork bomb, disk exhaustion, symlink, secret leakage, malicious archive,
dependency script ve log injection risklerini incele. Her risk için uygulanabilir kontrol ve test yaz.
```

### Antigravity IDE promptu — clone katmanı

```text
Worker'a güvenli repository checkout ekle. Yalnızca izin verilen GitHub repository ve kesin commit SHA
çekilsin. Shallow clone kullan, submodule'ları varsayılan olarak kapat, maksimum repository boyutu ve
clone timeout'u uygula. Geçici çalışma dizinini job sonunda her durumda temizle. Tokenları loglama.
```

### Antigravity IDE promptu — sandbox build

```text
Nixpacks ile build planı üretip ephemeral Docker container içinde çalıştır. Container non-root olsun;
capabilities drop ALL, no-new-privileges, read-only root filesystem, tmpfs, 1 CPU, 1.5 GB RAM,
128 PID, 5 GB disk ve 600 saniye timeout uygula. Docker socket veya host path mount etme.
Private/internal IP aralıklarına ve metadata endpoint'ine erişimi engelle. Çıkış kodu, süre ve hata
sebebini state machine'e kaydet. Timeout, memory ve fork-bomb testleri ekle.
```

### Antigravity IDE promptu — secret masking

```text
Build log pipeline'ına secret masking ekle. Bilinen environment variable değerlerini log yayılmadan
önce REDACTED ile değiştir. Çok kısa değerleri maskeleme kuralını güvenli biçimde belirle.
ANSI kontrol karakterlerini ve log injection girişimlerini normalize et. Unit testlerde secret'ın
Redis, PostgreSQL, API yanıtı ve konsol loguna sızmadığını doğrula.
```

### Tamamlanma ölçütü

- [ ] Basit Vite uygulaması sandbox içinde build oluyor.
- [ ] Timeout ve kaynak limitleri gerçekten çalışıyor.
- [ ] Job bitince container ve geçici dosyalar siliniyor.
- [ ] Build container Docker socket'e ve dahili servislere erişemiyor.
- [ ] Secret değerler loglarda görünmüyor.

---

## Faz 6 — Artifact yükleme ve preview deployment

### Hedef

Build çıktısını immutable olarak MinIO'ya yükleyip benzersiz preview URL ile sunmak.

### Antigravity promptu — artifact sözleşmesi

```text
Statik build artifact'leri için S3 key yapısı, manifest formatı, content-type, cache-control,
index.html fallback, immutable deployment ve cleanup/retention politikası tasarla.
Path traversal ve symlink risklerine karşı doğrulama kurallarını ekle.
```

### Antigravity IDE promptu — upload

```text
Worker'da output directory'yi güvenli biçimde doğrula ve dosyaları
artifacts/{projectId}/{deploymentId}/ prefix'i altında MinIO'ya yükle. MIME type ve cache-control
metadata'sını ayarla. Dosya sayısı ve toplam boyut limiti uygula. Manifest oluştur ve upload yarıda
kalırsa partial artifact'leri cleanup job ile sil. MinIO integration testleri yaz.
```

### Antigravity IDE promptu — artifact gateway

```text
Deployment artifact'lerini MinIO'dan güvenli biçimde sunan bir artifact gateway route'u oluştur.
Host bilgisinden deployment'ı çöz, yalnızca READY deployment'ın izin verilen prefix'ine eriş.
Path traversal'ı engelle, SPA fallback ve doğru content-type/cache header'larını uygula.
MinIO bucket'ını public yapma. Preview URL için uçtan uca test yaz.
```

### Tamamlanma ölçütü

- [ ] Her deployment farklı immutable prefix kullanıyor.
- [ ] MinIO bucket public değil.
- [ ] Preview URL statik siteyi açıyor.
- [ ] SPA route fallback çalışıyor.
- [ ] Partial upload cleanup ediliyor.

---

## Faz 7 — Canlı loglar ve dashboard

### Hedef

Kullanıcı build durumunu ve logları gerçek zamanlı izleyebilsin.

### Antigravity promptu — kullanıcı akışı

```text
Proje listesi, proje detay, deployment listesi, deployment detay ve canlı terminal ekranlarının
kullanıcı akışını tasarla. Loading, empty, reconnect, retry, cancelled ve failed durumlarının
metinlerini ve erişilebilirlik kabul kriterlerini yaz.
```

### Antigravity IDE promptu — log altyapısı

```text
Worker loglarını Redis Pub/Sub üzerinden yayınla ve kalıcı log chunk'larını PostgreSQL veya MinIO'ya
yaz. Fastify'da yetki kontrollü SSE endpoint'i oluştur. Last-Event-ID ile reconnect, heartbeat,
backpressure ve bağlantı cleanup desteği ekle. Terminal durumdan sonra geçmiş logların okunmasını sağla.
```

### Antigravity IDE promptu — dashboard

```text
Next.js dashboard'a proje ve deployment ekranlarını ekle. Deployment detayında durum zaman çizgisi,
commit bilgisi, süre, preview linki ve SSE canlı terminal göster. Reconnect ve error durumlarını yönet.
Mobil görünüm, klavye erişimi ve temel Playwright uçtan uca testlerini tamamla.
```

### Tamamlanma ölçütü

- [ ] Loglar sayfa yenilenmeden akıyor.
- [ ] Bağlantı kopunca devam edebiliyor.
- [ ] Kullanıcı başka projelerin loglarını göremiyor.
- [ ] Tamamlanan deployment logları daha sonra okunabiliyor.

---

## Faz 8 — Production pointer ve rollback

### Hedef

Yeni build almadan aktif deployment'ı atomik olarak değiştirmek.

### Antigravity promptu — rollback kuralları

```text
Immutable deployment ve project.currentDeploymentId modeliyle production promote ve rollback
akışını tasarla. Transaction, optimistic locking, audit event, concurrent promote, silinmiş artifact
ve başarısız health check senaryoları için kurallar ve test matrisi hazırla.
```

### Antigravity IDE promptu — promote/rollback

```text
READY deployment'ı production'a promote eden ve önceki READY deployment'a rollback yapan API'leri
uygula. currentDeploymentId değişimini transaction ve optimistic locking ile atomik yap.
Her işlem için actor, önceki/yeni deployment ve timestamp içeren audit event oluştur.
Concurrent promote ve rollback integration testlerini yaz.
```

### Tamamlanma ölçütü

- [ ] Promote ve rollback yeni build başlatmıyor.
- [ ] Pointer atomik değişiyor.
- [ ] Concurrent istekler tutarlı sonuç veriyor.
- [ ] İşlem audit geçmişinde görünüyor.

---

## Faz 9 — Domain, Caddy ve TLS

### Hedef

Preview ve production domainlerini HTTPS üzerinden güvenli sunmak.

### Senin yapacağın

- [ ] Gerçek bir domain edin.
- [ ] Wildcard DNS kaydını sunucuya yönlendir.
- [ ] Gerekirse DNS provider API token'ı oluştur; repository'ye koyma.

### Antigravity promptu — routing planı

```text
preview ve production hostname formatlarını belirle. Wildcard DNS, wildcard TLS, custom domain
doğrulama, certificate renewal, rate limit ve Caddy routing tasarımını yaz. On-Demand TLS abuse
riskini değerlendir ve ask endpoint/allowlist yaklaşımını belirt.
```

### Antigravity IDE promptu — Caddy entegrasyonu

```text
Caddy'yi web/API ve artifact gateway için reverse proxy olarak yapılandır. Development ortamında
yerel HTTP domainlerini, production'da HTTPS ve wildcard domainleri destekle. Güvenlik header'ları,
request body limitleri ve trusted proxy ayarları ekle. Caddy yapılandırmasını doğrula ve route smoke
testleri yaz. MinIO yönetim panelini internete açma.
```

### Antigravity IDE promptu — custom domain

```text
Project custom domain CRUD ve sahiplik doğrulaması ekle. Kullanıcıdan DNS TXT kaydı iste,
sunucu tarafında doğrula ve yalnızca doğrulanmış domaini Caddy allowlist'ine al.
Domain takeover, duplicate claim ve silme senaryolarını test et.
```

### Tamamlanma ölçütü

- [ ] Preview ve production URL'leri doğru deployment'ı açıyor.
- [ ] HTTPS sertifikası otomatik yönetiliyor.
- [ ] Rastgele domain için sertifika üretilemiyor.
- [ ] Custom domain sahipliği doğrulanıyor.

---

## Faz 10 — Güvenlik sertleştirmesi

### Antigravity promptu — güvenlik denetimi

```text
Doplo MVP'yi authentication, authorization, webhook, Docker runner, network, secrets,
artifact serving, TLS, dependency supply chain ve denial-of-service açısından denetle.
Bulgu başına severity, saldırı yolu, düzeltme ve doğrulama testi üret. Production blocker'ları ayır.
```

### Antigravity IDE promptu — uygulama güvenliği

```text
Tüm API route'larında authentication ve project ownership kontrolünü merkezileştir.
CSRF, CORS allowlist, secure headers, rate limit, body limit, input validation ve güvenli hata
mesajlarını uygula. GitHub token ve env secret'ları loglardan temizle. Authorization regression
testleri ve kötü niyetli input testleri ekle.
```

### Antigravity IDE promptu — supply chain

```text
CI'a dependency audit, secret scan, container image scan ve SBOM üretimi ekle.
Production image'larını non-root ve minimum base image ile oluştur. Lockfile kullanımını zorunlu yap.
Critical vulnerability olduğunda pipeline'ı durdur; false-positive istisnalarını belgeli ve süreli tut.
```

### Tamamlanma ölçütü

- [ ] Tenant authorization testleri geçiyor.
- [ ] Rate limit ve request limitleri uygulanıyor.
- [ ] Secret scan ve image scan CI'da çalışıyor.
- [ ] Production blocker güvenlik bulgusu kalmıyor.

---

## Faz 11 — Observability, backup ve operasyon

### Antigravity promptu — SLO ve runbook

```text
Doplo için deployment success rate, queue wait time, build duration, API availability,
artifact serving latency ve log delivery metriklerini tanımla. SLO, alert eşikleri ve Redis,
PostgreSQL, disk doluluğu, failed build spike için on-call runbook hazırla.
```

### Antigravity IDE promptu — telemetry

```text
API ve worker'a structured JSON log, request/deployment correlation ID, Prometheus metrics ve
OpenTelemetry trace ekle. Health/readiness endpoint'leri dependency durumunu doğru yansıtsın.
Dashboard ve alert kuralı dosyalarını deploy/observability altında oluştur.
```

### Antigravity IDE promptu — backup ve cleanup

```text
PostgreSQL ve MinIO için zamanlanmış backup, retention ve doğrulanmış restore akışı oluştur.
Eski preview deployment, orphan Docker container, geçici klasör, partial upload ve eski loglar için
idempotent cleanup job ekle. Önce dry-run modu ve güvenli sınırlar uygula. Restore tatbikatını belgele.
```

### Tamamlanma ölçütü

- [ ] Sorunlar correlation ID ile izlenebiliyor.
- [ ] Temel metrik ve alarmlar mevcut.
- [ ] Backup otomatik alınıyor.
- [ ] Restore gerçekten test edilmiş durumda.
- [ ] Disk tüketimi cleanup politikasıyla sınırlı.

---

## Faz 12 — Test, chaos ve production yayını

### Antigravity promptu — go/no-go planı

```text
Doplo MVP için production go/no-go checklist'i oluştur. Fonksiyonel test, güvenlik,
performans, backup/restore, observability, DNS/TLS ve rollback kriterlerini blocker/non-blocker
olarak sınıflandır. Redis kesintisi, worker crash, Docker timeout, MinIO kesintisi ve disk doluluğu
senaryolarında beklenen davranışı yaz.
```

### Antigravity IDE promptu — uçtan uca test

```text
Test fixture olarak küçük bir Vite repository kullan. GitHub webhook'tan başlayan ve READY preview
URL'de biten uçtan uca testi oluştur. Login, proje oluşturma, build logu, artifact serving, promote,
rollback, failed build ve cancel akışlarını Playwright/integration testleriyle doğrula.
```

### Antigravity IDE promptu — hata enjeksiyonu

```text
Yalnızca test ortamında Redis gecikmesi/kesintisi, worker process kill, build timeout,
MinIO upload hatası ve duplicate webhook senaryolarını kontrollü olarak çalıştır.
Deployment'ın yanlışlıkla READY olmadığını, retry veya FAILED durumuna geçtiğini ve kaynakların
temizlendiğini doğrula. Sonuçları docs/chaos-report.md dosyasına yaz.
```

### Antigravity IDE promptu — production paketi

```text
Tek sunuculu production Docker Compose paketini hazırla. Servis restart policy, health check,
resource limit, persistent volume, log rotation, migration job ve güvenli network ayrımını ekle.
Production .env.example ve adım adım deployment/rollback runbook'u yaz. Gerçek secret oluşturma.
docker compose config ve mümkün olan smoke testleri çalıştır.
```

### Production go/no-go kriterleri

- [ ] Temiz ortamda kurulum dokümanı çalışıyor.
- [ ] Webhook → build → upload → preview uçtan uca başarılı.
- [ ] Başarısız build yanlışlıkla yayınlanmıyor.
- [ ] Rollback test edildi.
- [ ] Secret sızıntısı testi geçiyor.
- [ ] Backup restore edildi.
- [ ] TLS yenileme ve DNS doğrulandı.
- [ ] Kritik güvenlik açığı bulunmuyor.
- [ ] Disk, RAM ve CPU alarmı mevcut.

---

## Faz 13 — MVP sonrası

Sadece MVP production'da kararlı çalıştıktan sonra:

- [ ] Node.js SSR deployment desteği
- [ ] Preview deployment TTL ve otomatik PR yorumu
- [ ] Takım/organizasyon ve gelişmiş RBAC
- [ ] Build cache optimizasyonu
- [ ] Kullanım kotaları ve ölçüm
- [ ] Worker'ı ayrı VM'ye taşıma
- [ ] Birden fazla worker node ve scheduler
- [ ] Managed PostgreSQL, Redis ve object storage
- [ ] Canary deployment
- [ ] Kubernetes'e geçiş değerlendirmesi

### Antigravity promptu — ölçekleme kararı

```text
Mevcut production metriklerine göre tek sunuculu Doplo mimarisinin darboğazlarını analiz et.
Kubernetes'e geçişi varsayma. Önce ayrı worker VM, managed database, managed object storage ve
horizontal worker seçeneklerini maliyet, güvenlik ve operasyon yükü açısından karşılaştır.
Ölçülebilir geçiş eşikleri öner.
```

## 4. İlk 14 günlük uygulama planı

| Gün | Hedef | Faz |
|---|---|---|
| 1 | Araç kontrolü ve monorepo iskeleti | 0–1 |
| 2 | Docker Compose ve health check'ler | 1 |
| 3 | Prisma şeması ve migration | 2 |
| 4 | Proje API'si ve env şifreleme | 2 |
| 5 | BullMQ queue ve worker | 3 |
| 6 | State machine ve idempotency | 3 |
| 7 | GitHub OAuth ve session | 4 |
| 8 | GitHub App ve webhook | 4 |
| 9 | Güvenli clone ve Nixpacks build | 5 |
| 10 | Sandbox limitleri ve secret masking | 5 |
| 11 | MinIO upload ve artifact gateway | 6 |
| 12 | SSE loglar ve dashboard | 7 |
| 13 | Promote, rollback ve Caddy routing | 8–9 |
| 14 | Uçtan uca test ve MVP demo | 10–12 |

Bu takvim hedef sırasını gösterir; bir fazın tamamlanma ölçütleri geçmeden sonraki faza geçilmez.

## 5. İlk çalıştırılacak prompt

Önce Antigravity'ye Faz 0'daki kontrol listesi promptunu ver. Araçlar zaten kuruluysa boş `doplo` klasörünü Antigravity IDE'de aç ve aşağıdaki promptu çalıştır:

```text
Bu boş klasörün Doplo projesi için uygun olup olmadığını kontrol et.
Git, Node.js, pnpm ve Docker sürümlerini doğrula. Eksik araç varsa dosya oluşturmadan önce bildir.
Her şey uygunsa Git repository başlat, temel .gitignore oluştur ve sonuçları özetle.

Mevcut repository'yi önce incele ve çalışan kodu gereksiz yere yeniden yazma.
İstenen değişiklikleri dosyalara gerçekten uygula. Placeholder, TODO veya sahte implementasyon bırakma.
Gerekli kontrolleri çalıştır; oluşan hataları düzelt. Secret değer üretme veya commit etme.
```
