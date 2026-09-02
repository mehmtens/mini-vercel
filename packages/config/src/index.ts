import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';

// Load .env from workspace root or current directory
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface AppConfig {
  env: string;
  isProduction: boolean;
  app: {
    url: string;
    domain: string;
    baseDomain: string;
  };
  api: {
    port: number;
    host: string;
    url: string;
  };
  web: {
    port: number;
    url: string;
  };
  cors: {
    allowedOrigins: string[];
  };
  db: {
    url: string;
    host: string;
    port: number;
    user: string;
    pass: string;
    name: string;
  };
  redis: {
    url: string;
    host: string;
    port: number;
    password?: string;
  };
  minio: {
    endpoint: string;
    port: number;
    useSSL: boolean;
    accessKey: string;
    secretKey: string;
    bucketBuilds: string;
    region: string;
  };
  queue: {
    name: string;
    concurrency: number;
    staleThresholdMs: number;
    reconciliationLockTtlMs: number;
  };
  github: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    webhookSecret: string;
  };
  auth: {
    sessionSecret: string;
    devBypass: boolean;
  };
  crypto: {
    masterKey: string;
  };
  security: {
    bodyLimit: number;
    requestTimeoutMs: number;
    rateLimitMax: number;
    rateLimitTimeWindow: string;
  };
  telemetry: {
    enabled: boolean;
    serviceName: string;
    otlpEndpoint: string;
  };
}

const DEFAULT_DEV_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const DEFAULT_DEV_SESSION_SECRET = 'super_secret_session_signing_key_32b';
const DEFAULT_DEV_WEBHOOK_SECRET = 'dev_webhook_secret_key_12345';

const rawMasterKey = (
  process.env.CRYPTO_MASTER_KEY ||
  process.env.ENCRYPTION_MASTER_KEY ||
  process.env.MASTER_KEY ||
  DEFAULT_DEV_MASTER_KEY
).trim();

// Canonical 64-hex validation & normalization (32 bytes = 256 bits for AES-256-GCM)
const normalizedMasterKey = /^[0-9a-fA-F]{64}$/.test(rawMasterKey)
  ? rawMasterKey
  : crypto.createHash('sha256').update(rawMasterKey, 'utf8').digest('hex');

const allowedOriginsEnv = process.env.CORS_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || '';
const parsedAllowedOrigins = allowedOriginsEnv
  ? allowedOriginsEnv.split(',').map((o) => o.trim()).filter(Boolean)
  : [
      'http://localhost:3000',
      'http://localhost:8080',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:8080',
      'http://app.localhost',
      'http://localhost',
    ];

const baseDomain = process.env.BASE_DOMAIN || 'localhost';
const appDomain = process.env.APP_DOMAIN || (baseDomain === 'localhost' ? 'app.localhost' : `app.${baseDomain}`);

export const config: AppConfig = {
  env: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  app: {
    url: process.env.APP_URL || 'http://localhost:3000',
    domain: appDomain,
    baseDomain: baseDomain,
  },
  api: {
    port: Number(process.env.API_PORT || process.env.PORT || 8080),
    host: process.env.API_HOST || '0.0.0.0',
    url: process.env.API_URL || 'http://localhost:8080',
  },
  web: {
    port: Number(process.env.WEB_PORT || 3000),
    url: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080',
  },
  cors: {
    allowedOrigins: parsedAllowedOrigins,
  },
  db: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/mini_vercel',
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER || 'postgres',
    pass: process.env.POSTGRES_PASSWORD || 'postgres',
    name: process.env.POSTGRES_DB || 'mini_vercel',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: Number(process.env.MINIO_PORT || 9000),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    bucketBuilds: process.env.MINIO_BUCKET_BUILDS || 'mini-vercel-builds',
    region: process.env.MINIO_REGION || 'us-east-1',
  },
  queue: {
    name: process.env.QUEUE_NAME || 'deployment-queue',
    concurrency: Number(process.env.QUEUE_CONCURRENCY || 5),
    staleThresholdMs: Number(process.env.RECONCILIATION_STALE_THRESHOLD_MS || process.env.STALE_DEPLOYMENT_THRESHOLD_MS || 10 * 60 * 1000),
    reconciliationLockTtlMs: Number(process.env.RECONCILIATION_LOCK_TTL_MS || 30 * 1000),
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || 'mock_github_client_id',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || 'mock_github_client_secret',
    callbackUrl: process.env.GITHUB_CALLBACK_URL || 'http://localhost:8080/api/auth/callback/github',
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || DEFAULT_DEV_WEBHOOK_SECRET,
  },
  auth: {
    sessionSecret: process.env.SESSION_SECRET || DEFAULT_DEV_SESSION_SECRET,
    devBypass: process.env.DEV_AUTH_BYPASS === 'true' || process.env.NODE_ENV !== 'production',
  },
  crypto: {
    masterKey: normalizedMasterKey,
  },
  security: {
    bodyLimit: Number(process.env.REQUEST_BODY_LIMIT_BYTES || 1048576), // 1MB
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30000), // 30s
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 120), // 120 requests
    rateLimitTimeWindow: process.env.RATE_LIMIT_TIME_WINDOW || '1 minute',
  },
  telemetry: {
    enabled: process.env.OTEL_SDK_DISABLED !== 'true',
    serviceName: process.env.OTEL_SERVICE_NAME || 'mini-vercel',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318',
  },
};

/**
 * Builds the canonical immutable preview URL for a deployment.
 * Local development uses Caddy's `.localhost` HTTP routing; production uses
 * the configured base domain and HTTPS.
 */
export function buildPreviewUrl(
  projectSlug: string,
  commitHash: string,
  baseDomain: string = config.app.baseDomain
): string {
  const normalizedDomain = baseDomain.trim().toLowerCase();
  const protocol = normalizedDomain === 'localhost' ? 'http' : 'https';
  return `${protocol}://${projectSlug}-${commitHash.slice(0, 7)}.${normalizedDomain}`;
}

/**
 * Validates that production environments do not use default or insecure secrets (fail-fast).
 */
export function validateProductionSecrets(): void {
  if (config.isProduction) {
    if (!config.auth.sessionSecret || config.auth.sessionSecret.length < 32) {
      throw new Error('SESSION_SECRET is required and must be at least 32 characters in production environment');
    }
    if (process.env.DEV_AUTH_BYPASS === 'true') {
      throw new Error('DEV_AUTH_BYPASS is strictly prohibited in production environment');
    }
    if (process.env.NODE_ENV === 'production') {
      if (process.env.CRYPTO_MASTER_KEY === DEFAULT_DEV_MASTER_KEY) {
        throw new Error('FATAL: In production, CRYPTO_MASTER_KEY must be explicitly set to a unique 64-character hex string.');
      }
      if (process.env.POSTGRES_PASSWORD === 'postgres') {
        throw new Error('FATAL: Default database password "postgres" is prohibited in production.');
      }
      if (process.env.GRAFANA_ADMIN_PASSWORD === 'admin') {
        throw new Error('FATAL: Default Grafana admin password "admin" is prohibited in production.');
      }
    }
  }
}
