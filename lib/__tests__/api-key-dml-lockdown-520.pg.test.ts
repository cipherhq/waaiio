/**
 * M520 — api_keys writes only through the server (#705 follow-up, PR #745, was M480).
 * Real PostgreSQL proof (disposable local database, created and dropped here).
 *
 * Fixture: public.api_keys as created by M180 (RLS on, owners_manage_api_keys FOR ALL to
 * PUBLIC), M474 applied from disk (issue_api_key / revoke_api_key, SECURITY INVOKER,
 * service_role-only EXECUTE). Table ACLs differ by environment (read 2026-11-05, read-only):
 * production gives anon, authenticated and service_role every privilege; staging gives
 * authenticated and service_role arwd. M520 is applied from disk as one whole-file statement
 * over both starting states and must give the same exact grants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M520 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m474 = readFileSync('supabase/migrations/474_api_key_atomic_issuance.sql', 'utf8');
const m520 = readFileSync('supabase/migrations/520_api_key_close_direct_writes.sql', 'utf8');
const database = `m520_${randomUUID().replaceAll('-', '')}`;
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const BIZ_A = randomUUID();
const BIZ_B = randomUUID();
const KEY_A = randomUUID();

type DbError = { code?: string; message?: string };

const EXPECTED = ['authenticated:SELECT', 'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE'];

suite('M520 api_keys grants (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;

  const q = (text: string, params?: unknown[]) => client.query(text, params);

  /** Run fn as `role` (optionally as auth user `sub`) inside a rolled-back transaction. */
  async function as<T>(role: string, sub: string | null, fn: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try {
      await q(`SET LOCAL ROLE ${role}`);
      if (sub) await q(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub]);
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
      WHERE c.oid = 'public.api_keys'::regclass
        AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role'))
      ORDER BY 1`);
    return rows.map(r => r.g);
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

      CREATE TABLE public.businesses (id UUID PRIMARY KEY, owner_id UUID NOT NULL, subscription_tier TEXT);
      ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
      CREATE POLICY owner_all ON public.businesses FOR ALL USING (owner_id = auth.uid());
      GRANT SELECT ON public.businesses TO authenticated;
      GRANT SELECT, UPDATE ON public.businesses TO service_role;

      CREATE TABLE public.api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'Default',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );
      ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
      CREATE POLICY owners_manage_api_keys ON public.api_keys FOR ALL
        USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
    `);
    await q(m474);
    await q(`INSERT INTO public.businesses (id, owner_id, subscription_tier) VALUES ($1, $2, 'growth'), ($3, $4, 'business')`,
      [BIZ_A, OWNER_A, BIZ_B, OWNER_B]);
    await q(`INSERT INTO public.api_keys (id, business_id, key_hash, key_prefix) VALUES ($1, $2, 'hash-a', 'wk_a')`, [KEY_A, BIZ_A]);
  }, 60000);

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('from the production grants: 520 sets exactly the contract (self-check passes)', async () => {
    await q(`
      GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.api_keys TO anon, authenticated, service_role;
      GRANT SELECT ON public.api_keys TO PUBLIC;`);
    expect(await grants()).toContain('authenticated:INSERT');
    await q(m520);
    expect(await grants()).toEqual(EXPECTED);
  });

  it('from the staging grants: 520 gives the same result, and re-applies cleanly', async () => {
    await q(`
      REVOKE ALL ON public.api_keys FROM PUBLIC, anon, authenticated, service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_keys TO authenticated, service_role;`);
    await q(m520);
    await q(m520);
    expect(await grants()).toEqual(EXPECTED);
  });

  it('RLS stays on, the policy is unchanged, and the RPCs stay service_role-only', async () => {
    const { rows: [rls] } = await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.api_keys'::regclass`);
    expect(rls.relrowsecurity).toBe(true);
    const { rows: pols } = await q(`SELECT polname FROM pg_policy WHERE polrelid = 'public.api_keys'::regclass`);
    expect(pols.map(r => r.polname)).toEqual(['owners_manage_api_keys']);
    for (const fn of ['issue_api_key(uuid,text,text,text,uuid)', 'revoke_api_key(uuid,uuid)']) {
      const { rows: [p] } = await q(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS auth,
        has_function_privilege('anon', $1, 'EXECUTE') AS anon, has_function_privilege('service_role', $1, 'EXECUTE') AS svc`, [`public.${fn}`]);
      expect(p, fn).toEqual({ auth: false, anon: false, svc: true });
    }
  });

  it('anon: no access of any kind', async () => {
    for (const sql of [
      'SELECT 1 FROM public.api_keys',
      `INSERT INTO public.api_keys (business_id, key_hash, key_prefix) VALUES ('${BIZ_A}', 'h', 'p')`,
      'UPDATE public.api_keys SET name = name',
      'DELETE FROM public.api_keys',
    ]) {
      const err = await as('anon', null, () => errorOf(() => q(sql)));
      expect(err.code, sql).toBe('42501');
    }
  });

  it('authenticated owner: lists own keys (GET route); another owner sees none', async () => {
    await as('authenticated', OWNER_A, async () => {
      expect((await q('SELECT key_prefix FROM public.api_keys')).rows).toEqual([{ key_prefix: 'wk_a' }]);
    });
    await as('authenticated', OWNER_B, async () => {
      expect((await q('SELECT 1 FROM public.api_keys')).rowCount).toBe(0);
    });
  });

  it('authenticated owner: cannot insert, update, revoke, delete or truncate directly', async () => {
    for (const sql of [
      `INSERT INTO public.api_keys (business_id, key_hash, key_prefix) VALUES ('${BIZ_A}', 'forged', 'wk_f')`,
      `UPDATE public.api_keys SET revoked_at = NULL WHERE id = '${KEY_A}'`,
      `UPDATE public.api_keys SET last_used_at = now() WHERE id = '${KEY_A}'`,
      `DELETE FROM public.api_keys WHERE id = '${KEY_A}'`,
      'TRUNCATE public.api_keys',
    ]) {
      const err = await as('authenticated', OWNER_A, () => errorOf(() => q(sql)));
      expect(err.code, sql).toBe('42501');
    }
  });

  it('service_role: issue_api_key and revoke_api_key work (route paths)', async () => {
    await as('service_role', null, async () => {
      const { rows: [issued] } = await q(`SELECT public.issue_api_key($1, 'hash-new', 'wk_n', 'New', $2) AS id`, [BIZ_A, OWNER_A]);
      expect(issued.id).toMatch(/^[0-9a-f-]{36}$/);
      const { rows: [revoked] } = await q(`SELECT public.revoke_api_key($1, $2) AS ok`, [issued.id, OWNER_A]);
      expect(revoked.ok).toBe(true);
      const { rows: [row] } = await q(`SELECT revoked_at IS NOT NULL AS gone FROM public.api_keys WHERE id = $1`, [issued.id]);
      expect(row.gone).toBe(true);
    });
  });

  it('service_role: validateApiKey lookup and last_used_at update work', async () => {
    await as('service_role', null, async () => {
      const { rows } = await q(`SELECT id, business_id FROM public.api_keys WHERE key_hash = 'hash-a' AND revoked_at IS NULL`);
      expect(rows).toEqual([{ id: KEY_A, business_id: BIZ_A }]);
      expect((await q(`UPDATE public.api_keys SET last_used_at = now() WHERE id = $1`, [KEY_A])).rowCount).toBe(1);
    });
  });

  it('service_role: cannot delete or truncate keys', async () => {
    for (const sql of [`DELETE FROM public.api_keys WHERE id = '${KEY_A}'`, 'TRUNCATE public.api_keys']) {
      const err = await as('service_role', null, () => errorOf(() => q(sql)));
      expect(err.code, sql).toBe('42501');
    }
  });

  it('service_role deleting a business still removes its keys (FK cascade runs as the table owner)', async () => {
    await q('BEGIN');
    try {
      await q('GRANT DELETE ON public.businesses TO service_role');
      await q('SET LOCAL ROLE service_role');
      expect((await q(`DELETE FROM public.businesses WHERE id = $1`, [BIZ_A])).rowCount).toBe(1);
      await q('RESET ROLE');
      expect((await q(`SELECT 1 FROM public.api_keys WHERE business_id = $1`, [BIZ_A])).rowCount).toBe(0);
    } finally {
      await q('ROLLBACK');
    }
  });
});
