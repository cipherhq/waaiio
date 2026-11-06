/**
 * M524 — a reseller reads its own resellers row but cannot write it directly.
 * Real PostgreSQL proof (disposable local database, created and dropped here).
 *
 * Fixture: public.resellers as created by M205/M207 with the three production policies
 * ("Resellers manage own record" FOR ALL to PUBLIC, "Admin manages resellers" FOR ALL to
 * authenticated USING is_admin(), "Service role manages resellers" FOR ALL to service_role).
 * is_admin() is stubbed with a session setting (the real one checks app_metadata + aal2, M439).
 * M524 is applied from disk as one whole-file statement over a broad and a narrow starting ACL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M524 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m524 = readFileSync('supabase/migrations/524_resellers_own_record_read_only.sql', 'utf8');
const database = `m524_${randomUUID().replaceAll('-', '')}`;
const RESELLER_USER = randomUUID();
const OTHER_RESELLER_USER = randomUUID();
const PLAIN_USER = randomUUID();
const ADMIN_USER = randomUUID();
const RESELLER_ID = randomUUID();
const OTHER_RESELLER_ID = randomUUID();

type DbError = { code?: string; message?: string };

const EXPECTED = [
  'authenticated:INSERT', 'authenticated:SELECT', 'authenticated:UPDATE',
  'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE',
];

suite('M524 resellers own record read-only (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;

  const q = (text: string, params?: unknown[]) => client.query(text, params);

  /** Run fn as `role` (optionally as auth user `sub`, optionally as admin) inside a rolled-back transaction. */
  async function as<T>(role: string, sub: string | null, fn: () => Promise<T>, admin = false): Promise<T> {
    await q('BEGIN');
    try {
      await q(`SET LOCAL ROLE ${role}`);
      if (sub) await q(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub]);
      await q(`SELECT set_config('test.is_admin', $1, true)`, [admin ? 'true' : 'false']);
      return await fn();
    } finally {
      await q('ROLLBACK');
    }
  }
  async function errorOf(fn: () => Promise<unknown>): Promise<DbError> {
    try { await fn(); } catch (err) { return err as DbError; }
    return {};
  }
  async function grants(): Promise<string[]> {
    const { rows } = await q(`
      SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) || ':' || a.privilege_type AS g
      FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = 'public.resellers'::regclass
        AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role'))
      ORDER BY 1`);
    return rows.map(r => r.g);
  }
  async function policies(): Promise<string[]> {
    const { rows } = await q(`SELECT polname FROM pg_policy WHERE polrelid = 'public.resellers'::regclass ORDER BY 1`);
    return rows.map(r => r.polname);
  }

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$`);
    await control.query(`ALTER ROLE service_role BYPASSRLS`);
    for (const role of ['anon', 'authenticated']) {
      await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await control.query(`CREATE DATABASE ${database}`);
    const target = new URL(url!); target.pathname = `/${database}`;
    client = new pg.Client({ connectionString: target.toString() }); await client.connect();

    await q(`
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT coalesce(current_setting('test.is_admin', true), '') = 'true' $$;

      CREATE TABLE public.resellers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL UNIQUE,
        company_name TEXT NOT NULL,
        commission_percentage DECIMAL(5,2) NOT NULL DEFAULT 10.00,
        max_sub_accounts INTEGER NOT NULL DEFAULT 50,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        tier TEXT DEFAULT 'starter' CHECK (tier IN ('starter', 'professional', 'enterprise')),
        branding JSONB DEFAULT '{}',
        stripe_subscription_id TEXT
      );
      ALTER TABLE public.resellers ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "Resellers manage own record" ON public.resellers FOR ALL USING (user_id = auth.uid());
      CREATE POLICY "Admin manages resellers" ON public.resellers FOR ALL TO authenticated USING (public.is_admin());
      CREATE POLICY "Service role manages resellers" ON public.resellers FOR ALL TO service_role USING (true);
    `);
    await q(`INSERT INTO public.resellers (id, user_id, company_name) VALUES ($1, $2, 'Reseller A'), ($3, $4, 'Reseller B')`,
      [RESELLER_ID, RESELLER_USER, OTHER_RESELLER_ID, OTHER_RESELLER_USER]);
  }, 60000);

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('fixture starts from the pre-M524 policy (owner-writable row)', async () => {
    await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.resellers TO anon, authenticated, service_role`);
    await as('authenticated', RESELLER_USER, async () => {
      expect((await q(`UPDATE public.resellers SET commission_percentage = 100 WHERE id = $1`, [RESELLER_ID])).rowCount).toBe(1);
    });
  });

  it('from a broad starting state: 524 sets exactly the contract (self-check passes)', async () => {
    await q(`
      GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.resellers TO anon, authenticated, service_role;
      GRANT SELECT ON public.resellers TO PUBLIC;`);
    await q(m524);
    expect(await grants()).toEqual(EXPECTED);
    expect(await policies()).toEqual(['Admin manages resellers', 'Resellers read own record', 'Service role manages resellers']);
  });

  it('from a narrow starting state: same result, and re-applies cleanly', async () => {
    await q(`
      REVOKE ALL ON public.resellers FROM PUBLIC, anon, authenticated, service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.resellers TO authenticated, service_role;`);
    await q(m524);
    await q(m524);
    expect(await grants()).toEqual(EXPECTED);
    const { rows: [rls] } = await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.resellers'::regclass`);
    expect(rls.relrowsecurity).toBe(true);
  });

  it('from a state with column-level write grants: 524 clears them (no column ACLs remain)', async () => {
    await q(`GRANT UPDATE (commission_percentage, max_sub_accounts, tier) ON public.resellers TO authenticated`);
    const { rows: [before] } = await q(`SELECT count(*)::int AS n FROM pg_attribute
      WHERE attrelid = 'public.resellers'::regclass AND attnum > 0 AND attacl IS NOT NULL`);
    expect(before.n).toBe(3);
    await q(m524);
    const { rows: [after] } = await q(`SELECT count(*)::int AS n FROM pg_attribute
      WHERE attrelid = 'public.resellers'::regclass AND attnum > 0 AND attacl IS NOT NULL`);
    expect(after.n).toBe(0);
    expect(await grants()).toEqual(EXPECTED);
  });

  it('anon: no access of any kind', async () => {
    for (const sql of [
      'SELECT 1 FROM public.resellers',
      `INSERT INTO public.resellers (user_id, company_name) VALUES ('${randomUUID()}', 'x')`,
      'UPDATE public.resellers SET company_name = company_name',
      'DELETE FROM public.resellers',
    ]) {
      const err = await as('anon', null, () => errorOf(() => q(sql)));
      expect(err.code, sql).toBe('42501');
    }
  });

  it('reseller: reads only its own row (dashboard and route lookups)', async () => {
    await as('authenticated', RESELLER_USER, async () => {
      expect((await q('SELECT id FROM public.resellers')).rows).toEqual([{ id: RESELLER_ID }]);
    });
  });

  it('reseller: cannot change its own commission, cap, tier, status or branding', async () => {
    for (const set of [
      'commission_percentage = 100', 'max_sub_accounts = 999', "tier = 'enterprise'",
      "status = 'active'", `branding = '{"logo_url":"x"}'`,
    ]) {
      await as('authenticated', RESELLER_USER, async () => {
        expect((await q(`UPDATE public.resellers SET ${set} WHERE id = $1`, [RESELLER_ID])).rowCount, set).toBe(0);
      });
    }
    const { rows: [row] } = await q(`SELECT commission_percentage::text AS c, max_sub_accounts AS m FROM public.resellers WHERE id = $1`, [RESELLER_ID]);
    expect(row).toEqual({ c: '10.00', m: 50 });
  });

  it('reseller: cannot delete its row; a signed-in non-reseller cannot create one', async () => {
    const del = await as('authenticated', RESELLER_USER, () => errorOf(() => q(`DELETE FROM public.resellers WHERE id = $1`, [RESELLER_ID])));
    expect(del.code).toBe('42501');
    const ins = await as('authenticated', PLAIN_USER, () => errorOf(() =>
      q(`INSERT INTO public.resellers (user_id, company_name, commission_percentage) VALUES ($1, 'Self-made', 100)`, [PLAIN_USER])));
    expect(ins.code).toBe('42501');
  });

  it('admin (is_admin): reads all, creates a reseller and changes status (admin panel paths)', async () => {
    await as('authenticated', ADMIN_USER, async () => {
      expect((await q('SELECT 1 FROM public.resellers')).rowCount).toBe(2);
      expect((await q(`INSERT INTO public.resellers (user_id, company_name) VALUES ($1, 'Admin-made')`, [PLAIN_USER])).rowCount).toBe(1);
      expect((await q(`UPDATE public.resellers SET status = 'suspended' WHERE id = $1`, [OTHER_RESELLER_ID])).rowCount).toBe(1);
    }, true);
  });

  it('service_role: reads, updates branding and subscription fields, inserts; cannot delete or truncate', async () => {
    await as('service_role', null, async () => {
      expect((await q('SELECT 1 FROM public.resellers')).rowCount).toBe(2);
      expect((await q(`UPDATE public.resellers SET branding = '{"primary_color":"#6C2BD9"}' WHERE id = $1`, [RESELLER_ID])).rowCount).toBe(1);
      expect((await q(`UPDATE public.resellers SET stripe_subscription_id = 'sub_test' WHERE id = $1`, [RESELLER_ID])).rowCount).toBe(1);
      expect((await q(`INSERT INTO public.resellers (user_id, company_name) VALUES ($1, 'Svc-made')`, [randomUUID()])).rowCount).toBe(1);
    });
    for (const sql of [`DELETE FROM public.resellers WHERE id = '${RESELLER_ID}'`, 'TRUNCATE public.resellers']) {
      const err = await as('service_role', null, () => errorOf(() => q(sql)));
      expect(err.code, sql).toBe('42501');
    }
  });

  it('self-check fails closed if another non-admin write policy exists', async () => {
    await q('BEGIN');
    try {
      await q(`CREATE POLICY "rogue update" ON public.resellers FOR UPDATE TO authenticated USING (true)`);
      const err = await errorOf(() => q(m524));
      expect(err.message).toMatch(/M524 self-check failed: write policies/);
    } finally {
      await q('ROLLBACK');
    }
  });
});
