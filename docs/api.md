# PulseOps API Reference

Yerel base URL: `http://localhost:8081`

---

## Endpoints

### 1. Health Check
Checks operational status and latencies for PostgreSQL, Redis, and the API instance.

- **Method**: `GET`
- **Path**: `/health` or `/api/v1/health`
- **Response**: `200 OK` (or `503 Service Unavailable` if core storage down)

```bash
curl -X GET http://localhost:8081/health
```

#### Response Example
```json
{
  "status": "healthy",
  "timestamp": "2026-08-29T10:30:00Z",
  "uptime": "25m14s",
  "version": "v1.0.0",
  "services": {
    "api": {
      "status": "up",
      "message": "service operational"
    },
    "postgres": {
      "status": "up",
      "latency": "1.12ms",
      "message": "connected"
    },
    "redis": {
      "status": "up",
      "latency": "0.78ms",
      "message": "connected"
    }
  }
}
```

---

### 2. Trigger New Deployment
Enqueues a new build & deploy job onto the Redis queue and saves it to PostgreSQL.

- **Method**: `POST`
- **Path**: `/api/v1/deployments`
- **Headers**: `Content-Type: application/json`

```bash
curl -X POST http://localhost:8081/api/v1/deployments \
  -H "Content-Type: application/json" \
  -d '{
    "project_name": "ecommerce-storefront",
    "repo_url": "https://github.com/example/storefront",
    "branch": "main"
  }'
```

#### Response Example (`201 Created`)
```json
{
  "id": "dpl_3f8b91a2c4e5",
  "project_name": "ecommerce-storefront",
  "repo_url": "https://github.com/example/storefront",
  "branch": "main",
  "commit_hash": "a1b2c3d",
  "status": "QUEUED",
  "created_at": "2026-08-29T10:31:00Z",
  "updated_at": "2026-08-29T10:31:00Z"
}
```

---

### 3. List Deployments
Retrieves paginated list of recent deployments.

- **Method**: `GET`
- **Path**: `/api/v1/deployments?limit=10&offset=0`

```bash
curl -X GET "http://localhost:8081/api/v1/deployments?limit=10"
```

#### Response Example (`200 OK`)
```json
{
  "deployments": [
    {
      "id": "dpl_3f8b91a2c4e5",
      "project_name": "ecommerce-storefront",
      "repo_url": "https://github.com/example/storefront",
      "branch": "main",
      "commit_hash": "a1b2c3d",
      "status": "READY",
      "preview_url": "http://ecommerce-storefront-a1b2c3d.localhost",
      "build_duration_ms": 2700,
      "created_at": "2026-08-29T10:31:00Z",
      "started_at": "2026-08-29T10:31:01Z",
      "completed_at": "2026-08-29T10:31:03Z",
      "updated_at": "2026-08-29T10:31:03Z"
    }
  ],
  "count": 1,
  "limit": 10,
  "offset": 0
}
```

---

### 4. Get Deployment Details & Logs
Fetches a single deployment by ID along with its build logs.

- **Method**: `GET`
- **Path**: `/api/v1/deployments/{id}`

```bash
curl -X GET http://localhost:8081/api/v1/deployments/dpl_3f8b91a2c4e5
```

---

### 5. Get System Stats
Returns aggregate statistics regarding deployments and Redis queue backlog.

- **Method**: `GET`
- **Path**: `/api/v1/stats`

```bash
curl -X GET http://localhost:8081/api/v1/stats
```
