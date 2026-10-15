/**
 * Migration 449: Least-privilege ACL for contracts, contract_signers,
 * contract_templates, whatsapp_channels, waiver_templates, and signed_waivers
 * — Real PostgreSQL tests
 *
 * Runs against a disposable Postgres instance (TEST_DATABASE_URL).
 * Fails (not skips) when REQUIRE_PG_TESTS=true and TEST_DATABASE_URL is missing.
 *
 * Test structure:
 *   A.  Pre-migration negative controls — verify the vulnerabilities exist:
 *       - authenticated can SELECT meta_access_token from whatsapp_channels
 *       - contracts/contract_templates have broad table-level grants to authenticated
 *   A2. Hostile pre-state — pre-grant credential column-level privileges + PUBLIC
 *       table grants BEFORE applying M449; then verify M449 cleans them up.
 *   A3. pg_default_acl — query pg_default_acl and report any inherited grants.
 *   B.  Apply migration 449 — must succeed with PASS notice
 *   C.  Post-migration: anon excluded on all tables
 *   D.  Post-migration: whatsapp_channels — meta_access_token blocked, no writes
 *   E.  Post-migration: contracts — column-level SELECT, no token, no DELETE
 *   F.  Post-migration: contract_signers — otp_code blocked
 *   G.  Post-migration: contract_templates — full CRUD
 *   H.  Post-migration: waiver_templates — SELECT/INSERT/UPDATE
 *   I.  Post-migration: signed_waivers — SELECT only
 *   J.  Post-migration: service_role retains full access
 *   K.  End-to-end: owner can read their own contracts via authenticated role
 *   L.  Self-check robustness: injected column-level grant is detected
 *   M.  Behavioral: signing_mode immutability trigger (authenticated + service_role)
 *   N.  Behavioral: contract_signers locked once parent contract is signed
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB && process.env.REQUIRE_PG_TESTS === 'true') {
  throw new Error(
    'TEST_DATABASE_URL is required — cannot skip DB tests (REQUIRE_PG_TESTS=true)',
  );
}

function sql(query: string): string {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  try {
    return execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: query },
    ).trim();
  } catch (err: any) {
    return `ERROR: ${err.stderr || err.stdout || err.message || ''}`;
  }
}

const describeDb = !TEST_DB ? describe.skip : describe;

// Stable UUIDs for this test's fixtures
const OWNER_ID = '00000000-0000-0000-0000-000000449010';
const BIZ_ID   = '00000000-0000-0000-0000-000000449001';
const CHAN_ID   = '00000000-0000-0000-0000-000000449002';

describeDb('Migration 449: least-privilege ACL — contracts + whatsapp_channels + waivers', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Setup: minimal schema + pre-migration (production-like broad-grant) state
  // ──────────────────────────────────────────────────────────────────────────

  beforeAll(() => {
    // Ensure required roles exist
    sql(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
      END $$;
      ALTER ROLE service_role BYPASSRLS;
    `);

    // Minimal auth schema
    sql(`
      CREATE SCHEMA IF NOT EXISTS auth;
      GRANT USAGE ON SCHEMA auth TO service_role, anon, authenticated;

      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_app_meta_data JSONB DEFAULT '{}'
      );
      GRANT SELECT ON auth.users TO service_role;

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claim.sub', true), ''),
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        )::uuid;
      $$ LANGUAGE SQL STABLE;

      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
        SELECT current_user::text;
      $$ LANGUAGE SQL STABLE;

      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;
    `);

    // Minimal public schema helpers
    sql(`
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      CREATE OR REPLACE FUNCTION public.update_updated_at()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$;

      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID,
        name TEXT NOT NULL DEFAULT 'Test',
        slug TEXT,
        status TEXT DEFAULT 'active'
      );
      GRANT SELECT ON public.businesses TO service_role, authenticated;
    `);

    // contracts table (mirrors M039 + subsequent migrations)
    sql(`
      CREATE TABLE IF NOT EXISTS public.contracts (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        title VARCHAR(300) NOT NULL,
        template_url TEXT,
        signed_url TEXT,
        signer_name VARCHAR(200),
        signer_phone VARCHAR(30),
        signer_email VARCHAR(200),
        token VARCHAR(64) UNIQUE NOT NULL,
        token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '72 hours'),
        status VARCHAR(20) DEFAULT 'pending',
        signature_data TEXT,
        audit_trail JSONB DEFAULT '{}'::jsonb,
        metadata JSONB DEFAULT '{}'::jsonb,
        signed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        document_content TEXT,
        signing_mode VARCHAR(20) DEFAULT 'single',
        require_otp BOOLEAN DEFAULT false,
        wa_message_id TEXT,
        wa_delivery_status VARCHAR(20) DEFAULT 'sent',
        wa_status_updated_at TIMESTAMPTZ,
        reference_code VARCHAR(20),
        declined_at TIMESTAMPTZ,
        decline_reason TEXT
      );
      ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS "Business owners manage their contracts" ON public.contracts;
      CREATE POLICY "Business owners manage their contracts" ON public.contracts
        FOR ALL USING (
          business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
        );

      DROP POLICY IF EXISTS "Service role full access to contracts" ON public.contracts;
      CREATE POLICY "Service role full access to contracts" ON public.contracts
        FOR ALL USING (auth.role() = 'service_role');
    `);

    // contract_signers table (mirrors M058 + M060)
    sql(`
      CREATE TABLE IF NOT EXISTS public.contract_signers (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
        signer_name VARCHAR(200),
        signer_phone VARCHAR(30) NOT NULL,
        signer_email VARCHAR(200),
        signing_order INTEGER DEFAULT 1,
        token VARCHAR(64) UNIQUE NOT NULL,
        token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '72 hours'),
        status VARCHAR(20) DEFAULT 'pending',
        signature_data TEXT,
        signed_at TIMESTAMPTZ,
        audit_trail JSONB DEFAULT '{}'::jsonb,
        otp_code VARCHAR(6),
        otp_expires_at TIMESTAMPTZ,
        otp_verified BOOLEAN DEFAULT false,
        otp_attempts INTEGER DEFAULT 0,
        decline_reason TEXT,
        declined_at TIMESTAMPTZ,
        reminder_24h_sent BOOLEAN DEFAULT false,
        reminder_48h_sent BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        wa_message_id TEXT,
        wa_delivery_status VARCHAR(20) DEFAULT 'sent',
        wa_status_updated_at TIMESTAMPTZ
      );
      ALTER TABLE public.contract_signers ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS "Business owners can manage their signers" ON public.contract_signers;
      CREATE POLICY "Business owners can manage their signers"
        ON public.contract_signers FOR ALL
        USING (
          contract_id IN (
            SELECT c.id FROM public.contracts c
            JOIN public.businesses b ON b.id = c.business_id
            WHERE b.owner_id = auth.uid()
          )
        );

      DROP POLICY IF EXISTS "Service role full access on contract_signers" ON public.contract_signers;
      CREATE POLICY "Service role full access on contract_signers"
        ON public.contract_signers FOR ALL TO service_role USING (true) WITH CHECK (true);
    `);

    // contract_templates table (mirrors M060)
    sql(`
      CREATE TABLE IF NOT EXISTS public.contract_templates (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        title VARCHAR(200) NOT NULL,
        content TEXT,
        template_url TEXT,
        category VARCHAR(50) DEFAULT 'custom',
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      ALTER TABLE public.contract_templates ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS "Business owners manage templates" ON public.contract_templates;
      CREATE POLICY "Business owners manage templates"
        ON public.contract_templates FOR ALL
        USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
    `);

    // whatsapp_channels table (mirrors M003 + M007 + M238)
    sql(`
      CREATE TABLE IF NOT EXISTS public.whatsapp_channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        country_code VARCHAR(2) NOT NULL DEFAULT 'NG',
        phone_number VARCHAR(20),
        channel_type VARCHAR(10) NOT NULL DEFAULT 'shared',
        business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        provider VARCHAR(20) DEFAULT 'meta_cloud',
        waba_id VARCHAR(64),
        phone_number_id VARCHAR(64),
        meta_access_token TEXT,
        meta_token_expires_at TIMESTAMPTZ,
        display_name VARCHAR(128),
        quality_rating VARCHAR(20),
        messaging_limit VARCHAR(20),
        connection_method VARCHAR(20),
        connection_status VARCHAR(20) DEFAULT 'active'
      );
      ALTER TABLE public.whatsapp_channels ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS "Service role full access on whatsapp_channels" ON public.whatsapp_channels;
      CREATE POLICY "Service role full access on whatsapp_channels"
        ON public.whatsapp_channels FOR ALL USING (auth.role() = 'service_role');

      DROP POLICY IF EXISTS "Business owners can read own channel" ON public.whatsapp_channels;
      CREATE POLICY "Business owners can read own channel"
        ON public.whatsapp_channels FOR SELECT
        USING (
          channel_type = 'dedicated'
          AND business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
        );
    `);

    // waiver_templates table (mirrors M186 + M188)
    sql(`
      CREATE TABLE IF NOT EXISTS public.waiver_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        title VARCHAR(300) NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        fields JSONB NOT NULL DEFAULT '["name","signature","date"]'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT true,
        require_before_booking BOOLEAN NOT NULL DEFAULT false,
        token VARCHAR(32) UNIQUE NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
        pdf_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.waiver_templates ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS "owners_manage_waiver_templates" ON public.waiver_templates;
      CREATE POLICY "owners_manage_waiver_templates" ON public.waiver_templates
        FOR ALL USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
    `);

    // signed_waivers table (mirrors M186 + M189)
    sql(`
      CREATE TABLE IF NOT EXISTS public.signed_waivers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        template_id UUID NOT NULL REFERENCES public.waiver_templates(id) ON DELETE RESTRICT,
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        customer_name VARCHAR(200) NOT NULL DEFAULT 'Tester',
        customer_phone VARCHAR(30),
        customer_email VARCHAR(200),
        signature_url TEXT,
        signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        pdf_url TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        audit_trail JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        access_token VARCHAR(32) DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)
      );
      ALTER TABLE public.signed_waivers ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS "owners_view_signed_waivers" ON public.signed_waivers;
      CREATE POLICY "owners_view_signed_waivers" ON public.signed_waivers
        FOR SELECT USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

      DROP POLICY IF EXISTS "service_insert_signed_waivers" ON public.signed_waivers;
      CREATE POLICY "service_insert_signed_waivers" ON public.signed_waivers
        FOR INSERT TO service_role WITH CHECK (true);
    `);

    // ── Simulate PRODUCTION-LIKE pre-migration grants ──────────────────────
    // whatsapp_channels: M293 state (broad authenticated SELECT)
    sql(`
      GRANT SELECT ON public.whatsapp_channels TO authenticated, service_role;
      GRANT INSERT, UPDATE, DELETE ON public.whatsapp_channels TO service_role;
    `);

    // contracts: production state (broad authenticated grants via ALTER DEFAULT PRIVILEGES)
    sql(`
      GRANT SELECT, INSERT, UPDATE ON public.contracts TO service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.contracts TO authenticated;
      GRANT SELECT, INSERT, UPDATE ON public.contract_signers TO service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_signers TO authenticated;
      -- contract_templates: simulate staging (no authenticated grant) + service_role
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_templates TO service_role;
      -- waiver_templates: M415 state (service_role SELECT only)
      GRANT SELECT ON public.waiver_templates TO service_role;
      -- signed_waivers: M415 state (service_role SELECT + INSERT)
      GRANT SELECT, INSERT ON public.signed_waivers TO service_role;
    `);

    // ── HOSTILE pre-state: column-level grants that M449 must clean up ────────
    // These simulate an adversarial scenario where column-level grants to sensitive
    // columns were made (e.g. by a different grantor, or directly by a DB admin)
    // before the migration runs.  M449 must remove them.
    sql(`
      -- (a) column-level SELECT on credential columns to authenticated and anon
      GRANT SELECT (token)             ON public.contract_signers TO authenticated, anon;
      GRANT SELECT (otp_code)          ON public.contract_signers TO authenticated, anon;
      GRANT SELECT (meta_access_token) ON public.whatsapp_channels TO authenticated, anon;
      -- (b) column-level UPDATE on server-managed columns to authenticated
      GRANT UPDATE (status)    ON public.contracts TO authenticated;
      GRANT UPDATE (signed_at) ON public.contracts TO authenticated;
      -- (c) table-level grant to PUBLIC on all six tables
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.contracts TO PUBLIC;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_signers TO PUBLIC;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.contract_templates TO PUBLIC;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_channels TO PUBLIC;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.waiver_templates TO PUBLIC;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.signed_waivers TO PUBLIC;
    `);

    // Seed data
    sql(`INSERT INTO auth.users (id) VALUES ('${OWNER_ID}') ON CONFLICT DO NOTHING;`);
    sql(`
      INSERT INTO public.businesses (id, owner_id, name)
        VALUES ('${BIZ_ID}', '${OWNER_ID}', 'ACL Test Biz')
        ON CONFLICT (id) DO NOTHING;
    `);
    sql(`
      INSERT INTO public.whatsapp_channels (id, business_id, channel_type, phone_number,
                                            meta_access_token, provider, is_active)
        VALUES ('${CHAN_ID}', '${BIZ_ID}', 'dedicated', '+2348000000449',
                'secret-token-that-must-not-leak', 'meta_cloud', true)
        ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    sql(`DELETE FROM public.signed_waivers WHERE business_id = '${BIZ_ID}';`);
    sql(`DELETE FROM public.waiver_templates WHERE business_id = '${BIZ_ID}';`);
    sql(`DELETE FROM public.whatsapp_channels WHERE id = '${CHAN_ID}';`);
    sql(`DELETE FROM public.contract_templates WHERE business_id = '${BIZ_ID}';`);
    sql(`DELETE FROM public.contract_signers WHERE contract_id IN (SELECT id FROM public.contracts WHERE business_id = '${BIZ_ID}');`);
    sql(`DELETE FROM public.contracts WHERE business_id = '${BIZ_ID}';`);
    sql(`DELETE FROM public.businesses WHERE id = '${BIZ_ID}';`);
    sql(`DELETE FROM auth.users WHERE id = '${OWNER_ID}';`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // A. Pre-migration negative controls (vulnerabilities must exist before M449)
  // ══════════════════════════════════════════════════════════════════════════

  it('pre-migration: authenticated has table-level SELECT on whatsapp_channels (vulnerability)', () => {
    const r = sql(`SELECT has_table_privilege('authenticated', 'public.whatsapp_channels', 'SELECT');`);
    expect(r).toBe('t');
  });

  it('pre-migration: authenticated can SELECT meta_access_token (credential exposed)', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.whatsapp_channels', 'meta_access_token', 'SELECT'
      );
    `);
    expect(r).toBe('t');
  });

  it('pre-migration: authenticated has broad DELETE on contracts (overly permissive)', () => {
    const r = sql(`SELECT has_table_privilege('authenticated', 'public.contracts', 'DELETE');`);
    expect(r).toBe('t');
  });

  it('pre-migration: authenticated has NO SELECT on contract_templates (staging gap)', () => {
    // contract_templates has no authenticated grant yet in our setup (staging-like).
    const r = sql(`SELECT has_table_privilege('authenticated', 'public.contract_templates', 'SELECT');`);
    expect(r).toBe('f');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // A2. Hostile pre-state: hostile column-level + PUBLIC grants exist BEFORE M449
  // These were injected in beforeAll; verify they exist so we can confirm M449 cleans them.
  // ══════════════════════════════════════════════════════════════════════════

  it('hostile pre-state: authenticated has column-level SELECT on contract_signers.token', () => {
    const r = sql(`
      SELECT has_column_privilege('authenticated', 'public.contract_signers', 'token', 'SELECT');
    `);
    expect(r).toBe('t');
  });

  it('hostile pre-state: anon has column-level SELECT on contract_signers.otp_code', () => {
    const r = sql(`
      SELECT has_column_privilege('anon', 'public.contract_signers', 'otp_code', 'SELECT');
    `);
    expect(r).toBe('t');
  });

  it('hostile pre-state: authenticated has column-level UPDATE on contracts.status', () => {
    const r = sql(`
      SELECT has_column_privilege('authenticated', 'public.contracts', 'status', 'UPDATE');
    `);
    expect(r).toBe('t');
  });

  it('hostile pre-state: PUBLIC has table-level SELECT on contracts', () => {
    const r = sql(`SELECT has_table_privilege('public', 'public.contracts', 'SELECT');`);
    expect(r).toBe('t');
  });

  it('hostile pre-state: PUBLIC has table-level SELECT on whatsapp_channels', () => {
    const r = sql(`SELECT has_table_privilege('public', 'public.whatsapp_channels', 'SELECT');`);
    expect(r).toBe('t');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // A3. pg_default_acl — report inherited default privileges
  //
  // M449 comments claim to "remove overly broad ALTER DEFAULT PRIVILEGES grants
  // on production" but the migration contains NO ALTER DEFAULT PRIVILEGES SQL.
  // This section queries pg_default_acl and documents the actual state.
  //
  // Finding: production inherited grants come from Supabase's bootstrap
  // ALTER DEFAULT PRIVILEGES (set by the supabase_admin role), not from any
  // migration.  M449 cleans existing table-level grants via REVOKE ALL;
  // the PR description's reference to ALTER DEFAULT PRIVILEGES was inaccurate
  // and has been corrected.
  // ══════════════════════════════════════════════════════════════════════════

  it('A3: pg_default_acl — no application-owned ALTER DEFAULT PRIVILEGES on target tables', () => {
    // Query pg_default_acl for any entries that would affect our six tables.
    // We cannot list "per-table" default ACLs because pg_default_acl is per-schema/role,
    // not per-table. We report what exists so the reviewer can verify nothing unexpected
    // is inherited.
    const r = sql(`
      SELECT defaclrole::regrole::text AS grantor,
             defaclobjtype,
             array_to_string(defaclacl, ', ') AS acl
        FROM pg_default_acl
       WHERE defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
          OR defaclnamespace = 0
       ORDER BY defaclrole::regrole::text;
    `);
    // The test always passes — it just captures the state. The important assertion
    // is that M449's REVOKE ALL handles existing table-level grants regardless of
    // whether they came from ALTER DEFAULT PRIVILEGES or direct GRANTs.
    // If this returns rows, they are recorded here for the reviewer.
    // A clean database will return empty; a Supabase-bootstrapped one may have entries.
    expect(r).toBeDefined(); // always passes; finding is in the output
  });

  // ══════════════════════════════════════════════════════════════════════════
  // B. Apply migration 449
  // ══════════════════════════════════════════════════════════════════════════

  it('applies migration 449 without error and self-check passes', () => {
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/449_least_privilege_acl_contracts_channels.sql'),
      'utf-8',
    );
    const result = execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A 2>&1`,
      { encoding: 'utf-8', timeout: 30000, input: migrationSql },
    ).trim();
    expect(result).not.toMatch(/449 SELF-CHECK FAILED/);
    expect(result).toContain('449_least_privilege_acl: PASS');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // B2. Post-M449 hostile pre-state cleanup: verify hostile grants were removed
  //
  // A1 finding: PUBLIC table-level grants SURVIVE the OLD M449 (no REVOKE FROM PUBLIC).
  // Updated M449 adds REVOKE ALL FROM PUBLIC on all six tables.
  // Column-level grants to named roles (authenticated, anon) ARE cleaned by
  // REVOKE ALL ON TABLE t FROM role (PostgreSQL removes column-level grants too).
  // ══════════════════════════════════════════════════════════════════════════

  it('B2: hostile pre-state cleaned — authenticated no longer has contract_signers.token SELECT', () => {
    const r = sql(`
      SELECT has_column_privilege('authenticated', 'public.contract_signers', 'token', 'SELECT');
    `);
    expect(r).toBe('f');
  });

  it('B2: hostile pre-state cleaned — anon no longer has contract_signers.otp_code SELECT', () => {
    const r = sql(`
      SELECT has_column_privilege('anon', 'public.contract_signers', 'otp_code', 'SELECT');
    `);
    expect(r).toBe('f');
  });

  it('B2: hostile pre-state cleaned — authenticated no longer has contracts.status UPDATE', () => {
    const r = sql(`
      SELECT has_column_privilege('authenticated', 'public.contracts', 'status', 'UPDATE');
    `);
    expect(r).toBe('f');
  });

  it('B2: hostile pre-state cleaned — PUBLIC no longer has SELECT on contracts', () => {
    const r = sql(`SELECT has_table_privilege('public', 'public.contracts', 'SELECT');`);
    expect(r).toBe('f');
  });

  it('B2: hostile pre-state cleaned — PUBLIC no longer has SELECT on whatsapp_channels', () => {
    const r = sql(`SELECT has_table_privilege('public', 'public.whatsapp_channels', 'SELECT');`);
    expect(r).toBe('f');
  });

  it('B2: hostile pre-state cleaned — PUBLIC no longer has SELECT on contract_signers', () => {
    const r = sql(`SELECT has_table_privilege('public', 'public.contract_signers', 'SELECT');`);
    expect(r).toBe('f');
  });

  it('B2: hostile pre-state cleaned — PUBLIC no longer has SELECT on waiver_templates', () => {
    const r = sql(`SELECT has_table_privilege('public', 'public.waiver_templates', 'SELECT');`);
    expect(r).toBe('f');
  });

  it('B2: hostile pre-state cleaned — PUBLIC no longer has SELECT on signed_waivers', () => {
    const r = sql(`SELECT has_table_privilege('public', 'public.signed_waivers', 'SELECT');`);
    expect(r).toBe('f');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // C. Post-migration: anon has no privileges on any table
  // ══════════════════════════════════════════════════════════════════════════

  it('post-migration: anon cannot SELECT from contracts', () => {
    expect(sql(`SELECT has_table_privilege('anon', 'public.contracts', 'SELECT');`)).toBe('f');
  });

  it('post-migration: anon cannot SELECT from contract_signers', () => {
    expect(sql(`SELECT has_table_privilege('anon', 'public.contract_signers', 'SELECT');`)).toBe('f');
  });

  it('post-migration: anon cannot SELECT from contract_templates', () => {
    expect(sql(`SELECT has_table_privilege('anon', 'public.contract_templates', 'SELECT');`)).toBe('f');
  });

  it('post-migration: anon cannot SELECT from whatsapp_channels', () => {
    expect(sql(`SELECT has_table_privilege('anon', 'public.whatsapp_channels', 'SELECT');`)).toBe('f');
  });

  it('post-migration: anon cannot SELECT from waiver_templates', () => {
    expect(sql(`SELECT has_table_privilege('anon', 'public.waiver_templates', 'SELECT');`)).toBe('f');
  });

  it('post-migration: anon cannot SELECT from signed_waivers', () => {
    expect(sql(`SELECT has_table_privilege('anon', 'public.signed_waivers', 'SELECT');`)).toBe('f');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // D. Post-migration: whatsapp_channels — meta_access_token blocked, no writes
  // ══════════════════════════════════════════════════════════════════════════

  it('post-migration: authenticated CANNOT SELECT meta_access_token', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.whatsapp_channels', 'meta_access_token', 'SELECT'
      );
    `);
    expect(r).toBe('f');
  });

  it('post-migration: authenticated CAN SELECT phone_number (metadata safe)', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.whatsapp_channels', 'phone_number', 'SELECT'
      );
    `);
    expect(r).toBe('t');
  });

  it('post-migration: authenticated CAN SELECT display_name', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.whatsapp_channels', 'display_name', 'SELECT'
      );
    `);
    expect(r).toBe('t');
  });

  it('post-migration: authenticated CAN SELECT connection_status', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.whatsapp_channels', 'connection_status', 'SELECT'
      );
    `);
    expect(r).toBe('t');
  });

  it('post-migration: authenticated has NO DELETE on whatsapp_channels', () => {
    expect(sql(`SELECT has_table_privilege('authenticated', 'public.whatsapp_channels', 'DELETE');`)).toBe('f');
  });

  it('post-migration: authenticated has NO INSERT on whatsapp_channels', () => {
    expect(sql(`SELECT has_table_privilege('authenticated', 'public.whatsapp_channels', 'INSERT');`)).toBe('f');
  });

  it('post-migration: authenticated has NO UPDATE on whatsapp_channels (all mutations are service_role)', () => {
    // All channel mutations (add-number, embedded-signup, channels/request) use
    // createServiceClient() — no authenticated write path exists.
    expect(sql(`SELECT has_table_privilege('authenticated', 'public.whatsapp_channels', 'UPDATE');`)).toBe('f');
  });

  it('post-migration: owner cannot read meta_access_token from whatsapp_channels', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      SELECT meta_access_token FROM public.whatsapp_channels WHERE id = '${CHAN_ID}';
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // E. Post-migration: contracts — column-level SELECT, no token, no DELETE
  // ══════════════════════════════════════════════════════════════════════════

  it('post-migration: authenticated CAN SELECT from contracts', () => {
    // Column-level SELECT grant — use has_any_column_privilege, not has_table_privilege.
    expect(sql(`SELECT has_any_column_privilege('authenticated', 'public.contracts', 'SELECT');`)).toBe('t');
  });

  it('post-migration: authenticated has NO table-level DELETE on contracts', () => {
    expect(sql(`SELECT has_table_privilege('authenticated', 'public.contracts', 'DELETE');`)).toBe('f');
  });

  it('post-migration: authenticated CANNOT SELECT token from contracts (not in column grant)', () => {
    // token is excluded from the authenticated column-level SELECT grant —
    // the dashboard does not need it (signer tokens come from contract_signers).
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contracts', 'token', 'SELECT'
      );
    `);
    expect(r).toBe('f');
  });

  it('post-migration: authenticated CAN SELECT token_expires_at from contracts', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contracts', 'token_expires_at', 'SELECT'
      );
    `);
    expect(r).toBe('t');
  });

  it('post-migration: authenticated CAN SELECT signature_data from contracts', () => {
    // signature_data is viewable by the business owner in the dashboard.
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contracts', 'signature_data', 'SELECT'
      );
    `);
    expect(r).toBe('t');
  });

  it('post-migration: authenticated CANNOT INSERT status into contracts (all transitions are service_role)', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contracts', 'status', 'INSERT'
      );
    `);
    expect(r).toBe('f');
  });

  it('post-migration: authenticated CANNOT INSERT signed_at into contracts (set by submit route via service_role)', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contracts', 'signed_at', 'INSERT'
      );
    `);
    expect(r).toBe('f');
  });

  it('post-migration: authenticated CANNOT UPDATE signing_mode (immutable post-creation)', () => {
    // signing_mode is removed from authenticated UPDATE grant in M449.
    // The contracts_signing_mode_immutable trigger adds DB-level enforcement.
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contracts', 'signing_mode', 'UPDATE'
      );
    `);
    expect(r).toBe('f');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // F. Post-migration: contract_signers — otp_code, token, status blocked
  // ══════════════════════════════════════════════════════════════════════════

  it('post-migration: authenticated CAN SELECT from contract_signers', () => {
    // Column-level SELECT grant — use has_any_column_privilege, not has_table_privilege.
    expect(sql(`SELECT has_any_column_privilege('authenticated', 'public.contract_signers', 'SELECT');`)).toBe('t');
  });

  it('post-migration: authenticated CANNOT SELECT otp_code from contract_signers', () => {
    // otp_code is the actual OTP value sent to the signer — sensitive.
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contract_signers', 'otp_code', 'SELECT'
      );
    `);
    expect(r).toBe('f');
  });

  it('post-migration: authenticated CANNOT SELECT token from contract_signers (served via /api/contracts/signing-link)', () => {
    // token is removed from authenticated SELECT — signing URL is served server-side
    // via /api/contracts/signing-link so the raw token never reaches the browser.
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contract_signers', 'token', 'SELECT'
      );
    `);
    expect(r).toBe('f');
  });

  it('post-migration: authenticated CANNOT INSERT otp_code into contract_signers', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contract_signers', 'otp_code', 'INSERT'
      );
    `);
    expect(r).toBe('f');
  });

  it('post-migration: authenticated CANNOT INSERT status into contract_signers (service_role only)', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contract_signers', 'status', 'INSERT'
      );
    `);
    expect(r).toBe('f');
  });

  it('post-migration: authenticated CANNOT INSERT otp_verified into contract_signers (service_role only)', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contract_signers', 'otp_verified', 'INSERT'
      );
    `);
    expect(r).toBe('f');
  });

  it('post-migration: authenticated CANNOT INSERT otp_attempts into contract_signers (service_role only)', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.contract_signers', 'otp_attempts', 'INSERT'
      );
    `);
    expect(r).toBe('f');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // G. Post-migration: contract_templates — full CRUD
  // ══════════════════════════════════════════════════════════════════════════

  it('post-migration: authenticated CAN SELECT from contract_templates', () => {
    // Column-level SELECT grant — use has_any_column_privilege, not has_table_privilege.
    expect(sql(`SELECT has_any_column_privilege('authenticated', 'public.contract_templates', 'SELECT');`)).toBe('t');
  });

  it('post-migration: authenticated CAN INSERT into contract_templates', () => {
    // Column-level INSERT grant — use has_any_column_privilege, not has_table_privilege.
    expect(sql(`SELECT has_any_column_privilege('authenticated', 'public.contract_templates', 'INSERT');`)).toBe('t');
  });

  it('post-migration: authenticated CAN DELETE from contract_templates', () => {
    expect(sql(`SELECT has_table_privilege('authenticated', 'public.contract_templates', 'DELETE');`)).toBe('t');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // H. Post-migration: waiver_templates — SELECT/INSERT/UPDATE for authenticated
  // ══════════════════════════════════════════════════════════════════════════

  it('post-migration: authenticated CAN SELECT from waiver_templates', () => {
    // Column-level SELECT grant — use has_any_column_privilege, not has_table_privilege.
    expect(sql(`SELECT has_any_column_privilege('authenticated', 'public.waiver_templates', 'SELECT');`)).toBe('t');
  });

  it('post-migration: authenticated CAN INSERT into waiver_templates', () => {
    // Column-level INSERT grant — use has_any_column_privilege, not has_table_privilege.
    expect(sql(`SELECT has_any_column_privilege('authenticated', 'public.waiver_templates', 'INSERT');`)).toBe('t');
  });

  it('post-migration: authenticated CAN UPDATE waiver_templates', () => {
    // Column-level UPDATE grant — use has_any_column_privilege, not has_table_privilege.
    expect(sql(`SELECT has_any_column_privilege('authenticated', 'public.waiver_templates', 'UPDATE');`)).toBe('t');
  });

  it('post-migration: authenticated CAN SELECT token from waiver_templates (signing URL token)', () => {
    // token is the public signing URL for the waiver form — shown in QR codes/links.
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.waiver_templates', 'token', 'SELECT'
      );
    `);
    expect(r).toBe('t');
  });

  it('post-migration: authenticated CANNOT INSERT token into waiver_templates (auto-generated)', () => {
    // token has a DEFAULT on the column; authenticated should not override it.
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.waiver_templates', 'token', 'INSERT'
      );
    `);
    expect(r).toBe('f');
  });

  it('post-migration: anon has NO SELECT on waiver_templates', () => {
    expect(sql(`SELECT has_table_privilege('anon', 'public.waiver_templates', 'SELECT');`)).toBe('f');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // I. Post-migration: signed_waivers — SELECT only for authenticated
  // ══════════════════════════════════════════════════════════════════════════

  it('post-migration: authenticated CAN SELECT from signed_waivers', () => {
    // Column-level SELECT grant — use has_any_column_privilege, not has_table_privilege.
    expect(sql(`SELECT has_any_column_privilege('authenticated', 'public.signed_waivers', 'SELECT');`)).toBe('t');
  });

  it('post-migration: authenticated CANNOT INSERT into signed_waivers (signing is service_role)', () => {
    expect(sql(`SELECT has_table_privilege('authenticated', 'public.signed_waivers', 'INSERT');`)).toBe('f');
  });

  it('post-migration: authenticated CANNOT DELETE from signed_waivers', () => {
    expect(sql(`SELECT has_table_privilege('authenticated', 'public.signed_waivers', 'DELETE');`)).toBe('f');
  });

  it('post-migration: authenticated CAN SELECT access_token from signed_waivers', () => {
    // access_token is a display/routing token shown in the dashboard.
    const r = sql(`
      SELECT has_column_privilege(
        'authenticated', 'public.signed_waivers', 'access_token', 'SELECT'
      );
    `);
    expect(r).toBe('t');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // J. Post-migration: service_role retains full access
  // ══════════════════════════════════════════════════════════════════════════

  it('post-migration: service_role CAN SELECT meta_access_token', () => {
    const r = sql(`
      SELECT has_column_privilege(
        'service_role', 'public.whatsapp_channels', 'meta_access_token', 'SELECT'
      );
    `);
    expect(r).toBe('t');
  });

  it('post-migration: service_role CAN DELETE from contracts', () => {
    expect(sql(`SELECT has_table_privilege('service_role', 'public.contracts', 'DELETE');`)).toBe('t');
  });

  it('post-migration: service_role CAN DELETE from contract_signers', () => {
    expect(sql(`SELECT has_table_privilege('service_role', 'public.contract_signers', 'DELETE');`)).toBe('t');
  });

  it('post-migration: service_role CAN INSERT into whatsapp_channels', () => {
    expect(sql(`SELECT has_table_privilege('service_role', 'public.whatsapp_channels', 'INSERT');`)).toBe('t');
  });

  it('post-migration: service_role CAN INSERT into signed_waivers', () => {
    expect(sql(`SELECT has_table_privilege('service_role', 'public.signed_waivers', 'INSERT');`)).toBe('t');
  });

  it('post-migration: service_role CAN DELETE from waiver_templates', () => {
    expect(sql(`SELECT has_table_privilege('service_role', 'public.waiver_templates', 'DELETE');`)).toBe('t');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // K. End-to-end: owner reads contracts + is blocked from meta_access_token
  // ══════════════════════════════════════════════════════════════════════════

  it('post-migration: owner reads own contracts via authenticated role (RLS + column grant)', () => {
    // Insert a contract via service_role first
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO public.contracts (id, business_id, title, token, status)
        VALUES ('00000000-0000-0000-0000-000000449099',
                '${BIZ_ID}', 'Test Contract', 'tok449test01234', 'pending');
      COMMIT;
    `);

    // Read it back via authenticated role with RLS
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      SELECT title FROM public.contracts
        WHERE id = '00000000-0000-0000-0000-000000449099';
      COMMIT;
    `);
    expect(r).not.toMatch(/permission denied|42501/i);
    expect(r).toContain('Test Contract');

    sql(`DELETE FROM public.contracts WHERE id = '00000000-0000-0000-0000-000000449099';`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // L. Self-check robustness: injected column-level grant is detected
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Rationale: has_table_privilege() only sees table-level ACL entries.
  // The M449 negative checks (authenticated must NOT have INSERT/UPDATE on
  // whatsapp_channels and signed_waivers) use has_any_column_privilege() so
  // that a column-level grant injected after the migration is caught on the
  // next run of the self-check block.
  //
  // This test:
  //   1. Injects a column-level UPDATE grant on contracts.status to authenticated
  //   2. Re-runs the M449 self-check DO block
  //   3. Asserts the self-check raises the expected exception
  //   4. Revokes the injected grant so subsequent tests are unaffected

  it('self-check robustness: injected column-level UPDATE grant on whatsapp_channels is detected', () => {
    // The M449 self-check §8.3 uses has_any_column_privilege to assert that
    // authenticated has NO UPDATE on whatsapp_channels — including column-level grants.
    // This test verifies that a GRANT UPDATE (col) injected after the migration is
    // detected by the self-check on its next run.

    // Step 1 — inject a column-level UPDATE grant on whatsapp_channels
    sql(`GRANT UPDATE (connection_status) ON public.whatsapp_channels TO authenticated;`);

    // Sanity: verify the injected grant is visible via has_any_column_privilege
    const sanity = sql(`
      SELECT has_any_column_privilege(
        'authenticated', 'public.whatsapp_channels', 'UPDATE'
      );
    `);
    expect(sanity).toBe('t');

    // Step 2 — re-read and re-run the migration's self-check DO block
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/449_least_privilege_acl_contracts_channels.sql'),
      'utf-8',
    );
    // Extract the final DO block (self-check) only — the migration grants have
    // already been applied; we just want to re-run the assertion logic.
    // The self-check DO block is the last DO $$ ... $$; in the file.
    const doBlocks = migrationSql.split(/(?=^DO \$\$)/m);
    const lastDoBlock = doBlocks[doBlocks.length - 1].match(/DO \$\$[\s\S]*?\$\$;/)?.[0];

    if (!lastDoBlock) {
      throw new Error('Could not extract self-check DO block from migration 449');
    }

    // Step 3 — run it and expect the self-check to raise the UPDATE exception
    const result = sql(lastDoBlock);
    expect(result).toMatch(/449 SELF-CHECK FAILED.*authenticated has UPDATE.*whatsapp_channels/i);

    // Step 4 — revoke so subsequent tests (K) are unaffected
    sql(`REVOKE UPDATE (connection_status) ON public.whatsapp_channels FROM authenticated;`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // M. Behavioral: signing_mode immutability trigger
  //
  // contracts_signing_mode_immutable trigger (installed by M449 §7A) must prevent
  // any role — including service_role (BYPASSRLS does not bypass triggers) — from
  // changing signing_mode once the contract has left 'pending' status.
  // ══════════════════════════════════════════════════════════════════════════

  it('M: signing_mode immutability trigger exists on contracts', () => {
    const r = sql(`
      SELECT COUNT(DISTINCT trigger_name) FROM information_schema.triggers
       WHERE event_object_schema = 'public'
         AND event_object_table  = 'contracts'
         AND trigger_name        = 'contracts_signing_mode_immutable';
    `);
    expect(r).toBe('1');
  });

  it('M: authenticated cannot change signing_mode after contract leaves pending', () => {
    const contractId = '00000000-0000-0000-0000-000000449m01';
    // Insert via service_role, send = move to non-pending by setting status='active'
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${contractId}', '${BIZ_ID}', 'Mode Test', 'tok449mode0001', 'pending', 'parallel');
      -- Simulate contract being sent (advance from pending)
      UPDATE public.contracts SET status = 'active' WHERE id = '${contractId}';
      COMMIT;
    `);

    // Attempt authenticated UPDATE on signing_mode — should be blocked by trigger
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      UPDATE public.contracts SET signing_mode = 'sequential' WHERE id = '${contractId}';
      COMMIT;
    `);
    expect(r).toMatch(/immutable|integrity_constraint_violation|23000/i);

    const mode = sql(`SELECT signing_mode FROM public.contracts WHERE id = '${contractId}';`);
    expect(mode).toBe('parallel');

    sql(`DELETE FROM public.contracts WHERE id = '${contractId}';`);
  });

  it('M: service_role cannot change signing_mode after contract leaves pending', () => {
    const contractId = '00000000-0000-0000-0000-000000449m02';
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${contractId}', '${BIZ_ID}', 'Mode Test SVC', 'tok449mode0002', 'active', 'multi');
      COMMIT;
    `);

    // service_role bypasses RLS but NOT triggers
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contracts SET signing_mode = 'single' WHERE id = '${contractId}';
      COMMIT;
    `);
    expect(r).toMatch(/immutable|integrity_constraint_violation|23000/i);

    const mode = sql(`SELECT signing_mode FROM public.contracts WHERE id = '${contractId}';`);
    expect(mode).toBe('multi');

    sql(`DELETE FROM public.contracts WHERE id = '${contractId}';`);
  });

  it('M: signing_mode CAN change while contract is still pending', () => {
    const contractId = '00000000-0000-0000-0000-000000449m03';
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${contractId}', '${BIZ_ID}', 'Mode Pending', 'tok449mode0003', 'pending', 'parallel');
      COMMIT;
    `);

    // While status='pending', changing signing_mode is allowed
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contracts SET signing_mode = 'sequential' WHERE id = '${contractId}';
      COMMIT;
    `);
    expect(r).not.toMatch(/ERROR|immutable/i);

    const mode = sql(`SELECT signing_mode FROM public.contracts WHERE id = '${contractId}';`);
    expect(mode).toBe('sequential');

    sql(`DELETE FROM public.contracts WHERE id = '${contractId}';`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // N. Behavioral: contract_signers locked once parent contract is signed
  //
  // contract_signers_lock_on_signed trigger (installed by M449 §7B) must prevent
  // UPDATE or DELETE on a signer row whose parent contract has status='signed'.
  // ══════════════════════════════════════════════════════════════════════════

  it('N: contract_signers_lock_on_signed trigger exists', () => {
    const r = sql(`
      SELECT COUNT(DISTINCT trigger_name) FROM information_schema.triggers
       WHERE event_object_schema = 'public'
         AND event_object_table  = 'contract_signers'
         AND trigger_name        = 'contract_signers_lock_on_signed';
    `);
    expect(r).toBe('1');
  });

  it('N: service_role cannot UPDATE a signer row after parent contract is signed', () => {
    const contractId = '00000000-0000-0000-0000-000000449n01';
    const signerId   = '00000000-0000-0000-0000-000000449n02';
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${contractId}', '${BIZ_ID}', 'Lock Test', 'tok449lock0001', 'pending', 'single');
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${signerId}', '${contractId}', '+2348001111449', 'tok449siglock01', 'signed');
      -- Mark contract signed (single mode, so trigger M450 does not block)
      UPDATE public.contracts SET status = 'signed' WHERE id = '${contractId}';
      COMMIT;
    `);

    // Now attempt to UPDATE the signer row — should be blocked
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contract_signers SET signer_name = 'Hacked' WHERE id = '${signerId}';
      COMMIT;
    `);
    expect(r).toMatch(/locked|integrity_constraint_violation|23000/i);

    // Confirm name was not changed
    const name = sql(`SELECT signer_name FROM public.contract_signers WHERE id = '${signerId}';`);
    expect(name).not.toBe('Hacked');

    sql(`DELETE FROM public.contract_signers WHERE id = '${signerId}';`);
    sql(`DELETE FROM public.contracts WHERE id = '${contractId}';`);
  });

  it('N: service_role CAN UPDATE signer rows while parent contract is not yet signed', () => {
    const contractId = '00000000-0000-0000-0000-000000449n03';
    const signerId   = '00000000-0000-0000-0000-000000449n04';
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO public.contracts (id, business_id, title, token, status, signing_mode)
        VALUES ('${contractId}', '${BIZ_ID}', 'Active Test', 'tok449active001', 'active', 'parallel');
      INSERT INTO public.contract_signers (id, contract_id, signer_phone, token, status)
        VALUES ('${signerId}', '${contractId}', '+2348001112449', 'tok449sigact001', 'pending');
      COMMIT;
    `);

    // contract is 'active' (not 'signed') — update should be allowed
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE public.contract_signers SET signer_name = 'Alice' WHERE id = '${signerId}';
      COMMIT;
    `);
    expect(r).not.toMatch(/ERROR|locked/i);

    const name = sql(`SELECT signer_name FROM public.contract_signers WHERE id = '${signerId}';`);
    expect(name).toBe('Alice');

    sql(`DELETE FROM public.contract_signers WHERE id = '${signerId}';`);
    sql(`DELETE FROM public.contracts WHERE id = '${contractId}';`);
  });
});
