import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@mini-vercel/database';
import { config } from '@mini-vercel/config';
import { redisConnection } from '../lib/queue';
import { minioClient } from '../lib/minio';
import { dependencyUpGauge } from '../lib/metrics';
import fs from 'fs';
import path from 'path';

const startTime = Date.now();

/**
 * Resolves application version from environment variables or package.json metadata
 */
function resolveAppVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version) return pkg.version;
    }
  } catch {
    // ignore
  }
  return '0.1.0';
}

const VERSION = resolveAppVersion();

export interface ServiceHealthCheck {
  status: 'up' | 'down';
  responseTimeMs: number;
  message: string;
}

export interface ReadinessResponse {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptimeSeconds: number;
  version: string;
  checks: {
    postgres: ServiceHealthCheck;
    redis: ServiceHealthCheck;
    minio: ServiceHealthCheck;
  };
}

export interface LivenessResponse {
  status: 'ok';
  timestamp: string;
  uptimeSeconds: number;
  version: string;
  service: 'api';
}

/**
 * Bounds the caller's waiting time and safely catches late rejections to prevent unhandled rejection events.
 * NOTE: In JavaScript/Node.js, Promise.race does NOT cancel or abort underlying network sockets;
 * actual I/O cancellation relies on the client's native timeout settings (e.g. pg query timeout).
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });

  const safePromise = promise
    .then((res) => {
      if (timer) clearTimeout(timer);
      return res;
    })
    .catch((_err) => {
      if (timer) clearTimeout(timer);
      return fallback;
    });

  return Promise.race([safePromise, timeoutPromise]);
}

/**
 * Performs sanitized, timeout-protected check for PostgreSQL
 * Uses pool.query() with statement/query timeout so client checkout and release
 * are handled automatically by the driver, avoiding connection leaks.
 */
export async function checkPostgres(timeoutMs: number = 2000): Promise<ServiceHealthCheck> {
  const start = Date.now();
  try {
    const pool = db.getPool();
    // pool.query() automatically acquires client, executes query, and releases client
    const queryPromise = pool.query('SELECT 1');
    const res = await withTimeout(queryPromise, timeoutMs, null);
    const duration = Date.now() - start;

    if (res && (res as any).rows) {
      return { status: 'up', responseTimeMs: duration, message: 'PostgreSQL connection healthy' };
    }
    return { status: 'down', responseTimeMs: duration, message: 'PostgreSQL query timeout or failed' };
  } catch {
    return { status: 'down', responseTimeMs: Date.now() - start, message: 'PostgreSQL check failed' };
  }
}

/**
 * Performs sanitized check for Redis
 */
export async function checkRedis(timeoutMs: number = 2000): Promise<ServiceHealthCheck> {
  const start = Date.now();
  try {
    const pingPromise = (async () => {
      if (redisConnection.status === 'wait') {
        await redisConnection.connect();
      }
      return await redisConnection.ping();
    })();

    const res = await withTimeout(pingPromise, timeoutMs, null);
    const duration = Date.now() - start;

    if (res === 'PONG') {
      return { status: 'up', responseTimeMs: duration, message: 'Redis connection healthy' };
    }
    return { status: 'down', responseTimeMs: duration, message: 'Redis check timed out or failed' };
  } catch {
    return { status: 'down', responseTimeMs: Date.now() - start, message: 'Redis check failed' };
  }
}

/**
 * Performs lowest-permission sanitized check for MinIO
 * Uses bucketExists on the configured builds bucket.
 * If the bucket does not exist (bucketExists=false or NoSuchBucket), MinIO is considered NOT ready (down).
 * Note: Readiness endpoint never creates the bucket; bucket creation is part of bootstrap/init.
 */
export async function checkMinio(timeoutMs: number = 2000): Promise<ServiceHealthCheck> {
  const start = Date.now();
  const bucketName = config.minio.bucketBuilds;
  try {
    const existsPromise = minioClient.bucketExists(bucketName);
    const exists = await withTimeout(existsPromise, timeoutMs, null);
    const duration = Date.now() - start;

    if (exists === true) {
      return { status: 'up', responseTimeMs: duration, message: `MinIO storage healthy (bucket "${bucketName}" active)` };
    } else if (exists === false) {
      return { status: 'down', responseTimeMs: duration, message: `MinIO bucket "${bucketName}" not found` };
    } else {
      return { status: 'down', responseTimeMs: duration, message: 'MinIO ping timed out' };
    }
  } catch (err: any) {
    const duration = Date.now() - start;
    const errCode = err?.code || err?.name || '';
    if (errCode === 'NoSuchBucket') {
      return { status: 'down', responseTimeMs: duration, message: `MinIO bucket "${bucketName}" not found` };
    }
    return { status: 'down', responseTimeMs: duration, message: 'MinIO storage connection failed' };
  }
}

export const healthChecker = {
  checkPostgres,
  checkRedis,
  checkMinio,
};

export async function registerHealthRoutes(app: FastifyInstance) {
  /**
   * 1. GET /health & /healthz (Liveness Endpoint)
   * Signals that the Fastify process is alive.
   * NEVER returns 503 on database/redis/minio outage. Always returns 200 when API process is up.
   */
  const livenessHandler = async (_req: FastifyRequest, reply: FastifyReply) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const response: LivenessResponse = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds,
      version: VERSION,
      service: 'api',
    };
    return reply.status(200).send(response);
  };

  /**
   * 2. GET /health/ready & /ready (Readiness Endpoint)
   * Actively checks PostgreSQL, Redis, and MinIO connections with short timeouts.
   * Returns 200 if ALL dependencies (including MinIO build bucket) are up; 503 if ANY dependency is down.
   */
  const readinessHandler = async (_req: FastifyRequest, reply: FastifyReply) => {
    const [pgCheck, redisCheck, minioCheck] = await Promise.all([
      healthChecker.checkPostgres(2000),
      healthChecker.checkRedis(2000),
      healthChecker.checkMinio(2000),
    ]);

    dependencyUpGauge.set({ dependency: 'postgres' }, pgCheck.status === 'up' ? 1 : 0);
    dependencyUpGauge.set({ dependency: 'redis' }, redisCheck.status === 'up' ? 1 : 0);
    dependencyUpGauge.set({ dependency: 'minio' }, minioCheck.status === 'up' ? 1 : 0);

    const allHealthy = pgCheck.status === 'up' && redisCheck.status === 'up' && minioCheck.status === 'up';
    const anyHealthy = pgCheck.status === 'up' || redisCheck.status === 'up' || minioCheck.status === 'up';

    let overallStatus: 'ok' | 'degraded' | 'unhealthy' = 'ok';
    if (!allHealthy) {
      overallStatus = anyHealthy ? 'degraded' : 'unhealthy';
    }

    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const response: ReadinessResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptimeSeconds,
      version: VERSION,
      checks: {
        postgres: pgCheck,
        redis: redisCheck,
        minio: minioCheck,
      },
    };

    const statusCode = allHealthy ? 200 : 503;
    return reply.status(statusCode).send(response);
  };

  // Register liveness routes
  app.get('/health', livenessHandler);
  app.get('/healthz', livenessHandler);
  app.get('/api/health', livenessHandler);
  app.get('/api/v1/health', livenessHandler);

  // Register readiness routes
  app.get('/health/ready', readinessHandler);
  app.get('/health/readiness', readinessHandler);
  app.get('/ready', readinessHandler);
  app.get('/readyz', readinessHandler);
  app.get('/api/health/ready', readinessHandler);
  app.get('/api/v1/health/ready', readinessHandler);
}
