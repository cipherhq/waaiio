/**
 * M515 — server-only owner consent answers (profiles.consent_preferences,
 * #878 Bug 2, Owner decision 2026-11-04 Option A). Real PostgreSQL proof
 * (disposable local database, created and dropped by this file).
 *
 * The fixture is the live final state of public.profiles, read on 2026-11-04
 * (read-only) and identical on staging and production:
 *   - columns as live (no metadata, no consent_preferences);
 *   - table ACL: service_role ALL, anon and authenticated SELECT;
 *   - authenticated UPDATE only on (phone, email, first_name, last_name,
 *     last_login_at, updated_at) — the M353 named-column grants;
 *   - RLS on, with profiles_select_own / profiles_update_own and the admin
 *     policies (production's admin_select_profiles form);
 *   - service_role BYPASSRLS, as on Supabase.
 * M515 is applied from disk as one whole-file statement, as it will be hosted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M515 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m515 = readFileSync('supabase/migrations/515_profile_consent_preferences.sql', 'utf8');
const database = `m515_${randomUUID().replaceAll('-', '')}`;
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const CONSENT = { marketing_emails: true, analytics: false, ai_processing: true, consented_at: '2026-11-04T10:00:00.000Z' };

type DbError = { code?: string; message?: string };

suite('M515 profiles.consent_preferences (real PostgreSQL)', () => {
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
    // Supabase's service_role bypasses RLS; match it even if another suite created the role first.
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
      CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION public.is_admin_or_support() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT false $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

      CREATE TYPE user_role AS ENUM ('restaurant_owner', 'customer', 'admin');
      CREATE TABLE public.profiles (
        id UUID PRIMARY KEY,
        phone VARCHAR UNIQUE,
        email VARCHAR,
        first_name VARCHAR,
        last_name VARCHAR,
        avatar_url TEXT,
        role user_role DEFAULT 'restaurant_owner',
        notification_prefs JSONB,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        no_show_count INTEGER DEFAULT 0,
        preferred_response_language TEXT
      );
      ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "Admin inserts team profiles" ON public.profiles FOR INSERT WITH CHECK (is_admin());
      CREATE POLICY admin_select_profiles ON public.profiles FOR SELECT USING ((id = auth.uid()) OR is_admin_or_support());
      CREATE POLICY admin_update_profiles ON public.profiles FOR UPDATE USING ((id = auth.uid()) OR is_admin());
      CREATE POLICY profiles_select_own ON public.profiles FOR SELECT USING (id = auth.uid());
      CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());

      GRANT ALL ON TABLE public.profiles TO service_role;
      GRANT SELECT ON TABLE public.profiles TO anon, authenticated;
      GRANT UPDATE (phone, email, first_name, last_name, last_login_at, updated_at) ON TABLE public.profiles TO authenticated;
    `);
    await q(`INSERT INTO public.profiles (id, first_name) VALUES ($1, 'Ada'), ($2, 'Bola')`, [OWNER_A, OWNER_B]);
  }, 60000);

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('before 515: the column does not exist, so the consent read fails with 42703 (the #878 500)', async () => {
    const err = await errorOf(() => as('service_role', null, () => q(`SELECT consent_preferences FROM public.profiles WHERE id = $1`, [OWNER_A])));
    expect(err.code).toBe('42703');
  });

  it('applies 515 (self-check passes) and re-applies cleanly', async () => {
    await q(m515);
    await q(m515);
    const { rows: [col] } = await q(`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'consent_preferences'`);
    expect(col).toEqual({ data_type: 'jsonb', is_nullable: 'YES', column_default: null });
    const { rows: cons } = await q(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_consent_preferences_object_check'`);
    expect(cons).toHaveLength(1);
    expect(cons[0].def).toMatch(/jsonb_typeof\(consent_preferences\) = 'object'/);
    const { rows: [comment] } = await q(`SELECT col_description('public.profiles'::regclass, attnum) AS c FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass AND attname = 'consent_preferences'`);
    expect(comment.c).toMatch(/M515/);
    // Existing rows keep NULL (no backfill, no default).
    expect((await q(`SELECT count(*)::int AS n FROM public.profiles WHERE consent_preferences IS NOT NULL`)).rows[0].n).toBe(0);
  });

  it('M353 named-column grants, the table ACL and every RLS policy are unchanged', async () => {
    const { rows: [acl] } = await q(`SELECT relacl::text AS acl FROM pg_class WHERE oid = 'public.profiles'::regclass`);
    expect(acl.acl).toMatch(/service_role=arwdDxtm?\//); // m = MAINTAIN, PostgreSQL 17 only
    expect(acl.acl).toMatch(/anon=r\//);
    expect(acl.acl).toMatch(/authenticated=r\//);
    const { rows: writable } = await q(`
      SELECT attname FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass AND attnum > 0 AND NOT attisdropped
        AND has_column_privilege('authenticated', 'public.profiles', attname, 'UPDATE') ORDER BY attname`);
    expect(writable.map((r) => r.attname)).toEqual(['email', 'first_name', 'last_login_at', 'last_name', 'phone', 'updated_at']);
    const { rows: pols } = await q(`SELECT polname FROM pg_policy WHERE polrelid = 'public.profiles'::regclass ORDER BY polname`);
    expect(pols.map((r) => r.polname)).toEqual(['Admin inserts team profiles', 'admin_select_profiles', 'admin_update_profiles', 'profiles_select_own', 'profiles_update_own']);
  });

  it('rejects a non-object value (array, string, JSON null); SQL NULL is allowed', async () => {
    for (const bad of ['[]', '"yes"', '1', 'null']) {
      const err = await errorOf(() => q(`UPDATE public.profiles SET consent_preferences = $1::jsonb WHERE id = $2`, [bad, OWNER_A]));
      expect(err.code, bad).toBe('23514');
    }
    await q(`UPDATE public.profiles SET consent_preferences = NULL WHERE id = $1`, [OWNER_A]);
  });

  it('service_role can write, merge and read consent_preferences (the server route path)', async () => {
    await as('service_role', null, async () => {
      const { rows: [w] } = await q(
        `UPDATE public.profiles SET consent_preferences = $1::jsonb WHERE id = $2 RETURNING consent_preferences`,
        [JSON.stringify(CONSENT), OWNER_A],
      );
      expect(w.consent_preferences).toEqual(CONSENT);
      const { rows: [m] } = await q(
        `UPDATE public.profiles SET consent_preferences = consent_preferences || '{"terms_accepted_at":"2026-11-04T10:01:00.000Z"}'::jsonb WHERE id = $1 RETURNING consent_preferences`,
        [OWNER_A],
      );
      expect(m.consent_preferences).toEqual({ ...CONSENT, terms_accepted_at: '2026-11-04T10:01:00.000Z' });
      const { rows: [ins] } = await q(
        `INSERT INTO public.profiles (id, consent_preferences) VALUES ($1, '{"analytics":true}') RETURNING consent_preferences`,
        [randomUUID()],
      );
      expect(ins.consent_preferences).toEqual({ analytics: true });
    });
  });

  for (const role of ['authenticated', 'anon'] as const) {
    it(`${role} cannot UPDATE consent_preferences, even on its own row (42501)`, async () => {
      const err = await errorOf(() => as(role, OWNER_A, () =>
        q(`UPDATE public.profiles SET consent_preferences = '{"terms_accepted_at":"forged"}'::jsonb WHERE id = $1`, [OWNER_A])));
      expect(err.code).toBe('42501');
      expect(err.message).toMatch(/permission denied for table profiles/);
    });

    it(`${role} cannot INSERT a profile carrying consent_preferences (42501)`, async () => {
      const err = await errorOf(() => as(role, OWNER_A, () =>
        q(`INSERT INTO public.profiles (id, consent_preferences) VALUES ($1, '{}'::jsonb)`, [randomUUID()])));
      expect(err.code).toBe('42501');
    });
  }

  it('authenticated can still update its own first_name (M353 path unchanged)', async () => {
    await as('authenticated', OWNER_A, async () => {
      const { rowCount } = await q(`UPDATE public.profiles SET first_name = 'Adaeze' WHERE id = $1`, [OWNER_A]);
      expect(rowCount).toBe(1);
    });
  });

  it('authenticated reads its own consent_preferences but never another owner\'s; anon reads nothing', async () => {
    await q(`UPDATE public.profiles SET consent_preferences = $1::jsonb WHERE id = $2`, [JSON.stringify(CONSENT), OWNER_A]);
    await q(`UPDATE public.profiles SET consent_preferences = $1::jsonb WHERE id = $2`, [JSON.stringify({ analytics: true }), OWNER_B]);
    await as('authenticated', OWNER_A, async () => {
      const { rows } = await q(`SELECT id, consent_preferences FROM public.profiles ORDER BY id`);
      expect(rows.map((r) => r.id)).toEqual([OWNER_A]);
      expect(rows[0].consent_preferences).toEqual(CONSENT);
      const { rows: other } = await q(`SELECT consent_preferences FROM public.profiles WHERE id = $1`, [OWNER_B]);
      expect(other).toHaveLength(0);
    });
    await as('anon', null, async () => {
      expect((await q(`SELECT consent_preferences FROM public.profiles`)).rows).toHaveLength(0);
    });
  });

  it('re-run converges a stray column grant (REVOKE removes it)', async () => {
    await q(`GRANT INSERT (consent_preferences), UPDATE (consent_preferences) ON TABLE public.profiles TO authenticated`);
    await q(`GRANT UPDATE (consent_preferences) ON TABLE public.profiles TO PUBLIC`);
    await q(m515);
    const { rows: [p] } = await q(`SELECT
      has_column_privilege('authenticated', 'public.profiles', 'consent_preferences', 'UPDATE') AS au,
      has_column_privilege('authenticated', 'public.profiles', 'consent_preferences', 'INSERT') AS ai,
      has_column_privilege('anon', 'public.profiles', 'consent_preferences', 'UPDATE') AS nu`);
    expect(p).toEqual({ au: false, ai: false, nu: false });
  });

  for (const [label, grant, revoke] of [
    ['table-wide UPDATE for authenticated', 'GRANT UPDATE ON TABLE public.profiles TO authenticated', 'REVOKE UPDATE ON TABLE public.profiles FROM authenticated'],
    ['table-wide INSERT for PUBLIC (inherited by anon)', 'GRANT INSERT ON TABLE public.profiles TO PUBLIC', 'REVOKE INSERT ON TABLE public.profiles FROM PUBLIC'],
  ] as const) {
    it(`self-check fails the migration on ${label} (M515)`, async () => {
      await q(grant);
      try {
        const err = await errorOf(() => q(m515));
        expect(err.message).toMatch(/^M515: (anon|authenticated) must not have (INSERT|UPDATE) on profiles\.consent_preferences/);
      } finally {
        await q(revoke);
        // Restore M353's named-column grant, which a table-wide REVOKE leaves alone.
        await q(`GRANT UPDATE (phone, email, first_name, last_name, last_login_at, updated_at) ON TABLE public.profiles TO authenticated`);
      }
      await q(m515);
    });
  }
});
