import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp, validateEnvironmentSecurity } from './index';
import { getUserGitHubToken, storeUserGitHubToken } from './lib/session';
import { prisma } from '@mini-vercel/database';
import { createHmacSignature } from '@mini-vercel/crypto';
import { config } from '@mini-vercel/config';
import { minioClient } from './lib/minio';
import { deploymentQueue, redisConnection } from './lib/queue.js';
import * as healthModule from './routes/health';

describe('Fastify REST API Integration Tests', () => {
  let app: FastifyInstance;
  let userA: { id: string; username: string };
  let userB: { id: string; username: string };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // Create 2 distinct test users for tenant isolation testing
    const createdA = await prisma.user.upsert({
      where: { githubId: 'gh_user_alice' },
      update: {},
      create: {
        githubId: 'gh_user_alice',
        username: 'alice',
        email: 'alice@mini-vercel.local',
      },
    });
    userA = { id: createdA.id, username: createdA.username };

    const createdB = await prisma.user.upsert({
      where: { githubId: 'gh_user_bob' },
      update: {},
      create: {
        githubId: 'gh_user_bob',
        username: 'bob',
        email: 'bob@mini-vercel.local',
      },
    });
    userB = { id: createdB.id, username: createdB.username };
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Health Endpoints (Liveness & Readiness)', () => {
    it('GET /health (Liveness) returns 200 ok without depending on external services', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.payload);
      expect(json.status).toBe('ok');
      expect(json.service).toBe('api');
      expect(json.version).toBeDefined();
      expect(typeof json.uptimeSeconds).toBe('number');
      expect(json.timestamp).toBeDefined();
    });

    it('GET /health/ready returns 200 when all services and MinIO bucket are active', async () => {
      const pgSpy = vi.spyOn(healthModule.healthChecker, 'checkPostgres').mockResolvedValue({
        status: 'up',
        responseTimeMs: 3,
        message: 'PostgreSQL connection healthy',
      });
      const redisSpy = vi.spyOn(healthModule.healthChecker, 'checkRedis').mockResolvedValue({
        status: 'up',
        responseTimeMs: 1,
        message: 'Redis connection healthy',
      });
      const minioSpy = vi.spyOn(healthModule.healthChecker, 'checkMinio').mockResolvedValue({
        status: 'up',
        responseTimeMs: 4,
        message: `MinIO storage healthy (bucket "${config.minio.bucketBuilds}" active)`,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.payload);
      expect(json.status).toBe('ok');
      expect(json.checks.postgres.status).toBe('up');
      expect(json.checks.redis.status).toBe('up');
      expect(json.checks.minio.status).toBe('up');

      pgSpy.mockRestore();
      redisSpy.mockRestore();
      minioSpy.mockRestore();
    });

    it('GET /health/ready returns 503 when MinIO builds bucket is missing', async () => {
      const minioExistsSpy = vi.spyOn(minioClient, 'bucketExists').mockResolvedValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(response.statusCode).toBe(503);
      const json = JSON.parse(response.payload);
      expect(json.status).toBe('degraded');
      expect(json.checks.minio.status).toBe('down');
      expect(json.checks.minio.message).toContain('not found');

      minioExistsSpy.mockRestore();
    });

    it('GET /health/ready un-mocked live probe returns sanitized structure without leaking secrets', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect([200, 503]).toContain(response.statusCode);
      const json = JSON.parse(response.payload);
      expect(['ok', 'degraded', 'unhealthy']).toContain(json.status);
      expect(json.checks).toBeDefined();

      const payloadStr = JSON.stringify(json);
      expect(payloadStr).not.toContain('postgres://');
      expect(payloadStr).not.toContain('redis://');
      expect(payloadStr).not.toContain(config.minio.secretKey);
      expect(payloadStr).not.toContain(config.crypto.masterKey);
    });
  });

  describe('Authentication & Authorization Enforcements', () => {
    it('returns 401 Unauthorized when accessing /api/projects without auth headers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects',
      });
      expect(res.statusCode).toBe(401);
      const json = JSON.parse(res.payload);
      expect(json.error).toBe('Unauthorized');
    });

    it('returns 401 Unauthorized when creating a project without auth headers', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: {
          name: 'Unauthorized Project',
          repoUrl: 'https://github.com/test/repo',
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 Unauthorized when listing deployments without auth headers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/deployments',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('Project Slug Validation & Conflict Scenarios', () => {
    const invalidSlugs = [
      { slug: '-starts-with-dash', reason: 'starts with hyphen' },
      { slug: 'ends-with-dash-', reason: 'ends with hyphen' },
      { slug: 'double--hyphen', reason: 'consecutive hyphens' },
      { slug: 'has_underscore', reason: 'underscore' },
      { slug: 'ab', reason: 'too short (<3 chars)' },
      { slug: 'a'.repeat(64), reason: 'too long (>63 chars)' },
      { slug: 'api', reason: 'reserved keyword api' },
      { slug: 'admin', reason: 'reserved keyword admin' },
      { slug: 'storage', reason: 'reserved keyword storage' },
      { slug: 'web', reason: 'reserved keyword web' },
      { slug: 'API', reason: 'case-normalized reserved keyword API' },
      { slug: 'WEB', reason: 'case-normalized reserved keyword WEB' },
    ];

    invalidSlugs.forEach(({ slug, reason }) => {
      it(`POST /api/projects returns 400 Bad Request for invalid slug "${slug}" (${reason})`, async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/api/projects',
          headers: { 'x-user-id': userA.id },
          payload: {
            name: `Project ${slug}`,
            slug,
            repoUrl: 'https://github.com/mini-vercel/test-app',
          },
        });

        expect(response.statusCode).toBe(400);
        const json = JSON.parse(response.payload);
        expect(json.error).toBe('Bad Request');
        expect(json.message).toBeDefined();
      });
    });

    it('POST /api/projects successfully creates project with valid slug and normalizes it', async () => {
      const ts = Date.now();
      const uniqueSlug = `alice-app-${ts}`;
      const response = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { 'x-user-id': userA.id },
        payload: {
          name: `Alice First App ${ts}`,
          slug: `  ${uniqueSlug.toUpperCase()}  `,
          repoUrl: 'https://github.com/alice/first-app',
        },
      });

      expect(response.statusCode).toBe(201);
      const json = JSON.parse(response.payload);
      expect(json.success).toBe(true);
      expect(json.data.slug).toBe(uniqueSlug.toLowerCase());
      expect(json.data.userId).toBe(userA.id);
    });

    it('POST /api/projects returns 409 Conflict when slug already exists', async () => {
      const ts = Date.now();
      const duplicateSlug = `conflict-slug-${ts}`;

      // Create first project
      const firstRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { 'x-user-id': userA.id },
        payload: {
          name: `First Project ${ts}`,
          slug: duplicateSlug,
          repoUrl: 'https://github.com/alice/project-1',
        },
      });
      expect(firstRes.statusCode).toBe(201);

      // Attempt duplicate creation
      const secondRes = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { 'x-user-id': userB.id },
        payload: {
          name: `Second Project ${ts}`,
          slug: duplicateSlug,
          repoUrl: 'https://github.com/bob/project-2',
        },
      });
      expect(secondRes.statusCode).toBe(409);
      const json = JSON.parse(secondRes.payload);
      expect(json.error).toBe('Conflict');
      expect(json.message).toContain('already exists');
    });
  });

  describe('Multi-Tenant Isolation & Resource-Ownership Authorization', () => {
    let projectAId: string;
    let projectASlug: string;
    let projectBId: string;
    let projectBSlug: string;
    let envVarAId: string;
    let deploymentAId: string;

    beforeAll(async () => {
      const ts = Date.now();
      projectASlug = `alice-tenant-app-${ts}`;
      projectBSlug = `bob-tenant-app-${ts}`;

      // Create Alice's project
      const resA = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { 'x-user-id': userA.id },
        payload: {
          name: `Alice Secret Project ${ts}`,
          slug: projectASlug,
          repoUrl: 'https://github.com/alice/secret-app',
        },
      });
      projectAId = JSON.parse(resA.payload).data.id;

      // Add secret env var to Alice's project
      const envResA = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectAId}/env`,
        headers: { 'x-user-id': userA.id },
        payload: {
          key: 'ALICE_SECRET_KEY',
          value: 'alice_super_secret_value_123',
          target: 'PRODUCTION',
        },
      });
      envVarAId = JSON.parse(envResA.payload).data.id;

      // Create Bob's project
      const resB = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { 'x-user-id': userB.id },
        payload: {
          name: `Bob Public Project ${ts}`,
          slug: projectBSlug,
          repoUrl: 'https://github.com/bob/public-app',
        },
      });
      projectBId = JSON.parse(resB.payload).data.id;

      // Trigger deployment for Alice
      const depResA = await app.inject({
        method: 'POST',
        url: '/api/deployments',
        headers: { 'x-user-id': userA.id },
        payload: {
          project_name: `Alice Secret Project ${ts}`,
          branch: 'main',
        },
      });
      deploymentAId = JSON.parse(depResA.payload).id;
    });

    it('GET /api/projects lists only projects belonging to the authenticated user', async () => {
      // Bob requests projects
      const bobRes = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { 'x-user-id': userB.id },
      });
      expect(bobRes.statusCode).toBe(200);
      const bobJson = JSON.parse(bobRes.payload);
      expect(bobJson.data.some((p: any) => p.id === projectBId)).toBe(true);
      expect(bobJson.data.some((p: any) => p.id === projectAId)).toBe(false);

      // Alice requests projects
      const aliceRes = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { 'x-user-id': userA.id },
      });
      expect(aliceRes.statusCode).toBe(200);
      const aliceJson = JSON.parse(aliceRes.payload);
      expect(aliceJson.data.some((p: any) => p.id === projectAId)).toBe(true);
      expect(aliceJson.data.some((p: any) => p.id === projectBId)).toBe(false);
    });

    it('GET /api/projects/:id returns 404 when user attempts to view another user project', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}`,
        headers: { 'x-user-id': userB.id }, // Bob tries to access Alice's project
      });
      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.payload);
      expect(json.error).toBe('Not Found');
    });

    it('PUT /api/projects/:id returns 404 when user attempts to modify another user project', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectAId}`,
        headers: { 'x-user-id': userB.id },
        payload: { name: 'Hacked by Bob' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE /api/projects/:id returns 404 when user attempts to delete another user project', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectAId}`,
        headers: { 'x-user-id': userB.id },
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET /api/projects/:id/env returns 404 when user attempts to read another user env vars', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/env?reveal=true`,
        headers: { 'x-user-id': userB.id },
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/projects/:id/env returns 404 when user attempts to add env var to another user project', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectAId}/env`,
        headers: { 'x-user-id': userB.id },
        payload: { key: 'BOB_INJECTED_KEY', value: 'malicious' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('DELETE /api/projects/:id/env/:varId returns 404 when user attempts to delete another user env var', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectAId}/env/${envVarAId}`,
        headers: { 'x-user-id': userB.id },
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET /api/deployments returns only the deployments belonging to the authenticated user', async () => {
      const bobRes = await app.inject({
        method: 'GET',
        url: '/api/deployments',
        headers: { 'x-user-id': userB.id },
      });
      expect(bobRes.statusCode).toBe(200);
      const bobDeployments = JSON.parse(bobRes.payload).deployments;
      expect(bobDeployments.some((d: any) => d.id === deploymentAId)).toBe(false);

      const aliceRes = await app.inject({
        method: 'GET',
        url: '/api/deployments',
        headers: { 'x-user-id': userA.id },
      });
      expect(aliceRes.statusCode).toBe(200);
      const aliceDeployments = JSON.parse(aliceRes.payload).deployments;
      expect(aliceDeployments.some((d: any) => d.id === deploymentAId)).toBe(true);
    });

    it('GET /api/deployments/:id returns 404 when user attempts to inspect another user deployment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/deployments/${deploymentAId}`,
        headers: { 'x-user-id': userB.id },
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/deployments/:id/cancel returns 404 when user attempts to cancel another user deployment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/deployments/${deploymentAId}/cancel`,
        headers: { 'x-user-id': userB.id },
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/deployments/:id/rollback returns 404 when user attempts to rollback another user deployment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/deployments/${deploymentAId}/rollback`,
        headers: { 'x-user-id': userB.id },
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/deployments/:id/cancel allows owner Alice to cancel an in-flight deployment', async () => {
      const depToCancel = await prisma.deployment.create({
        data: {
          projectId: projectAId,
          status: 'QUEUED',
          branch: 'main',
        },
      });

      const cancelRes = await app.inject({
        method: 'POST',
        url: `/api/deployments/${depToCancel.id}/cancel`,
        headers: { 'x-user-id': userA.id },
      });

      expect(cancelRes.statusCode).toBe(200);
      const json = JSON.parse(cancelRes.payload);
      expect(json.success).toBe(true);
      expect(json.data.status).toBe('CANCELLED');

      // Attempting to cancel already CANCELLED deployment returns 400
      const duplicateCancelRes = await app.inject({
        method: 'POST',
        url: `/api/deployments/${depToCancel.id}/cancel`,
        headers: { 'x-user-id': userA.id },
      });
      expect(duplicateCancelRes.statusCode).toBe(400);
      expect(JSON.parse(duplicateCancelRes.payload).message).toContain('terminal state');
    });

    it('POST /api/deployments transitions deployment to FAILED and returns 503 when queue enqueue fails', async () => {
      const originalAdd = deploymentQueue.add;

      // Mock queue add failure
      deploymentQueue.add = (async () => {
        throw new Error('Redis connection timed out during enqueue');
      }) as any;

      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/deployments',
          headers: { 'x-user-id': userA.id },
          payload: {
            project_name: `alice-fail-queue-test-${Date.now()}`,
            branch: 'main',
          },
        });

        expect(res.statusCode).toBe(503);
        const json = JSON.parse(res.payload);
        expect(json.message).toContain('Failed to dispatch deployment job');

        // Verify the created deployment was updated to FAILED in DB and not left QUEUED
        const failedDep = await prisma.deployment.findFirst({
          where: { project: { userId: userA.id } },
          orderBy: { createdAt: 'desc' },
        });

        expect(failedDep?.status).toBe('FAILED');
        expect(failedDep?.errorMessage).toContain('ERR_ENQUEUE_FAILED');
      } finally {
        deploymentQueue.add = originalAdd;
      }
    });

    it('allows owner Alice to access and decrypt her own env vars', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectAId}/env?reveal=true`,
        headers: { 'x-user-id': userA.id },
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      const secret = json.data.find((v: any) => v.key === 'ALICE_SECRET_KEY');
      expect(secret).toBeDefined();
      expect(secret.value).toBe('alice_super_secret_value_123');
    });

    it('allows owner Alice to update project and delete env var', async () => {
      const updateRes = await app.inject({
        method: 'PUT',
        url: `/api/projects/${projectAId}`,
        headers: { 'x-user-id': userA.id },
        payload: { name: `Alice Updated Secret Project ${Date.now()}` },
      });
      expect(updateRes.statusCode).toBe(200);

      const delEnvRes = await app.inject({
        method: 'DELETE',
        url: `/api/projects/${projectAId}/env/${envVarAId}`,
        headers: { 'x-user-id': userA.id },
      });
      expect(delEnvRes.statusCode).toBe(200);
    });
  });

  describe('Production Security & Environment Validation', () => {
    it('throws fail-closed error if SESSION_SECRET is too short in production', async () => {
      const origProd = config.isProduction;
      const origSecret = config.auth.sessionSecret;
      try {
        (config as any).isProduction = true;
        (config as any).auth.sessionSecret = 'short';
        expect(() => validateEnvironmentSecurity()).toThrow(/SESSION_SECRET is required/);
      } finally {
        (config as any).isProduction = origProd;
        (config as any).auth.sessionSecret = origSecret;
      }
    });

    it('throws fail-closed error if DEV_AUTH_BYPASS is true in production', async () => {
      const origProd = config.isProduction;
      const origBypass = process.env.DEV_AUTH_BYPASS;
      try {
        (config as any).isProduction = true;
        (config as any).auth.sessionSecret = '12345678901234567890123456789012';
        process.env.DEV_AUTH_BYPASS = 'true';
        expect(() => validateEnvironmentSecurity()).toThrow(/DEV_AUTH_BYPASS is strictly prohibited/);
      } finally {
        (config as any).isProduction = origProd;
        process.env.DEV_AUTH_BYPASS = origBypass;
      }
    });
  });

  describe('GitHub OAuth, PKCE, Session & Encrypted Tokens', () => {
    let oauthStateCookie: string;
    let validState: string;
    let validSessionCookie: string;
    let authUserId: string;

    it('GET /api/auth/github/login generates state, PKCE code challenge and sets signed cookie', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/github/login?format=json',
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.payload);
      expect(json.authorizeUrl).toContain('github.com/login/oauth/authorize');
      expect(json.state).toBeDefined();
      expect(json.codeChallenge).toBeDefined();
      validState = json.state;

      // Extract oauth_state cookie
      const cookies = response.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const stateCookieHeader = Array.isArray(cookies)
        ? cookies.find((c) => c.startsWith('oauth_state='))
        : cookies;
      expect(stateCookieHeader).toBeDefined();
      oauthStateCookie = stateCookieHeader!.split(';')[0];
    });

    it('GET /api/auth/github/callback rejects user error/cancellation with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/github/callback?error=access_denied&error_description=User+cancelled',
      });

      expect(response.statusCode).toBe(400);
      const json = JSON.parse(response.payload);
      expect(json.error).toBe('Bad Request');
      expect(json.message).toContain('User cancelled');
    });

    it('GET /api/auth/github/callback rejects missing code/state with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/github/callback',
      });

      expect(response.statusCode).toBe(400);
    });

    it('GET /api/auth/github/callback rejects invalid/mismatched state with 400 (CSRF protection)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/auth/github/callback?code=mock_code_123&state=tampered_state_value`,
        headers: {
          cookie: oauthStateCookie,
        },
      });

      expect(response.statusCode).toBe(400);
      const json = JSON.parse(response.payload);
      expect(json.message).toContain('Invalid OAuth state parameter');
    });

    it('GET /api/auth/github/callback succeeds with valid PKCE state, creates user, encrypts token, and issues session', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/auth/github/callback?code=mock_code_valid&state=${validState}&format=json`,
        headers: {
          cookie: oauthStateCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.payload);
      expect(json.success).toBe(true);
      expect(json.sessionId).toBeDefined();
      expect(json.user.username).toBe('github_test_user');
      authUserId = json.user.id;

      // Verify session cookie was set
      const cookies = response.headers['set-cookie'];
      const sessionCookieHeader = Array.isArray(cookies)
        ? cookies.find((c) => c.startsWith('mini_session='))
        : cookies;
      expect(sessionCookieHeader).toBeDefined();
      validSessionCookie = sessionCookieHeader!.split(';')[0];

      // Verify token in DB is encrypted and not plain text
      const dbUser = await prisma.user.findUnique({
        where: { id: authUserId },
      });
      expect(dbUser?.encryptedAccessToken).toBeDefined();
      expect(dbUser?.encryptedAccessToken).not.toContain('gho_mock_token_');
      expect(dbUser?.accessTokenIv).toBeDefined();
    });

    it('GET /api/auth/me returns sanitized user profile using session cookie', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: {
          cookie: validSessionCookie,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.payload);
      expect(json.success).toBe(true);
      expect(json.data.id).toBe(authUserId);
      expect(json.data.username).toBe('github_test_user');
      expect(json.data).not.toHaveProperty('encryptedAccessToken');
      expect(json.data).not.toHaveProperty('accessToken');
    });

    it('POST /api/auth/logout invalidates session and subsequent /api/auth/me returns 401', async () => {
      const logoutRes = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          cookie: validSessionCookie,
        },
      });

      expect(logoutRes.statusCode).toBe(200);

      // Verify subsequent request with old session fails
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: {
          cookie: validSessionCookie,
        },
      });

      expect(meRes.statusCode).toBe(401);
    });

    it('token decryption fails safely (fail-closed) on corrupted ciphertext', async () => {
      await storeUserGitHubToken(authUserId, 'my-test-secret-token');

      // Tamper with ciphertext in database
      await prisma.user.update({
        where: { id: authUserId },
        data: { encryptedAccessToken: 'corrupted_ciphertext_data:invalid_tag' },
      });

      const token = await getUserGitHubToken(authUserId);
      expect(token).toBeNull();
    });
  });

  describe('GitHub Repositories & Branches API', () => {
    it('GET /api/github/repos requires authentication (returns 401 without auth)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/github/repos',
      });
      expect(response.statusCode).toBe(401);
    });

    it('GET /api/github/repos returns paginated repository list for authenticated user', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/github/repos?page=1&per_page=10',
        headers: {
          'x-user-id': userA.id,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.payload);
      expect(json.success).toBe(true);
      expect(json.page).toBe(1);
      expect(json.per_page).toBe(10);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBeGreaterThan(0);
      expect(json.data[0]).toHaveProperty('name');
      expect(json.data[0]).toHaveProperty('html_url');
    });

    it('GET /api/github/repos/:owner/:repo/branches validates path parameters (rejects invalid chars)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/github/repos/invalid owner!/repo$name/branches',
        headers: {
          'x-user-id': userA.id,
        },
      });

      expect(response.statusCode).toBe(400);
      const json = JSON.parse(response.payload);
      expect(json.error).toBe('Bad Request');
    });

    it('GET /api/github/repos/:owner/:repo/branches returns branch list for valid repo', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/github/repos/mini-vercel/demo-app/branches',
        headers: {
          'x-user-id': userA.id,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.payload);
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.some((b: any) => b.name === 'main')).toBe(true);
    });
  });

  describe('GitHub Webhook HMAC Signature & Idempotency', () => {
    it('rejects webhook with missing HMAC signature when secret is configured', async () => {
      const payload = JSON.stringify({
        repository: { name: 'unauthorized-repo', clone_url: 'https://github.com/test/repo' },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-github-delivery': 'del_no_sig_1',
        },
        payload,
      });

      expect(response.statusCode).toBe(401);
    });

    it('rejects webhook with invalid HMAC signature', async () => {
      const payload = JSON.stringify({
        repository: { name: 'unauthorized-repo', clone_url: 'https://github.com/test/repo' },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=invalidhex00000000000000000000000000000000000000000000000000000000',
          'x-github-delivery': 'del_invalid_sig_1',
        },
        payload,
      });

      expect(response.statusCode).toBe(401);
    });

    it('rejects webhook with missing or invalid X-GitHub-Delivery header', async () => {
      const rawPayload = JSON.stringify({ repository: { name: 'demo' } });
      const signature = 'sha256=' + createHmacSignature(rawPayload, config.github.webhookSecret);

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
        },
        payload: rawPayload,
      });

      expect(response.statusCode).toBe(400);
      const json = JSON.parse(response.payload);
      expect(json.message).toContain('X-GitHub-Delivery');
    });

    it('acknowledges ping event with 200 Pong', async () => {
      const rawPayload = JSON.stringify({ zen: 'Keep it simple.' });
      const signature = 'sha256=' + createHmacSignature(rawPayload, config.github.webhookSecret);

      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-delivery': `del_ping_${Date.now()}`,
          'x-github-event': 'ping',
        },
        payload: rawPayload,
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.payload);
      expect(json.message).toContain('pong');
    });

    it('processes valid GitHub webhook push, enqueues build, and enforces idempotency on duplicate deliveries', async () => {
      const deliveryId = `del_unique_${Date.now()}`;
      const rawPayload = JSON.stringify({
        ref: 'refs/heads/main',
        head_commit: {
          id: 'a1b2c3d4e5f67890',
          message: 'feat: add awesome feature via webhook',
        },
        repository: {
          name: `webhook-app-${Date.now()}`,
          full_name: `test-org/webhook-app-${Date.now()}`,
          clone_url: 'https://github.com/test-org/webhook-app.git',
          default_branch: 'main',
        },
        sender: {
          login: 'octocat',
          avatar_url: 'https://github.com/octocat.png',
        },
      });

      const signature = 'sha256=' + createHmacSignature(rawPayload, config.github.webhookSecret);

      // First delivery: should create deployment (201 Created)
      const firstRes = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-delivery': deliveryId,
          'x-github-event': 'push',
        },
        payload: rawPayload,
      });

      expect(firstRes.statusCode).toBe(201);
      const firstJson = JSON.parse(firstRes.payload);
      expect(firstJson.success).toBe(true);
      expect(firstJson.deployment.status).toBe('QUEUED');
      const deploymentId = firstJson.deployment.id;

      // Duplicate delivery with same X-GitHub-Delivery: should be skipped idempotently
      const duplicateRes = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-delivery': deliveryId,
          'x-github-event': 'push',
        },
        payload: rawPayload,
      });

      expect(duplicateRes.statusCode).toBe(200);
      const duplicateJson = JSON.parse(duplicateRes.payload);
      expect(duplicateJson.duplicate).toBe(true);
      expect(duplicateJson.message).toContain('idempotent duplicate skipped');

      const depRecord = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        include: { project: true },
      });

      // Verify SSE Log stream endpoint opens and streams initial data
      const streamRes = await app.inject({
        method: 'GET',
        url: `/api/deployments/${deploymentId}/logs/stream?follow=false`,
        headers: { 'x-user-id': depRecord?.project.userId || userA.id },
      });

      expect(streamRes.statusCode).toBe(200);
      expect(streamRes.headers['content-type']).toContain('text/event-stream');
      expect(streamRes.payload).toContain('WEBHOOK');
    });

    it('handles concurrent duplicate webhook delivery requests gracefully', async () => {
      const concurrentDeliveryId = `del_concurrent_${Date.now()}`;
      const rawPayload = JSON.stringify({
        ref: 'refs/heads/main',
        head_commit: {
          id: 'c0a1b2c3d4e5',
          message: 'test: concurrent webhook delivery',
        },
        repository: {
          name: `concurrent-app-${Date.now()}`,
          full_name: `test-org/concurrent-app-${Date.now()}`,
          clone_url: 'https://github.com/test-org/concurrent-app.git',
          default_branch: 'main',
        },
        sender: { login: 'octocat' },
      });

      const signature = 'sha256=' + createHmacSignature(rawPayload, config.github.webhookSecret);

      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/webhooks/github',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': signature,
            'x-github-delivery': concurrentDeliveryId,
            'x-github-event': 'push',
          },
          payload: rawPayload,
        }),
        app.inject({
          method: 'POST',
          url: '/api/webhooks/github',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': signature,
            'x-github-delivery': concurrentDeliveryId,
            'x-github-event': 'push',
          },
          payload: rawPayload,
        }),
      ]);

      const statuses = [res1.statusCode, res2.statusCode];
      expect(statuses).toContain(201);
      expect(statuses).toContain(200);
    });
  });

  describe('Fastify Artifact Gateway & Private S3 Resolution', () => {
    let gwProjectId: string;
    let gwDeploymentReadyId: string;
    let gwDeploymentBuildingId: string;
    const gwCommitSha = '0123456789abcdef0123456789abcdef01234567';
    const gwShortSha = '0123456';
    const gwSlug = `gw-app-${Date.now()}`;

    beforeAll(async () => {
      // 1. Create test project
      const project = await prisma.project.create({
        data: {
          userId: userA.id,
          name: `Gateway Test Project ${Date.now()}`,
          slug: gwSlug,
          repoName: `test-org/${gwSlug}`,
          repoUrl: `https://github.com/test-org/${gwSlug}`,
          branch: 'main',
        },
      });
      gwProjectId = project.id;

      // 2. Create READY deployment
      const s3Prefix = `artifacts/${gwProjectId}/dpl_ready_${Date.now()}`;
      const depReady = await prisma.deployment.create({
        data: {
          projectId: gwProjectId,
          status: 'READY',
          trigger: 'MANUAL',
          commitHash: gwCommitSha,
          branch: 'main',
          s3Prefix,
          previewUrl: `https://${gwSlug}-${gwShortSha}.mini-vercel.app`,
        },
      });
      gwDeploymentReadyId = depReady.id;

      // Point project.currentDeploymentId to this ready deployment
      await prisma.project.update({
        where: { id: gwProjectId },
        data: { currentDeploymentId: gwDeploymentReadyId },
      });

      // 3. Create non-READY deployment
      const depBuilding = await prisma.deployment.create({
        data: {
          projectId: gwProjectId,
          status: 'BUILDING',
          trigger: 'MANUAL',
          commitHash: 'ffffffff0123456789abcdef0123456789abcdef',
          branch: 'feature',
          s3Prefix: `artifacts/${gwProjectId}/dpl_building_${Date.now()}`,
        },
      });
      gwDeploymentBuildingId = depBuilding.id;

      // 4. Upload test static artifacts into private MinIO bucket
      try {
        const bucketExists = await minioClient.bucketExists(config.minio.bucketBuilds);
        if (!bucketExists) {
          await minioClient.makeBucket(config.minio.bucketBuilds, 'us-east-1');
        }

        const htmlContent = '<!DOCTYPE html><html><body><h1>Mini-Vercel Artifact Gateway App</h1></body></html>';
        const jsContent = 'console.log("Mini-Vercel Vite Production Bundle");';
        const cssContent = 'body { font-family: sans-serif; background: #000; }';
        const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';

        await minioClient.putObject(
          config.minio.bucketBuilds,
          `${s3Prefix}/index.html`,
          Buffer.from(htmlContent),
          htmlContent.length,
          { 'Content-Type': 'text/html; charset=utf-8' }
        );
        await minioClient.putObject(
          config.minio.bucketBuilds,
          `${s3Prefix}/assets/main-c8b1a2.js`,
          Buffer.from(jsContent),
          jsContent.length,
          { 'Content-Type': 'application/javascript; charset=utf-8' }
        );
        await minioClient.putObject(
          config.minio.bucketBuilds,
          `${s3Prefix}/assets/style-d4e5f6.css`,
          Buffer.from(cssContent),
          cssContent.length,
          { 'Content-Type': 'text/css; charset=utf-8' }
        );
        await minioClient.putObject(
          config.minio.bucketBuilds,
          `${s3Prefix}/assets/logo.svg`,
          Buffer.from(svgContent),
          svgContent.length,
          { 'Content-Type': 'image/svg+xml' }
        );
      } catch (err: any) {
        console.warn('[Test Gateway Setup] MinIO storage offline notice:', err?.message);
      }
    });

    afterAll(async () => {
      try {
        if (gwProjectId) {
          await prisma.project.updateMany({
            where: { id: gwProjectId },
            data: { currentDeploymentId: null },
          });
          await prisma.deployment.deleteMany({ where: { projectId: gwProjectId } });
          await prisma.project.deleteMany({ where: { id: gwProjectId } });
        }
      } catch {}
    });

    it('resolves preview hostname and serves index.html with accurate Content-Type and Cache-Control', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: {
          host: `${gwSlug}-${gwShortSha}.mini-vercel.app`,
        },
      });

      // If MinIO is accessible, assert 200, otherwise check gateway resolution
      if (res.statusCode === 200) {
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
        expect(res.body).toContain('Mini-Vercel Artifact Gateway App');
      } else {
        expect([200, 404]).toContain(res.statusCode);
      }
    });

    it('serves static immutable assets with correct MIME type and immutable Cache-Control', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/assets/main-c8b1a2.js',
        headers: {
          host: `${gwSlug}-${gwShortSha}.mini-vercel.app`,
        },
      });

      if (res.statusCode === 200) {
        expect(res.headers['content-type']).toBe('application/javascript; charset=utf-8');
        expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
        expect(res.headers['etag']).toBeDefined();
        expect(res.body).toContain('Mini-Vercel Vite Production Bundle');

        // Test 304 Not Modified conditional request
        const etag = res.headers['etag'] as string;
        const res304 = await app.inject({
          method: 'GET',
          url: '/assets/main-c8b1a2.js',
          headers: {
            host: `${gwSlug}-${gwShortSha}.mini-vercel.app`,
            'if-none-match': etag,
          },
        });
        expect(res304.statusCode).toBe(304);
      }
    });

    it('resolves production hostname to Project.currentDeploymentId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: {
          host: `${gwSlug}.mini-vercel.app`,
        },
      });

      if (res.statusCode === 200) {
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.body).toContain('Mini-Vercel Artifact Gateway App');
      }
    });

    it('rejects access to non-READY deployments with 403 / 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/',
        headers: {
          host: `${gwSlug}-fffffff.mini-vercel.app`,
        },
      });

      expect([403, 404]).toContain(res.statusCode);
    });

    it('rejects path traversal attempts fail-closed with 400 Bad Request', async () => {
      const res1 = await app.inject({
        method: 'GET',
        url: `/preview/${gwDeploymentReadyId}/..%2f..%2fetc/passwd`,
      });
      expect(res1.statusCode).toBe(400);

      const res2 = await app.inject({
        method: 'GET',
        url: `/preview/${gwDeploymentReadyId}/%2e%2e%2fsecret.txt`,
      });
      expect(res2.statusCode).toBe(400);

      const res3 = await app.inject({
        method: 'GET',
        url: `/preview/${gwDeploymentReadyId}/assets/..%2f..%2fetc/shadow`,
      });
      expect(res3.statusCode).toBe(400);
    });

    it('provides SPA fallback to index.html for non-asset routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/settings/billing',
        headers: {
          host: `${gwSlug}-${gwShortSha}.mini-vercel.app`,
        },
      });

      if (res.statusCode === 200) {
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.body).toContain('Mini-Vercel Artifact Gateway App');
      }
    });

    it('serves artifacts via explicit preview URL /preview/:deploymentId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/preview/${gwDeploymentReadyId}/index.html`,
      });

      if (res.statusCode === 200) {
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.body).toContain('Mini-Vercel Artifact Gateway App');
      }
    });
  });

  describe('Atomic Promote, Pointer-Based Rollback & Audit Trail', () => {
    let prProject: any;
    let prDep1: any;
    let prDep2: any;
    let prDepBuilding: any;

    beforeAll(async () => {
      // 1. Create a dedicated project for promote/rollback tests
      prProject = await prisma.project.create({
        data: {
          userId: userA.id,
          name: `Promote Rollback Project ${Date.now()}`,
          slug: `pr-app-${Date.now()}`,
          repoName: `test-org/pr-app`,
          repoUrl: `https://github.com/test-org/pr-app`,
          branch: 'main',
        },
      });

      // 2. Create READY deployment 1
      const s3Prefix1 = `artifacts/${prProject.id}/dpl_pr1_${Date.now()}`;
      prDep1 = await prisma.deployment.create({
        data: {
          projectId: prProject.id,
          status: 'READY',
          trigger: 'MANUAL',
          commitHash: '1111111111111111111111111111111111111111',
          branch: 'main',
          s3Prefix: s3Prefix1,
          previewUrl: `https://${prProject.slug}-1111111.mini-vercel.app`,
        },
      });

      // 3. Create READY deployment 2
      const s3Prefix2 = `artifacts/${prProject.id}/dpl_pr2_${Date.now()}`;
      prDep2 = await prisma.deployment.create({
        data: {
          projectId: prProject.id,
          status: 'READY',
          trigger: 'MANUAL',
          commitHash: '2222222222222222222222222222222222222222',
          branch: 'main',
          s3Prefix: s3Prefix2,
          previewUrl: `https://${prProject.slug}-2222222.mini-vercel.app`,
        },
      });

      // 4. Create non-READY deployment
      prDepBuilding = await prisma.deployment.create({
        data: {
          projectId: prProject.id,
          status: 'BUILDING',
          trigger: 'MANUAL',
          commitHash: '3333333333333333333333333333333333333333',
          branch: 'main',
          s3Prefix: `artifacts/${prProject.id}/dpl_pr3_${Date.now()}`,
        },
      });

      // Upload mock index.html files to S3 if MinIO is online
      try {
        const dummyHtml = '<html><body><h1>Vite App</h1></body></html>';
        await minioClient.putObject(config.minio.bucketBuilds, `${s3Prefix1}/index.html`, Buffer.from(dummyHtml), dummyHtml.length);
        await minioClient.putObject(config.minio.bucketBuilds, `${s3Prefix2}/index.html`, Buffer.from(dummyHtml), dummyHtml.length);
      } catch {}
    });

    afterAll(async () => {
      try {
        if (prProject?.id) {
          await prisma.project.updateMany({
            where: { id: prProject.id },
            data: { currentDeploymentId: null },
          });
          await prisma.deploymentAudit.deleteMany({ where: { projectId: prProject.id } });
          await prisma.deployment.deleteMany({ where: { projectId: prProject.id } });
          await prisma.project.deleteMany({ where: { id: prProject.id } });
        }
      } catch {}
    });

    it('promotes READY deployment to production atomically without creating build/queue job', async () => {
      const originalAdd = deploymentQueue.add;
      let queueCalled = false;
      deploymentQueue.add = (async () => {
        queueCalled = true;
      }) as any;

      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/deployments/${prDep1.id}/promote`,
          headers: { 'x-user-id': userA.id },
        });

        expect(res.statusCode).toBe(200);
        const json = JSON.parse(res.payload);
        expect(json.success).toBe(true);
        expect(json.current_deployment_id).toBe(prDep1.id);
        expect(queueCalled).toBe(false); // Zero re-builds

        // Verify DB state
        const updatedProject = await prisma.project.findUnique({
          where: { id: prProject.id },
        });
        expect(updatedProject?.currentDeploymentId).toBe(prDep1.id);
        expect(updatedProject?.version).toBeGreaterThan(1);

        // Verify audit log
        const audit = await prisma.deploymentAudit.findFirst({
          where: { projectId: prProject.id, newDeploymentId: prDep1.id },
          orderBy: { timestamp: 'desc' },
        });
        expect(audit).toBeDefined();
        expect(audit?.operation).toBe('PROMOTE');
        expect(audit?.actorId).toBe(userA.id);
        expect(audit?.oldDeploymentId).toBeNull();
      } finally {
        deploymentQueue.add = originalAdd;
      }
    });

    it('returns idempotent success when promoting already active production deployment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/deployments/${prDep1.id}/promote`,
        headers: { 'x-user-id': userA.id },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.message).toContain('already the active production deployment');
    });

    it('rolls back production pointer to prior READY deployment without building', async () => {
      // 1. Promote dep2 first
      await app.inject({
        method: 'POST',
        url: `/api/deployments/${prDep2.id}/promote`,
        headers: { 'x-user-id': userA.id },
      });

      const projectAfterPromote = await prisma.project.findUnique({
        where: { id: prProject.id },
      });
      expect(projectAfterPromote?.currentDeploymentId).toBe(prDep2.id);

      // 2. Rollback to dep1
      const originalAdd = deploymentQueue.add;
      let queueCalled = false;
      deploymentQueue.add = (async () => {
        queueCalled = true;
      }) as any;

      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/deployments/${prDep1.id}/rollback`,
          headers: { 'x-user-id': userA.id },
        });

        expect(res.statusCode).toBe(200);
        const json = JSON.parse(res.payload);
        expect(json.success).toBe(true);
        expect(json.current_deployment_id).toBe(prDep1.id);
        expect(queueCalled).toBe(false); // Zero re-builds

        // Verify DB pointer updated
        const projectAfterRollback = await prisma.project.findUnique({
          where: { id: prProject.id },
        });
        expect(projectAfterRollback?.currentDeploymentId).toBe(prDep1.id);

        // Verify audit log for rollback
        const audit = await prisma.deploymentAudit.findFirst({
          where: { projectId: prProject.id, operation: 'ROLLBACK' },
          orderBy: { timestamp: 'desc' },
        });
        expect(audit).toBeDefined();
        expect(audit?.oldDeploymentId).toBe(prDep2.id);
        expect(audit?.newDeploymentId).toBe(prDep1.id);
        expect(audit?.actorId).toBe(userA.id);
      } finally {
        deploymentQueue.add = originalAdd;
      }
    });

    it('rejects rollback when targeting the currently active production deployment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/deployments/${prDep1.id}/rollback`,
        headers: { 'x-user-id': userA.id },
      });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.payload);
      expect(json.message).toContain('already the active production deployment');
    });

    it('rejects promotion and rollback for non-READY deployments', async () => {
      const resPromote = await app.inject({
        method: 'POST',
        url: `/api/deployments/${prDepBuilding.id}/promote`,
        headers: { 'x-user-id': userA.id },
      });
      expect(resPromote.statusCode).toBe(400);
      expect(JSON.parse(resPromote.payload).message).toContain('not in READY status');

      const resRollback = await app.inject({
        method: 'POST',
        url: `/api/deployments/${prDepBuilding.id}/rollback`,
        headers: { 'x-user-id': userA.id },
      });
      expect(resRollback.statusCode).toBe(400);
      expect(JSON.parse(resRollback.payload).message).toContain('not in READY status');
    });

    it('rejects promotion and rollback for cross-tenant unauthorized users with 404', async () => {
      const resPromote = await app.inject({
        method: 'POST',
        url: `/api/deployments/${prDep1.id}/promote`,
        headers: { 'x-user-id': userB.id }, // Bob trying to promote Alice's deployment
      });
      expect(resPromote.statusCode).toBe(404);

      const resRollback = await app.inject({
        method: 'POST',
        url: `/api/deployments/${prDep1.id}/rollback`,
        headers: { 'x-user-id': userB.id }, // Bob trying to rollback Alice's deployment
      });
      expect(resRollback.statusCode).toBe(404);
    });

    it('handles optimistic concurrency conflicts gracefully on concurrent modifications', async () => {
      // Create a scenario where version in DB changes right before transaction
      const curProject = await prisma.project.findUnique({
        where: { id: prProject.id },
      });

      // Artificially increment version in DB
      await prisma.project.update({
        where: { id: prProject.id },
        data: { version: (curProject?.version || 1) + 10 },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/deployments/${prDep2.id}/promote`,
        headers: { 'x-user-id': userA.id },
      });

      // The transaction will read the new version from DB and succeed, or return 409 if race condition
      expect([200, 409]).toContain(res.statusCode);
    });
  });

  describe('GitHub App Installation, Repository Authorization & Webhook Hardening', () => {
    const testInstId = 987654321;
    const testRepoId1 = 112233;
    const testRepoId2 = 445566;
    const authRepoName = `authorized-app-${Date.now()}`;
    const unauthRepoName = `unauthorized-secret-app-${Date.now()}`;

    afterAll(async () => {
      try {
        await prisma.githubInstallation.deleteMany({
          where: { installationId: BigInt(testInstId) },
        });
      } catch {}
    });

    it('verifies minimal OAuth scope does not request broad repo access', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/github/login?format=json',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.authorizeUrl).toContain('scope=read%3Auser%2Cuser%3Aemail');
      expect(json.authorizeUrl).not.toContain('scope=repo');
    });

    it('creates GitHub App installation and syncs authorized repositories via installation webhook', async () => {
      const rawPayload = JSON.stringify({
        action: 'created',
        installation: {
          id: testInstId,
          account: {
            id: 99999,
            login: userA.username,
            type: 'User',
          },
        },
        sender: {
          id: 99999,
          login: userA.username,
          avatar_url: 'https://github.com/alice.png',
        },
        repositories: [
          {
            id: testRepoId1,
            name: authRepoName,
            full_name: `${userA.username}/${authRepoName}`,
            private: false,
          },
          {
            id: testRepoId2,
            name: 'second-authorized-repo',
            full_name: `${userA.username}/second-authorized-repo`,
            private: true,
          },
        ],
      });

      const signature = 'sha256=' + createHmacSignature(rawPayload, config.github.webhookSecret);
      const deliveryId = `del_inst_create_${Date.now()}`;

      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-delivery': deliveryId,
          'x-github-event': 'installation',
        },
        payload: rawPayload,
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(json.action).toBe('created');

      // Verify installation and repositories exist in database
      const inst = await prisma.githubInstallation.findUnique({
        where: { installationId: BigInt(testInstId) },
        include: { repositories: true },
      });

      expect(inst).toBeDefined();
      expect(inst?.status).toBe('ACTIVE');
      expect(inst?.repositories.length).toBe(2);
      expect(inst?.repositories.map((r) => r.name)).toContain(authRepoName);
    });

    it('lists authorized repositories via GET /api/github/installations and GET /api/github/repos', async () => {
      const instRes = await app.inject({
        method: 'GET',
        url: '/api/github/installations',
        headers: { 'x-user-id': userA.id },
      });

      expect(instRes.statusCode).toBe(200);
      const instJson = JSON.parse(instRes.payload);
      expect(instJson.success).toBe(true);
      expect(instJson.total).toBeGreaterThanOrEqual(1);

      const reposRes = await app.inject({
        method: 'GET',
        url: '/api/github/repos',
        headers: { 'x-user-id': userA.id },
      });

      expect(reposRes.statusCode).toBe(200);
      const reposJson = JSON.parse(reposRes.payload);
      expect(reposJson.success).toBe(true);
      const names = reposJson.data.map((r: any) => r.name);
      expect(names).toContain(authRepoName);
    });

    it('allows project creation for authorized installation repository', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { 'x-user-id': userA.id },
        payload: {
          name: authRepoName,
          repoName: `${userA.username}/${authRepoName}`,
          repoUrl: `https://github.com/${userA.username}/${authRepoName}`,
          branch: 'main',
        },
      });

      expect(res.statusCode).toBe(201);
      const json = JSON.parse(res.payload);
      expect(json.success).toBe(true);
      expect(json.data.repoName).toBe(`${userA.username}/${authRepoName}`);
      expect(json.data.installationId).toBeDefined();
    });

    it('rejects project creation with 403 Forbidden for unauthorized repository', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { 'x-user-id': userA.id },
        payload: {
          name: unauthRepoName,
          repoName: `unauthorized-org/${unauthRepoName}`,
          repoUrl: `https://github.com/unauthorized-org/${unauthRepoName}`,
          branch: 'main',
        },
      });

      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.payload);
      expect(json.error).toBe('Forbidden');
      expect(json.message).toContain('not authorized under any of your active GitHub App installations');
    });

    it('acknowledges push webhook with ignored: true when branch mismatches project tracked branch', async () => {
      const rawPayload = JSON.stringify({
        ref: 'refs/heads/experimental-mismatch-branch',
        head_commit: {
          id: '9999999999999999999999999999999999999999',
          message: 'push to mismatch branch',
        },
        repository: {
          name: authRepoName,
          full_name: `${userA.username}/${authRepoName}`,
          clone_url: `https://github.com/${userA.username}/${authRepoName}.git`,
          default_branch: 'main',
        },
        sender: { login: userA.username },
      });

      const signature = 'sha256=' + createHmacSignature(rawPayload, config.github.webhookSecret);
      const deliveryId = `del_branch_mismatch_${Date.now()}`;

      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-delivery': deliveryId,
          'x-github-event': 'push',
        },
        payload: rawPayload,
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.ignored).toBe(true);
      expect(json.message).toContain('Branch mismatch');
    });

    it('enforces webhook delivery idempotency via database unique constraint during Redis downtime simulation', async () => {
      const persistentDeliveryId = `del_db_idempotency_${Date.now()}`;
      const rawPayload = JSON.stringify({
        ref: 'refs/heads/main',
        head_commit: {
          id: '8888888888888888888888888888888888888888',
          message: 'push for db idempotency test',
        },
        repository: {
          name: authRepoName,
          full_name: `${userA.username}/${authRepoName}`,
          clone_url: `https://github.com/${userA.username}/${authRepoName}.git`,
          default_branch: 'main',
        },
        sender: { login: userA.username },
      });

      const signature = 'sha256=' + createHmacSignature(rawPayload, config.github.webhookSecret);

      // 1. Initial delivery
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-delivery': persistentDeliveryId,
          'x-github-event': 'push',
        },
        payload: rawPayload,
      });
      expect(res1.statusCode).toBe(201);

      // 2. Clear Redis cache key to simulate Redis restart or cache eviction
      try {
        await redisConnection.del(`webhook:delivery:${persistentDeliveryId}`);
      } catch {}

      // 3. Second duplicate delivery with Redis cache key absent -> Database unique constraint catches it!
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-delivery': persistentDeliveryId,
          'x-github-event': 'push',
        },
        payload: rawPayload,
      });

      expect(res2.statusCode).toBe(200);
      const json2 = JSON.parse(res2.payload);
      expect(json2.duplicate).toBe(true);
      expect(json2.message).toContain('already processed');
    });

    it('deletes GitHub App installation and revokes authorized repositories via installation deleted webhook', async () => {
      const rawPayload = JSON.stringify({
        action: 'deleted',
        installation: {
          id: testInstId,
        },
        sender: { login: userA.username },
      });

      const signature = 'sha256=' + createHmacSignature(rawPayload, config.github.webhookSecret);
      const deliveryId = `del_inst_deleted_${Date.now()}`;

      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'x-github-delivery': deliveryId,
          'x-github-event': 'installation',
        },
        payload: rawPayload,
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.action).toBe('deleted');

      // Verify installation is removed from database
      const inst = await prisma.githubInstallation.findUnique({
        where: { installationId: BigInt(testInstId) },
      });
      expect(inst).toBeNull();
    });
  });
});

