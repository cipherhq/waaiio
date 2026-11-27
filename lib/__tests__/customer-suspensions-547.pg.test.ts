/**
 * M547 — platform-wide customer suspension (#1103). Real PostgreSQL proof
 * (disposable local database, created and dropped here).
 *
 * Fixture: the canonical M439 step-up table, the step-up CHECK as last
 * redefined by M538 (M496 slice, then M538 from disk), admin_audit_logs as
 * created by M010 with M439's grants, then M547 applied from disk twice
 * (idempotency).
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
if (!url) throw new Error('Disposable PostgreSQL required for M547 (TEST_DATABASE_URL)');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');

const migration = (file: string) => readFileSync(`supabase/migrations/${file}`, 'utf8');
const database = `m547_${randomUUID().replaceAll('-', '')}`;
const ADMIN = '00000000-0000-0000-0000-000000000547';
const PHONE = '2348012345678';

describe('M547 customer suspensions (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const q = (text: string, params?: unknown[]) => client.query(text, params);

  /** Run as an API role inside a rolled-back transaction. */
  async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try {
      await q(`SET LOCAL ROLE ${role}`);
      return await fn();
    } finally { await q('ROLLBACK'); }
  }

  const setSuspension = (suspend: boolean, reason: string | null, phone = PHONE, actor = ADMIN) =>
    q('SELECT public.svc_set_customer_suspension($1, $2, $3, $4, $5) AS r', [actor, phone, suspend, reason, '203.0.113.9'])
      .then(res => res.rows[0].r as { changed: boolean; suspended: boolean; id?: string });

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
    // Supabase's service_role bypasses RLS.
    await q(`DO $$ BEGIN IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role') THEN ALTER ROLE service_role BYPASSRLS; END IF; END $$`);
    await q('GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role');
    // Production's drift: new tables and functions default to every right for every API role.
    await q(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;`);

    const m439 = migration('439_admin_mfa_enforcement.sql');
    const start = m439.indexOf('CREATE TABLE IF NOT EXISTS public.admin_step_up_authorizations');
    const end = m439.indexOf('-- §2.');
    if (start < 0 || end <= start) throw new Error('Canonical M439 section markers changed');
    await q(m439.slice(start, end));
    const m496 = migration('496_channel_number_continuity.sql');
    const checkStart = m496.indexOf('ALTER TABLE public.admin_step_up_authorizations\n  DROP CONSTRAINT IF EXISTS admin_step_up_authorizations_action_type_check;');
    const checkEnd = m496.indexOf('-- ── §4b.');
    if (checkStart < 0 || checkEnd <= checkStart) throw new Error('Canonical M496 CHECK markers changed');
    await q(m496.slice(checkStart, checkEnd));
    await q(migration('538_admin_passkey_step_up.sql'));

    // admin_audit_logs as created by M010, with M439's final grants.
    await q(`CREATE TABLE public.profiles(id uuid PRIMARY KEY);
      CREATE TABLE public.admin_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id UUID REFERENCES public.profiles(id),
        action VARCHAR(50) NOT NULL,
        entity_type VARCHAR(50),
        entity_id UUID,
        details JSONB DEFAULT '{}',
        ip_address VARCHAR(45),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;
      REVOKE INSERT, UPDATE, DELETE ON public.admin_audit_logs FROM PUBLIC, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_audit_logs TO service_role;`);
    await q('INSERT INTO auth.users(id) VALUES ($1)', [ADMIN]);
    await q('INSERT INTO public.profiles(id) VALUES ($1)', [ADMIN]);

    await q(migration('547_customer_suspensions.sql'));
    await q(migration('547_customer_suspensions.sql'));
  }, 30000);

  // DROP DATABASE can wait for a shared checkpoint in CI (seen at ~16s).
  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  }, 35_000);

  it('step-up CHECK keeps every earlier action, adds customer_suspension, rejects unknown ones', async () => {
    const insert = (action: string) => q(
      `INSERT INTO public.admin_step_up_authorizations(admin_user_id, session_id, action_type, params_hash) VALUES ($1, 's', $2, 'h')`,
      [ADMIN, action]);
    for (const a of ['payout_approve', 'payout_reject', 'payout_generate', 'payout_confirm_settlement', 'payout_force_settle',
      'provider_config', 'team_grant', 'team_revoke', 'impersonate', 'refund', 'reseller_payout_approve', 'reseller_payout_reject',
      'reseller_payout_mark_paid', 'reseller_payout_generate', 'commercial_config', 'messaging_config', 'messaging_suspension',
      'business_status', 'channel_change_execute', 'passkey_approve', 'passkey_remove', 'customer_suspension']) await insert(a);
    await expect(insert('customer_suspend_everyone')).rejects.toMatchObject({ code: '23514' });
  });

  it('table: RLS on with a deny-all policy; service role only, despite default grants', async () => {
    const { rows: rls } = await q(`SELECT relrowsecurity FROM pg_class WHERE oid='public.customer_suspensions'::regclass`);
    expect(rls[0].relrowsecurity).toBe(true);
    const { rows: pol } = await q(`SELECT cmd, qual, with_check FROM pg_policies WHERE tablename='customer_suspensions'`);
    expect(pol).toEqual([{ cmd: 'ALL', qual: 'false', with_check: 'false' }]);
    const priv = async (role: string, p: string) =>
      (await q('SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.customer_suspensions', p])).rows[0].ok;
    for (const role of ['anon', 'authenticated']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) expect(await priv(role, p)).toBe(false);
    }
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect(await priv('service_role', p)).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      await expect(as(role, () => q('SELECT * FROM public.customer_suspensions'))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('function: SECURITY INVOKER, fixed search_path, EXECUTE for service_role only', async () => {
    const { rows } = await q(`SELECT prosecdef, proconfig FROM pg_proc
      WHERE oid = 'public.svc_set_customer_suspension(uuid, text, boolean, text, text)'::regprocedure`);
    expect(rows[0]).toEqual({ prosecdef: false, proconfig: ['search_path=public, pg_temp'] });
    const exec = async (role: string) => (await q(
      `SELECT has_function_privilege($1, 'public.svc_set_customer_suspension(uuid, text, boolean, text, text)', 'EXECUTE') AS ok`, [role])).rows[0].ok;
    expect(await exec('anon')).toBe(false);
    expect(await exec('authenticated')).toBe(false);
    expect(await exec('service_role')).toBe(true);
    await expect(as('authenticated', () => setSuspension(true, 'abuse'))).rejects.toMatchObject({ code: '42501' });
  });

  it('phone and reason CHECKs: canonical digits only, reason 3 to 500 characters', async () => {
    for (const phone of ['+2348012345678', '08012345678', '234 801 234 5678', '12345', '1234567890123456']) {
      await expect(q(`INSERT INTO public.customer_suspensions(phone, reason, suspended_by) VALUES ($1, 'abuse', $2)`, [phone, ADMIN]))
        .rejects.toMatchObject({ code: '23514' });
    }
    for (const reason of ['  ', 'ab', 'x'.repeat(501)]) {
      await expect(q(`INSERT INTO public.customer_suspensions(phone, reason, suspended_by) VALUES ('2348011111111', $1, $2)`, [reason, ADMIN]))
        .rejects.toMatchObject({ code: '23514' });
    }
  });

  it('suspend, repeat, unsuspend, repeat: one row and one audit entry per real change (as service_role)', async () => {
    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE service_role');
      const first = await setSuspension(true, '  Abusive messages  ');
      expect(first).toMatchObject({ changed: true, suspended: true });
      const { rows: [row] } = await q('SELECT * FROM public.customer_suspensions WHERE phone=$1', [PHONE]);
      expect(row).toMatchObject({ id: first.id, reason: 'Abusive messages', suspended_by: ADMIN, last_notified_at: null });

      expect(await setSuspension(true, 'again')).toEqual({ changed: false, suspended: true });
      expect((await q('SELECT reason FROM public.customer_suspensions WHERE phone=$1', [PHONE])).rows).toEqual([{ reason: 'Abusive messages' }]);

      const off = await setSuspension(false, null);
      expect(off).toMatchObject({ changed: true, suspended: false, id: first.id });
      expect((await q('SELECT 1 FROM public.customer_suspensions WHERE phone=$1', [PHONE])).rowCount).toBe(0);
      expect(await setSuspension(false, null)).toEqual({ changed: false, suspended: false });

      const { rows: audit } = await q(`SELECT actor_id, action, entity_type, entity_id, details, ip_address
        FROM public.admin_audit_logs WHERE entity_type='customer_suspension' ORDER BY created_at, action DESC`);
      expect(audit).toHaveLength(2);
      expect(audit.map(a => a.action).sort()).toEqual(['suspend_customer', 'unsuspend_customer']);
      for (const a of audit) {
        expect(a).toMatchObject({ actor_id: ADMIN, entity_id: first.id, ip_address: '203.0.113.9' });
        expect(a.details).toMatchObject({ phone: PHONE, suspended_by: ADMIN });
      }
      expect(audit.find(a => a.action === 'suspend_customer')!.details.reason).toBe('Abusive messages');
      expect(audit.find(a => a.action === 'unsuspend_customer')!.details.reason).toBeNull();
    } finally { await q('ROLLBACK'); }
  });

  it('is atomic: when the audit row cannot be written, the suspension is not saved', async () => {
    const stranger = randomUUID(); // no profile → the audit FK fails
    await expect(setSuspension(true, 'abuse', '2348022222222', stranger)).rejects.toMatchObject({ code: '23503' });
    expect((await q(`SELECT 1 FROM public.customer_suspensions WHERE phone='2348022222222'`)).rowCount).toBe(0);
  });

  it('suspending one number does not touch another; re-suspending gets a new id', async () => {
    const a = await setSuspension(true, 'abuse', '2348033333333');
    const b = await setSuspension(true, 'abuse', '2348044444444');
    await setSuspension(false, null, '2348033333333');
    expect((await q(`SELECT phone FROM public.customer_suspensions WHERE phone IN ('2348033333333','2348044444444')`)).rows)
      .toEqual([{ phone: '2348044444444' }]);
    const again = await setSuspension(true, 'abuse', '2348033333333');
    expect(again.id).not.toBe(a.id);
    expect(b.changed).toBe(true);
  });

  it('rejects a missing actor, phone or flag', async () => {
    await expect(q('SELECT public.svc_set_customer_suspension(NULL, $1, true, $2)', [PHONE, 'abuse'])).rejects.toThrow(/required/);
    await expect(q('SELECT public.svc_set_customer_suspension($1, NULL, true, $2)', [ADMIN, 'abuse'])).rejects.toThrow(/required/);
    await expect(q('SELECT public.svc_set_customer_suspension($1, $2, NULL, $3)', [ADMIN, PHONE, 'abuse'])).rejects.toThrow(/required/);
  });
});
