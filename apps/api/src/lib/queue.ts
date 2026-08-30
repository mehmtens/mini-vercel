import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from '@mini-vercel/config';
import { DeploymentJobPayload } from '@mini-vercel/types';

export const redisConnection = new Redis(config.redis.url, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
});

export const deploymentQueue = new Queue<DeploymentJobPayload>(config.queue.name, {
  connection: redisConnection,
});

export async function pingRedis(): Promise<{ latency: string; ok: boolean }> {
  const start = Date.now();
  try {
    if (redisConnection.status === 'wait') {
      await redisConnection.connect();
    }
    const res = await redisConnection.ping();
    if (res === 'PONG') {
      return { latency: `${Date.now() - start}ms`, ok: true };
    }
    return { latency: '0ms', ok: false };
  } catch {
    return { latency: '0ms', ok: false };
  }
}
