/**
 * M553 — step-up action 'subscription_admin_action'. Real PostgreSQL proof
 * (disposable local database, created and dropped here).
 *
 * Fixture: the canonical M439 step-up table, then M553 applied from disk twice
 * (idempotency). The earlier actions are read from M548's CHECK on disk, so the
 * test fails if M553 drops any action M548 allowed.
 *
 * This test FAILS, never skips, when the database is missing. It runs in CI in
 * the security-acl-tests job ("Run .pg.test.ts files in parallel with isolated
 * databases").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Disposable PostgreSQL required for M553 (TEST_DATABASE_URL)');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');

const migration = (file: string) => readFileSync(`supabase/migrations/${file}`, 'utf8');
const database = `m553_${randomUUID().replaceAll('-', '')}`;
const ADMIN = '00000000-0000-0000-0000-000000000553';

function checkList(sql: string): string[] {
  const match = sql.match(/admin_step_up_authorizations_action_type_check\s+CHECK \(action_type IN \(([^)]*)\)\)/);
  if (!match) throw new Error('action_type CHECK not found');
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
}

describe('M553 subscription_admin_action step-up (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const q = (text: string, params?: unknown[]) => client.query(text, params);

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url });
    await control.connect();
    await control.query(`CREATE DATABASE ${database}`);
    const parsed = new URL(url!);
    parsed.pathname = `/${database}`;
    client = new pg.Client({ connectionString: parsed.toString(), statement_timeout: 5000 });
    await client.connect();
    await q('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!(await q('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await q(`CREATE ROLE ${role}`);
    }
    const m439 = migration('439_admin_mfa_enforcement.sql');
    const start = m439.indexOf('CREATE TABLE IF NOT EXISTS public.admin_step_up_authorizations');
    const end = m439.indexOf('-- §2.');
    if (start < 0 || end <= start) throw new Error('Canonical M439 section markers changed');
    await q(m439.slice(start, end));
    await q('INSERT INTO auth.users(id) VALUES ($1)', [ADMIN]);

    await q(migration('553_subscription_admin_action_step_up.sql'));
    await q(migration('553_subscription_admin_action_step_up.sql'));
  }, 30000);

  // DROP DATABASE can wait for a shared checkpoint in CI.
  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  }, 35_000);

  const insert = (action: string) => q(
    `INSERT INTO public.admin_step_up_authorizations(admin_user_id, session_id, action_type, params_hash) VALUES ($1, 's', $2, 'h')`,
    [ADMIN, action]);

  it('keeps every action M548 allowed and adds subscription_admin_action', async () => {
    const earlier = checkList(migration('548_admin_whatsapp_broadcasts.sql'));
    expect(earlier.length).toBeGreaterThan(20);
    expect(checkList(migration('553_subscription_admin_action_step_up.sql'))).toEqual([...earlier, 'subscription_admin_action']);
    for (const action of [...earlier, 'subscription_admin_action']) await insert(action);
  });

  it('still rejects unknown actions', async () => {
    await expect(insert('subscription_admin_action_everything')).rejects.toMatchObject({ code: '23514' });
  });

  it('leaves exactly one CHECK on action_type', async () => {
    const { rows } = await q(`SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'public.admin_step_up_authorizations'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%action_type%'`);
    expect(rows[0].n).toBe(1);
  });
});
