import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, DeploymentStatus } from '@mini-vercel/database';
import { reconcileStaleDeployments, redisConnection, NonRetryableError, processDeploymentJob } from './index';
import { Queue } from 'bullmq';
import { config } from '@mini-vercel/config';

describe('Worker Chaos & Failure Resilience Test Suite', () => {
  let testUser: any;
  let testProject: any;
  let testQueue: Queue;

  beforeAll(async () => {
    testQueue = new Queue(config.queue.name, { connection: redisConnection });

    testUser = await prisma.user.upsert({
      where: { githubId: 'chaos_worker_tester' },
      update: {},
      create: {
        githubId: 'chaos_worker_tester',
        username: 'chaos_worker_tester',
        email: 'chaos_worker@mini-vercel.local',
      },
    });

    const slug = `chaos-worker-${Date.now()}`;
    testProject = await prisma.project.create({
      data: {
        userId: testUser.id,
        name: slug,
        slug: slug,
        repoName: `mini-vercel/${slug}`,
        repoUrl: `https://github.com/mini-vercel/${slug}`,
      },
    });
  });

  afterAll(async () => {
    await prisma.deploymentLog.deleteMany({ where: { deployment: { projectId: testProject.id } } });
    await prisma.deploymentEvent.deleteMany({ where: { deployment: { projectId: testProject.id } } });
    await prisma.deployment.deleteMany({ where: { projectId: testProject.id } });
    await prisma.project.delete({ where: { id: testProject.id } }).catch(() => {});
    await testQueue.close();
  });

  it('1. Worker Kill & Reconciler Resilience: detects stale in-flight deployment without heartbeat', async () => {
    // Create a deployment simulated as stuck in BUILDING because previous worker died
    const stuckDeployment = await prisma.deployment.create({
      data: {
        projectId: testProject.id,
        commitHash: '0123456789abcdef0123456789abcdef01234567',
        commitMessage: 'fix: dead worker crash',
        branch: 'main',
        status: DeploymentStatus.BUILDING,
        updatedAt: new Date(Date.now() - 15 * 60 * 1000), // 15 mins ago
      },
    });

    // Run reconciliation cycle
    const recon = await reconcileStaleDeployments(redisConnection, testQueue, {
      staleThresholdMs: 60 * 1000, // 1 min threshold
    });

    expect(recon.reconciledCount).toBeGreaterThanOrEqual(1);

    // Verify deployment is marked FAILED or recovered
    const updated = await prisma.deployment.findUnique({
      where: { id: stuckDeployment.id },
    });
    expect([DeploymentStatus.FAILED, DeploymentStatus.QUEUED]).toContain(updated?.status);
  });

  it('2. Strict Parameter Validation: throws NonRetryableError on malicious repo URL without retrying', async () => {
    await expect(
      processDeploymentJob({
        deployment_id: 'dep_bad_url',
        project_name: testProject.name,
        repo_url: 'git://malicious-protocol.com/exploit',
        branch: 'main',
        commit_hash: '0123456789abcdef0123456789abcdef01234567',
        created_at: new Date().toISOString(),
      })
    ).rejects.toThrow(NonRetryableError);
  });

  it('3. Strict Commit SHA Validation: throws NonRetryableError on invalid commit hash', async () => {
    await expect(
      processDeploymentJob({
        deployment_id: 'dep_bad_sha',
        project_name: testProject.name,
        repo_url: 'https://github.com/mini-vercel/app',
        branch: 'main',
        commit_hash: 'not-a-valid-40-hex-sha',
        created_at: new Date().toISOString(),
      })
    ).rejects.toThrow(NonRetryableError);
  });
});
