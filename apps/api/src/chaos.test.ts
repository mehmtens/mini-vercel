import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { buildApp } from './index';
import { prisma, DeploymentStatus } from '@mini-vercel/database';
import { config } from '@mini-vercel/config';
import { minioClient } from './lib/minio';

describe('Chaos & Resilience Test Suite', () => {
  let app: FastifyInstance;
  let testUser: any;
  let testProject: any;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    testUser = await prisma.user.upsert({
      where: { githubId: 'gh_chaos_tester' },
      update: {},
      create: {
        githubId: 'gh_chaos_tester',
        username: 'chaos_tester',
        email: 'chaos_tester@mini-vercel.local',
      },
    });

    const slug = `chaos-project-${Date.now()}`;
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
    await prisma.deployment.deleteMany({ where: { projectId: testProject.id } });
    await prisma.project.delete({ where: { id: testProject.id } }).catch(() => {});
    await app.close();
  });

  it('1. Duplicate Webhook Push Idempotency: rejects or deduplicates duplicate delivery IDs', async () => {
    const deliveryId = `chaos_deliv_${Date.now()}`;
    const payload = JSON.stringify({
      ref: 'refs/heads/main',
      after: '0123456789abcdef0123456789abcdef01234567',
      repository: {
        id: 99999,
        name: testProject.name,
        full_name: testProject.repoName,
        clone_url: testProject.repoUrl,
        default_branch: 'main',
      },
      head_commit: {
        id: '0123456789abcdef0123456789abcdef01234567',
        message: 'fix: duplicate webhook chaos test',
        timestamp: new Date().toISOString(),
      },
      sender: {
        login: 'chaos_tester',
      },
    });

    const secret = config.github.webhookSecret;
    const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');

    // First delivery attempt
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'push',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload,
    });

    expect([200, 201, 202]).toContain(res1.statusCode);

    // Duplicate delivery attempt with identical delivery ID
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-github-event': 'push',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload,
    });

    // Should return 200/202 with idempotency acknowledgement or duplicate status
    expect([200, 202]).toContain(res2.statusCode);
  });

  it('2. Build Cancellation Resilience: immediate cancellation transitions status to CANCELLED', async () => {
    const deployment = await prisma.deployment.create({
      data: {
        projectId: testProject.id,
        commitHash: '0123456789abcdef0123456789abcdef01234567',
        commitMessage: 'feat: cancel chaos test',
        branch: 'main',
        status: DeploymentStatus.BUILDING,
      },
    });

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/deployments/${deployment.id}/cancel`,
      headers: {
        authorization: `Bearer ${testUser.id}`,
      },
    });

    expect(cancelRes.statusCode).toBe(200);

    const updated = await prisma.deployment.findUnique({
      where: { id: deployment.id },
    });
    expect(updated?.status).toBe(DeploymentStatus.CANCELLED);
  });

  it('3. Pointer Rollback Resilience: rollback activates previous successful deployment target', async () => {
    const d1Id = crypto.randomUUID();
    const d2Id = crypto.randomUUID();

    const d1 = await prisma.deployment.create({
      data: {
        id: d1Id,
        projectId: testProject.id,
        commitHash: '1111111111111111111111111111111111111111',
        commitMessage: 'deploy v1',
        branch: 'main',
        s3Prefix: `artifacts/${testProject.id}/${d1Id}`,
        status: DeploymentStatus.READY,
      },
    });

    const d2 = await prisma.deployment.create({
      data: {
        id: d2Id,
        projectId: testProject.id,
        commitHash: '2222222222222222222222222222222222222222',
        commitMessage: 'deploy v2',
        branch: 'main',
        s3Prefix: `artifacts/${testProject.id}/${d2Id}`,
        status: DeploymentStatus.READY,
      },
    });

    // Seed test artifact in MinIO
    const bucket = config.minio.bucketBuilds;
    if (!(await minioClient.bucketExists(bucket))) {
      await minioClient.makeBucket(bucket);
    }
    const html1 = Buffer.from('<h1>v1</h1>');
    const html2 = Buffer.from('<h1>v2</h1>');
    await minioClient.putObject(bucket, `artifacts/${testProject.id}/${d1Id}/index.html`, html1, html1.length);
    await minioClient.putObject(bucket, `artifacts/${testProject.id}/${d2Id}/index.html`, html2, html2.length);

    // Set current deployment to d2
    await prisma.project.update({
      where: { id: testProject.id },
      data: { currentDeploymentId: d2.id },
    });

    // Rollback to d1
    const rollbackRes = await app.inject({
      method: 'POST',
      url: `/api/deployments/${d1.id}/rollback`,
      headers: {
        authorization: `Bearer ${testUser.id}`,
      },
    });

    expect(rollbackRes.statusCode).toBe(200);

    const projectAfter = await prisma.project.findUnique({
      where: { id: testProject.id },
    });
    expect(projectAfter?.currentDeploymentId).toBe(d1.id);
  });

  it('4. Prometheus Metrics endpoint resilience: exposes metrics format without crashing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.payload).toContain('http_requests_total');
    expect(res.payload).toContain('mini_vercel_');
  });

  it('5. Dependency Outage Resilience: /health/ready accurately reports component status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect([200, 503]).toContain(res.statusCode);
    const body = JSON.parse(res.payload);
    expect(body.checks).toBeDefined();
    expect(body.checks.postgres).toBeDefined();
    expect(body.checks.redis).toBeDefined();
    expect(body.checks.minio).toBeDefined();
  });
});
