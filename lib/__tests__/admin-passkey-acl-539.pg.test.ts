/**
 * M539 — explicit service_role ACL on admin_passkey_approvals. Real PostgreSQL
 * proof (disposable local database, created and dropped here).
 *
 * Fixture: production-like default privileges (service_role gets every table
 * right on new tables), the canonical M439 step-up table, then M538 and M539
 * applied from disk as whole-file statements. M539 is applied twice
 * (idempotency). The final ACL must be exactly SELECT, INSERT, DELETE.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M539 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const database = `m539_${randomUUID().replaceAll('-', '')}`;
const TABLE_RIGHTS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

suite('M539 explicit admin_passkey_approvals ACL (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const q = (text: string, params?: unknown[]) => client.query(text, params);
  const has = async (role: string, right: string) =>
    (await q('SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.admin_passkey_approvals', right])).rows[0].ok as boolean;
  const rights = async (role: string) => {
    const out: string[] = [];
    for (const r of TABLE_RIGHTS) if (await has(role, r)) out.push(r);
    return out;
  };

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url });
    await control.connect();
    await control.query(`CREATE DATABASE ${database}`);
    const parsed = new URL(url!);
    parsed.pathname = `/${database}`;
    client = new pg.Client({ connectionString: parsed.toString(), statement_timeout: 5000 });
    await client.connect();
    await q(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE TYPE auth.aal_level AS ENUM ('aal1', 'aal2', 'aal3');
      CREATE TABLE auth.sessions(id uuid PRIMARY KEY, user_id uuid NOT NULL, created_at timestamptz, aal auth.aal_level, factor_id uuid)`);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!(await q('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await q(`CREATE ROLE ${role}`);
    }
    // Production-like defaults: new tables give service_role every right.
    await q('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role');
    const m439 = readFileSync('supabase/migrations/439_admin_mfa_enforcement.sql', 'utf8');
    const start = m439.indexOf('CREATE TABLE IF NOT EXISTS public.admin_step_up_authorizations');
    const end = m439.indexOf('-- §2.');
    if (start < 0 || end <= start) throw new Error('Canonical M439 section markers changed');
    await q(m439.slice(start, end));
    await q(readFileSync('supabase/migrations/538_admin_passkey_step_up.sql', 'utf8'));
  }, 20000);

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database}`);
    await control?.end();
  });

  it('M538 alone leaves service_role with the environment default rights (the drift M539 fixes)', async () => {
    expect(await rights('service_role')).toEqual(TABLE_RIGHTS);
  });

  it('after M539 (twice), service_role has exactly SELECT, INSERT, DELETE; anon and authenticated have nothing', async () => {
    const m539 = readFileSync('supabase/migrations/539_admin_passkey_approvals_explicit_acl.sql', 'utf8');
    await q(m539);
    await q(m539);
    expect(await rights('service_role')).toEqual(['SELECT', 'INSERT', 'DELETE']);
    expect(await rights('anon')).toEqual([]);
    expect(await rights('authenticated')).toEqual([]);
  });
});
