import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from 'pg';
import { config } from '@mini-vercel/config';

async function main() {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sourceUrl = new URL(config.db.url);
  const testDatabase = 'mini_vercel_test';

  if (!sourceUrl.protocol.startsWith('postgres')) {
    throw new Error('Test database preparation requires a PostgreSQL DATABASE_URL.');
  }
  if (!testDatabase.endsWith('_test')) {
    throw new Error('Refusing to reset a database without the _test suffix.');
  }

  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = '/postgres';
  const testUrl = new URL(sourceUrl);
  testUrl.pathname = `/${testDatabase}`;

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [testDatabase]
    );
    await admin.query(`DROP DATABASE IF EXISTS ${testDatabase}`);
    if (process.argv.includes('--drop-only')) {
      console.log(`[Test DB] Dropped ${testDatabase}`);
      return;
    }
    await admin.query(`CREATE DATABASE ${testDatabase}`);
  } finally {
    await admin.end();
  }

  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error('pnpm executable path is unavailable.');
  execFileSync(process.execPath, [pnpmCli, 'exec', 'prisma', 'migrate', 'deploy'], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: testUrl.toString(), NODE_ENV: 'test' },
    stdio: 'inherit',
  });

  console.log(`[Test DB] Reset and migrated ${testDatabase}`);
}

main().catch((error) => {
  console.error('[Test DB] Preparation failed:', error);
  process.exit(1);
});
