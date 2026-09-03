import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../index';
import { prisma, DeploymentStatus, DeploymentTrigger, LogStream } from '@doplo/database';

describe('SSE Live Log Stream & History Contract (/api/deployments/:id/logs/stream)', () => {
  let app: FastifyInstance;
  let userA: { id: string; username: string };
  let userB: { id: string; username: string };
  let testProjectA: any;
  let testProjectB: any;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // Create 2 test users for authorization checks
    const uA = await prisma.user.upsert({
      where: { githubId: 'gh_logs_alice' },
      update: {},
      create: {
        githubId: 'gh_logs_alice',
        username: 'logs_alice',
        email: 'alice_logs@doplo.local',
      },
    });
    userA = { id: uA.id, username: uA.username };

    const uB = await prisma.user.upsert({
      where: { githubId: 'gh_logs_bob' },
      update: {},
      create: {
        githubId: 'gh_logs_bob',
        username: 'logs_bob',
        email: 'bob_logs@doplo.local',
      },
    });
    userB = { id: uB.id, username: uB.username };

    // Create projects for each user
    testProjectA = await prisma.project.create({
      data: {
        userId: userA.id,
        name: `logs-proj-a-${Date.now()}`,
        slug: `logs-proj-a-${Date.now()}`,
        repoName: 'doplo/logs-proj-a',
        repoUrl: 'https://github.com/doplo/logs-proj-a',
      },
    });

    testProjectB = await prisma.project.create({
      data: {
        userId: userB.id,
        name: `logs-proj-b-${Date.now()}`,
        slug: `logs-proj-b-${Date.now()}`,
        repoName: 'doplo/logs-proj-b',
        repoUrl: 'https://github.com/doplo/logs-proj-b',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated requests with 401 Unauthorized', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/deployments/non-existent-id/logs/stream`,
    });

    expect(res.statusCode).toBe(401);
    const json = JSON.parse(res.payload);
    expect(json.error).toBe('Unauthorized');
  });

  it('enforces tenant isolation and returns 404 when accessing another user\'s deployment log stream', async () => {
    // Create deployment under User B
    const depB = await prisma.deployment.create({
      data: {
        projectId: testProjectB.id,
        status: DeploymentStatus.BUILDING,
        trigger: DeploymentTrigger.MANUAL,
        commitHash: 'abcdef0123456789',
        branch: 'main',
        senderUsername: userB.username,
      },
    });

    // User A tries to access User B's deployment log stream
    const res = await app.inject({
      method: 'GET',
      url: `/api/deployments/${depB.id}/logs/stream`,
      headers: { 'x-user-id': userA.id },
    });

    expect(res.statusCode).toBe(404);
    const json = JSON.parse(res.payload);
    expect(json.error).toBe('Not Found');
  });

  it('streams historical logs for terminal READY deployment and ends stream immediately without hanging', async () => {
    const dep = await prisma.deployment.create({
      data: {
        projectId: testProjectA.id,
        status: DeploymentStatus.READY,
        trigger: DeploymentTrigger.MANUAL,
        commitHash: '1111222233334444',
        branch: 'main',
        senderUsername: userA.username,
      },
    });

    // Insert historical log records
    await prisma.deploymentLog.createMany({
      data: [
        {
          deploymentId: dep.id,
          sequence: 1,
          stream: LogStream.STDOUT,
          logChunk: '[CLONE] Shallow cloning repository...',
        },
        {
          deploymentId: dep.id,
          sequence: 2,
          stream: LogStream.STDOUT,
          logChunk: '[BUILD] Running npm run build...',
        },
        {
          deploymentId: dep.id,
          sequence: 3,
          stream: LogStream.STDOUT,
          logChunk: '[DEPLOY] Deployment ready at https://preview.domain',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/deployments/${dep.id}/logs/stream`,
      headers: { 'x-user-id': userA.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('id: 1');
    expect(res.payload).toContain('[CLONE] Shallow cloning repository...');
    expect(res.payload).toContain('id: 2');
    expect(res.payload).toContain('[BUILD] Running npm run build...');
    expect(res.payload).toContain('id: 3');
    expect(res.payload).toContain('[DEPLOY] Deployment ready at https://preview.domain');
    expect(res.payload).toContain('event: end');
    expect(res.payload).toContain('"status":"READY"');
  });

  it('replays only missing sequences from PostgreSQL when Last-Event-ID header is provided', async () => {
    const dep = await prisma.deployment.create({
      data: {
        projectId: testProjectA.id,
        status: DeploymentStatus.READY,
        trigger: DeploymentTrigger.MANUAL,
        commitHash: '5555666677778888',
        branch: 'main',
        senderUsername: userA.username,
      },
    });

    // Create 5 sequences
    await prisma.deploymentLog.createMany({
      data: [
        { deploymentId: dep.id, sequence: 1, stream: LogStream.STDOUT, logChunk: 'Seq 1: init' },
        { deploymentId: dep.id, sequence: 2, stream: LogStream.STDOUT, logChunk: 'Seq 2: clone' },
        { deploymentId: dep.id, sequence: 3, stream: LogStream.STDOUT, logChunk: 'Seq 3: build' },
        { deploymentId: dep.id, sequence: 4, stream: LogStream.STDOUT, logChunk: 'Seq 4: upload' },
        { deploymentId: dep.id, sequence: 5, stream: LogStream.STDOUT, logChunk: 'Seq 5: deploy' },
      ],
    });

    // Replay requesting starting after sequence 3 (Last-Event-ID: 3)
    const res = await app.inject({
      method: 'GET',
      url: `/api/deployments/${dep.id}/logs/stream`,
      headers: {
        'x-user-id': userA.id,
        'last-event-id': '3',
      },
    });

    expect(res.statusCode).toBe(200);
    // Should NOT contain sequence 1, 2, 3
    expect(res.payload).not.toContain('Seq 1: init');
    expect(res.payload).not.toContain('Seq 2: clone');
    expect(res.payload).not.toContain('Seq 3: build');

    // Should contain sequence 4 and 5
    expect(res.payload).toContain('id: 4');
    expect(res.payload).toContain('Seq 4: upload');
    expect(res.payload).toContain('id: 5');
    expect(res.payload).toContain('Seq 5: deploy');
    expect(res.payload).toContain('event: end');
  });

  it('replays missing sequences using lastEventId query parameter when EventSource headers are unavailable', async () => {
    const dep = await prisma.deployment.create({
      data: {
        projectId: testProjectA.id,
        status: DeploymentStatus.FAILED,
        trigger: DeploymentTrigger.MANUAL,
        commitHash: '9999000011112222',
        branch: 'main',
        senderUsername: userA.username,
      },
    });

    await prisma.deploymentLog.createMany({
      data: [
        { deploymentId: dep.id, sequence: 10, stream: LogStream.STDOUT, logChunk: 'Seq 10: starting' },
        { deploymentId: dep.id, sequence: 20, stream: LogStream.STDERR, logChunk: 'Seq 20: error occurred' },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/deployments/${dep.id}/logs/stream?lastEventId=10&userId=${userA.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('Seq 10: starting');
    expect(res.payload).toContain('id: 20');
    expect(res.payload).toContain('Seq 20: error occurred');
    expect(res.payload).toContain('event: end');
    expect(res.payload).toContain('"status":"FAILED"');
  });

  it('handles follow=false query parameter to retrieve historical snapshot without opening live stream', async () => {
    const dep = await prisma.deployment.create({
      data: {
        projectId: testProjectA.id,
        status: DeploymentStatus.BUILDING,
        trigger: DeploymentTrigger.MANUAL,
        commitHash: '3333444455556666',
        branch: 'main',
        senderUsername: userA.username,
      },
    });

    await prisma.deploymentLog.create({
      data: {
        deploymentId: dep.id,
        sequence: 1,
        stream: LogStream.STDOUT,
        logChunk: 'Active build snapshot',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/deployments/${dep.id}/logs/stream?follow=false`,
      headers: { 'x-user-id': userA.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Active build snapshot');
    expect(res.payload).toContain('event: end');
  });
});
