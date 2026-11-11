// Disposable CI replay of the already-approved M501 operational entrypoints.
// No enrollment, activation, live connection, or relaxation of catalog locks.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { installAccountingFinalizers } from './release-v3/catalog-oracle.mjs';

const connectionString = process.argv[2];
const migrationSource = process.argv[3];
if (migrationSource && migrationSource !== '--migration-stdin') {
  throw new Error('Unknown accounting fixture restoration source');
}
const host = connectionString ? new URL(connectionString).hostname : (process.env.PGHOST || 'localhost');
if (!['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(host)) {
  throw new Error('Accounting fixture restoration requires a disposable local PostgreSQL endpoint');
}
const client = new pg.Client(connectionString ? { connectionString } : {});
await client.connect();
try {
  if ((await client.query('SELECT current_user AS owner')).rows[0].owner !== 'postgres') {
    throw new Error('Accounting fixture restoration requires canonical postgres ownership');
  }
  await client.query('BEGIN');
  try {
    await installAccountingFinalizers(client, readFileSync(migrationSource === '--migration-stdin' ? 0 : new URL('../supabase/migrations/501_accounting_cutover_installer.sql', import.meta.url), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
} finally {
  await client.end();
}
