import { FastifyInstance } from 'fastify';
import { db } from '@mini-vercel/database';
import { StatsResponse } from '@mini-vercel/types';
import { deploymentQueue } from '../lib/queue';

export async function registerStatsRoutes(app: FastifyInstance) {
  const getStatsHandler = async (_req: any, reply: any) => {
    let stats: StatsResponse = {
      total_deployments: 0,
      active_queue_jobs: 0,
      status_counts: {},
      avg_build_time_ms: 0,
      success_rate: 100,
    };

    try {
      stats = await db.getStats();
    } catch (err) {
      app.log.error(err, 'Failed to fetch DB stats');
    }

    try {
      const waitingCount = await deploymentQueue.getWaitingCount();
      const activeCount = await deploymentQueue.getActiveCount();
      stats.active_queue_jobs = waitingCount + activeCount;
    } catch (err) {
      // Redis might be offline
    }

    return reply.send(stats);
  };

  app.get('/api/stats', getStatsHandler);
  app.get('/api/v1/stats', getStatsHandler);
}
