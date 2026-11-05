/**
 * M519 — exact table grants on party_tables and seating_resources (PR #789, was M487).
 * Real PostgreSQL proof (disposable local database, created and dropped here).
 *
 * Fixtures are the live final state read on 2026-11-05 (read-only):
 *  - party_tables: 8 columns (M457 + M514 reserved_tag), RLS on, owner policy for PUBLIC,
 *    admin read policy for authenticated;
 *  - seating_resources: RLS on, owner select/insert/update (PUBLIC), admin policies,
 *    service_role ALL policy;
 *  - table ACLs differ by environment. Production: anon, authenticated and service_role hold
 *    every privilege. Staging: authenticated arwd / arw, service_role none / arw.
 * M519 is applied from disk as one whole-file statement, as it will be hosted, over both
 * starting states, and must give the same exact grants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M519 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m519 = readFileSync('supabase/migrations/519_revoke_inherited_acl_party_seating.sql', 'utf8');
const database = `m519_${randomUUID().replaceAll('-', '')}`;
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const BIZ_A = randomUUID();
const BIZ_B = randomUUID();
const PARTY_A = randomUUID();
const TABLE_A = randomUUID();
const SEAT_A = randomUUID();
const INVITE_A = randomUUID();

type DbError = { code?: string; message?: string };

const EXPECTED: Record<string, string[]> = {
  party_tables: ['authenticated:DELETE', 'authenticated:INSERT', 'authenticated:SELECT', 'authenticated:UPDATE', 'service_role:SELECT'],
  seating_resources: ['authenticated:INSERT', 'authenticated:SELECT', 'authenticated:UPDATE',
    'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE'],
};

suite('M519 party_tables / seating_resources grants (real PostgreSQL)', () => {
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
  const ALL = 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER';
  async function setProductionAcl() {
    await q(`
      GRANT ${ALL} ON public.party_tables, public.seating_resources TO anon, authenticated, service_role;
      GRANT SELECT ON public.party_tables, public.seating_resources TO PUBLIC;`);
  }
  async function setStagingAcl() {
    await q(`
      REVOKE ALL ON public.party_tables, public.seating_resources FROM PUBLIC, anon, authenticated, service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.party_tables TO authenticated;
      GRANT SELECT, INSERT, UPDATE ON public.seating_resources TO authenticated, service_role;`);
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

      CREATE TABLE public.seating_resources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        capacity INTEGER NOT NULL DEFAULT 2,
        is_active BOOLEAN NOT NULL DEFAULT true,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.seating_resources ENABLE ROW LEVEL SECURITY;
      CREATE POLICY seating_resources_owner_select ON public.seating_resources FOR SELECT
        USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      CREATE POLICY seating_resources_owner_insert ON public.seating_resources FOR INSERT
        WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      CREATE POLICY seating_resources_owner_update ON public.seating_resources FOR UPDATE
        USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
      CREATE POLICY seating_resources_service_all ON public.seating_resources FOR ALL TO service_role USING (true) WITH CHECK (true);
      CREATE POLICY seating_resources_admin_select ON public.seating_resources FOR SELECT TO authenticated
        USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));
      CREATE POLICY seating_resources_admin_write ON public.seating_resources FOR ALL TO authenticated
        USING (public.has_admin_role(ARRAY['admin'])) WITH CHECK (public.has_admin_role(ARRAY['admin']));

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
    await q(`INSERT INTO public.seating_resources (id, business_id, name) VALUES ($1, $2, 'Booth')`, [SEAT_A, BIZ_A]);
    await q(`INSERT INTO public.event_invites (id, business_id, party_id, table_id) VALUES ($1, $2, $3, $4)`, [INVITE_A, BIZ_A, PARTY_A, TABLE_A]);
  }, 60000);

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('from the production grants: 519 sets exactly the contract (self-check passes)', async () => {
    await setProductionAcl();
    expect(await grants('party_tables')).toContain('anon:TRUNCATE');
    await q(m519);
    expect(await grants('party_tables')).toEqual(EXPECTED.party_tables);
    expect(await grants('seating_resources')).toEqual(EXPECTED.seating_resources);
  });

  it('from the staging grants: 519 gives the same result, and re-applies cleanly', async () => {
    await setStagingAcl();
    expect(await grants('party_tables')).not.toContain('service_role:SELECT');
    await q(m519);
    await q(m519);
    expect(await grants('party_tables')).toEqual(EXPECTED.party_tables);
    expect(await grants('seating_resources')).toEqual(EXPECTED.seating_resources);
  });

  it('RLS stays on and the policies are unchanged', async () => {
    const { rows } = await q(`SELECT relname, relrowsecurity FROM pg_class WHERE oid IN ('public.party_tables'::regclass, 'public.seating_resources'::regclass) ORDER BY 1`);
    expect(rows).toEqual([{ relname: 'party_tables', relrowsecurity: true }, { relname: 'seating_resources', relrowsecurity: true }]);
    const { rows: pols } = await q(`SELECT polname FROM pg_policy WHERE polrelid IN ('public.party_tables'::regclass, 'public.seating_resources'::regclass) ORDER BY 1`);
    expect(pols.map(r => r.polname)).toEqual([
      'Admin reads party tables', 'Business owners manage party tables',
      'seating_resources_admin_select', 'seating_resources_admin_write', 'seating_resources_owner_insert',
      'seating_resources_owner_select', 'seating_resources_owner_update', 'seating_resources_service_all',
    ]);
  });

  it('a leftover anon column-level grant is removed too (table REVOKE ALL covers columns)', async () => {
    await q('BEGIN');
    try {
      await q('GRANT SELECT (name) ON public.party_tables TO anon');
      await q('GRANT UPDATE (name) ON public.seating_resources TO anon');
      await q(m519);
      const { rows } = await q(`SELECT count(*)::int AS n FROM pg_attribute
        WHERE attrelid IN ('public.party_tables'::regclass, 'public.seating_resources'::regclass) AND attacl IS NOT NULL`);
      expect(rows[0].n).toBe(0);
      expect(await grants('party_tables')).toEqual(EXPECTED.party_tables);
    } finally {
      await q('ROLLBACK');
    }
  });

  it('anon: no access of any kind to either table', async () => {
    for (const sql of [
      'SELECT 1 FROM public.party_tables',
      `INSERT INTO public.party_tables (business_id, party_id, name) VALUES ('${BIZ_A}', '${PARTY_A}', 'x')`,
      'UPDATE public.party_tables SET name = name',
      'DELETE FROM public.party_tables',
      'SELECT 1 FROM public.seating_resources',
      `INSERT INTO public.seating_resources (business_id, name) VALUES ('${BIZ_A}', 'x')`,
      'UPDATE public.seating_resources SET name = name',
      'DELETE FROM public.seating_resources',
    ]) {
      const err = await as('anon', null, () => errorOf(() => q(sql)));
      expect(err.code, sql).toBe('42501');
    }
  });

  it('authenticated owner: party tables list, add, rename, reserve and delete (dashboard)', async () => {
    await as('authenticated', OWNER_A, async () => {
      expect((await q('SELECT name FROM public.party_tables')).rows).toEqual([{ name: 'Table 1' }]);
      const { rows: [t] } = await q(`INSERT INTO public.party_tables (business_id, party_id, name) VALUES ($1, $2, 'Table 2') RETURNING id`, [BIZ_A, PARTY_A]);
      expect((await q(`UPDATE public.party_tables SET reserved_tag = 'family' WHERE id = $1`, [t.id])).rowCount).toBe(1);
      expect((await q(`DELETE FROM public.party_tables WHERE id = $1`, [t.id])).rowCount).toBe(1);
    });
  });

  it('authenticated: another owner sees and changes nothing (RLS), and nobody can TRUNCATE', async () => {
    await as('authenticated', OWNER_B, async () => {
      expect((await q('SELECT 1 FROM public.party_tables')).rowCount).toBe(0);
      expect((await q('DELETE FROM public.party_tables')).rowCount).toBe(0);
      expect((await q('SELECT 1 FROM public.seating_resources')).rowCount).toBe(0);
      expect((await q(`UPDATE public.seating_resources SET name = 'x'`)).rowCount).toBe(0);
    });
    for (const role of ['authenticated', 'service_role']) {
      for (const table of ['party_tables', 'seating_resources']) {
        const err = await as(role, OWNER_A, () => errorOf(() => q(`TRUNCATE public.${table}`)));
        expect(err.code, `${role} ${table}`).toBe('42501');
      }
    }
  });

  it('authenticated owner: seating resources list, add, edit, archive; never delete', async () => {
    await as('authenticated', OWNER_A, async () => {
      expect((await q('SELECT name FROM public.seating_resources')).rows).toEqual([{ name: 'Booth' }]);
      await q(`INSERT INTO public.seating_resources (business_id, name) VALUES ($1, 'Patio')`, [BIZ_A]);
      expect((await q(`UPDATE public.seating_resources SET is_active = false WHERE id = $1`, [SEAT_A])).rowCount).toBe(1);
      const err = await errorOf(() => q(`DELETE FROM public.seating_resources WHERE id = $1`, [SEAT_A]));
      expect(err.code).toBe('42501');
    });
  });

  it('service_role: reads party tables (reminders) but cannot write them', async () => {
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

  it('service_role: seating resources read, add, edit (bot, admin route); never delete', async () => {
    await as('service_role', null, async () => {
      expect((await q('SELECT name FROM public.seating_resources WHERE business_id = $1', [BIZ_A])).rows).toEqual([{ name: 'Booth' }]);
      await q(`INSERT INTO public.seating_resources (business_id, name) VALUES ($1, 'Bar')`, [BIZ_A]);
      expect((await q(`UPDATE public.seating_resources SET capacity = 4 WHERE id = $1`, [SEAT_A])).rowCount).toBe(1);
      const err = await errorOf(() => q(`DELETE FROM public.seating_resources WHERE id = $1`, [SEAT_A]));
      expect(err.code).toBe('42501');
    });
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
