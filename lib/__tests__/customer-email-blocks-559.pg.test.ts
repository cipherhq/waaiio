/**
 * M559 — customer blocking covers email (#1166). Real PostgreSQL proof
 * (disposable local database, created and dropped here).
 *
 * Fixture: the step-up table and CHECK exactly as the M547 suite builds them
 * (M439 slice, M496 slice, M538 from disk), admin_audit_logs as created by
 * M010 with M439's grants, a minimal bookings table with the owner SELECT and
 * UPDATE policies from M002 (plus an owner INSERT policy, so the insert path
 * is exercised too) and every right for every API role (Supabase default
 * privileges). Then M547 from disk, then M559 from disk twice (idempotency).
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
if (!url) throw new Error('Disposable PostgreSQL required for M559 (TEST_DATABASE_URL)');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');

const migration = (file: string) => readFileSync(`supabase/migrations/${file}`, 'utf8');
const database = `m559_${randomUUID().replaceAll('-', '')}`;
const ADMIN = '00000000-0000-0000-0000-000000000559';
const OWNER = '00000000-0000-0000-0000-0000000559a1';
const BIZ = '00000000-0000-0000-0000-0000000559b1';
const BOOKING = '00000000-0000-0000-0000-0000000559c1';
const PHONE = '2348012345678';
const FN = 'public.svc_set_customer_block(uuid, text, text, text[], text[], text, text)';
const OLD_FN = 'public.svc_set_customer_suspension(uuid, text, boolean, text, text)';

type BlockResult = {
  phone: { changed: boolean; suspended: boolean; id?: string } | null;
  emails: { email: string; changed: boolean; blocked: boolean; id?: string }[];
};

describe('M559 customer email blocks (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const q = (text: string, params?: unknown[]) => client.query(text, params);

  /** Run as a role (with optional JWT claims) inside a rolled-back transaction. */
  async function as<T>(role: string, fn: () => Promise<T>, sub?: string): Promise<T> {
    await q('BEGIN');
    try {
      await q(`SET LOCAL ROLE ${role}`);
      if (sub) await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub, role })]);
      return await fn();
    } finally { await q('ROLLBACK'); }
  }

  const setBlock = (args: {
    phone?: string | null; action?: 'block' | 'unblock' | null; block?: string[]; unblock?: string[];
    reason?: string | null; actor?: string;
  }) => q(`SELECT public.svc_set_customer_block($1, $2, $3, $4, $5, $6, $7) AS r`, [
    'actor' in args ? args.actor : ADMIN, args.phone ?? null, args.action ?? null, args.block ?? [], args.unblock ?? [],
    args.reason === undefined ? 'Abusive messages' : args.reason, '203.0.113.9',
  ]).then(res => res.rows[0].r as BlockResult);

  const audit = (entityType: string) => q(
    `SELECT action, entity_id, details, ip_address FROM public.admin_audit_logs WHERE entity_type = $1 ORDER BY created_at, id`,
    [entityType]).then(r => r.rows);

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
      CREATE TABLE auth.sessions(id uuid PRIMARY KEY, user_id uuid NOT NULL, created_at timestamptz, aal auth.aal_level, factor_id uuid);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;`);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!(await q('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await q(`CREATE ROLE ${role}`);
    }
    // Supabase's service_role bypasses RLS.
    await q(`DO $$ BEGIN IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role') THEN ALTER ROLE service_role BYPASSRLS; END IF; END $$`);
    await q('GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role');
    await q('GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role');
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

    await q(`CREATE TABLE public.profiles(id uuid PRIMARY KEY);
      CREATE TABLE public.admin_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id UUID REFERENCES public.profiles(id),
        action VARCHAR(50) NOT NULL,
        entity_type VARCHAR(50),
        entity_id UUID,
        details JSONB DEFAULT '{}',
        ip_address VARCHAR(45),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
      ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;
      REVOKE INSERT, UPDATE, DELETE ON public.admin_audit_logs FROM PUBLIC, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_audit_logs TO service_role;

      CREATE TABLE public.businesses(id uuid PRIMARY KEY, owner_id uuid NOT NULL);
      ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "owner reads business" ON public.businesses FOR SELECT USING (owner_id = auth.uid());
      CREATE TABLE public.bookings(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES public.businesses(id),
        status text NOT NULL DEFAULT 'pending',
        guest_email text);
      ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "Owners view business bookings" ON public.bookings FOR SELECT
        USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
      CREATE POLICY "Owners update business bookings" ON public.bookings FOR UPDATE
        USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
      CREATE POLICY "fixture owners insert bookings" ON public.bookings FOR INSERT
        WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));`);
    await q('INSERT INTO auth.users(id) VALUES ($1), ($2)', [ADMIN, OWNER]);
    await q('INSERT INTO public.profiles(id) VALUES ($1)', [ADMIN]);
    await q('INSERT INTO public.businesses(id, owner_id) VALUES ($1, $2)', [BIZ, OWNER]);
    await q('INSERT INTO public.bookings(id, business_id, guest_email) VALUES ($1, $2, $3)', [BOOKING, BIZ, 'guest@example.com']);

    await q(migration('547_customer_suspensions.sql'));
    await q(migration('559_customer_email_blocks.sql'));
    await q(migration('559_customer_email_blocks.sql'));
  }, 30000);

  // DROP DATABASE can wait for a shared checkpoint in CI (seen at ~16s).
  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  }, 35_000);

  it('table: RLS on with a deny-all policy; service role only, despite default grants', async () => {
    const { rows: rls } = await q(`SELECT relrowsecurity FROM pg_class WHERE oid='public.customer_email_blocks'::regclass`);
    expect(rls[0].relrowsecurity).toBe(true);
    const { rows: pol } = await q(`SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename='customer_email_blocks'`);
    expect(pol).toEqual([{ policyname: 'customer_email_blocks_deny_all', cmd: 'ALL', qual: 'false', with_check: 'false' }]);
    const priv = async (role: string, p: string) =>
      (await q('SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.customer_email_blocks', p])).rows[0].ok;
    for (const role of ['anon', 'authenticated']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) expect(await priv(role, p)).toBe(false);
      await expect(as(role, () => q('SELECT * FROM public.customer_email_blocks'))).rejects.toMatchObject({ code: '42501' });
    }
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect(await priv('service_role', p)).toBe(true);
  });

  it('functions: SECURITY INVOKER, fixed search_path, EXECUTE for service_role only (every signature)', async () => {
    const { rows: sigs } = await q(`SELECT p.oid::regprocedure::text AS sig, p.prosecdef, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('svc_set_customer_block', 'svc_set_customer_suspension') ORDER BY 1`);
    expect(sigs).toEqual([
      { sig: 'svc_set_customer_block(uuid,text,text,text[],text[],text,text)', prosecdef: false, proconfig: ['search_path=public, pg_temp'] },
      { sig: 'svc_set_customer_suspension(uuid,text,boolean,text,text)', prosecdef: false, proconfig: ['search_path=public, pg_temp'] },
    ]);
    const exec = async (role: string, fn: string) =>
      (await q(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn])).rows[0].ok;
    for (const fn of [FN, OLD_FN, 'private.bookings_email_verified_at_guard()']) {
      expect(await exec('anon', fn)).toBe(false);
      expect(await exec('authenticated', fn)).toBe(false);
    }
    expect(await exec('service_role', FN)).toBe(true);
    expect(await exec('service_role', OLD_FN)).toBe(true);
    const { rows: guard } = await q(`SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'private.bookings_email_verified_at_guard()'::regprocedure`);
    expect(guard[0]).toEqual({ prosecdef: false, proconfig: ['search_path=""'] });
    await expect(as('authenticated', () => setBlock({ block: ['a@example.com'] }), OWNER)).rejects.toMatchObject({ code: '42501' });
  });

  it('CHECKs: email must be trimmed, lower-case and well formed; phone canonical; reason 3 to 500', async () => {
    const insert = (email: string, phone: string | null = null, reason = 'abuse') => q(
      `INSERT INTO public.customer_email_blocks(email, phone, reason, blocked_by) VALUES ($1, $2, $3, $4)`, [email, phone, reason, ADMIN]);
    for (const email of ['Ann@Example.com', ' ann@example.com', 'ann@example.com ', 'ann', 'ann@example', 'a b@example.com', 'a@b@example.com']) {
      await expect(insert(email)).rejects.toMatchObject({ code: '23514' });
    }
    for (const phone of ['+2348012345678', '08012345678', '12345']) await expect(insert('ok1@example.com', phone)).rejects.toMatchObject({ code: '23514' });
    for (const reason of ['  ', 'ab', 'x'.repeat(501)]) await expect(insert('ok2@example.com', null, reason)).rejects.toMatchObject({ code: '23514' });
  });

  it('blocks a phone and emails in one call; one audit row per changed item; repeat changes nothing', async () => {
    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE service_role');
      const first = await setBlock({ phone: PHONE, action: 'block', block: [' Ann@Example.com ', 'ann@example.com', 'b@example.com'] });
      expect(first.phone).toMatchObject({ changed: true, suspended: true });
      expect(first.emails.map(e => [e.email, e.changed, e.blocked])).toEqual([
        ['ann@example.com', true, true], ['b@example.com', true, true]]);
      const { rows } = await q('SELECT email, phone, reason, blocked_by FROM public.customer_email_blocks ORDER BY email');
      expect(rows).toEqual([
        { email: 'ann@example.com', phone: PHONE, reason: 'Abusive messages', blocked_by: ADMIN },
        { email: 'b@example.com', phone: PHONE, reason: 'Abusive messages', blocked_by: ADMIN }]);

      const again = await setBlock({ phone: PHONE, action: 'block', block: ['ann@example.com'] });
      expect(again.phone).toEqual({ changed: false, suspended: true });
      expect(again.emails).toEqual([{ email: 'ann@example.com', changed: false, blocked: true }]);

      const phoneAudit = await audit('customer_suspension');
      expect(phoneAudit).toHaveLength(1);
      expect(phoneAudit[0]).toMatchObject({ action: 'suspend_customer', entity_id: first.phone!.id, ip_address: '203.0.113.9' });
      const emailAudit = await audit('customer_email_block');
      expect(emailAudit).toHaveLength(2);
      for (const e of first.emails) {
        const row = emailAudit.find(a => a.entity_id === e.id)!;
        expect(row).toMatchObject({ action: 'block_customer_email' });
        expect(row.details).toMatchObject({ email: e.email, phone: PHONE, reason: 'Abusive messages', blocked_by: ADMIN });
      }
    } finally { await q('ROLLBACK'); }
  });

  it('an email block survives unblocking its phone; unblocking with no emails ticked leaves every email blocked', async () => {
    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE service_role');
      await setBlock({ phone: PHONE, action: 'block', block: ['ann@example.com', 'b@example.com'] });
      const off = await setBlock({ phone: PHONE, action: 'unblock', reason: null });
      expect(off.phone).toMatchObject({ changed: true, suspended: false });
      expect(off.emails).toEqual([]);
      expect((await q('SELECT 1 FROM public.customer_suspensions WHERE phone=$1', [PHONE])).rowCount).toBe(0);
      expect((await q('SELECT email FROM public.customer_email_blocks ORDER BY email')).rows.map(r => r.email))
        .toEqual(['ann@example.com', 'b@example.com']);
      // Deleting the phone row directly (as M547's unblock does) does not touch them either.
      await setBlock({ phone: PHONE, action: 'block' });
      await q('SELECT public.svc_set_customer_suspension($1, $2, false, NULL, NULL)', [ADMIN, PHONE]);
      expect((await q('SELECT count(*)::int AS n FROM public.customer_email_blocks')).rows[0].n).toBe(2);
    } finally { await q('ROLLBACK'); }
  });

  it('unblocking a phone with some emails ticked unblocks only those, in one transaction, one audit row each', async () => {
    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE service_role');
      await setBlock({ phone: PHONE, action: 'block', block: ['ann@example.com', 'b@example.com'] });
      const res = await setBlock({ phone: PHONE, action: 'unblock', unblock: ['B@example.com'], reason: null });
      expect(res.phone).toMatchObject({ changed: true, suspended: false });
      expect(res.emails.map(e => [e.email, e.changed, e.blocked])).toEqual([['b@example.com', true, false]]);
      expect((await q('SELECT email FROM public.customer_email_blocks')).rows).toEqual([{ email: 'ann@example.com' }]);
      const actions = (await audit('customer_email_block')).map(a => a.action);
      expect(actions).toEqual(['block_customer_email', 'block_customer_email', 'unblock_customer_email']);
      expect((await audit('customer_suspension')).map(a => a.action)).toEqual(['suspend_customer', 'unsuspend_customer']);
      expect(await setBlock({ unblock: ['b@example.com'], reason: null }))
        .toEqual({ phone: null, emails: [{ email: 'b@example.com', changed: false, blocked: false }] });
    } finally { await q('ROLLBACK'); }
  });

  it('email-only block with no phone; adding an email for an already blocked phone', async () => {
    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE service_role');
      const solo = await setBlock({ block: ['solo@example.com'] });
      expect(solo.phone).toBeNull();
      expect((await q(`SELECT phone FROM public.customer_email_blocks WHERE email='solo@example.com'`)).rows).toEqual([{ phone: null }]);
      await setBlock({ phone: PHONE, action: 'block' });
      const extra = await setBlock({ phone: PHONE, block: ['extra@example.com'] });
      expect(extra.phone).toBeNull();
      expect((await q(`SELECT phone FROM public.customer_email_blocks WHERE email='extra@example.com'`)).rows).toEqual([{ phone: PHONE }]);
      expect((await audit('customer_suspension'))).toHaveLength(1);
    } finally { await q('ROLLBACK'); }
  });

  it('is atomic: when an audit row cannot be written, neither the phone nor any email is saved', async () => {
    const stranger = randomUUID(); // no profile → the audit FK fails
    await expect(setBlock({ phone: '2348022222222', action: 'block', block: ['atomic@example.com'], actor: stranger }))
      .rejects.toMatchObject({ code: '23503' });
    expect((await q(`SELECT 1 FROM public.customer_suspensions WHERE phone='2348022222222'`)).rowCount).toBe(0);
    expect((await q(`SELECT 1 FROM public.customer_email_blocks WHERE email='atomic@example.com'`)).rowCount).toBe(0);
  });

  it('rejects bad calls: no actor, nothing to change, unknown action, phone action without phone, both lists, block without reason', async () => {
    await expect(setBlock({ actor: null as unknown as string, block: ['x@example.com'] })).rejects.toThrow(/actor is required/);
    await expect(setBlock({})).rejects.toThrow(/nothing to change/);
    await expect(setBlock({ phone: PHONE, action: 'delete' as 'block' })).rejects.toThrow(/phone action/);
    await expect(setBlock({ action: 'block' })).rejects.toThrow(/phone is required/);
    await expect(setBlock({ block: ['x@example.com'], unblock: ['X@example.com'] })).rejects.toThrow(/blocked and unblocked/);
    await expect(setBlock({ block: ['x@example.com'], reason: '  ' })).rejects.toThrow(/reason is required/);
    await expect(setBlock({ phone: PHONE, action: 'block', reason: null })).rejects.toThrow(/reason is required/);
    await expect(setBlock({ block: ['not-an-email'] })).rejects.toMatchObject({ code: '23514' });
  });

  it('bookings.email_verified_at exists and is nullable; existing rows stay NULL', async () => {
    const { rows } = await q(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='bookings' AND column_name='email_verified_at'`);
    expect(rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null }]);
    expect((await q('SELECT email_verified_at FROM public.bookings WHERE id=$1', [BOOKING])).rows).toEqual([{ email_verified_at: null }]);
  });

  it('an owner cannot set or change email_verified_at (insert or update); service_role can', async () => {
    const owner = <T>(fn: () => Promise<T>) => as('authenticated', fn, OWNER);
    // The owner can see and update the booking under RLS...
    expect(await owner(async () => (await q('SELECT id FROM public.bookings')).rowCount)).toBe(1);
    // ...but not set the mark.
    await expect(owner(() => q('UPDATE public.bookings SET email_verified_at = now() WHERE id=$1', [BOOKING])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(owner(() => q(`INSERT INTO public.bookings(business_id, email_verified_at) VALUES ($1, now())`, [BIZ])))
      .rejects.toMatchObject({ code: '42501' });

    await q('BEGIN');
    try {
      await q('SET LOCAL ROLE service_role');
      await q(`UPDATE public.bookings SET email_verified_at = '2026-11-27T10:00:00Z' WHERE id=$1`, [BOOKING]);
      await q(`INSERT INTO public.bookings(business_id, email_verified_at) VALUES ($1, now())`, [BIZ]);
      await q('RESET ROLE');
      await q(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: OWNER, role: 'authenticated' })]);
      await q('SET LOCAL ROLE authenticated');
      // Once set, the owner can neither clear nor move it.
      await q('SAVEPOINT s');
      await expect(q('UPDATE public.bookings SET email_verified_at = NULL WHERE id=$1', [BOOKING])).rejects.toMatchObject({ code: '42501' });
      await q('ROLLBACK TO SAVEPOINT s');
      // An ordinary owner update of another column still works, including one that rewrites the same value.
      await q(`UPDATE public.bookings SET status = 'confirmed' WHERE id=$1`, [BOOKING]);
      await q(`UPDATE public.bookings SET email_verified_at = '2026-11-27T10:00:00Z', status = 'completed' WHERE id=$1`, [BOOKING]);
      expect((await q('SELECT status, email_verified_at FROM public.bookings WHERE id=$1', [BOOKING])).rows[0])
        .toEqual({ status: 'completed', email_verified_at: new Date('2026-11-27T10:00:00Z') });
    } finally { await q('ROLLBACK'); }
  });

  it('an owner ordinary update and insert without the mark still work', async () => {
    await as('authenticated', async () => {
      await q(`UPDATE public.bookings SET status = 'confirmed', guest_email = 'new@example.com' WHERE id=$1`, [BOOKING]);
      await q(`INSERT INTO public.bookings(business_id, status) VALUES ($1, 'pending')`, [BIZ]);
      expect((await q(`SELECT count(*)::int AS n FROM public.bookings`)).rows[0].n).toBe(2);
    }, OWNER);
  });
});
