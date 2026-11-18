/**
 * M548 — admin WhatsApp broadcasts (#1104). Real PostgreSQL proof
 * (disposable local database, created and dropped here).
 *
 * Fixture: the canonical M439 step-up table, the step-up CHECK as last
 * redefined by M547 (M496 slice, M538, M547 from disk), admin_broadcasts as
 * created by M012 (table section), then M548 applied from disk twice
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
if (!url) throw new Error('Disposable PostgreSQL required for M548 (TEST_DATABASE_URL)');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');

const migration = (file: string) => readFileSync(`supabase/migrations/${file}`, 'utf8');
const database = `m548_${randomUUID().replaceAll('-', '')}`;
const ADMIN = '00000000-0000-0000-0000-000000000548';
const PHONE = '2348012345678';

describe('M548 admin WhatsApp broadcasts (real PostgreSQL)', () => {
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

  const broadcast = async (requestId: string | null = null) => (await q(
    `INSERT INTO public.admin_broadcasts(sender_id, channel, audience, message, request_id)
     VALUES ($1, 'whatsapp', 'specific', 'Hi', $2) RETURNING id`, [ADMIN, requestId])).rows[0].id as string;

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
    await q('ALTER ROLE service_role BYPASSRLS');
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

    // profiles + admin_audit_logs exist before M547 (its function writes audit rows).
    await q(`CREATE TABLE public.profiles(id uuid PRIMARY KEY);
      CREATE TABLE public.admin_audit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_id UUID REFERENCES public.profiles(id),
        action VARCHAR(50) NOT NULL, entity_type VARCHAR(50), entity_id UUID, details JSONB DEFAULT '{}', ip_address VARCHAR(45),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    await q(migration('547_customer_suspensions.sql'));

    // admin_broadcasts as created by M012.
    const m012 = migration('012_admin_expansion.sql');
    const tStart = m012.indexOf('CREATE TABLE IF NOT EXISTS public.admin_broadcasts');
    const tEnd = m012.indexOf(');', tStart);
    if (tStart < 0 || tEnd <= tStart) throw new Error('Canonical M012 admin_broadcasts markers changed');
    await q(m012.slice(tStart, tEnd + 2));
    await q('ALTER TABLE public.admin_broadcasts ENABLE ROW LEVEL SECURITY');
    await q('INSERT INTO auth.users(id) VALUES ($1)', [ADMIN]);
    await q('INSERT INTO public.profiles(id) VALUES ($1)', [ADMIN]);

    await q(migration('548_admin_whatsapp_broadcasts.sql'));
    await q(migration('548_admin_whatsapp_broadcasts.sql'));
  }, 30000);

  // DROP DATABASE can wait for a shared checkpoint in CI (seen at ~16s).
  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  }, 35_000);

  it('step-up CHECK keeps every earlier action, adds admin_broadcast, rejects unknown ones', async () => {
    const insert = (action: string) => q(
      `INSERT INTO public.admin_step_up_authorizations(admin_user_id, session_id, action_type, params_hash) VALUES ($1, 's', $2, 'h')`,
      [ADMIN, action]);
    for (const a of ['payout_approve', 'payout_reject', 'payout_generate', 'payout_confirm_settlement', 'payout_force_settle',
      'provider_config', 'team_grant', 'team_revoke', 'impersonate', 'refund', 'reseller_payout_approve', 'reseller_payout_reject',
      'reseller_payout_mark_paid', 'reseller_payout_generate', 'commercial_config', 'messaging_config', 'messaging_suspension',
      'business_status', 'channel_change_execute', 'passkey_approve', 'passkey_remove', 'customer_suspension',
      'admin_broadcast']) await insert(a);
    await expect(insert('admin_broadcast_everyone')).rejects.toMatchObject({ code: '23514' });
  });

  it('one broadcast per request id; broadcasts without one are unaffected', async () => {
    const requestId = randomUUID();
    await broadcast(requestId);
    await expect(broadcast(requestId)).rejects.toMatchObject({ code: '23505' });
    await broadcast(null);
    await broadcast(null);
    expect((await q('SELECT count(*)::int AS n FROM public.admin_broadcasts WHERE request_id IS NULL')).rows[0].n).toBe(2);
  });

  it('recipients: one row per number per broadcast; the same number may be in another broadcast', async () => {
    const a = await broadcast();
    const b = await broadcast();
    const add = (id: string, phone = PHONE, status = 'sending') => q(
      'INSERT INTO public.admin_broadcast_recipients(broadcast_id, phone, status) VALUES ($1, $2, $3)', [id, phone, status]);
    await add(a);
    await expect(add(a)).rejects.toMatchObject({ code: '23505' });
    await add(b);
    // Claim-before-send: ON CONFLICT DO NOTHING returns no row for a second claim.
    const claim = await q(`INSERT INTO public.admin_broadcast_recipients(broadcast_id, phone, status) VALUES ($1, $2, 'sending')
      ON CONFLICT (broadcast_id, phone) DO NOTHING RETURNING id`, [a, PHONE]);
    expect(claim.rowCount).toBe(0);
    // Deleting a broadcast removes its recipient rows.
    await q('DELETE FROM public.admin_broadcasts WHERE id=$1', [b]);
    expect((await q('SELECT count(*)::int AS n FROM public.admin_broadcast_recipients WHERE broadcast_id=$1', [b])).rows[0].n).toBe(0);
  });

  it('recipient CHECKs: canonical phone, known status, bounded error', async () => {
    const id = await broadcast();
    for (const phone of ['+2348012345678', '08012345678', '12345', '1234567890123456']) {
      await expect(q(`INSERT INTO public.admin_broadcast_recipients(broadcast_id, phone, status) VALUES ($1, $2, 'sent')`, [id, phone]))
        .rejects.toMatchObject({ code: '23514' });
    }
    await expect(q(`INSERT INTO public.admin_broadcast_recipients(broadcast_id, phone, status) VALUES ($1, $2, 'delivered')`, [id, PHONE]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(q(`INSERT INTO public.admin_broadcast_recipients(broadcast_id, phone, status, error) VALUES ($1, $2, 'failed', $3)`, [id, PHONE, 'x'.repeat(501)]))
      .rejects.toMatchObject({ code: '23514' });
    for (const [i, status] of ['sending', 'sent', 'failed', 'unknown', 'skipped_opted_out', 'skipped_suspended', 'skipped_unverified'].entries()) {
      await q('INSERT INTO public.admin_broadcast_recipients(broadcast_id, phone, status) VALUES ($1, $2, $3)', [id, `23480100000${10 + i}`, status]);
    }
  });

  it('recipients table: RLS on with a deny-all policy; service role only, despite default grants', async () => {
    const { rows: rls } = await q(`SELECT relrowsecurity FROM pg_class WHERE oid='public.admin_broadcast_recipients'::regclass`);
    expect(rls[0].relrowsecurity).toBe(true);
    const { rows: pol } = await q(`SELECT cmd, qual, with_check FROM pg_policies WHERE tablename='admin_broadcast_recipients'`);
    expect(pol).toEqual([{ cmd: 'ALL', qual: 'false', with_check: 'false' }]);
    const priv = async (role: string, p: string) =>
      (await q('SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.admin_broadcast_recipients', p])).rows[0].ok;
    for (const role of ['anon', 'authenticated']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) expect(await priv(role, p)).toBe(false);
      await expect(as(role, () => q('SELECT * FROM public.admin_broadcast_recipients'))).rejects.toMatchObject({ code: '42501' });
    }
    for (const p of ['SELECT', 'INSERT', 'UPDATE']) expect(await priv('service_role', p)).toBe(true);
    // Delivery records are not deleted by the app; they go only with their broadcast.
    expect(await priv('service_role', 'DELETE')).toBe(false);
  });
});
