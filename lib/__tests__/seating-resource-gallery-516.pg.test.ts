/**
 * M516 — optional photos for tables and sections
 * (seating_resources.gallery_urls, #892, Owner decisions 2026-11-05).
 * Real PostgreSQL proof (disposable local database, created and dropped here).
 *
 * The fixture is the live final state of public.seating_resources on staging,
 * read on 2026-11-05 (read-only): the 18 columns and 7 checks from M476/M510,
 * RLS on, owner insert/select/update policies (role PUBLIC), admin policies
 * via has_admin_role, service_role ALL policy; table ACL authenticated=arw,
 * service_role=arw, no anon. M516 is applied from disk as one whole-file
 * statement, as it will be hosted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M516 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m516 = readFileSync('supabase/migrations/516_seating_resource_gallery.sql', 'utf8');
const database = `m516_${randomUUID().replaceAll('-', '')}`;
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const BIZ_A = randomUUID();
const BIZ_B = randomUUID();
const SEAT_A = randomUUID();
const SEAT_B = randomUUID();
const photo = (n: number) => `https://x.supabase.co/storage/v1/object/public/business-documents/${BIZ_A}/seating/${n}.jpg`;

type DbError = { code?: string; message?: string };

suite('M516 seating_resources.gallery_urls (real PostgreSQL)', () => {
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

      CREATE TABLE public.seating_resources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        resource_type VARCHAR(30) NOT NULL DEFAULT 'table'
          CONSTRAINT seating_resources_resource_type_check
          CHECK (resource_type IN ('table', 'booth', 'section', 'vip_area', 'private_room', 'bar_seat')),
        capacity INTEGER NOT NULL DEFAULT 2 CONSTRAINT seating_resources_capacity_check CHECK (capacity > 0 AND capacity <= 500),
        min_party_size INTEGER NOT NULL DEFAULT 1 CONSTRAINT seating_resources_min_party_size_check CHECK (min_party_size > 0),
        section VARCHAR(100),
        reservation_duration_minutes INTEGER NOT NULL DEFAULT 90
          CONSTRAINT seating_resources_reservation_duration_minutes_check CHECK (reservation_duration_minutes > 0 AND reservation_duration_minutes <= 480),
        deposit_amount INTEGER NOT NULL DEFAULT 0 CONSTRAINT seating_resources_deposit_amount_check CHECK (deposit_amount >= 0),
        is_active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        available_days TEXT[],
        available_from TIME,
        available_to TIME,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT seating_min_lte_max CHECK (min_party_size <= capacity),
        CONSTRAINT seating_no_overnight CHECK (available_from IS NULL OR available_to IS NULL OR available_from < available_to)
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

      GRANT SELECT, INSERT, UPDATE ON public.seating_resources TO authenticated, service_role;
    `);
    await q(`INSERT INTO public.businesses (id, owner_id) VALUES ($1, $2), ($3, $4)`, [BIZ_A, OWNER_A, BIZ_B, OWNER_B]);
    await q(`INSERT INTO public.seating_resources (id, business_id, name, section) VALUES ($1, $2, 'VIP Booth', 'Rooftop'), ($3, $4, 'Table 1', NULL)`,
      [SEAT_A, BIZ_A, SEAT_B, BIZ_B]);
  }, 60000);

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('before 516: the column does not exist (42703)', async () => {
    const err = await errorOf(() => q(`SELECT gallery_urls FROM public.seating_resources`));
    expect(err.code).toBe('42703');
  });

  it('A1/A4 applies 516 (self-check passes), re-applies cleanly; existing rows read {}', async () => {
    await q(m516);
    await q(m516);
    const { rows: [col] } = await q(`
      SELECT udt_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'seating_resources' AND column_name = 'gallery_urls'`);
    expect(col).toEqual({ udt_name: '_text', is_nullable: 'NO', column_default: "'{}'::text[]" });
    const { rows: cons } = await q(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'public.seating_resources'::regclass AND conname = 'seating_resources_gallery_max_3'`);
    expect(cons).toHaveLength(1);
    expect(cons[0].def).toBe('CHECK ((cardinality(gallery_urls) <= 3))');
    const { rows: [comment] } = await q(`SELECT col_description('public.seating_resources'::regclass, attnum) AS c FROM pg_attribute WHERE attrelid = 'public.seating_resources'::regclass AND attname = 'gallery_urls'`);
    expect(comment.c).toMatch(/M516/);
    const { rows } = await q(`SELECT gallery_urls FROM public.seating_resources ORDER BY name`);
    expect(rows.map(r => r.gallery_urls)).toEqual([[], []]);
  });

  it('table ACL and every RLS policy are unchanged', async () => {
    const { rows: [acl] } = await q(`SELECT relacl::text AS acl FROM pg_class WHERE oid = 'public.seating_resources'::regclass`);
    expect(acl.acl).toMatch(/authenticated=arw\//);
    expect(acl.acl).toMatch(/service_role=arw\//);
    expect(acl.acl).not.toMatch(/anon=/);
    const { rows: pols } = await q(`SELECT polname FROM pg_policy WHERE polrelid = 'public.seating_resources'::regclass ORDER BY polname`);
    expect(pols.map(r => r.polname)).toEqual([
      'seating_resources_admin_select', 'seating_resources_admin_write', 'seating_resources_owner_insert',
      'seating_resources_owner_select', 'seating_resources_owner_update', 'seating_resources_service_all',
    ]);
  });

  it('A2 accepts 0 to 3 photos and rejects 4 (23514); NULL is rejected (23502)', async () => {
    for (const n of [0, 1, 2, 3]) {
      const urls = Array.from({ length: n }, (_, i) => photo(i));
      await q(`UPDATE public.seating_resources SET gallery_urls = $1 WHERE id = $2`, [urls, SEAT_A]);
    }
    const four = await errorOf(() => q(`UPDATE public.seating_resources SET gallery_urls = $1 WHERE id = $2`, [[photo(1), photo(2), photo(3), photo(4)], SEAT_A]));
    expect(four.code).toBe('23514');
    expect(four.message).toMatch(/seating_resources_gallery_max_3/);
    const nul = await errorOf(() => q(`UPDATE public.seating_resources SET gallery_urls = NULL WHERE id = $1`, [SEAT_A]));
    expect(nul.code).toBe('23502');
    await q(`UPDATE public.seating_resources SET gallery_urls = '{}' WHERE id = $1`, [SEAT_A]);
  });

  it('A3 an owner sets photos on their own seat, and on a new seat at insert', async () => {
    await as('authenticated', OWNER_A, async () => {
      const { rows: [r], rowCount } = await q(
        `UPDATE public.seating_resources SET gallery_urls = $1 WHERE id = $2 RETURNING gallery_urls`, [[photo(1), photo(2)], SEAT_A]);
      expect(rowCount).toBe(1);
      expect(r.gallery_urls).toEqual([photo(1), photo(2)]);
      const { rows: [ins] } = await q(
        `INSERT INTO public.seating_resources (business_id, name, gallery_urls) VALUES ($1, 'Patio', $2) RETURNING gallery_urls`, [BIZ_A, [photo(3)]]);
      expect(ins.gallery_urls).toEqual([photo(3)]);
    });
  });

  it('A3 another owner cannot change or see the photos; cannot insert into another business', async () => {
    await q(`UPDATE public.seating_resources SET gallery_urls = $1 WHERE id = $2`, [[photo(1)], SEAT_A]);
    await as('authenticated', OWNER_B, async () => {
      const { rowCount } = await q(`UPDATE public.seating_resources SET gallery_urls = $1 WHERE id = $2`, [[photo(9)], SEAT_A]);
      expect(rowCount).toBe(0);
      expect((await q(`SELECT gallery_urls FROM public.seating_resources WHERE id = $1`, [SEAT_A])).rows).toHaveLength(0);
      const err = await errorOf(() => q(`INSERT INTO public.seating_resources (business_id, name, gallery_urls) VALUES ($1, 'Forged', $2)`, [BIZ_A, [photo(9)]]));
      expect(err.code).toBe('42501');
    });
    expect((await q(`SELECT gallery_urls FROM public.seating_resources WHERE id = $1`, [SEAT_A])).rows[0].gallery_urls).toEqual([photo(1)]);
  });

  it('A3 anon cannot write photos (42501)', async () => {
    const err = await errorOf(() => as('anon', null, () =>
      q(`UPDATE public.seating_resources SET gallery_urls = $1 WHERE id = $2`, [[photo(9)], SEAT_A])));
    expect(err.code).toBe('42501');
  });

  it('A4 re-run converges a dropped check (recreated by the guarded DO block)', async () => {
    await q(`ALTER TABLE public.seating_resources DROP CONSTRAINT seating_resources_gallery_max_3`);
    await q(m516);
    const err = await errorOf(() => q(`UPDATE public.seating_resources SET gallery_urls = $1 WHERE id = $2`, [[photo(1), photo(2), photo(3), photo(4)], SEAT_A]));
    expect(err.code).toBe('23514');
  });

  it('self-check fails the migration if authenticated loses UPDATE on the table (M516)', async () => {
    await q(`REVOKE UPDATE ON public.seating_resources FROM authenticated`);
    try {
      const err = await errorOf(() => q(m516));
      expect(err.message).toMatch(/^M516: authenticated must be able to read and write/);
    } finally {
      await q(`GRANT UPDATE ON public.seating_resources TO authenticated`);
    }
    await q(m516);
  });
});
