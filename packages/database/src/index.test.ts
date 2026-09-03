import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  prisma,
  db,
  EnvTarget,
  DeploymentStatus,
  DeploymentTrigger,
  LogStream,
} from './index';

describe('Prisma PostgreSQL Database Integration Tests', () => {
  const testGithubId = `gh_test_${Date.now()}`;
  const testEmail = `test_${Date.now()}@example.com`;
  let testUserId: string;
  let testProjectId: string;
  let testDeploymentId: string;

  beforeAll(async () => {
    // Ensure clean state for test user if needed
    try {
      await prisma.$connect();
    } catch (e) {
      console.warn('Prisma connection test warning:', (e as Error).message);
    }
  });

  afterAll(async () => {
    // Cleanup created test resources
    try {
      if (testUserId) {
        await prisma.user.delete({ where: { id: testUserId } });
      }
    } catch {}
    await db.close();
  });

  it('1. User Model: creates user with unique constraints', async () => {
    const user = await prisma.user.create({
      data: {
        githubId: testGithubId,
        username: 'integration_tester',
        email: testEmail,
        avatarUrl: 'https://github.com/avatar.png',
      },
    });

    expect(user).toBeDefined();
    expect(user.id).toBeTypeOf('string');
    expect(user.githubId).toBe(testGithubId);
    expect(user.email).toBe(testEmail);
    testUserId = user.id;

    // Verify duplicate email constraint failure
    await expect(
      prisma.user.create({
        data: {
          githubId: `${testGithubId}_diff`,
          username: 'diff_tester',
          email: testEmail, // duplicate
        },
      })
    ).rejects.toThrow();
  });

  it('2. Project Model: creates project with relations and constraints', async () => {
    const projectSlug = `test-project-${Date.now()}`;
    const project = await prisma.project.create({
      data: {
        userId: testUserId,
        name: 'My Test Project',
        slug: projectSlug,
        repoName: 'tester/my-test-project',
        repoUrl: 'https://github.com/tester/my-test-project',
        branch: 'main',
        framework: 'nextjs',
      },
    });

    expect(project).toBeDefined();
    expect(project.userId).toBe(testUserId);
    expect(project.name).toBe('My Test Project');
    expect(project.slug).toBe(projectSlug);
    testProjectId = project.id;

    // Verify composite unique [userId, name] constraint
    await expect(
      prisma.project.create({
        data: {
          userId: testUserId,
          name: 'My Test Project', // duplicate name for same user
          slug: `${projectSlug}-diff`,
          repoName: 'tester/my-test-project-2',
          repoUrl: 'https://github.com/tester/my-test-project-2',
        },
      })
    ).rejects.toThrow();
  });

  it('3. ProjectEnvVar Model: manages encrypted env vars with composite unique constraint', async () => {
    const envVar = await prisma.projectEnvVar.create({
      data: {
        projectId: testProjectId,
        key: 'API_SECRET_KEY',
        encryptedValue: 'aes256gcm:encrypted_data_string',
        iv: 'iv_vector_hex_123456',
        target: EnvTarget.PRODUCTION,
      },
    });

    expect(envVar).toBeDefined();
    expect(envVar.key).toBe('API_SECRET_KEY');
    expect(envVar.target).toBe(EnvTarget.PRODUCTION);

    // Verify composite unique [projectId, key, target]
    await expect(
      prisma.projectEnvVar.create({
        data: {
          projectId: testProjectId,
          key: 'API_SECRET_KEY',
          encryptedValue: 'different_val',
          iv: 'different_iv',
          target: EnvTarget.PRODUCTION, // duplicate (projectId, key, target)
        },
      })
    ).rejects.toThrow();
  });

  it('4. Deployment Model: creates deployment and tracks state machine', async () => {
    const deployment = await prisma.deployment.create({
      data: {
        projectId: testProjectId,
        status: DeploymentStatus.QUEUED,
        trigger: DeploymentTrigger.WEBHOOK_PUSH,
        commitHash: '7b8c9d0',
        commitMessage: 'feat: integration test commit',
        senderUsername: 'integration_tester',
        branch: 'main',
      },
    });

    expect(deployment).toBeDefined();
    expect(deployment.id).toBeTypeOf('string');
    expect(deployment.status).toBe(DeploymentStatus.QUEUED);
    testDeploymentId = deployment.id;

    // Link as Current Deployment on Project (SetNull relation)
    const updatedProject = await prisma.project.update({
      where: { id: testProjectId },
      data: { currentDeploymentId: deployment.id },
    });
    expect(updatedProject.currentDeploymentId).toBe(deployment.id);
  });

  it('5. DeploymentEvent Model: records transition history', async () => {
    const event1 = await prisma.deploymentEvent.create({
      data: {
        deploymentId: testDeploymentId,
        fromStatus: DeploymentStatus.QUEUED,
        toStatus: DeploymentStatus.INITIALIZING,
        eventMessage: 'Allocating sandbox container',
      },
    });

    const event2 = await prisma.deploymentEvent.create({
      data: {
        deploymentId: testDeploymentId,
        fromStatus: DeploymentStatus.INITIALIZING,
        toStatus: DeploymentStatus.BUILDING,
        eventMessage: 'Executing build pipeline',
      },
    });

    expect(event1.toStatus).toBe(DeploymentStatus.INITIALIZING);
    expect(event2.toStatus).toBe(DeploymentStatus.BUILDING);

    const events = await prisma.deploymentEvent.findMany({
      where: { deploymentId: testDeploymentId },
      orderBy: { timestamp: 'asc' },
    });
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('6. DeploymentLog Model: records sequential logs with BigInt autoincrement ID', async () => {
    const log1 = await prisma.deploymentLog.create({
      data: {
        deploymentId: testDeploymentId,
        sequence: 1,
        stream: LogStream.STDOUT,
        logChunk: '[TEST] Starting integration test log stream',
      },
    });

    const log2 = await prisma.deploymentLog.create({
      data: {
        deploymentId: testDeploymentId,
        sequence: 2,
        stream: LogStream.STDOUT,
        logChunk: '[TEST] Second line of build logs',
      },
    });

    expect(typeof log1.id).toBe('bigint');
    expect(log1.sequence).toBe(1);
    expect(log2.sequence).toBe(2);

    // Verify composite unique [deploymentId, sequence]
    await expect(
      prisma.deploymentLog.create({
        data: {
          deploymentId: testDeploymentId,
          sequence: 1, // duplicate sequence
          stream: LogStream.STDERR,
          logChunk: 'Duplicate sequence log chunk',
        },
      })
    ).rejects.toThrow();
  });

  it('7. Database DAL helper methods: ping, addBuildLog, updateDeploymentStatus, getStats', async () => {
    const pingRes = await db.ping();
    expect(pingRes.ok).toBe(true);

    await db.addBuildLog({
      deployment_id: testDeploymentId,
      step: 'COMPILE',
      message: 'Compiled TypeScript bundle',
    });

    // Step through valid state transitions to READY
    await db.updateDeploymentStatus(testDeploymentId, 'INITIALIZING');
    await db.updateDeploymentStatus(testDeploymentId, 'CLONING');
    await db.updateDeploymentStatus(testDeploymentId, 'BUILDING');
    await db.updateDeploymentStatus(testDeploymentId, 'UPLOADING');
    await db.updateDeploymentStatus(testDeploymentId, 'DEPLOYING');
    await db.updateDeploymentStatus(
      testDeploymentId,
      'READY',
      'https://preview-test.doplo.app',
      1200
    );

    const updatedDep = await prisma.deployment.findUnique({
      where: { id: testDeploymentId },
    });
    expect(updatedDep?.status).toBe(DeploymentStatus.READY);
    expect(updatedDep?.previewUrl).toBe('https://preview-test.doplo.app');

    const stats = await db.getStats();
    expect(stats.total_deployments).toBeGreaterThan(0);
  });

  it('8. Cascade Deletions: deleting user cascades to projects and deployments without cyclic FK lock', async () => {
    // Creating temporary user, project, deployment, logs
    const tempUser = await prisma.user.create({
      data: {
        githubId: `gh_temp_${Date.now()}`,
        username: 'temp_user',
        email: `temp_${Date.now()}@example.com`,
      },
    });

    const tempProject = await prisma.project.create({
      data: {
        userId: tempUser.id,
        name: 'Temp Project',
        slug: `temp-slug-${Date.now()}`,
        repoName: 'temp/project',
        repoUrl: 'https://github.com/temp/project',
      },
    });

    const tempDep = await prisma.deployment.create({
      data: {
        projectId: tempProject.id,
        status: DeploymentStatus.READY,
        branch: 'main',
      },
    });

    await prisma.project.update({
      where: { id: tempProject.id },
      data: { currentDeploymentId: tempDep.id },
    });

    await prisma.deploymentLog.create({
      data: {
        deploymentId: tempDep.id,
        sequence: 1,
        logChunk: 'Temporary log message',
      },
    });

    // Delete temp user (should cascade and clean up tempProject, tempDep, and logs without error)
    await prisma.user.delete({ where: { id: tempUser.id } });

    const foundDep = await prisma.deployment.findUnique({ where: { id: tempDep.id } });
    expect(foundDep).toBeNull();
  });
});
