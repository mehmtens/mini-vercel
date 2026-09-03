import './telemetry-init.js';
import fastify, { FastifyError, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import rawBody from 'fastify-raw-body';
import crypto from 'crypto';
import { config, validateProductionSecrets } from '@doplo/config';
import { prisma } from '@doplo/database';
import { ensureBucketExists } from './lib/minio';
import { registerHealthRoutes } from './routes/health';
import { registerAuthRoutes } from './routes/auth';
import { registerGitHubRoutes } from './routes/github';
import { registerDeploymentRoutes } from './routes/deployments';
import { registerProjectRoutes } from './routes/projects';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerLogRoutes } from './routes/logs';
import { registerStatsRoutes } from './routes/stats';
import { registerGatewayRoutes } from './routes/gateway.js';
import { registerTlsRoutes } from './routes/tls';
import { metricsPlugin, AppErrorCode } from './lib/metrics';

// Handle BigInt JSON serialization globally for Fastify and JSON.stringify
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export { AppErrorCode };

/**
 * Validates security constraints on startup: fail-closed in production
 */
export function validateEnvironmentSecurity(): void {
  validateProductionSecrets();
}

export async function buildApp(): Promise<FastifyInstance> {
  // Validate production security settings
  validateEnvironmentSecurity();

  const app = fastify({
    logger: config.env !== 'test' ? {
      level: process.env.LOG_LEVEL || 'info',
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      serializers: {
        req(req) {
          return {
            id: req.id,
            method: req.method,
            url: req.url,
            hostname: req.hostname,
            remoteAddress: req.ip,
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    } : false,
    genReqId: (req) => (req.headers['x-request-id'] as string) || crypto.randomUUID(),
    bodyLimit: config.security.bodyLimit, // 1MB default body limit to prevent memory exhaustion
    connectionTimeout: config.security.requestTimeoutMs,
  });

  // Attach X-Request-ID response header for distributed tracing and correlation
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // 1. Prometheus Metrics Plugin & /metrics endpoint
  await app.register(metricsPlugin);

  // 2. Helmet Security Headers (CSP, HSTS, X-Content-Type-Options, Frame-Options, etc.)
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'https:', 'http:'],
        fontSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
      },
    },
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
  });

  // 3. Global & Endpoint Rate Limiting
  await app.register(rateLimit, {
    max: config.security.rateLimitMax,
    timeWindow: config.security.rateLimitTimeWindow,
    allowList: (req) => {
      // Exclude health checks & metrics from rate limiting
      return (
        req.url === '/health' ||
        req.url === '/health/ready' ||
        req.url === '/health/live' ||
        req.url === '/metrics'
      );
    },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      code: AppErrorCode.RATE_LIMITED,
      message: `Rate limit exceeded, retry in ${Math.round(context.ttl / 1000)} seconds`,
      retryAfter: Math.round(context.ttl / 1000),
    }),
  });

  // 4. Environment-Based CORS Allowlist Policy
  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow server-to-server, curl, CLI, and mobile apps (no origin header)
      if (!origin) return cb(null, true);

      if (!config.isProduction) {
        return cb(null, true);
      }

      // Check configured allowlist
      const allowed = config.cors.allowedOrigins;
      const isAllowed = allowed.some((allowedOrigin) => {
        if (allowedOrigin.startsWith('*.')) {
          const suffix = allowedOrigin.slice(2);
          return origin.endsWith(suffix) || origin.endsWith(`://${suffix}`);
        }
        return origin === allowedOrigin;
      });

      if (isAllowed) {
        return cb(null, true);
      }

      return cb(new Error('CORS request blocked by origin allowlist policy'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  });

  // 5. Session Cookies
  await app.register(cookie, {
    secret: config.auth.sessionSecret,
    hook: 'onRequest',
  });

  await app.register(sensible);

  // 6. Global Security Hooks: Path Traversal & CSRF Protection
  app.addHook('onRequest', async (req, reply) => {
    const rawUrl = req.raw.url || req.url || '';
    if (
      rawUrl.includes('/..') ||
      rawUrl.includes('../') ||
      rawUrl.includes('%2e%2e') ||
      rawUrl.includes('%2E%2E') ||
      rawUrl.includes('\0') ||
      rawUrl.includes('\\')
    ) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'BadRequest',
        code: AppErrorCode.INVALID_INPUT,
        message: 'Path traversal attempt detected',
      });
    }

    // CSRF Protection for Cookie-Authenticated Mutation Requests
    const isMutation = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    const isWebhook = rawUrl.startsWith('/api/webhooks') || rawUrl.startsWith('/webhooks');
    const isOAuth = rawUrl.startsWith('/api/auth/github') || rawUrl.startsWith('/auth/github');

    if (isMutation && !isWebhook && !isOAuth) {
      const hasSessionCookie = Boolean(req.cookies?.mini_session);
      const authHeader = req.headers['authorization'];

      // If user is authenticated via Cookie (not Bearer token), verify anti-CSRF measures
      if (hasSessionCookie && !authHeader) {
        const csrfToken = req.headers['x-csrf-token'] || req.headers['x-requested-with'];
        const secFetchSite = req.headers['sec-fetch-site'];

        const isValidOrigin = secFetchSite === 'same-origin' || secFetchSite === 'none' || Boolean(csrfToken);

        if (!isValidOrigin && config.isProduction) {
          return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            code: AppErrorCode.FORBIDDEN,
            message: 'CSRF token missing or cross-site request validation failed',
          });
        }
      }
    }
  });

  // 7. Centralized Safe Error Handler
  app.setErrorHandler((error: FastifyError, req, reply) => {
    const statusCode = error.statusCode || (error as any).status || 500;
    const errorName = error.name || 'InternalServerError';

    // Mask internal error messages and database details in production
    let message = error.message || 'An unexpected error occurred';
    if (config.isProduction && statusCode === 500) {
      message = 'An internal server error occurred. Please contact support.';
    }

    if (statusCode >= 500) {
      app.log.error({ err: error, reqId: req.id, url: req.url }, 'Internal server error handled');
    }

    reply.status(statusCode).send({
      statusCode,
      error: errorName,
      code: (error as any).code || (statusCode >= 500 ? AppErrorCode.INTERNAL_ERROR : AppErrorCode.INVALID_INPUT),
      message,
      ...(error.validation ? { validation: error.validation } : {}),
    });
  });

  // 8. Register raw body plugin for GitHub Webhook HMAC validation
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  // 9. Register all API routes
  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerGitHubRoutes(app);
  await registerProjectRoutes(app);
  await registerDeploymentRoutes(app);
  await registerWebhookRoutes(app);
  await registerLogRoutes(app);
  await registerStatsRoutes(app);
  await registerGatewayRoutes(app);
  await registerTlsRoutes(app);

  return app;
}

async function start() {
  const app = await buildApp();

  // Connect to PostgreSQL via Prisma
  try {
    await prisma.$connect();
    app.log.info('PostgreSQL connection established with Prisma');
  } catch (err) {
    app.log.warn({ err }, 'Could not connect to PostgreSQL on boot (will retry on request)');
  }

  // Ensure MinIO storage bucket exists
  try {
    await ensureBucketExists();
    app.log.info('MinIO bucket verified');
  } catch (err) {
    app.log.warn({ err }, 'Could not verify MinIO bucket on boot');
  }

  try {
    await app.listen({ port: config.api.port, host: config.api.host });
    app.log.info(`Doplo Fastify API listening at http://${config.api.host}:${config.api.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  start();
}
