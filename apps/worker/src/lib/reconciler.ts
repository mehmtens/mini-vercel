import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { prisma, DeploymentStatus, LogStream, transitionDeploymentState } from '@doplo/database';
import { config } from '@doplo/config';
import crypto from 'crypto';

export interface ReconciliationResult {
  lockAcquired: boolean;
  inspectedCount: number;
  reconciledCount: number;
  skippedActiveCount: number;
  durationMs: number;
  error?: string;
}

/**
 * Reconciles stale deployments stuck in non-terminal states (QUEUED, INITIALIZING, CLONING, BUILDING, UPLOADING, DEPLOYING).
 * Uses a Redis distributed lock to ensure only one worker executes reconciliation.
 */
export async function reconcileStaleDeployments(
  redis: Redis,
  queue?: Queue,
  options?: {
    staleThresholdMs?: number;
    lockTtlMs?: number;
    workerId?: string;
  }
): Promise<ReconciliationResult> {
  const startTime = Date.now();
  const staleThresholdMs = options?.staleThresholdMs || config.queue.staleThresholdMs || 10 * 60 * 1000;
  const lockTtlMs = options?.lockTtlMs || config.queue.reconciliationLockTtlMs || 30 * 1000;
  const workerId = options?.workerId || `worker-${crypto.randomUUID()}`;
  const lockKey = 'worker:reconciliation:lock';

  let inspectedCount = 0;
  let reconciledCount = 0;
  let skippedActiveCount = 0;

  // 1. Acquire Redis distributed lock
  let lockAcquired = false;
  try {
    const lockRes = await redis.set(lockKey, workerId, 'PX', lockTtlMs, 'NX');
    lockAcquired = lockRes === 'OK';
  } catch (err: any) {
    console.warn('[Reconciliation] Failed to connect to Redis for distributed lock:', err?.message);
    return {
      lockAcquired: false,
      inspectedCount: 0,
      reconciledCount: 0,
      skippedActiveCount: 0,
      durationMs: Date.now() - startTime,
      error: err?.message,
    };
  }

  if (!lockAcquired) {
    console.log('[Reconciliation] Another worker holds the distributed lock. Skipping reconciliation.');
    return {
      lockAcquired: false,
      inspectedCount: 0,
      reconciledCount: 0,
      skippedActiveCount: 0,
      durationMs: Date.now() - startTime,
    };
  }

  try {
    const cutoffDate = new Date(Date.now() - staleThresholdMs);

    // 2. Query candidates: in-flight non-terminal statuses updated before cutoffDate
    const inFlightStatuses: DeploymentStatus[] = [
      DeploymentStatus.QUEUED,
      DeploymentStatus.INITIALIZING,
      DeploymentStatus.CLONING,
      DeploymentStatus.BUILDING,
      DeploymentStatus.UPLOADING,
      DeploymentStatus.DEPLOYING,
    ];

    const candidates = await prisma.deployment.findMany({
      where: {
        status: { in: inFlightStatuses },
        updatedAt: { lt: cutoffDate },
      },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        projectId: true,
      },
    });

    inspectedCount = candidates.length;

    for (const dep of candidates) {
      // 3. Heartbeat / active BullMQ job check
      // A. Check Redis heartbeat key
      let heartbeat: string | null = null;
      try {
        heartbeat = await redis.get(`deployment:heartbeat:${dep.id}`);
      } catch (redisErr: any) {
        console.warn(`[Reconciliation] Could not read heartbeat for ${dep.id}:`, redisErr?.message);
      }

      if (heartbeat) {
        skippedActiveCount++;
        continue;
      }

      // B. Check BullMQ queue state if queue instance provided
      if (queue) {
        try {
          const job = await queue.getJob(dep.id);
          if (job) {
            const isActive = await job.isActive();
            const isWaiting = await job.isWaiting();
            const isDelayed = await job.isDelayed();
            if (isActive || isWaiting || isDelayed) {
              skippedActiveCount++;
              continue;
            }
          }
        } catch (queueErr: any) {
          console.warn(`[Reconciliation] Queue check error for ${dep.id}:`, queueErr?.message);
        }
      }

      // 4. Atomic state transition to FAILED with error code
      const isQueued = dep.status === DeploymentStatus.QUEUED;
      const errorCode = isQueued
        ? 'ERR_RECONCILIATION_UNENQUEUED_TIMEOUT'
        : 'ERR_RECONCILIATION_STALE_TIMEOUT';
      const errorMessage = isQueued
        ? `ERR_RECONCILIATION_UNENQUEUED_TIMEOUT: Deployment remained queued for >${Math.round(
            staleThresholdMs / 1000
          )}s without an active queue job`
        : `ERR_RECONCILIATION_STALE_TIMEOUT: Build process timed out in ${dep.status} or worker crashed unexpectedly`;

      try {
        const result = await transitionDeploymentState(prisma, {
          deploymentId: dep.id,
          toStatus: DeploymentStatus.FAILED,
          expectedStatus: inFlightStatuses,
          errorMessage,
          eventMessage: `[RECONCILIATION] Stale deployment marked FAILED (exceeded ${Math.round(
            staleThresholdMs / 1000
          )}s threshold without active worker heartbeat in status ${dep.status})`,
          logMessage: `[ERROR] [${errorCode}] Stale deployment detected in status ${dep.status}. Marked as FAILED during reconciliation.`,
          logStream: LogStream.STDERR,
        });

        if (result.success && !result.skippedDueToTerminal) {
          reconciledCount++;
        }
      } catch (transErr: any) {
        console.error(`[Reconciliation] Failed to reconcile deployment ${dep.id}:`, transErr?.message);
      }
    }

    console.log(
      `[Reconciliation] Finished: inspected ${inspectedCount}, reconciled ${reconciledCount}, skipped active ${skippedActiveCount} in ${
        Date.now() - startTime
      }ms`
    );

    return {
      lockAcquired: true,
      inspectedCount,
      reconciledCount,
      skippedActiveCount,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    console.error('[Reconciliation] Error during reconciliation execution:', err);
    return {
      lockAcquired: true,
      inspectedCount,
      reconciledCount,
      skippedActiveCount,
      durationMs: Date.now() - startTime,
      error: err?.message,
    };
  } finally {
    // 5. Release distributed lock safely
    try {
      const releaseScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await redis.eval(releaseScript, 1, lockKey, workerId);
    } catch (releaseErr: any) {
      console.warn('[Reconciliation] Failed to release distributed lock:', releaseErr?.message);
    }
  }
}
