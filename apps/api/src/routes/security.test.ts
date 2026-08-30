import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp, validateEnvironmentSecurity } from '../index';
import { prisma } from '@mini-vercel/database';
import { validateProductionSecrets, config } from '@mini-vercel/config';

describe('Application & Edge Security Baseline Integration Tests', () => {
  let app: FastifyInstance;
  let testUser: any;
  let testProject: any;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    testUser = await prisma.user.upsert({
      where: { githubId: 'gh_sec_user' },
      update: {},
      create: {
        githubId: 'gh_sec_user',
        username: 'sec_user',
        email: 'sec_user@mini-vercel.local',
      },
    });

    const uniqueSlug = `custom-domain-app-${Date.now()}`;
    testProject = await prisma.project.create({
      data: {
        userId: testUser.id,
        name: uniqueSlug,
        slug: uniqueSlug,
        repoName: `mini-vercel/${uniqueSlug}`,
        repoUrl: `https://github.com/mini-vercel/${uniqueSlug}`,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('1. Security Headers (Helmet, CSP, HSTS, X-Content-Type-Options)', () => {
    it('sets standard defensive security headers on all HTTP responses', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    });
  });

  describe('2. Path Traversal & Injection Attack Prevention', () => {
    it('blocks path traversal attempts with encoded dots or malicious traversal sequences', async () => {
      const res1 = await app.inject({
        method: 'GET',
        url: '/health?path=%2e%2e/%2e%2e/shadow',
      });
      expect(res1.statusCode).toBe(400);
      expect(JSON.parse(res1.payload).message).toContain('Path traversal');

      const res2 = await app.inject({
        method: 'GET',
        url: '/health?file=../../etc/passwd',
      });
      expect(res2.statusCode).toBe(400);
      expect(JSON.parse(res2.payload).message).toContain('Path traversal');
    });
  });

  describe('3. Rate Limiting Protection', () => {
    it('handles request throttling and sets standard rate limit headers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/stats',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    });
  });

  describe('4. Caddy On-Demand TLS Validation (/api/tls/ask)', () => {
    it('approves TLS certificate for local development domains (localhost, app.localhost)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/tls/ask?domain=app.localhost',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.allowed).toBe(true);
      expect(json.domain).toBe('app.localhost');
    });

    it('approves TLS certificate for registered project slug domains', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/tls/ask?domain=${testProject.slug}`,
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.allowed).toBe(true);
      expect(json.projectId).toBe(testProject.id);
    });

    it('rejects unauthorized or unknown custom domains with 403 Forbidden to prevent TLS abuse', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/tls/ask?domain=malicious-unregistered-domain.com',
      });

      expect(res.statusCode).toBe(403);
      const json = JSON.parse(res.payload);
      expect(json.allowed).toBe(false);
      expect(json.error).toBe('Forbidden');
    });

    it('rejects missing domain query parameter with 400 Bad Request', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/tls/ask',
      });

      expect(res.statusCode).toBe(400);
      const json = JSON.parse(res.payload);
      expect(json.allowed).toBe(false);
    });
  });

  describe('5. Production Environment Fail-Fast Secret Validator', () => {
    it('allows valid development configuration', () => {
      expect(() => validateProductionSecrets()).not.toThrow();
    });

    it('throws fail-closed error if SESSION_SECRET is too short in production', () => {
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

    it('throws fail-closed error if DEV_AUTH_BYPASS is true in production', () => {
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
});
