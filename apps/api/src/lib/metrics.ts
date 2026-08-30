import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';

// Create a unified Prometheus Registry for Mini-Vercel
export const register = new Registry();

// Collect Node.js process / runtime metrics (memory, cpu, event loop lag, etc.)
collectDefaultMetrics({ register, prefix: 'mini_vercel_' });

// 1. HTTP Request Counter & Duration Histogram
export const httpRequestCounter = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests processed by Mini-Vercel API',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// 2. Queue Wait Duration Histogram
export const queueWaitDuration = new Histogram({
  name: 'mini_vercel_queue_wait_duration_seconds',
  help: 'Duration a deployment job spent waiting in BullMQ before worker pickup',
  labelNames: ['queue_name'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [register],
});

// 3. Build Duration Histogram
export const buildDuration = new Histogram({
  name: 'mini_vercel_build_duration_seconds',
  help: 'Total build execution duration in seconds',
  labelNames: ['status', 'framework'],
  buckets: [1, 5, 10, 20, 30, 60, 120, 300, 600],
  registers: [register],
});

// 4. Deployments Total Counter & Active Gauge
export const deploymentsCounter = new Counter({
  name: 'mini_vercel_deployments_total',
  help: 'Total count of deployments categorized by terminal status (READY, FAILED, CANCELLED)',
  labelNames: ['status'],
  registers: [register],
});

export const activeDeploymentsGauge = new Gauge({
  name: 'mini_vercel_active_deployments_gauge',
  help: 'Current number of in-flight active deployments',
  registers: [register],
});

// 5. Artifact Fetch Duration Histogram
export const artifactFetchDuration = new Histogram({
  name: 'mini_vercel_artifact_fetch_duration_seconds',
  help: 'Latency of fetching immutable deployment build artifacts from MinIO storage',
  labelNames: ['status'],
  buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [register],
});

// 6. Log Delivery Events Counter
export const logDeliveryEventsCounter = new Counter({
  name: 'mini_vercel_log_delivery_events_total',
  help: 'Total number of live or replay log lines delivered via SSE stream',
  labelNames: ['stream_type'],
  registers: [register],
});

// 7. Queue Waiting & Active Jobs Gauges
export const queueWaitingJobsGauge = new Gauge({
  name: 'mini_vercel_queue_waiting_jobs_gauge',
  help: 'Number of deployment jobs currently waiting in queue',
  labelNames: ['queue_name'],
  registers: [register],
});

export const queueActiveJobsGauge = new Gauge({
  name: 'mini_vercel_queue_active_jobs_gauge',
  help: 'Number of deployment jobs currently actively processing',
  labelNames: ['queue_name'],
  registers: [register],
});

// 8. Dependency Up Health Status Gauge (1 = UP, 0 = DOWN)
export const dependencyUpGauge = new Gauge({
  name: 'mini_vercel_dependency_up_gauge',
  help: 'Health state of dependent backend infrastructure components (1 = UP, 0 = DOWN)',
  labelNames: ['dependency'],
  registers: [register],
});

// 9. Backup Last Success Timestamp Gauge
export const backupLastSuccessTimestamp = new Gauge({
  name: 'mini_vercel_backup_last_success_timestamp_seconds',
  help: 'Unix timestamp in seconds of the last successful backup completion',
  labelNames: ['target'],
  registers: [register],
});

// 10. Cleanup Operations Errors Counter
export const cleanupErrorsCounter = new Counter({
  name: 'mini_vercel_cleanup_errors_total',
  help: 'Total count of errors encountered during background resource cleanup jobs',
  labelNames: ['component'],
  registers: [register],
});

/**
 * Fastify Plugin to register HTTP metrics hook and /metrics endpoint
 */
export const metricsPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Capture request duration on all routes
  app.addHook('onRequest', async (req) => {
    (req as any).metricsStartTime = process.hrtime();
  });

  app.addHook('onResponse', async (req, reply) => {
    const startTime = (req as any).metricsStartTime;
    if (startTime) {
      const diff = process.hrtime(startTime);
      const durationSeconds = diff[0] + diff[1] / 1e9;
      const route = req.routeOptions?.url || req.routerPath || req.url.split('?')[0] || 'unknown';
      const statusCode = reply.statusCode.toString();

      httpRequestCounter.inc({ method: req.method, route, status_code: statusCode });
      httpRequestDuration.observe({ method: req.method, route, status_code: statusCode }, durationSeconds);
    }
  });

  // Expose Prometheus Metrics format
  const metricsHandler = async (_req: any, reply: any) => {
    reply.header('Content-Type', register.contentType);
    return reply.send(await register.metrics());
  };

  app.get('/metrics', metricsHandler);
  app.get('/api/metrics', metricsHandler);
};

export enum AppErrorCode {
  DEPLOYMENT_NOT_FOUND = 'DEPLOYMENT_NOT_FOUND',
  PROJECT_NOT_FOUND = 'PROJECT_NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  BUILD_TIMEOUT = 'BUILD_TIMEOUT',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  DOCKER_ERROR = 'DOCKER_ERROR',
  STORAGE_ERROR = 'STORAGE_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  INVALID_INPUT = 'INVALID_INPUT',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}
