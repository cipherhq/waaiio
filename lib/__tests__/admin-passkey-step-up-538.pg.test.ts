/**
 * M538 — admin passkey step-up. Real PostgreSQL proof (disposable local
 * database, created and dropped here).
 *
 * Fixture: the canonical M439 step-up table section and its cleanup function
 * (§6), the step-up CHECK as last redefined by M496, a minimal auth.sessions
 * with Supabase Auth's aal/factor_id/created_at columns, then M538 applied
 * from disk as one whole-file statement, twice (idempotency).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M538 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m538 = readFileSync('supabase/migrations/538_admin_passkey_step_up.sql', 'utf8');
const database = `m538_${randomUUID().replaceAll('-', '')}`;
const ADMIN = '00000000-0000-0000-0000-000000000201';

suite('M538 admin passkey step-up (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const q = (text: string, params?: unknown[]) => client.query(text, params);

  async function insertGrant(action: string, challenge: string | null) {
    const { rows } = await q(
      `INSERT INTO public.admin_step_up_authorizations(admin_user_id, session_id, action_type, params_hash, challenge_id)
       VALUES ($1, 's', $2, 'h', $3) RETURNING id`, [ADMIN, action, challenge]);
    return rows[0].id as string;
  }

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
    const m439 = readFileSync('supabase/migrations/439_admin_mfa_enforcement.sql', 'utf8');
    const start = m439.indexOf('CREATE TABLE IF NOT EXISTS public.admin_step_up_authorizations');
    const end = m439.indexOf('-- §2.');
    if (start < 0 || end <= start) throw new Error('Canonical M439 section markers changed');
    await q(m439.slice(start, end));
    const cleanupStart = m439.indexOf('CREATE OR REPLACE FUNCTION public.cleanup_expired_step_ups()');
    const cleanupEnd = m439.indexOf('-- §6b.');
    if (cleanupStart < 0 || cleanupEnd <= cleanupStart) throw new Error('Canonical M439 cleanup markers changed');
    await q(m439.slice(cleanupStart, cleanupEnd));
    // The cumulative CHECK before M538 (last redefined by M496 §4).
    const m496 = readFileSync('supabase/migrations/496_channel_number_continuity.sql', 'utf8');
    const checkStart = m496.indexOf('ALTER TABLE public.admin_step_up_authorizations\n  DROP CONSTRAINT IF EXISTS admin_step_up_authorizations_action_type_check;');
    const checkEnd = m496.indexOf('-- ── §4b.');
    if (checkStart < 0 || checkEnd <= checkStart) throw new Error('Canonical M496 CHECK markers changed');
    await q(m496.slice(checkStart, checkEnd));
    await q('INSERT INTO auth.users(id) VALUES ($1)', [ADMIN]);
    await q(m538);
    await q(m538);
  }, 20000);

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database}`);
    await control?.end();
  });

  it('keeps every earlier action, accepts the new passkey actions and still rejects unknown ones', async () => {
    for (const a of ['payout_approve', 'payout_reject', 'payout_generate', 'payout_confirm_settlement', 'payout_force_settle',
      'provider_config', 'team_grant', 'team_revoke', 'impersonate', 'refund', 'reseller_payout_approve', 'reseller_payout_reject',
      'reseller_payout_mark_paid', 'reseller_payout_generate', 'commercial_config', 'messaging_config', 'messaging_suspension',
      'business_status', 'channel_change_execute']) await insertGrant(a, null);
    await insertGrant('passkey_approve', null);
    await insertGrant('passkey_remove', null);
    await insertGrant('refund', null);
    await expect(insertGrant('passkey_skip_everything', null)).rejects.toMatchObject({ code: '23514' });
  });

  it('one challenge id (one passkey tap) can verify only one grant', async () => {
    const tap = randomUUID();
    const a = await insertGrant('refund', null);
    const b = await insertGrant('payout_approve', null);
    await q('UPDATE public.admin_step_up_authorizations SET challenge_id=$1, verified_at=now() WHERE id=$2 AND challenge_id IS NULL', [tap, a]);
    await expect(q('UPDATE public.admin_step_up_authorizations SET challenge_id=$1, verified_at=now() WHERE id=$2 AND challenge_id IS NULL', [tap, b]))
      .rejects.toMatchObject({ code: '23505' });
    const { rows } = await q('SELECT verified_at FROM public.admin_step_up_authorizations WHERE id=$1', [b]);
    expect(rows[0].verified_at).toBeNull();
  });

  it('many pending grants may have no challenge yet', async () => {
    await insertGrant('refund', null);
    await insertGrant('refund', null);
    const { rows } = await q('SELECT count(*)::int AS n FROM public.admin_step_up_authorizations WHERE challenge_id IS NULL');
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('approvals table: RLS on, service role only, no updates', async () => {
    const { rows: rls } = await q(`SELECT relrowsecurity FROM pg_class WHERE oid='public.admin_passkey_approvals'::regclass`);
    expect(rls[0].relrowsecurity).toBe(true);
    const priv = async (role: string, p: string) =>
      (await q('SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.admin_passkey_approvals', p])).rows[0].ok;
    for (const role of ['anon', 'authenticated']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect(await priv(role, p)).toBe(false);
    }
    expect(await priv('service_role', 'SELECT')).toBe(true);
    expect(await priv('service_role', 'INSERT')).toBe(true);
    expect(await priv('service_role', 'DELETE')).toBe(true);
    expect(await priv('service_role', 'UPDATE')).toBe(false);
    const { rows: pol } = await q(`SELECT qual, with_check FROM pg_policies WHERE tablename='admin_passkey_approvals'`);
    expect(pol).toEqual([{ qual: 'false', with_check: 'false' }]);
  });

  it('an approval is unique per passkey', async () => {
    const su = await insertGrant('passkey_approve', null);
    const factor = randomUUID();
    await q('INSERT INTO public.admin_passkey_approvals(factor_id, admin_user_id, step_up_id) VALUES ($1,$2,$3)', [factor, ADMIN, su]);
    await expect(q('INSERT INTO public.admin_passkey_approvals(factor_id, admin_user_id, step_up_id) VALUES ($1,$2,$3)', [factor, ADMIN, su]))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('cleanup_expired_step_ups still works after a passkey approval, and the approval survives', async () => {
    const su = await insertGrant('passkey_approve', null);
    const other = await insertGrant('refund', null);
    const factor = randomUUID();
    await q('INSERT INTO public.admin_passkey_approvals(factor_id, admin_user_id, step_up_id) VALUES ($1,$2,$3)', [factor, ADMIN, su]);
    await q(`UPDATE public.admin_step_up_authorizations SET expires_at = now() - interval '2 hours' WHERE id = ANY($1)`, [[su, other]]);
    await q('SELECT public.cleanup_expired_step_ups()');
    const { rows } = await q('SELECT count(*)::int AS n FROM public.admin_step_up_authorizations WHERE id = ANY($1)', [[su, other]]);
    expect(rows[0].n).toBe(0);
    const { rows: kept } = await q('SELECT step_up_id FROM public.admin_passkey_approvals WHERE factor_id=$1', [factor]);
    expect(kept).toEqual([{ step_up_id: su }]);
  });

  it('admin_session_mfa_state returns Supabase Auth\'s session record, to service_role only', async () => {
    const session = randomUUID(); const factor = randomUUID();
    await q(`INSERT INTO auth.sessions(id, user_id, created_at, aal, factor_id) VALUES ($1, $2, '2026-11-12T08:00:00Z', 'aal2', $3)`, [session, ADMIN, factor]);
    const { rows } = await q('SELECT * FROM public.admin_session_mfa_state($1)', [session]);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_aal).toBe('aal2');
    expect(rows[0].session_factor_id).toBe(factor);
    expect(new Date(rows[0].session_created_at).toISOString()).toBe('2026-11-12T08:00:00.000Z');
    expect((await q('SELECT * FROM public.admin_session_mfa_state($1)', [randomUUID()])).rows).toEqual([]);

    const exec = async (role: string) =>
      (await q(`SELECT has_function_privilege($1, 'public.admin_session_mfa_state(uuid)', 'EXECUTE') AS ok`, [role])).rows[0].ok;
    expect(await exec('anon')).toBe(false);
    expect(await exec('authenticated')).toBe(false);
    expect(await exec('service_role')).toBe(true);
    const { rows: fn } = await q(`SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.admin_session_mfa_state(uuid)'::regprocedure`);
    expect(fn[0]).toEqual({ prosecdef: true, proconfig: ['search_path=""'] });
  });
});
