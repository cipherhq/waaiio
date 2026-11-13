/**
 * M538 — admin passkey step-up. Real PostgreSQL proof (disposable local
 * database, created and dropped here).
 *
 * Fixture: the canonical M439 step-up table section, then M538 applied from
 * disk as one whole-file statement, twice (idempotency).
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
    await q('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY)');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!(await q('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await q(`CREATE ROLE ${role}`);
    }
    const m439 = readFileSync('supabase/migrations/439_admin_mfa_enforcement.sql', 'utf8');
    const start = m439.indexOf('CREATE TABLE IF NOT EXISTS public.admin_step_up_authorizations');
    const end = m439.indexOf('-- §2.');
    if (start < 0 || end <= start) throw new Error('Canonical M439 section markers changed');
    await q(m439.slice(start, end));
    await q('INSERT INTO auth.users(id) VALUES ($1)', [ADMIN]);
    await q(m538);
    await q(m538);
  }, 20000);

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database}`);
    await control?.end();
  });

  it('accepts the new passkey actions and still rejects unknown ones', async () => {
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

  it('an approval must reference a real step-up and is unique per passkey', async () => {
    const su = await insertGrant('passkey_approve', null);
    const factor = randomUUID();
    await q('INSERT INTO public.admin_passkey_approvals(factor_id, admin_user_id, step_up_id) VALUES ($1,$2,$3)', [factor, ADMIN, su]);
    await expect(q('INSERT INTO public.admin_passkey_approvals(factor_id, admin_user_id, step_up_id) VALUES ($1,$2,$3)', [factor, ADMIN, su]))
      .rejects.toMatchObject({ code: '23505' });
    await expect(q('INSERT INTO public.admin_passkey_approvals(factor_id, admin_user_id, step_up_id) VALUES ($1,$2,$3)', [randomUUID(), ADMIN, randomUUID()]))
      .rejects.toMatchObject({ code: '23503' });
  });
});
