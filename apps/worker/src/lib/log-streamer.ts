import Redis from 'ioredis';
import { prisma, LogStream } from '@doplo/database';
import { logSanitizer, LogSanitizer } from './log-sanitizer.js';

export interface BufferedLogItem {
  deploymentId: string;
  logChunk: string;
  stream: LogStream;
  sequence: number;
  timestamp: Date;
}

export class LogStreamer {
  private redis: Redis;
  private buffer: BufferedLogItem[] = [];
  private sequenceCounters = new Map<string, number>();
  private sanitizer: LogSanitizer;
  private isUuid = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

  constructor(redis: Redis, customSanitizer?: LogSanitizer) {
    this.redis = redis;
    this.sanitizer = customSanitizer || logSanitizer;
  }

  /**
   * Registers secret values to mask in logs
   */
  public addSecrets(secrets: string[]): void {
    this.sanitizer.addSecrets(secrets);
  }

  /**
   * Clears registered secrets
   */
  public clearSecrets(): void {
    this.sanitizer.clearSecrets();
  }

  /**
   * Initializes sequence counter from DB for a given deployment
   */
  public async initDeployment(deploymentId: string): Promise<void> {
    if (!this.isUuid(deploymentId)) {
      this.sequenceCounters.set(deploymentId, 0);
      return;
    }

    try {
      const count = await prisma.deploymentLog.count({
        where: { deploymentId },
      });
      this.sequenceCounters.set(deploymentId, count);
    } catch {
      this.sequenceCounters.set(deploymentId, 0);
    }
  }

  /**
   * Publishes a log chunk in real time to Redis Pub/Sub and buffers for DB batch write
   * Normalizes ANSI codes and masks secret credentials
   */
  public async log(
    deploymentId: string,
    rawLogChunk: string,
    stream: 'STDOUT' | 'STDERR' = 'STDOUT'
  ): Promise<void> {
    const sanitizedChunk = this.sanitizer.sanitize(rawLogChunk);
    if (!sanitizedChunk && rawLogChunk) return;

    const currentSeq = (this.sequenceCounters.get(deploymentId) || 0) + 1;
    this.sequenceCounters.set(deploymentId, currentSeq);

    const logStreamEnum: LogStream = stream === 'STDERR' ? LogStream.STDERR : LogStream.STDOUT;
    const now = new Date();

    const logItem: BufferedLogItem = {
      deploymentId,
      logChunk: sanitizedChunk,
      stream: logStreamEnum,
      sequence: currentSeq,
      timestamp: now,
    };

    // 1. Publish to Redis Pub/Sub in real-time
    try {
      const channel = `deployment:logs:${deploymentId}`;
      const payload = JSON.stringify({
        id: `${deploymentId}-${currentSeq}`,
        deploymentId,
        sequence: currentSeq,
        logChunk: sanitizedChunk,
        stream: logStreamEnum,
        timestamp: now.toISOString(),
      });
      await this.redis.publish(channel, payload);
    } catch {}

    // 2. Buffer for batched database persistence
    this.buffer.push(logItem);

    if (this.buffer.length >= 5) {
      await this.flush();
    }
  }

  /**
   * Flushes all buffered log chunks to PostgreSQL in a batch
   */
  public async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const itemsToFlush = [...this.buffer];
    this.buffer = [];

    // Filter valid UUIDs to avoid DB constraint failure on mock IDs
    const validItems = itemsToFlush.filter((item) => this.isUuid(item.deploymentId));
    if (validItems.length === 0) return;

    try {
      const deploymentIds = Array.from(new Set(validItems.map((i) => i.deploymentId)));
      const existingDeployments = await prisma.deployment.findMany({
        where: { id: { in: deploymentIds } },
        select: { id: true },
      });
      const existingIds = new Set(existingDeployments.map((d) => d.id));

      const persistableItems = validItems.filter((item) => existingIds.has(item.deploymentId));
      if (persistableItems.length === 0) return;

      await prisma.deploymentLog.createMany({
        data: persistableItems.map((item) => ({
          deploymentId: item.deploymentId,
          logChunk: item.logChunk,
          stream: item.stream,
          sequence: item.sequence,
          timestamp: item.timestamp,
        })),
        skipDuplicates: true,
      });
    } catch {
      // Fallback to safe sequential insert if batch insert encounters conflict
      for (const item of validItems) {
        try {
          const exists = await prisma.deployment.findUnique({
            where: { id: item.deploymentId },
            select: { id: true },
          });
          if (exists) {
            await prisma.deploymentLog.create({
              data: {
                deploymentId: item.deploymentId,
                logChunk: item.logChunk,
                stream: item.stream,
                sequence: item.sequence,
                timestamp: item.timestamp,
              },
            });
          }
        } catch {}
      }
    }
  }
}
