import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
const original = readFileSync(envPath, 'utf8');
const lines = original.split(/\r?\n/);
const values = new Map();

for (const line of lines) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (match) values.set(match[1], match[2]);
}

const set = (key, value) => values.set(key, value);
const currentCryptoKey = values.get('CRYPTO_MASTER_KEY') || '';
const knownDevelopmentKey = Array.from({ length: 64 }, (_, index) => {
  const nibble = index % 16;
  return nibble < 10 ? String(nibble) : String.fromCharCode(87 + nibble);
}).join('');

if (!/^[a-f0-9]{64}$/i.test(currentCryptoKey) || currentCryptoKey === knownDevelopmentKey) {
  set('CRYPTO_MASTER_KEY', randomBytes(32).toString('hex'));
}

if ((values.get('SESSION_SECRET') || '').length < 32) {
  set('SESSION_SECRET', randomBytes(48).toString('base64url'));
}

if ((values.get('GITHUB_WEBHOOK_SECRET') || '').length < 32) {
  set('GITHUB_WEBHOOK_SECRET', randomBytes(48).toString('base64url'));
}

set('NODE_ENV', 'production');
set('DEV_AUTH_BYPASS', 'false');
set('BASE_DOMAIN', 'doplo.dev');
set('APP_DOMAIN', 'doplo.dev');
set('APP_URL', 'https://doplo.dev');
set('API_URL', 'https://doplo.dev');
set('NEXT_PUBLIC_API_URL', 'https://doplo.dev');
set('NEXT_PUBLIC_BASE_DOMAIN', 'doplo.dev');
set('GITHUB_CALLBACK_URL', 'https://doplo.dev/api/auth/callback/github');

const emitted = new Set();
const output = lines.map((line) => {
  const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
  if (!match) return line;
  emitted.add(match[1]);
  return `${match[1]}=${values.get(match[1])}`;
});

for (const [key, value] of values) {
  if (!emitted.has(key)) output.push(`${key}=${value}`);
}

writeFileSync(envPath, `${output.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
console.log('Tunnel beta environment configured. Secret values were not printed.');
