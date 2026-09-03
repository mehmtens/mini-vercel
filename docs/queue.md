# 📨 BullMQ Kuyruk ve Worker Mimarisi

Doplo, yüksek performanslı, asenkron ve güvenilir iş dağıtımı için **Redis** destekli **BullMQ** kuyruk motorunu kullanır.

---

## 1. Kuyruk Mimarisi

```
[apps/api Fastify Producer]
       │
       ▼ (Queue.add('build-and-deploy', payload))
┌────────────────────────────────────────────────────────┐
│             Redis 7 BullMQ Job Queue                   │
│         Kuyruk Adı: deployment-queue                   │
│  [İş N] ───► [İş 2] ───► [İş 1 (En Eski)]              │
└────────────────────────────────────────────────────────┘
       │
       ▼ (Worker Concurrency: 5)
[apps/worker Worker Pool]
       ├─ İş Parçacığı 1
       ├─ İş Parçacığı 2
       ├─ İş Parçacığı 3
       ├─ İş Parçacığı 4
       └─ İş Parçacığı 5
```

---

## 2. İş Yükü Şeması (`DeploymentJobPayload`)

```typescript
export interface DeploymentJobPayload {
  deployment_id: string;
  project_name: string;
  repo_url: string;
  branch: string;
  commit_hash: string;
  created_at: string;
}
```

---

## 3. Worker Derleme ve Dağıtım Adımları

1. **CLONE**: Belirtilen Git repository'si ve branch klonlanır.
2. **DEPENDENCIES**: `pnpm` paket yöneticisiyle bağımlılıklar çözülür ve önbelleğe alınır.
3. **COMPILE**: Desteklenen statik framework üretim paketi izole Docker sandbox'ında derlenir.
4. **STATIC_GEN**: Statik HTML ve optimize edilmiş asset'ler üretilir.
5. **MINIO_UPLOAD**: Üretilen statik dosyalar ve metadata S3 uyumlu MinIO bucket'ına (`doplo-builds/${deployment_id}/`) yüklenir.
6. **EDGE_DEPLOY**: Canlı önizleme URL'i (`https://${project_slug}-${short_commit}.${BASE_DOMAIN}`) yapılandırılır ve Caddy gateway'e bağlanır.
7. **SUCCESS**: PostgreSQL kaydı `READY` durumuna güncellenir ve toplam süre kaydedilir.

---

## 4. Zarif Kapanma (Graceful Shutdown)

Worker süreci `SIGINT` veya `SIGTERM` sinyali aldığında:
- Yeni iş kabulü durdurulur.
- Devam etmekte olan derleme işleri tamamlanır.
- Redis ve PostgreSQL bağlantıları güvenle sonlandırılır.
