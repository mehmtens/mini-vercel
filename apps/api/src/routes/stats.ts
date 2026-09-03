import { FastifyInstance } from 'fastify';
import { db } from '@doplo/database';
import { StatsResponse } from '@doplo/types';
import { authenticateRequest } from '../lib/auth';

export async function registerStatsRoutes(app: FastifyInstance) {
  const getStatsHandler = async (req: any, reply: any) => {
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    let stats: StatsResponse = {
      total_deployments: 0,
      active_queue_jobs: 0,
      status_counts: {},
      avg_build_time_ms: 0,
      success_rate: 100,
    };

    try {
      stats = await db.getStats(user.id);
    } catch (err) {
      app.log.error(err, 'Failed to fetch DB stats');
    }

    return reply.send(stats);
  };

  app.get('/api/stats', getStatsHandler);
  app.get('/api/v1/stats', getStatsHandler);
}
