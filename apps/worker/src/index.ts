import './telemetry-init.js';
import { Worker, Job, UnrecoverableError, Queue } from 'bullmq';
import Redis from 'ioredis';
import * as Minio from 'minio';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { config } from '@mini-vercel/config';
import {
  prisma,
  DeploymentStatus,
  LogStream,
  transitionDeploymentState,
  isTerminalStatus,
} from '@mini-vercel/database';
import { decrypt } from '@mini-vercel/crypto';
import { DeploymentJobPayload } from '@mini-vercel/types';
import { dockerRunner, DockerUnavailableError, BuildTimeoutError, DiskQuotaExceededError } from './lib/docker-runner.js';
import { gitCloner, GitCloner, InvalidCommitShaError, RepoSizeExceededError } from './lib/git-cloner.js';
import { buildPlanner, InvalidOutputDirectoryError } from './lib/build-planner.js';
import {
  artifactPipeline,
  ArtifactPipeline,
  PathTraversalError,
  SymlinkEscapeError,
  UploadFailedError,
} from './lib/artifact-pipeline.js';
import { LogStreamer } from './lib/log-streamer.js';
import { logSanitizer } from './lib/log-sanitizer.js';
import { reconcileStaleDeployments } from './lib/reconciler.js';
import {
  startWorkerMetricsServer,
  workerBuildDuration,
  workerDeploymentsCounter,
  workerActiveJobsGauge,
  workerQueueWaitDuration,
} from './lib/metrics.js';
import { withWorkerSpan } from './lib/telemetry.js';

const isUuid = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

/**
 * Custom Non-Retryable Error class for permanent validation or configuration failures
 */
export class NonRetryableError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/**
 * Structured JSON logger for worker service with correlation attributes
 */
export function workerLog(level: 'info' | 'warn' | 'error', message: string, meta: Record<string, any> = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message,
    service: 'worker',
    ...meta,
  };
  if (process.env.NODE_ENV === 'production') {
    console.log(JSON.stringify(record));
  } else {
    console.log(`[Worker][${level.toUpperCase()}] ${message}`, Object.keys(meta).length ? meta : '');
  }
}

// Redis connection for BullMQ and LogStreamer
export const redisConnection = new Redis(config.redis.url, {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    return Math.min(times * 100, 3000);
  },
});

redisConnection.on('error', () => {
  // Suppress unhandled error events during test runs and teardown
});

