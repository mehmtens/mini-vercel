import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@mini-vercel/database';
import Redis from 'ioredis';
import { config } from '@mini-vercel/config';
import { authenticateRequest } from '../lib/auth';

const MAX_PENDING_QUEUE = 500;

export async function registerLogRoutes(app: FastifyInstance) {
  const streamLogsHandler = async (
    req: FastifyRequest<{ Params: { id: string }; Querystring: { follow?: string; lastEventId?: string; 'last-event-id'?: string } }>,
    reply: FastifyReply
  ) => {
    // 1. Centralized Authentication and Ownership Check
    const user = await authenticateRequest(req, reply);
    if (!user) return;

    const { id } = req.params;

    const deployment = await prisma.deployment.findUnique({
      where: { id },
      include: { project: true },
    });

    // Tenant isolation: Return 404 if deployment doesn't exist or belongs to another user
    if (!deployment || deployment.project.userId !== user.id) {
      return reply.code(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: `Deployment "${id}" not found`,
      });
    }

    // 2. Set Server-Sent Events (SSE) headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    // Send connection established comment
    reply.raw.write(`: connected to deployment log stream for ${id}\n\n`);

    // 3. Extract Last-Event-ID for gapless replay
    const headerLastEventId = req.headers['last-event-id'] as string | undefined;
    const queryLastEventId = req.query?.lastEventId || req.query?.['last-event-id'];
    const rawLastEventId = headerLastEventId || queryLastEventId;
    const startSequence = rawLastEventId && !isNaN(Number(rawLastEventId)) ? parseInt(String(rawLastEventId), 10) : 0;

    let maxReplayedSequence = startSequence;
    const isTerminal = ['READY', 'FAILED', 'CANCELLED'].includes(deployment.status);
    const follow = req.query?.follow !== 'false';

    // Helper to format and safely write SSE events with backpressure tracking
    const pendingBuffer: string[] = [];
    let isDraining = false;

    const flushBuffer = () => {
      if (reply.raw.writableEnded) return;
      while (pendingBuffer.length > 0) {
        const item = pendingBuffer[0];
        const canContinue = reply.raw.write(item);
        pendingBuffer.shift();
        if (!canContinue) {
          reply.raw.once('drain', flushBuffer);
          return;
        }
      }
      isDraining = false;
    };

    const safeWrite = (formattedChunk: string) => {
      if (reply.raw.writableEnded) return;

      if (isDraining || pendingBuffer.length > 0) {
        if (pendingBuffer.length >= MAX_PENDING_QUEUE) {
          app.log.warn({ deploymentId: id }, 'SSE client backpressure buffer overflow, closing connection');
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: 'BUFFER_OVERFLOW', message: 'Client backpressure exceeded buffer limit' })}\n\n`);
          reply.raw.end();
          return;
        }
        pendingBuffer.push(formattedChunk);
        return;
      }

      const ok = reply.raw.write(formattedChunk);
      if (!ok) {
        isDraining = true;
        reply.raw.once('drain', flushBuffer);
      }
    };

    const writeLogEvent = (seq: number, dataPayload: string) => {
      safeWrite(`id: ${seq}\ndata: ${dataPayload}\n\n`);
    };

    // 4. Terminal Deployment Handling (No Redis subscriber needed)
    if (isTerminal || !follow) {
      const historicalLogs = await prisma.deploymentLog.findMany({
        where: {
          deploymentId: id,
          ...(startSequence > 0 ? { sequence: { gt: startSequence } } : {}),
        },
        orderBy: { sequence: 'asc' },
      });

      for (const log of historicalLogs) {
        const payload = JSON.stringify({
          id: log.id.toString(),
          deploymentId: log.deploymentId,
          sequence: log.sequence,
          logChunk: log.logChunk,
          stream: log.stream,
          timestamp: log.timestamp.toISOString(),
        });
        writeLogEvent(log.sequence, payload);
      }

      safeWrite(`event: end\ndata: ${JSON.stringify({ status: deployment.status, message: 'Log stream completed' })}\n\n`);
      reply.raw.end();
      return;
    }

    // 5. Active Deployment: Pre-subscribe to Redis to eliminate race conditions
    let subscriber: Redis | null = null;
    let keepAliveTimer: NodeJS.Timeout | null = null;
    let replayComplete = false;
    const preReplayBuffer: Array<{ sequence: number; rawMessage: string }> = [];

    let isCleanedUp = false;
    const cleanup = async () => {
      if (isCleanedUp) return;
      isCleanedUp = true;

      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }

      if (subscriber) {
        try {
          await subscriber.unsubscribe();
          await subscriber.quit();
        } catch {
          // Ignore subscriber teardown errors
        }
        subscriber = null;
      }
      pendingBuffer.length = 0;
      preReplayBuffer.length = 0;
    };

    req.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
    reply.raw.on('error', cleanup);

    try {
      subscriber = new Redis(config.redis.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
      await subscriber.connect();

      const channelName = `deployment:logs:${id}`;
      await subscriber.subscribe(channelName);

      subscriber.on('message', (channel, message) => {
        if (channel !== channelName || reply.raw.writableEnded) return;

        try {
          const parsed = JSON.parse(message);
          const seq = typeof parsed.sequence === 'number' ? parsed.sequence : null;

          if (!replayComplete) {
            // Buffer Redis events until PostgreSQL replay finishes
            preReplayBuffer.push({ sequence: seq ?? -1, rawMessage: message });
            return;
          }

          // Gapless deduplication: Skip if already replayed from DB or prior message
          if (seq !== null && seq <= maxReplayedSequence) {
            return;
          }

          if (seq !== null) {
            maxReplayedSequence = Math.max(maxReplayedSequence, seq);
          }

          writeLogEvent(seq ?? maxReplayedSequence + 1, message);

          // Check if message indicates terminal deployment transition
          if (parsed.terminal || ['READY', 'FAILED', 'CANCELLED'].includes(parsed.toStatus)) {
            safeWrite(`event: end\ndata: ${JSON.stringify({ status: parsed.toStatus || 'FINISHED', message: 'Log stream completed' })}\n\n`);
            reply.raw.end();
            cleanup();
          }
        } catch {
          safeWrite(`data: ${message}\n\n`);
        }
      });
    } catch (redisErr) {
      app.log.warn({ redisErr }, 'Failed to connect to Redis for live log streaming, falling back to DB poll');
    }

    // 6. Fetch and stream historical logs from DB
    const historicalLogs = await prisma.deploymentLog.findMany({
      where: {
        deploymentId: id,
        ...(startSequence > 0 ? { sequence: { gt: startSequence } } : {}),
      },
      orderBy: { sequence: 'asc' },
    });

    for (const log of historicalLogs) {
      if (log.sequence > maxReplayedSequence) {
        maxReplayedSequence = log.sequence;
      }

      const payload = JSON.stringify({
        id: log.id.toString(),
        deploymentId: log.deploymentId,
        sequence: log.sequence,
        logChunk: log.logChunk,
        stream: log.stream,
        timestamp: log.timestamp.toISOString(),
      });
      writeLogEvent(log.sequence, payload);
    }

    // Mark DB replay complete and drain buffered Redis events with deduplication
    replayComplete = true;

    for (const item of preReplayBuffer) {
      if (item.sequence !== -1 && item.sequence <= maxReplayedSequence) {
        // Skip duplicate
        continue;
      }

      if (item.sequence !== -1) {
        maxReplayedSequence = Math.max(maxReplayedSequence, item.sequence);
      }

      writeLogEvent(item.sequence !== -1 ? item.sequence : maxReplayedSequence + 1, item.rawMessage);
    }
    preReplayBuffer.length = 0;

    // Check if deployment transitioned to terminal state during setup
    const latestDepState = await prisma.deployment.findUnique({
      where: { id },
      select: { status: true },
    });

    if (latestDepState && ['READY', 'FAILED', 'CANCELLED'].includes(latestDepState.status)) {
      safeWrite(`event: end\ndata: ${JSON.stringify({ status: latestDepState.status, message: 'Log stream completed' })}\n\n`);
      reply.raw.end();
      cleanup();
      return;
    }

    // 7. Heartbeat ping every 15s to keep connection and intermediate proxies alive
    keepAliveTimer = setInterval(() => {
      if (!reply.raw.writableEnded) {
        safeWrite(`: ping\n\n`);
      }
    }, 15000);
  };

  // Register on both /api/deployments/:id/logs/stream and /api/v1/deployments/:id/logs/stream
  app.get('/api/deployments/:id/logs/stream', streamLogsHandler);
  app.get('/api/v1/deployments/:id/logs/stream', streamLogsHandler);
}
