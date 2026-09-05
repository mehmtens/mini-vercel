import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const envPath = path.resolve(process.cwd(), process.argv[2] || '.env');
if (!existsSync(envPath)) {
  console.error(`[Preflight] Environment file not found: ${envPath}`);
  process.exit(1);
}

const values = {};
for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const separator = line.indexOf('=');
  if (separator < 1) continue;
  values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
}

const required = [
  'NODE_ENV',
  'BASE_DOMAIN',
  'APP_DOMAIN',
  'ACME_EMAIL',
  'DOCKER_GID',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'REDIS_PASSWORD',
  'MINIO_ROOT_USER',
  'MINIO_ROOT_PASSWORD',
  'MINIO_BUCKET_BUILDS',
  'CRYPTO_MASTER_KEY',
  'SESSION_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_CALLBACK_URL',
  'GITHUB_WEBHOOK_SECRET',
];

const errors = [];
for (const key of required) {
  if (!values[key]) errors.push(`${key} is required`);
}

const placeholderPattern =
  /(yourdomain|your[_-]|generate[_-]|change[_-]?me|example\.com|minio_admin_user)/i;
for (const key of required) {
  if (values[key] && placeholderPattern.test(values[key])) {
    errors.push(`${key} still contains a template placeholder`);
  }
}

if (values.NODE_ENV !== 'production') errors.push('NODE_ENV must be production');
if (values.DEV_AUTH_BYPASS === 'true') errors.push('DEV_AUTH_BYPASS must not be true');
if (!/^\d+$/.test(values.DOCKER_GID || '')) errors.push('DOCKER_GID must be numeric');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.ACME_EMAIL || '')) {
  errors.push('ACME_EMAIL must be a valid email address');
}
if (!/^[0-9a-f]{64}$/i.test(values.CRYPTO_MASTER_KEY || '')) {
  errors.push('CRYPTO_MASTER_KEY must be exactly 64 hexadecimal characters');
}

for (const key of [
  'SESSION_SECRET',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  'MINIO_ROOT_PASSWORD',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
]) {
  if ((values[key] || '').length < 32) errors.push(`${key} must be at least 32 characters`);
}

for (const key of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD']) {
  if (values[key] && !/^[A-Za-z0-9._~-]+$/.test(values[key])) {
    errors.push(`${key} must use URL-safe characters only (A-Z, a-z, 0-9, ., _, ~, -)`);
  }
}

for (const key of ['POSTGRES_USER', 'POSTGRES_DB']) {
  if (values[key] && !/^[A-Za-z0-9_]+$/.test(values[key])) {
    errors.push(`${key} must use letters, digits, and underscores only`);
  }
}

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
for (const key of ['BASE_DOMAIN', 'APP_DOMAIN']) {
  if (values[key] && !domainPattern.test(values[key]))
    errors.push(`${key} must be a valid hostname`);
}

if (
  values.BASE_DOMAIN &&
  values.APP_DOMAIN &&
  values.APP_DOMAIN !== values.BASE_DOMAIN &&
  !values.APP_DOMAIN.endsWith(`.${values.BASE_DOMAIN}`)
) {
  errors.push('APP_DOMAIN must equal BASE_DOMAIN or be one of its subdomains');
}
const expectedCallback = values.APP_DOMAIN
  ? `https://${values.APP_DOMAIN}/api/auth/callback/github`
  : '';
if (values.GITHUB_CALLBACK_URL && values.GITHUB_CALLBACK_URL !== expectedCallback) {
  errors.push(`GITHUB_CALLBACK_URL must equal ${expectedCallback}`);
}

if (errors.length > 0) {
  console.error('[Preflight] Production configuration is not safe to deploy:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`[Preflight] Production environment is valid for ${values.APP_DOMAIN}.`);