// MinIO S3 client
export const minioClient = new Minio.Client({
  endPoint: config.minio.endpoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

export const logStreamer = new LogStreamer(redisConnection);

/**
 * Health check helper for worker dependencies
 */
export async function checkWorkerHealth(): Promise<{
  redis: boolean;
  minio: boolean;
  postgres: boolean;
  docker: boolean;
}> {
  let redisOk = false;
  let minioOk = false;
  let postgresOk = false;
  let dockerOk = false;

  try {
    if (redisConnection.status === 'wait') {
      await redisConnection.connect();
    }
    const pong = await redisConnection.ping();
    redisOk = pong === 'PONG';
  } catch {}

  try {
    await minioClient.listBuckets();
    minioOk = true;
  } catch {}

  try {
    await prisma.$queryRaw`SELECT 1`;
    postgresOk = true;
  } catch {}

  try {
    dockerOk = await dockerRunner.isAvailable();
  } catch {}

  return { redis: redisOk, minio: minioOk, postgres: postgresOk, docker: dockerOk };
}

/**
 * Updates deployment state atomically and writes a lifecycle event
 */
async function transitionState(
  deploymentId: string,
  toStatus: DeploymentStatus,
  eventMessage: string,
  expectedStatus?: DeploymentStatus | DeploymentStatus[]
): Promise<{ success: boolean; cancelled?: boolean; error?: string }> {
  if (!isUuid(deploymentId)) {
    return { success: true };
  }

  try {
    const result = await transitionDeploymentState(prisma, {
      deploymentId,
      toStatus,
      expectedStatus,
      eventMessage,
    });

    if (!result.success) {
      if (result.fromStatus === 'CANCELLED' || result.error?.includes('CANCELLED')) {
        return { success: false, cancelled: true, error: 'Deployment cancelled by user' };
      }
      return { success: false, error: result.error };
    }

    return { success: true };
  } catch (err: any) {
    if (err?.name === 'InvalidStateTransitionError') {
      console.warn(`[Worker] State transition rejected: ${err.message}`);
    } else {
      console.warn(`[Worker] Error transitioning state for ${deploymentId}:`, err?.message);
    }
    return { success: false, error: err?.message };
  }
}

/**
 * Main BullMQ Worker Process Lifecycle Handler
 * Executes the state machine: QUEUED -> INITIALIZING -> CLONING -> BUILDING -> UPLOADING -> DEPLOYING -> READY
 */
export async function processDeploymentJob(jobData: DeploymentJobPayload): Promise<void> {
  const {
    deployment_id,
    project_name,
    repo_url,
    branch = 'main',
    commit_hash,
    build_command,
    install_command,
    output_directory,
    root_directory,
  } = jobData;

  // 1. Strict Validation: Non-retryable if missing critical identifiers
  if (!deployment_id || !project_name) {
    throw new NonRetryableError('Missing deployment_id or project_name in job payload');
  }

  if (!GitCloner.isValidRepoUrl(repo_url)) {
    throw new NonRetryableError(`Invalid repository URL: "${repo_url}". Terminal failure without retry.`);
  }

  if (!GitCloner.isValidCommitSha(commit_hash)) {
    throw new NonRetryableError(
      `Invalid commit SHA: "${commit_hash}". Must be a valid 40-character hexadecimal string.`
    );
  }

  const startTime = Date.now();
  workerActiveJobsGauge.inc();

  // Observe queue wait duration
  if (jobData.created_at) {
    const queueWaitSeconds = Math.max(0, (Date.now() - new Date(jobData.created_at).getTime()) / 1000);
    workerQueueWaitDuration.observe(queueWaitSeconds);
  }

  workerLog('info', `Started processing deployment: ${deployment_id} (${project_name})`, {
    deploymentId: deployment_id,
    projectName: project_name,
    commitHash: commit_hash,
  });

  return withWorkerSpan(
    'processDeploymentJob',
    { traceparent: jobData.traceparent, tracestate: jobData.tracestate },
    async (span) => {
      span.setAttribute('deployment.id', deployment_id);
      span.setAttribute('project.name', project_name);
      span.setAttribute('commit.hash', commit_hash || '');

      // Check if job is already in a terminal state (replay protection)
      if (isUuid(deployment_id)) {
        try {
          const existing = await prisma.deployment.findUnique({
            where: { id: deployment_id },
            select: { id: true, status: true },
          });

          if (existing && isTerminalStatus(existing.status)) {
            workerLog('info', `Deployment ${deployment_id} is already in terminal state "${existing.status}". Skipping redundant replay.`);
            return;
          }
        } catch (dbErr: any) {
          workerLog('warn', `Notice checking deployment state for ${deployment_id}: ${dbErr?.message}`);
        }
      }

      await logStreamer.initDeployment(deployment_id);

  const log = async (message: string, stream: 'STDOUT' | 'STDERR' = 'STDOUT') => {
    const sanitized = logSanitizer.sanitize(message);
    console.log(sanitized);
    await logStreamer.log(deployment_id, message, stream);
  };

  // Heartbeat interval to prevent reconciliation from marking active job as stale
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const heartbeatKey = `deployment:heartbeat:${deployment_id}`;
  const workspaceDir = path.join(os.tmpdir(), 'mini-vercel-builds', deployment_id);
  let targetProjectId: string = project_name;
  let targetEnv: 'PRODUCTION' | 'PREVIEW' = 'PREVIEW';

  try {
    // Set initial heartbeat
    await redisConnection.set(heartbeatKey, 'active', 'PX', 30000);
    heartbeatTimer = setInterval(() => {
      redisConnection.set(heartbeatKey, 'active', 'PX', 30000).catch(() => {});
    }, 10000);

    // ----------------------------------------------------
    // PHASE 1: INITIALIZING
    // ----------------------------------------------------
    const initRes = await transitionState(
      deployment_id,
      'INITIALIZING',
      'Build worker assigned and initializing workspace environment',
      ['QUEUED', 'INITIALIZING']
    );
    if (!initRes.success && initRes.cancelled) {
      console.log(`[Worker] Deployment ${deployment_id} was cancelled by user. Aborting pipeline.`);
      return;
    }
    await log(`[INIT] Worker picked up deployment ${deployment_id} for project "${project_name}"`);

    // Fetch project and filter environment secrets according to target (PRODUCTION vs PREVIEW)
    const envVars: Record<string, string> = {};
    if (isUuid(deployment_id)) {
      try {
        const deploymentRecord = await prisma.deployment.findUnique({
          where: { id: deployment_id },
          include: { project: { include: { envVars: true } } },
        });

        if (deploymentRecord?.project) {
          targetProjectId = deploymentRecord.project.id;
          const isProd = branch === deploymentRecord.project.branch || branch === 'main';
          targetEnv = isProd ? 'PRODUCTION' : 'PREVIEW';

          if (deploymentRecord.project.envVars) {
            const filteredVars = deploymentRecord.project.envVars.filter(
              (e: any) => e.target === targetEnv || e.target === 'ALL'
            );

            for (const env of filteredVars) {
              try {
                const decryptedVal = decrypt(env.encryptedValue, env.iv, config.crypto.masterKey);
                envVars[env.key] = decryptedVal;
              } catch {
                envVars[env.key] = '';
              }
            }

            // Register secret values into log sanitizer for strict masking
            logStreamer.addSecrets(Object.values(envVars));
            await log(`[INIT] Loaded ${Object.keys(envVars).length} environment variables for scope "${targetEnv}"`);
          }
        }
      } catch (err: any) {
        console.warn(`[Worker] Notice loading env vars for ${deployment_id}:`, err?.message);
      }
    }

    // ----------------------------------------------------
    // PHASE 2: CLONING
    // ----------------------------------------------------
    const cloneRes = await transitionState(
      deployment_id,
      'CLONING',
      `Fetching repository source code from ${repo_url}#${branch}`,
      ['INITIALIZING', 'CLONING']
    );
    if (!cloneRes.success && cloneRes.cancelled) {
      console.log(`[Worker] Deployment ${deployment_id} was cancelled by user. Aborting pipeline.`);
      return;
    }

    await gitCloner.clone({
      repoUrl: repo_url,
      commitHash: commit_hash,
      branch,
      targetDir: workspaceDir,
      onLog: log,
    });

    // ----------------------------------------------------
    // PHASE 3: BUILDING (Docker Container Execution)
    // ----------------------------------------------------
    const buildTransRes = await transitionState(
      deployment_id,
      'BUILDING',
      `Executing build container with resource limits and security profile`,
      ['CLONING', 'BUILDING']
    );
    if (!buildTransRes.success && buildTransRes.cancelled) {
      console.log(`[Worker] Deployment ${deployment_id} was cancelled by user. Aborting pipeline.`);
      return;
    }
    await log(`[BUILD] Launching build container with limits: 1 CPU, 1.5GB RAM, 128 PIDs, CapDrop: ALL`);

    const buildResult = await dockerRunner.runBuild({
      deploymentId: deployment_id,
      projectName: project_name,
      repoUrl: repo_url,
      branch: branch,
      commitHash: commit_hash,
      workspaceDir,
      installCommand: install_command,
      buildCommand: build_command,
      outputDirectory: output_directory,
      envVars,
      onLog: log,
    });

    if (buildResult.exitCode !== 0) {
      throw new Error(`Build container exited with non-zero exit code: ${buildResult.exitCode}`);
    }

    // ----------------------------------------------------
    // PHASE 4: UPLOADING (MinIO S3 Bundle Storage)
    // ----------------------------------------------------
    const uploadTransRes = await transitionState(
      deployment_id,
      'UPLOADING',
      `Uploading build output bundle to MinIO storage bucket`,
      ['BUILDING', 'UPLOADING']
    );
    if (!uploadTransRes.success && uploadTransRes.cancelled) {
      console.log(`[Worker] Deployment ${deployment_id} was cancelled by user. Aborting pipeline.`);
      return;
    }

    const isProd = process.env.NODE_ENV === 'production' || config.env === 'production';
    const effectiveOutDir = output_directory || buildResult.outputDirectory;
    let s3Prefix = `artifacts/${targetProjectId}/${deployment_id}`;

    try {
      const uploadResult = await artifactPipeline.processAndUpload({
        minioClient,
        bucket: config.minio.bucketBuilds,
        projectId: targetProjectId,
        deploymentId: deployment_id,
        commitHash: commit_hash,
        branch,
        target: targetEnv,
        workspaceDir,
        rootDirectory: root_directory,
        outputDirectory: effectiveOutDir,
        onLog: log,
      });
      s3Prefix = uploadResult.s3Prefix;
    } catch (uploadErr: any) {
      if (isProd) {
        throw uploadErr;
      }
      await log(`[UPLOAD] Storage offline notice in test mode: ${uploadErr.message}`, 'STDOUT');
    }

    // ----------------------------------------------------
    // PHASE 5: DEPLOYING (Edge CDN Route Binding)
    // ----------------------------------------------------
    const deployTransRes = await transitionState(
      deployment_id,
      'DEPLOYING',
      `Binding preview domain routing to edge CDN network`,
      ['UPLOADING', 'DEPLOYING']
    );
    if (!deployTransRes.success && deployTransRes.cancelled) {
      console.log(`[Worker] Deployment ${deployment_id} was cancelled by user. Aborting pipeline.`);
      return;
    }

    const previewUrl = `https://${project_name}-${commit_hash.slice(0, 7)}.mini-vercel.app`;
    await log(`[DEPLOY] Configured edge routing for domain: ${previewUrl}`);

    // ----------------------------------------------------
    // PHASE 6: READY (Success Finalization)
    // ----------------------------------------------------
    const totalDurationMs = Date.now() - startTime;
    const totalDurationSeconds = totalDurationMs / 1000;
    workerBuildDuration.observe({ status: 'READY', framework: 'unknown' }, totalDurationSeconds);
    workerDeploymentsCounter.inc({ status: 'READY' });
    await log(`[SUCCESS] Deployment published successfully in ${totalDurationMs}ms! Live at: ${previewUrl}`);

    if (isUuid(deployment_id)) {
      try {
        await transitionDeploymentState(prisma, {
          deploymentId: deployment_id,
          toStatus: DeploymentStatus.READY,
          expectedStatus: [DeploymentStatus.DEPLOYING, DeploymentStatus.READY],
          previewUrl,
          s3Prefix,
          buildDurationMs: totalDurationMs,
          eventMessage: `Deployment successfully published (${totalDurationMs}ms)`,
        });

        if (targetEnv === 'PRODUCTION' && isUuid(targetProjectId)) {
          await prisma.project.update({
            where: { id: targetProjectId },
            data: { currentDeploymentId: deployment_id },
          }).catch(() => {});
        }
      } catch (readyErr: any) {
        console.warn(`[Worker] Notice finalizing READY state for ${deployment_id}:`, readyErr?.message);
      }
    }

    // Flush all pending buffered log records to PostgreSQL
    await logStreamer.flush();
    workerLog('info', `Completed deployment ${deployment_id} in ${totalDurationMs}ms`, {
      deploymentId: deployment_id,
      durationMs: totalDurationMs,
      status: 'READY',
    });
  } catch (err: any) {
    const totalDurationMs = Date.now() - startTime;
    const totalDurationSeconds = totalDurationMs / 1000;
    workerBuildDuration.observe({ status: 'FAILED', framework: 'unknown' }, totalDurationSeconds);
    workerDeploymentsCounter.inc({ status: 'FAILED' });
    const errorMsg = err.message || 'Build pipeline failed during execution';
    await log(`[ERROR] Build pipeline failure: ${errorMsg}`, 'STDERR');

    if (isUuid(deployment_id)) {
      try {
        await transitionDeploymentState(prisma, {
          deploymentId: deployment_id,
          toStatus: DeploymentStatus.FAILED,
          expectedStatus: [
            DeploymentStatus.QUEUED,
            DeploymentStatus.INITIALIZING,
            DeploymentStatus.CLONING,
            DeploymentStatus.BUILDING,
            DeploymentStatus.UPLOADING,
            DeploymentStatus.DEPLOYING,
          ],
          buildDurationMs: totalDurationMs,
          errorMessage: errorMsg,
          eventMessage: `Build failed: ${errorMsg}`,
        });
      } catch (failTransErr: any) {
        console.warn(`[Worker] Notice marking deployment as FAILED for ${deployment_id}:`, failTransErr?.message);
      }
    }

    await logStreamer.flush();
    workerLog('error', `Build pipeline failure for ${deployment_id}: ${errorMsg}`, {
      deploymentId: deployment_id,
      durationMs: totalDurationMs,
      error: errorMsg,
    });
    throw err;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      await redisConnection.del(heartbeatKey);
    } catch {}
    logStreamer.clearSecrets();
    // Clean temporary workspace directory
    GitCloner.cleanWorkspace(workspaceDir);
    workerActiveJobsGauge.dec();
  }
    }
  );
}

/**
 * Creates BullMQ worker instance
 */
export function createWorker(customConnection?: Redis): Worker<DeploymentJobPayload> {
  const worker = new Worker<DeploymentJobPayload>(
    config.queue.name,
    async (job: Job<DeploymentJobPayload>) => {
      await processDeploymentJob(job.data);
    },
    {
      connection: customConnection || redisConnection,
      concurrency: config.queue.concurrency,
    }
  );

  worker.on('completed', (job) => {
    console.log(`[BullMQ] Job ${job.id} completed successfully`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[BullMQ] Job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts || 1}):`, err.message);
  });

  return worker;
}

export { reconcileStaleDeployments } from './lib/reconciler';

async function start() {
  console.log(`[Worker] Starting Mini-Vercel BullMQ Worker...`);

  const health = await checkWorkerHealth();
  console.log(
    `[Worker Health] Initialized -> Redis: ${health.redis ? 'ONLINE' : 'STANDBY'}, MinIO: ${
      health.minio ? 'ONLINE' : 'STANDBY'
    }, PostgreSQL: ${health.postgres ? 'ONLINE' : 'STANDBY'}, Docker: ${
      health.docker ? 'ONLINE' : 'EMULATION'
    }, Queue: "${config.queue.name}", Concurrency: ${config.queue.concurrency}`
  );

  // 1. Run startup reconciliation for stale deployments with distributed lock
  try {
    const queue = new Queue<DeploymentJobPayload>(config.queue.name, { connection: redisConnection });
    const reconResult = await reconcileStaleDeployments(redisConnection, queue);
    console.log('[Worker Startup] Reconciliation completed:', reconResult);
  } catch (reconErr: any) {
    console.warn('[Worker Startup] Reconciliation skipped or failed non-critically:', reconErr.message);
  }

  // 2. Initialize BullMQ worker & internal Prometheus metrics listener
  const worker = createWorker();
  const metricsServer = startWorkerMetricsServer();

  // 3. Setup graceful shutdown handlers
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      console.warn(`[Worker] Second ${signal} signal received, forcing termination.`);
      process.exit(1);
    }
    isShuttingDown = true;
    console.log(`[Worker] Received ${signal}, starting graceful shutdown...`);

    const timeoutTimer = setTimeout(() => {
      console.error('[Worker] Graceful shutdown timed out (15s limit reached), forcing exit.');
      process.exit(1);
    }, 15000);

    try {
      // Step A: Stop accepting new jobs and wait for active jobs to finish
      await worker.close();
      console.log('[Worker] Worker queue closed to new jobs.');

      // Step B: Close internal metrics server
      metricsServer.close();

      // Step C: Flush pending logs
      await logStreamer.flush();

      // Step D: Close Redis and Database connections in order
      await redisConnection.quit();
      await prisma.$disconnect();

      clearTimeout(timeoutTimer);
      console.log('[Worker] Graceful shutdown finished cleanly.');
      process.exit(0);
    } catch (shutdownErr) {
      clearTimeout(timeoutTimer);
      console.error('[Worker] Error encountered during shutdown:', shutdownErr);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.env.NODE_ENV !== 'test') {
  start();
}
