/**
 * M523 — businesses_public / whatsapp_channels_public run as the caller
 * (security_invoker) and keep exactly the same public columns and rows.
 * Real PostgreSQL proof (disposable local database, created and dropped by
 * this file).
 *
 * The fixture is the live final state read on 2026-11-05 (read-only,
 * production cxcmiqotkowhxinjbytg):
 *   - businesses: RLS on; ACL postgres/authenticated/service_role ALL, no anon;
 *     policies "Admins can view all businesses" (authenticated, is_admin()),
 *     "Owners manage own businesses" (PUBLIC, owner_id = auth.uid()),
 *     "Resellers view sub-businesses" (PUBLIC);
 *   - whatsapp_channels: RLS on; table ACL postgres/service_role only;
 *     authenticated has column-level SELECT on non-secret columns; policies
 *     "Business owners can read own channel" (dedicated only),
 *     "Service role full access", admin_select_whatsapp_channels;
 *   - both views exactly as M293 created them (owner rights, security_barrier,
 *     SELECT to anon, authenticated, service_role);
 *   - service_role BYPASSRLS, as on Supabase.
 * Only the columns the views read plus representative secret columns are
 * modelled. M523 is applied from disk as one whole-file statement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M523 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m523 = readFileSync('supabase/migrations/523_public_views_security_invoker.sql', 'utf8');
const database = `m523_${randomUUID().replaceAll('-', '')}`;
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const BIZ_ACTIVE = randomUUID();
const BIZ_PENDING = randomUUID();
const BIZ_SUSPENDED = randomUUID();
const BIZ_B = randomUUID();
const CH_SHARED_US = randomUUID();
const CH_SHARED_NG = randomUUID();
const CH_SHARED_OFF = randomUUID();
const CH_DEDICATED = randomUUID();

type DbError = { code?: string; message?: string };

const BUSINESS_VIEW_COLUMNS = [
  'id', 'name', 'slug', 'description', 'address', 'city', 'state', 'country_code', 'phone', 'email',
  'logo_url', 'cover_photo_url', 'category', 'flow_type', 'operating_hours', 'rating_avg', 'rating_count',
  'total_bookings', 'instagram_handle', 'timezone', 'recurring_enabled', 'bot_code', 'status',
  'created_at', 'updated_at',
];
const CHANNEL_VIEW_COLUMNS = ['id', 'country_code', 'phone_number', 'display_name', 'channel_type', 'is_active'];

suite('M523 public views run as the caller (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  let columnsBefore: unknown[];
  let aclBefore: unknown[];

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
  const viewColumns = () => q(`
    SELECT c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.oid IN ('public.businesses_public'::regclass, 'public.whatsapp_channels_public'::regclass)
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`).then(r => r.rows);
  const viewAcl = () => q(`
    SELECT relname, relacl::text FROM pg_class
    WHERE oid IN ('public.businesses_public'::regclass, 'public.whatsapp_channels_public'::regclass)
    ORDER BY relname`).then(r => r.rows);

  /** Build the live fixture in a fresh database. */
  async function buildFixture(db: pg.Client) {
    await db.query(`
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_user::text $$;
      CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

      CREATE TYPE public.restaurant_status AS ENUM ('pending', 'active', 'suspended');
      CREATE TYPE public.business_category AS ENUM ('restaurant', 'barber', 'shortlet', 'other');
      CREATE TYPE public.flow_type AS ENUM ('scheduling', 'payment', 'ordering', 'reservation');

      CREATE TABLE public.resellers (id uuid PRIMARY KEY, user_id uuid);
      GRANT SELECT ON public.resellers TO authenticated;

      CREATE TABLE public.businesses (
        id uuid PRIMARY KEY, owner_id uuid NOT NULL, reseller_id uuid,
        name varchar(200) NOT NULL, slug varchar(200) UNIQUE, description text, address text,
        city varchar(50), state varchar(100), country_code varchar(2), phone varchar(20), email varchar(255),
        logo_url text, cover_photo_url text, category public.business_category, flow_type public.flow_type,
        operating_hours jsonb, rating_avg numeric(2,1), rating_count integer, total_bookings integer,
        instagram_handle varchar(100), timezone varchar(50), recurring_enabled boolean, bot_code varchar(30),
        status public.restaurant_status NOT NULL DEFAULT 'pending',
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
        google_calendar_token text, google_calendar_refresh_token text, payment_channels jsonb,
        custom_fee_percentage numeric, custom_fee_flat numeric, metadata jsonb
      );
      ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.businesses FROM PUBLIC, anon;
      GRANT ALL ON public.businesses TO authenticated, service_role;
      CREATE POLICY "Admins can view all businesses" ON public.businesses FOR SELECT TO authenticated USING (is_admin());
      CREATE POLICY "Owners manage own businesses" ON public.businesses FOR ALL USING (owner_id = auth.uid());
      CREATE POLICY "Resellers view sub-businesses" ON public.businesses FOR SELECT
        USING (reseller_id IN (SELECT resellers.id FROM resellers WHERE resellers.user_id = auth.uid()));

      CREATE TABLE public.whatsapp_channels (
        id uuid PRIMARY KEY, business_id uuid, country_code varchar(2), phone_number varchar(20),
        display_name varchar(128), channel_type varchar(10) NOT NULL DEFAULT 'shared', is_active boolean DEFAULT true,
        meta_access_token text, waba_id text, phone_number_id text,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      ALTER TABLE public.whatsapp_channels ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.whatsapp_channels FROM PUBLIC, anon, authenticated;
      GRANT ALL ON public.whatsapp_channels TO service_role;
      GRANT SELECT (id, country_code, phone_number, channel_type, business_id, is_active, created_at, updated_at,
                    waba_id, phone_number_id, display_name) ON public.whatsapp_channels TO authenticated;
      CREATE POLICY "Business owners can read own channel" ON public.whatsapp_channels FOR SELECT
        USING (channel_type::text = 'dedicated' AND business_id IN (SELECT businesses.id FROM businesses WHERE businesses.owner_id = auth.uid()));
      CREATE POLICY "Service role full access on whatsapp_channels" ON public.whatsapp_channels FOR ALL
        USING (auth.role() = 'service_role');
      CREATE POLICY admin_select_whatsapp_channels ON public.whatsapp_channels FOR SELECT USING (is_admin());

      -- The two views exactly as M293 left them (live definitions).
      CREATE VIEW public.whatsapp_channels_public WITH (security_barrier = true) AS
        SELECT id, country_code, phone_number, display_name, channel_type, is_active
        FROM public.whatsapp_channels WHERE channel_type::text = 'shared' AND is_active = true;
      REVOKE ALL ON public.whatsapp_channels_public FROM PUBLIC;
      GRANT SELECT ON public.whatsapp_channels_public TO anon, authenticated, service_role;
      CREATE VIEW public.businesses_public WITH (security_barrier = true) AS
        SELECT ${BUSINESS_VIEW_COLUMNS.join(', ')} FROM public.businesses WHERE status = 'active';
      REVOKE ALL ON public.businesses_public FROM PUBLIC;
      GRANT SELECT ON public.businesses_public TO anon, authenticated, service_role;
    `);
    await db.query(`
      INSERT INTO public.businesses (id, owner_id, name, slug, description, address, country_code, category,
        operating_hours, recurring_enabled, status, google_calendar_token, payment_channels, metadata)
      VALUES
        ($1, $5, 'Active Spa', 'active-spa', 'Open', '1 Main St', 'NG', 'other', '{"mon":"9-5"}', true, 'active',
         'tok-secret', '{"k":"secret"}', '{"m":1}'),
        ($2, $5, 'Pending Spa', 'pending-spa', 'Not yet', NULL, 'NG', 'other', NULL, false, 'pending', NULL, NULL, NULL),
        ($3, $5, 'Suspended Spa', 'suspended-spa', 'Off', NULL, 'NG', 'other', NULL, false, 'suspended', NULL, NULL, NULL),
        ($4, $6, 'Other Barber', 'other-barber', 'B', NULL, 'US', 'barber', NULL, false, 'active', 'tok-b', NULL, NULL)`,
      [BIZ_ACTIVE, BIZ_PENDING, BIZ_SUSPENDED, BIZ_B, OWNER_A, OWNER_B]);
    await db.query(`
      INSERT INTO public.whatsapp_channels (id, business_id, country_code, phone_number, display_name, channel_type, is_active, meta_access_token)
      VALUES
        ($1, NULL, 'US', '+15550001', 'Waaiio US', 'shared', true, 'meta-secret-1'),
        ($2, NULL, 'NG', '+23480001', 'Waaiio NG', 'shared', true, 'meta-secret-2'),
        ($3, NULL, 'GB', '+44700001', 'Waaiio GB', 'shared', false, 'meta-secret-3'),
        ($4, $5, 'NG', '+23480999', 'Active Spa', 'dedicated', true, 'meta-secret-4')`,
      [CH_SHARED_US, CH_SHARED_NG, CH_SHARED_OFF, CH_DEDICATED, BIZ_ACTIVE]);
  }

  async function freshDatabase(name: string): Promise<pg.Client> {
    await control.query(`CREATE DATABASE ${name}`);
    const target = new URL(url!); target.pathname = `/${name}`;
    const db = new pg.Client({ connectionString: target.toString() }); await db.connect();
    return db;
  }

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    // Roles are cluster-wide and other .pg.test.ts files create them in parallel.
    const roleSetup = `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS;
        ELSIF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role') THEN ALTER ROLE service_role BYPASSRLS; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'm523_outsider') THEN CREATE ROLE m523_outsider NOLOGIN; END IF;
      END $$`;
    try { await control.query(roleSetup); } catch (err) {
      const code = (err as DbError).code;
      if (code !== 'XX000' && code !== '23505' && code !== '42710') throw err;
      await new Promise(resolve => setTimeout(resolve, 250));
      await control.query(roleSetup);
    }
    client = await freshDatabase(database);
    await buildFixture(client);
    // The Security Advisor condition holds before M523.
    const before = await q(`SELECT relname, reloptions FROM pg_class
      WHERE oid IN ('public.businesses_public'::regclass, 'public.whatsapp_channels_public'::regclass) ORDER BY relname`);
    expect(before.rows).toEqual([
      { relname: 'businesses_public', reloptions: ['security_barrier=true'] },
      { relname: 'whatsapp_channels_public', reloptions: ['security_barrier=true'] },
    ]);
    columnsBefore = await viewColumns();
    aclBefore = await viewAcl();
    await q(m523);
  });

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('both views now run as the caller and keep security_barrier', async () => {
    const r = await q(`SELECT relname, reloptions FROM pg_class
      WHERE oid IN ('public.businesses_public'::regclass, 'public.whatsapp_channels_public'::regclass) ORDER BY relname`);
    for (const row of r.rows) {
      expect(row.reloptions).toEqual(expect.arrayContaining(['security_barrier=true', 'security_invoker=true']));
    }
    // Same query shape as Supabase lint 0010: no view in public without security_invoker.
    const lint = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'v'
        AND NOT coalesce('security_invoker=true' = ANY(c.reloptions), false)
        AND NOT coalesce('security_invoker=on' = ANY(c.reloptions), false)`);
    expect(lint.rows).toEqual([]);
  });

  it('keeps every view column name, type and order, and the same grants', async () => {
    expect(await viewColumns()).toEqual(columnsBefore);
    expect((columnsBefore as { relname: string; attname: string }[])
      .filter(c => c.relname === 'businesses_public').map(c => c.attname)).toEqual(BUSINESS_VIEW_COLUMNS);
    expect((columnsBefore as { relname: string; attname: string }[])
      .filter(c => c.relname === 'whatsapp_channels_public').map(c => c.attname)).toEqual(CHANNEL_VIEW_COLUMNS);
    expect(await viewAcl()).toEqual(aclBefore);
  });

  it('anon reads only active businesses through businesses_public', async () => {
    const rows = await as('anon', null, () => q(`SELECT slug FROM public.businesses_public ORDER BY slug`));
    expect(rows.rows.map(r => r.slug)).toEqual(['active-spa', 'other-barber']);
  });

  it('anon cannot select secret business columns through the view', async () => {
    for (const col of ['google_calendar_token', 'google_calendar_refresh_token', 'payment_channels', 'metadata', 'owner_id', 'custom_fee_percentage']) {
      const err = await as('anon', null, () => errorOf(() => q(`SELECT ${col} FROM public.businesses_public`)));
      expect(err.code, col).toBe('42703');
    }
  });

  it('anon still cannot read either base table directly', async () => {
    for (const table of ['public.businesses', 'public.whatsapp_channels']) {
      const err = await as('anon', null, () => errorOf(() => q(`SELECT id FROM ${table}`)));
      expect(err.code, table).toBe('42501');
    }
  });

  it('anon cannot call the helper functions to get anything beyond the view', async () => {
    // The functions return only the view columns and rows; there is nothing extra to reach.
    const fnCols = await q(`SELECT p.proname, array_to_string(p.proargnames, ',') AS cols FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public_view_private' ORDER BY p.proname`);
    expect(fnCols.rows).toEqual([
      { proname: 'businesses_public_rows', cols: BUSINESS_VIEW_COLUMNS.join(',') },
      { proname: 'whatsapp_channels_public_rows', cols: CHANNEL_VIEW_COLUMNS.join(',') },
    ]);
    const biz = await as('anon', null, () => q(`SELECT slug FROM public_view_private.businesses_public_rows() ORDER BY slug`));
    expect(biz.rows.map(r => r.slug)).toEqual(['active-spa', 'other-barber']);
    const err = await as('anon', null, () => errorOf(() => q(`SELECT meta_access_token FROM public_view_private.whatsapp_channels_public_rows()`)));
    expect(err.code).toBe('42703');
  });

  it('anon reads only active shared channels, never dedicated or inactive ones or tokens', async () => {
    const rows = await as('anon', null, () => q(`SELECT phone_number FROM public.whatsapp_channels_public ORDER BY phone_number`));
    expect(rows.rows.map(r => r.phone_number)).toEqual(['+15550001', '+23480001']);
    const err = await as('anon', null, () => errorOf(() => q(`SELECT meta_access_token FROM public.whatsapp_channels_public`)));
    expect(err.code).toBe('42703');
  });

  it('the public business page queries still work for anon (app/b/[slug], app/recurring/[slug])', async () => {
    await as('anon', null, async () => {
      const meta = await q(`SELECT name, description FROM public.businesses_public WHERE slug = $1`, ['active-spa']);
      expect(meta.rows).toEqual([{ name: 'Active Spa', description: 'Open' }]);
      const page = await q(`SELECT id, name, slug, logo_url, description, address, operating_hours, country_code
        FROM public.businesses_public WHERE slug = $1`, ['active-spa']);
      expect(page.rows).toEqual([{ id: BIZ_ACTIVE, name: 'Active Spa', slug: 'active-spa', logo_url: null,
        description: 'Open', address: '1 Main St', operating_hours: { mon: '9-5' }, country_code: 'NG' }]);
      const recurring = await q(`SELECT id, name, slug, category, country_code, recurring_enabled
        FROM public.businesses_public WHERE slug = $1`, ['active-spa']);
      expect(recurring.rows).toEqual([{ id: BIZ_ACTIVE, name: 'Active Spa', slug: 'active-spa', category: 'other',
        country_code: 'NG', recurring_enabled: true }]);
      const hidden = await q(`SELECT id FROM public.businesses_public WHERE slug IN ('pending-spa', 'suspended-spa')`);
      expect(hidden.rows).toEqual([]);
    });
  });

  it('a signed-in merchant still sees other active businesses and shared numbers (onboarding, QR, keyword pages)', async () => {
    await as('authenticated', OWNER_B, async () => {
      const page = await q(`SELECT name FROM public.businesses_public WHERE slug = $1`, ['active-spa']);
      expect(page.rows).toEqual([{ name: 'Active Spa' }]);
      // OnboardingWizard / keyword-campaigns: first active shared number for a country.
      const byCountry = await q(`SELECT phone_number FROM public.whatsapp_channels_public WHERE country_code = $1 LIMIT 1`, ['NG']);
      expect(byCountry.rows).toEqual([{ phone_number: '+23480001' }]);
      // qr-code: assigned shared channel by id.
      const byId = await q(`SELECT id FROM public.whatsapp_channels_public WHERE id = $1`, [CH_SHARED_US]);
      expect(byId.rows).toEqual([{ id: CH_SHARED_US }]);
      const dedicated = await q(`SELECT id FROM public.whatsapp_channels_public WHERE id = $1`, [CH_DEDICATED]);
      expect(dedicated.rows).toEqual([]);
      // Base-table access for this user is unchanged: own businesses only, no shared channels.
      const own = await q(`SELECT slug FROM public.businesses ORDER BY slug`);
      expect(own.rows.map(r => r.slug)).toEqual(['other-barber']);
      const sharedBase = await q(`SELECT id FROM public.whatsapp_channels WHERE channel_type = 'shared'`);
      expect(sharedBase.rows).toEqual([]);
    });
    // The owner of the dedicated channel still reads it from the base table.
    const own = await as('authenticated', OWNER_A, () => q(`SELECT id FROM public.whatsapp_channels`));
    expect(own.rows).toEqual([{ id: CH_DEDICATED }]);
  });

  it('service_role still reads both views', async () => {
    await as('service_role', null, async () => {
      expect((await q(`SELECT count(*)::int AS n FROM public.businesses_public`)).rows[0].n).toBe(2);
      expect((await q(`SELECT count(*)::int AS n FROM public.whatsapp_channels_public`)).rows[0].n).toBe(2);
    });
  });

  it('anon and authenticated cannot write through either view', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const sql of [
        `INSERT INTO public.businesses_public (id, name) VALUES (gen_random_uuid(), 'x')`,
        `UPDATE public.businesses_public SET name = 'x'`,
        `DELETE FROM public.businesses_public`,
        `INSERT INTO public.whatsapp_channels_public (id, phone_number) VALUES (gen_random_uuid(), '+1')`,
        `UPDATE public.whatsapp_channels_public SET phone_number = '+1'`,
        `DELETE FROM public.whatsapp_channels_public`,
      ]) {
        const err = await as(role, OWNER_A, () => errorOf(() => q(sql)));
        // 42501 = no write privilege; 55000 = the view is not updatable. Both refuse the write.
        expect(['42501', '55000'], `${role}: ${sql} → ${err.code}`).toContain(err.code);
      }
    }
    const counts = await q(`SELECT (SELECT count(*)::int FROM public.businesses) AS b, (SELECT count(*)::int FROM public.whatsapp_channels) AS c`);
    expect(counts.rows[0]).toEqual({ b: 4, c: 4 });
  });

  it('a role without grants can use neither the views, the schema nor the functions', async () => {
    for (const sql of [
      `SELECT id FROM public.businesses_public`,
      `SELECT id FROM public.whatsapp_channels_public`,
      `SELECT id FROM public_view_private.businesses_public_rows()`,
    ]) {
      const err = await as('m523_outsider', null, () => errorOf(() => q(sql)));
      expect(err.code, sql).toBe('42501');
    }
    const create = await as('anon', null, () => errorOf(() => q(`CREATE TABLE public_view_private.x (id int)`)));
    expect(create.code).toBe('42501');
  });

  it('helper functions are SECURITY DEFINER, STABLE, with an empty search_path and no PUBLIC execute', async () => {
    const r = await q(`SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig,
        (SELECT array_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text)
           FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS executors,
        EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_grant
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public_view_private' ORDER BY p.proname`);
    for (const row of r.rows) {
      expect(row).toMatchObject({ prosecdef: true, provolatile: 's', proconfig: ['search_path=""'], public_grant: false,
        executors: ['anon', 'authenticated', 'service_role'] });
    }
    expect(r.rows).toHaveLength(2);
  });

  it('is idempotent: a second whole-file application succeeds and changes nothing', async () => {
    const before = await viewColumns();
    await q(m523);
    expect(await viewColumns()).toEqual(before);
    expect(await viewAcl()).toEqual(aclBefore);
  });

  it('fails closed if anon has been given direct base-table read access', async () => {
    await q('BEGIN');
    try {
      await q(`GRANT SELECT (id) ON public.businesses TO anon`);
      const err = await errorOf(() => q(m523));
      expect(err.message).toContain('M523 self-check: anon can read a base table directly');
    } finally {
      await q('ROLLBACK');
    }
  });
});
