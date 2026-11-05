/**
 * M519 — exact table grants on party_tables (PR #789, was M487).
 * Real PostgreSQL proof (disposable local database, created and dropped here).
 *
 * Fixture is the live final state read on 2026-11-05 (read-only): party_tables with its
 * 8 columns (M457 + M514 reserved_tag), RLS on, owner policy for PUBLIC, admin read policy
 * for authenticated. Table ACLs differ by environment, so M519 is applied from disk as one
 * whole-file statement over two starting states, a broad one (every privilege for every API
 * role, as Supabase default privileges give a new table) and a narrow one (the grants in
 * migration history), and must give the same exact grants from both.
 * seating_resources is out of scope (Owner decision 2026-11-05) and must be
 * left exactly as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M519 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m519 = readFileSync('supabase/migrations/519_party_tables_exact_grants.sql', 'utf8');
const database = `m519_${randomUUID().replaceAll('-', '')}`;
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const BIZ_A = randomUUID();
const BIZ_B = randomUUID();
const PARTY_A = randomUUID();
const TABLE_A = randomUUID();
const INVITE_A = randomUUID();

type DbError = { code?: string; message?: string };

const EXPECTED = ['authenticated:DELETE', 'authenticated:INSERT', 'authenticated:SELECT', 'authenticated:UPDATE', 'service_role:SELECT'];
const ALL = 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER';

suite('M519 party_tables grants (real PostgreSQL)', () => {
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
  /** API-role grants on a table, as role:PRIVILEGE, sorted. */
  async function grants(table: string): Promise<string[]> {
    const { rows } = await q(`
      SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) || ':' || a.privilege_type AS g
      FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE c.oid = $1::regclass
        AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role'))
      ORDER BY 1`, [`public.${table}`]);
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
      CREATE FUNCTION public.has_admin_role(roles TEXT[]) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT false $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

      CREATE TABLE public.businesses (id UUID PRIMARY KEY, owner_id UUID NOT NULL);
      GRANT SELECT ON public.businesses TO authenticated, service_role;
      CREATE TABLE public.parties (id UUID PRIMARY KEY, business_id UUID NOT NULL REFERENCES public.businesses(id));

      CREATE TABLE public.party_tables (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        party_id UUID NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        capacity INTEGER NOT NULL DEFAULT 10,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        reserved_tag TEXT,
        UNIQUE (party_id, name)
      );
      ALTER TABLE public.party_tables ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "Business owners manage party tables" ON public.party_tables FOR ALL
        USING (business_id IN (SELECT businesses.id FROM businesses WHERE businesses.owner_id = auth.uid()));
      CREATE POLICY "Admin reads party tables" ON public.party_tables FOR SELECT TO authenticated
        USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

      -- Out of scope: must keep whatever grants it has.
      CREATE TABLE public.seating_resources (id UUID PRIMARY KEY, business_id UUID NOT NULL);
      ALTER TABLE public.seating_resources ENABLE ROW LEVEL SECURITY;
      GRANT ${ALL} ON public.seating_resources TO anon, authenticated, service_role;

      -- event_invites with a SECURITY INVOKER trigger that reads party_tables, the same shape
      -- as M457 enforce_invite_capacity: whoever writes a seated invite needs SELECT on party_tables.
      CREATE TABLE public.event_invites (
        id UUID PRIMARY KEY, business_id UUID NOT NULL, party_id UUID NOT NULL,
        table_id UUID REFERENCES public.party_tables(id), status TEXT NOT NULL DEFAULT 'pending'
      );
      ALTER TABLE public.event_invites ENABLE ROW LEVEL SECURITY;
      CREATE POLICY invites_owner ON public.event_invites FOR ALL
        USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      GRANT SELECT, INSERT, UPDATE ON public.event_invites TO authenticated, service_role;
      CREATE FUNCTION public.enforce_invite_capacity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_max integer;
      BEGIN
        IF NEW.table_id IS NOT NULL THEN
          SELECT capacity INTO v_max FROM public.party_tables WHERE id = NEW.table_id;
        END IF;
        RETURN NULL;
      END $$;
      CREATE TRIGGER trg_enforce_invite_capacity AFTER INSERT OR UPDATE ON public.event_invites
        FOR EACH ROW EXECUTE FUNCTION public.enforce_invite_capacity_fixture();
    `);
    await q(`INSERT INTO public.businesses (id, owner_id) VALUES ($1, $2), ($3, $4)`, [BIZ_A, OWNER_A, BIZ_B, OWNER_B]);
    await q(`INSERT INTO public.parties (id, business_id) VALUES ($1, $2)`, [PARTY_A, BIZ_A]);
    await q(`INSERT INTO public.party_tables (id, business_id, party_id, name) VALUES ($1, $2, $3, 'Table 1')`, [TABLE_A, BIZ_A, PARTY_A]);
    await q(`INSERT INTO public.event_invites (id, business_id, party_id, table_id) VALUES ($1, $2, $3, $4)`, [INVITE_A, BIZ_A, PARTY_A, TABLE_A]);
  }, 60000);

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('from a broad starting state: 519 sets exactly the contract (self-check passes); seating_resources untouched', async () => {
    await q(`GRANT ${ALL} ON public.party_tables TO anon, authenticated, service_role; GRANT SELECT ON public.party_tables TO PUBLIC;`);
    expect(await grants('party_tables')).toContain('anon:TRUNCATE');
    const seatingBefore = await grants('seating_resources');
    await q(m519);
    expect(await grants('party_tables')).toEqual(EXPECTED);
    expect(await grants('seating_resources')).toEqual(seatingBefore);
  });

  it('from the narrow starting state: 519 gives the same result, and re-applies cleanly', async () => {
    await q(`
      REVOKE ALL ON public.party_tables FROM PUBLIC, anon, authenticated, service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.party_tables TO authenticated;`);
    expect(await grants('party_tables')).not.toContain('service_role:SELECT');
    await q(m519);
    await q(m519);
    expect(await grants('party_tables')).toEqual(EXPECTED);
  });

  it('RLS stays on and the policies are unchanged', async () => {
    const { rows: [rls] } = await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.party_tables'::regclass`);
    expect(rls.relrowsecurity).toBe(true);
    const { rows: pols } = await q(`SELECT polname FROM pg_policy WHERE polrelid = 'public.party_tables'::regclass ORDER BY 1`);
    expect(pols.map(r => r.polname)).toEqual(['Admin reads party tables', 'Business owners manage party tables']);
  });

  it('a leftover anon column-level grant is removed too (table REVOKE ALL covers columns)', async () => {
    await q('BEGIN');
    try {
      await q('GRANT SELECT (name) ON public.party_tables TO anon');
      await q(m519);
      const { rows } = await q(`SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = 'public.party_tables'::regclass AND attacl IS NOT NULL`);
      expect(rows[0].n).toBe(0);
      expect(await grants('party_tables')).toEqual(EXPECTED);
    } finally {
      await q('ROLLBACK');
    }
  });

  it('anon: no access of any kind', async () => {
    for (const sql of [
      'SELECT 1 FROM public.party_tables',
      `INSERT INTO public.party_tables (business_id, party_id, name) VALUES ('${BIZ_A}', '${PARTY_A}', 'x')`,
      'UPDATE public.party_tables SET name = name',
      'DELETE FROM public.party_tables',
    ]) {
      const err = await as('anon', null, () => errorOf(() => q(sql)));
      expect(err.code, sql).toBe('42501');
    }
  });

  it('authenticated owner: list, add, reserve and delete tables (dashboard)', async () => {
    await as('authenticated', OWNER_A, async () => {
      expect((await q('SELECT name FROM public.party_tables')).rows).toEqual([{ name: 'Table 1' }]);
      const { rows: [t] } = await q(`INSERT INTO public.party_tables (business_id, party_id, name) VALUES ($1, $2, 'Table 2') RETURNING id`, [BIZ_A, PARTY_A]);
      expect((await q(`UPDATE public.party_tables SET reserved_tag = 'family' WHERE id = $1`, [t.id])).rowCount).toBe(1);
      expect((await q(`DELETE FROM public.party_tables WHERE id = $1`, [t.id])).rowCount).toBe(1);
    });
  });

  it('authenticated: another owner sees and changes nothing (RLS); nobody can TRUNCATE', async () => {
    await as('authenticated', OWNER_B, async () => {
      expect((await q('SELECT 1 FROM public.party_tables')).rowCount).toBe(0);
      expect((await q('DELETE FROM public.party_tables')).rowCount).toBe(0);
    });
    for (const role of ['authenticated', 'service_role']) {
      const err = await as(role, OWNER_A, () => errorOf(() => q('TRUNCATE public.party_tables')));
      expect(err.code, role).toBe('42501');
    }
  });

  it('service_role: reads tables (reminders) but cannot write them', async () => {
    await as('service_role', null, async () => {
      expect((await q('SELECT name FROM public.party_tables WHERE party_id = $1', [PARTY_A])).rows).toEqual([{ name: 'Table 1' }]);
    });
    for (const sql of [
      `INSERT INTO public.party_tables (business_id, party_id, name) VALUES ('${BIZ_A}', '${PARTY_A}', 'x')`,
      'UPDATE public.party_tables SET name = name',
      'DELETE FROM public.party_tables',
    ]) {
      const err = await as('service_role', null, () => errorOf(() => q(sql)));
      expect(err.code, sql).toBe('42501');
    }
  });

  it('a seated guest RSVP still saves: the invoker trigger reads party_tables as service_role and as the owner', async () => {
    await as('service_role', null, async () => {
      expect((await q(`UPDATE public.event_invites SET status = 'accepted' WHERE id = $1`, [INVITE_A])).rowCount).toBe(1);
    });
    await as('authenticated', OWNER_A, async () => {
      expect((await q(`UPDATE public.event_invites SET status = 'maybe' WHERE id = $1`, [INVITE_A])).rowCount).toBe(1);
    });
  });
});
