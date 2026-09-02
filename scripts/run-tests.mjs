import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const envPath = path.resolve(process.cwd(), '.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}

const databaseUrl = new URL(
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5435/mini_vercel'
);
databaseUrl.pathname = '/mini_vercel_test';

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('pnpm executable path is unavailable.');
const result = spawnSync(process.execPath, [pnpmCli, 'exec', 'turbo', 'run', 'test'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl.toString(),
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
