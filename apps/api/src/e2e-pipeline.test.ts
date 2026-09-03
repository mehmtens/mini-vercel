import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { prisma, DeploymentStatus } from '@doplo/database';
import { config } from '@doplo/config';
import { buildApp } from './index';
import { redisConnection, processDeploymentJob } from '@doplo/worker';
import { minioClient } from './lib/minio';
import { FastifyInstance } from 'fastify';
import { Worker as BullWorker, Queue } from 'bullmq';

describe('Real Vite End-to-End Pipeline (Webhook -> DB -> BullMQ -> Real Worker -> MinIO -> READY -> Gateway -> Compiled Asset)', () => {
  const fixturePath = path.resolve(__dirname, '../../../fixtures/sample-vite-app');
  let app: FastifyInstance;
  let testUser: any;
  let testProject: any;
  let bullWorker: BullWorker | null = null;
  let queue: Queue;

  beforeAll(async () => {
    // 1. Ensure MinIO test bucket exists
    const bucket = config.minio.bucketBuilds;
    const exists = await minioClient.bucketExists(bucket);
    if (!exists) {
      await minioClient.makeBucket(bucket);
    }

    queue = new Queue(config.queue.name, { connection: redisConnection });
    await queue.obliterate({ force: true }).catch(() => {});

    // 2. Start real BullMQ Worker instance listening to deployment queue
    bullWorker = new BullWorker(
      config.queue.name,
      async (job) => {
        await processDeploymentJob(job.data);
      },
      {
        connection: redisConnection,
        concurrency: 1,
      }
    );

    app = await buildApp();
    await app.ready();

    const uniqueId = `vite_live_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    testUser = await prisma.user.create({
      data: {
        githubId: uniqueId,
        username: uniqueId,
        email: `${uniqueId}@doplo.local`,
      },
    });

    const slug = `vite-real-${Date.now()}`;
    testProject = await prisma.project.create({
      data: {
        userId: testUser.id,
        name: slug,
        slug: slug,
        repoName: `doplo/${slug}`,
        repoUrl: `file://${fixturePath.replace(/\\/g, '/')}`,
        branch: 'main',
        buildCommand: 'npm run build',
        outputDirectory: 'dist',
      },
    });
  });

  afterAll(async () => {
    if (bullWorker) {
      await bullWorker.close(true).catch(() => {});
    }
    if (queue) {
      await queue.close().catch(() => {});
    }
    if (testProject?.id) {
      await prisma.deploymentLog.deleteMany({ where: { deployment: { projectId: testProject.id } } }).catch(() => {});
      await prisma.deploymentEvent.deleteMany({ where: { deployment: { projectId: testProject.id } } }).catch(() => {});
      await prisma.deployment.deleteMany({ where: { projectId: testProject.id } }).catch(() => {});
      await prisma.project.delete({ where: { id: testProject.id } }).catch(() => {});
    }
    if (testUser?.id) {
      await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    }
    await app.close();
  }, 30000);

  it('processes webhook through BullMQ queue and verifies compiled Vite assets on gateway', async () => {
    const commitHash = 'aabbccddeeff0011223344556677889900112233';
    const deliveryId = `deliv_queue_${Date.now()}`;
    const payload = JSON.stringify({
      ref: 'refs/heads/main',
      after: commitHash,
      repository: {
        id: 77777,
        name: testProject.name,
        full_name: testProject.repoName,
        clone_url: testProject.repoUrl,
        default_branch: 'main',
      },
      head_commit: {
        id: commitHash,
        message: 'feat: real vite compiled asset pipeline',
        timestamp: new Date().toISOString(),
      },
      sender: {
        login: testUser.username,
      },
    });

    const secret = config.github.webhookSecret;
    const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');

    // -------------------------------------------------------------------------
    // STEP 1: Post Webhook to Fastify API
    // -------------------------------------------------------------------------
    const webhookRes = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
      },
      payload,
    });

    expect(webhookRes.statusCode).toBe(201);
    const webhookJson = JSON.parse(webhookRes.payload);
    const deploymentId = webhookJson.deployment?.id;
    const jobId = webhookJson.queue?.jobId || deploymentId;

    expect(deploymentId).toBeDefined();
    expect(jobId).toBeDefined();

    // -------------------------------------------------------------------------
    // STEP 2: Verify Initial DB State is QUEUED
    // -------------------------------------------------------------------------
    const initialDep = await prisma.deployment.findUnique({
      where: { id: deploymentId },
    });
    expect(initialDep).toBeDefined();
    expect(initialDep?.status).toBe(DeploymentStatus.QUEUED);

    // -------------------------------------------------------------------------
    // STEP 3: Wait for Real BullMQ Worker to pick up and complete the job
    // -------------------------------------------------------------------------
    let completed = false;
    const maxWaitMs = 90000; // 90s timeout for real container build
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const dep = await prisma.deployment.findUnique({
        where: { id: deploymentId },
      });
      if (dep?.status === DeploymentStatus.READY) {
        completed = true;
        break;
      }
      if (dep?.status === DeploymentStatus.FAILED) {
        throw new Error(`Deployment failed unexpectedly: ${dep.errorMessage || 'Unknown build error'}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(completed).toBe(true);

    // Verify BullMQ Job State
    const bullJob = await queue.getJob(jobId);
    expect(bullJob).toBeDefined();
    expect(bullJob?.data.deployment_id).toBe(deploymentId);

    // Verify DB Final State & Pointer
    const finalizedDep = await prisma.deployment.findUnique({
      where: { id: deploymentId },
    });
    expect(finalizedDep?.status).toBe(DeploymentStatus.READY);
    expect(finalizedDep?.s3Prefix).toBeDefined();

    const updatedProject = await prisma.project.findUnique({
      where: { id: testProject.id },
    });
    expect(updatedProject?.currentDeploymentId).toBe(deploymentId);

    // -------------------------------------------------------------------------
    // STEP 4: Query Fastify Artifact Gateway for index.html (Strict 200 OK)
    // -------------------------------------------------------------------------
    const gatewayHtmlRes = await app.inject({
      method: 'GET',
      url: '/',
      headers: {
        host: `${testProject.slug}.localhost`,
      },
    });

    expect(gatewayHtmlRes.statusCode).toBe(200);
    expect(gatewayHtmlRes.headers['content-type']).toContain('text/html');
    expect(gatewayHtmlRes.payload).toContain('<h1>Doplo Live Vite Fixture</h1>');

    // -------------------------------------------------------------------------
    // STEP 5: Resolve Fingerprinted Vite Asset or Entry Script from HTML
    // -------------------------------------------------------------------------
    // Extract script src from index.html (e.g. /assets/index-*.js or /src/main.ts)
    const scriptSrcMatch = gatewayHtmlRes.payload.match(/src="(\/[^"]+)"/);
    expect(scriptSrcMatch).toBeDefined();
    const assetUrl = scriptSrcMatch ? scriptSrcMatch[1] : '/src/main.ts';

    const assetRes = await app.inject({
      method: 'GET',
      url: assetUrl,
      headers: {
        host: `${testProject.slug}.localhost`,
      },
    });

    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.headers['content-type']).toMatch(/javascript|plain|typescript/);
    expect(assetRes.payload.length).toBeGreaterThan(10);
  }, 120000);
});
