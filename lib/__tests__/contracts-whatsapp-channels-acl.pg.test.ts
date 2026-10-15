/**
 * Migration 449: Least-privilege ACL for contracts, contract_signers,
 * contract_templates, whatsapp_channels, waiver_templates, and signed_waivers
 * — Real PostgreSQL tests
 *
 * Runs against a disposable Postgres instance (TEST_DATABASE_URL).
 * Fails (not skips) when REQUIRE_PG_TESTS=true and TEST_DATABASE_URL is missing.
 *
 * Test structure:
 *   A. Pre-migration negative controls — verify the vulnerabilities exist:
 *      - authenticated can SELECT meta_access_token from whatsapp_channels
 *      - contracts/contract_templates have broad table-level grants to authenticated
 *   B. Apply migration 449 — must succeed with PASS notice
 *   C. Post-migration: anon excluded on all tables
 *   D. Post-migration: whatsapp_channels — meta_access_token blocked, no writes
 *   E. Post-migration: contracts — column-level SELECT, no token, no DELETE
 *   F. Post-migration: contract_signers — otp_code blocked
 *   G. Post-migration: contract_templates — full CRUD
 *   H. Post-migration: waiver_templates — SELECT/INSERT/UPDATE
 *   I. Post-migration: signed_waivers — SELECT only
 *   J. Post-migration: service_role retains full access
 *   K. End-to-end: owner can read their own contracts via authenticated role
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

  it('self-check robustness: injected column-level UPDATE grant on contracts.status is detected', () => {
    // Step 1 — inject the column-level grant
    sql(`GRANT UPDATE (status) ON public.contracts TO authenticated;`);

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

    // Step 3 — run it and expect the self-check to raise an exception
    const result = sql(lastDoBlock);
    expect(result).toMatch(/449 SELF-CHECK FAILED.*authenticated has UPDATE.*contracts/i);

    // Step 4 — revoke so subsequent tests (K) are unaffected
    sql(`REVOKE UPDATE (status) ON public.contracts FROM authenticated;`);
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
});
