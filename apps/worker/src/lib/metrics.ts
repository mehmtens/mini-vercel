import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

export const workerRegister = new Registry();

collectDefaultMetrics({ register: workerRegister, prefix: 'doplo_worker_' });

export const workerBuildDuration = new Histogram({
  name: 'doplo_worker_build_duration_seconds',
  help: 'Total build execution duration in worker process',
  labelNames: ['status', 'framework'],
  buckets: [1, 5, 10, 20, 30, 60, 120, 300, 600],
  registers: [workerRegister],
});

export const workerDeploymentsCounter = new Counter({
  name: 'doplo_worker_deployments_total',
  help: 'Total number of deployments processed by worker',
  labelNames: ['status'],
  registers: [workerRegister],
});

export const workerActiveJobsGauge = new Gauge({
  name: 'doplo_worker_active_jobs_gauge',
  help: 'Number of active deployment build jobs currently executing',
  registers: [workerRegister],
});

export const workerQueueWaitDuration = new Histogram({
  name: 'doplo_worker_queue_wait_duration_seconds',
  help: 'Time spent in BullMQ queue before worker execution began',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [workerRegister],
});

export const workerCleanupErrorsCounter = new Counter({
  name: 'doplo_worker_cleanup_errors_total',
  help: 'Total number of errors encountered during cleanup tasks in worker',
  labelNames: ['component'],
  registers: [workerRegister],
});

import http from 'http';

/**
 * Starts an internal HTTP server for Prometheus metrics scraping on worker private network
 */
export function startWorkerMetricsServer(port: number = Number(process.env.WORKER_METRICS_PORT || 9090)): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      try {
        const metrics = await workerRegister.metrics();
        res.writeHead(200, { 'Content-Type': workerRegister.contentType });
        res.end(metrics);
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err?.message || 'Error collecting worker metrics');
      }
    } else if ((req.url === '/health' || req.url === '/healthz') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'worker' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[Worker Metrics] Internal Prometheus metrics server listening on http://0.0.0.0:${port}/metrics`);
  });

  return server;
}

