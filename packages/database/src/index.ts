import { PrismaClient } from '@prisma/client';
import { Pool, PoolConfig } from 'pg';
import { config } from '@mini-vercel/config';

import { transitionDeploymentState } from './state-machine';

// Re-export all Prisma client types and enums
export * from '@prisma/client';
export * from './state-machine';

// Global Prisma Singleton
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// PostgreSQL Raw Client & DAL for high performance and compatibility
export class Database {
  private pool: Pool;

  constructor(customConfig?: PoolConfig) {
    this.pool = new Pool({
      connectionString: customConfig?.connectionString || config.db.url,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ...customConfig,
    });
  }

  public getPool(): Pool {
    return this.pool;
  }

  public async ping(): Promise<{ latency: string; ok: boolean }> {
    const start = Date.now();
    try {
      await this.pool.query('SELECT 1');
      const latency = `${Date.now() - start}ms`;
      return { latency, ok: true };
    } catch {
      return { latency: '0ms', ok: false };
    }
  }

  public async getStats() {
    try {
      const totalDeployments = await prisma.deployment.count();
      const readyDeployments = await prisma.deployment.count({ where: { status: 'READY' } });
      const avgDuration = await prisma.deployment.aggregate({
        _avg: { buildDurationMs: true },
        where: { status: 'READY' },
      });

      const grouped = await prisma.deployment.groupBy({
        by: ['status'],
        _count: { status: true },
      });

      const status_counts: Record<string, number> = {};
      grouped.forEach((g) => {
        status_counts[g.status] = g._count.status;
      });

      return {
        total_deployments: totalDeployments,
        active_queue_jobs: 0,
        status_counts,
        avg_build_time_ms: Math.round(avgDuration._avg.buildDurationMs || 0),
        success_rate: totalDeployments > 0 ? (readyDeployments / totalDeployments) * 100 : 100,
      };
    } catch {
      return {
        total_deployments: 0,
        active_queue_jobs: 0,
        status_counts: {},
        avg_build_time_ms: 0,
        success_rate: 100,
      };
    }
  }

  public async setDeploymentStarted(id: string): Promise<void> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) return;

    try {
      await transitionDeploymentState(prisma, {
        deploymentId: id,
        toStatus: 'BUILDING',
        eventMessage: 'Deployment build started',
      });
    } catch (err: any) {
      if (err?.name !== 'InvalidStateTransitionError') {
        console.warn(`[Database] Failed to set deployment started for ${id}:`, err.message);
      }
    }
  }

  public async updateDeploymentStatus(
    id: string,
    status: any,
    previewUrl?: string | null,
    durationMs?: number,
    errorMessage?: string | null
  ): Promise<void> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) return;

    try {
      await transitionDeploymentState(prisma, {
        deploymentId: id,
        toStatus: status,
        previewUrl,
        buildDurationMs: durationMs,
        errorMessage,
      });
    } catch (err: any) {
      if (err?.name !== 'InvalidStateTransitionError') {
        console.warn(`[Database] Failed to update deployment status for ${id}:`, err.message);
      }
    }
  }

  public async addBuildLog(data: {
    deployment_id: string;
    step: string;
    message: string;
    log_level?: string;
  }): Promise<void> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.deployment_id);
    if (!isUuid) return;

    try {
      const count = await prisma.deploymentLog.count({
        where: { deploymentId: data.deployment_id },
      });

      await prisma.deploymentLog.create({
        data: {
          deploymentId: data.deployment_id,
          logChunk: `[${data.step}] ${data.message}`,
          sequence: count + 1,
          stream: data.log_level === 'ERROR' ? 'STDERR' : 'STDOUT',
        },
      });
    } catch {}
  }

  public async close(): Promise<void> {
    await this.pool.end();
    await prisma.$disconnect();
  }
}

export const db = new Database();
