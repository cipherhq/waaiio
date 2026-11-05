// Trusted integration-only fixture runner. Fixed local connection and new database;
// no caller URL, credentials, database name, or SQL can be supplied through CLI/env.
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export async function runStorageTests({ client = new pg.Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:5432/postgres' }), execute = execFileSync, environment = process.env } = {}) {
  let created = false;
  try {
    await client.connect();
    await client.query('CREATE DATABASE storage_security_test');
    created = true;
    return execute('npm', ['exec', '--', 'vitest', 'run', 'lib/__tests__/private-storage-491.pg.test.ts', '--no-file-parallelism', '--reporter=json'], {
      env: { PATH: environment.PATH, HOME: environment.HOME, CI: 'true', HUSKY: '0', TZ: 'UTC', REQUIRE_PG_TESTS: 'true', TEST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/storage_security_test' },
      encoding: 'utf8', maxBuffer: 20*1024*1024, stdio: ['ignore', 'pipe', 'inherit'],
    });
  } finally {
    try { if (created) await client.query('DROP DATABASE storage_security_test'); }
    finally { await client.end(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(await runStorageTests());
