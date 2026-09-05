import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = path.resolve('scripts/production-preflight.mjs');

const validEnvironment = {
  NODE_ENV: 'production',
  BASE_DOMAIN: 'doplo.dev',
  APP_DOMAIN: 'doplo.dev',
  ACME_EMAIL: 'admin@doplo.dev',
  DOCKER_GID: '999',
  POSTGRES_USER: 'doplo_prod',
  POSTGRES_PASSWORD: 'database-password-that-is-long-enough',
  POSTGRES_DB: 'doplo',
  REDIS_PASSWORD: 'redis-password-that-is-long-enough',
  MINIO_ROOT_USER: 'doplo',
  MINIO_ROOT_PASSWORD: 'minio-password-that-is-long-enough',
  MINIO_BUCKET_BUILDS: 'doplo-builds',
  CRYPTO_MASTER_KEY: '01'.repeat(32),
  SESSION_SECRET: 'session-secret-that-is-long-enough',
  GITHUB_CLIENT_ID: 'github-client-id',
  GITHUB_CLIENT_SECRET: 'github-client-secret-that-is-long-enough',
  GITHUB_CALLBACK_URL: 'https://doplo.dev/api/auth/callback/github',
  GITHUB_WEBHOOK_SECRET: 'github-webhook-secret-that-is-long-enough',
};

function runPreflight(overrides = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'doplo-preflight-'));
  const envPath = path.join(directory, '.env');
  const values = { ...validEnvironment, ...overrides };
  writeFileSync(
    envPath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );

  try {
    return spawnSync(process.execPath, [scriptPath, envPath], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('accepts the zone apex as the application domain', () => {
  const result = runPreflight();
  assert.equal(result.status, 0, result.stderr);
});

test('accepts an application subdomain of the base domain', () => {
  const result = runPreflight({
    APP_DOMAIN: 'app.doplo.dev',
    GITHUB_CALLBACK_URL: 'https://app.doplo.dev/api/auth/callback/github',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('rejects an application domain outside the base domain', () => {
  const result = runPreflight({
    APP_DOMAIN: 'doplo.example',
    GITHUB_CALLBACK_URL: 'https://doplo.example/api/auth/callback/github',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must equal BASE_DOMAIN or be one of its subdomains/);
});
