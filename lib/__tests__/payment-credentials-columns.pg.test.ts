/**
 * Migration 443: business_payment_credentials column-level access hardening
 *
 * Runs against a disposable Postgres instance (TEST_DATABASE_URL).
 * Skips when TEST_DATABASE_URL is absent (main-app job has no PG).
 * FAILS (not skips) when REQUIRE_PG_TESTS=true and TEST_DATABASE_URL is missing
 * — the dedicated migration-shard CI step sets both.
 *
 * Creates the table, grants broad SELECT (simulating production defaults),
 * applies M443, then verifies:
 *   - authenticated/anon cannot SELECT secret_key or webhook_secret_hash
 *   - authenticated CAN SELECT the allowed columns
 *   - service_role retains full access
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB && process.env.REQUIRE_PG_TESTS === 'true') {
  throw new Error('TEST_DATABASE_URL is required — cannot skip DB tests (REQUIRE_PG_TESTS=true)');
}

const describeDb = !TEST_DB ? describe.skip : describe;

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

const BIZ_ID = '00000000-0000-0000-0000-000000443001';
const OWNER_ID = '00000000-0000-0000-0000-000000443010';

describeDb('Migration 443: payment credentials column-level access hardening', () => {
  beforeAll(() => {
    // ── Create roles if not present ──
    sql(`
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
      ALTER ROLE service_role BYPASSRLS;
    `);

    // ── auth schema ──
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
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
    `);

    // ── businesses table ──
    sql(`
      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID,
        name TEXT NOT NULL DEFAULT 'Test',
        slug TEXT,
        status TEXT DEFAULT 'active'
      );
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT SELECT ON public.businesses TO service_role, authenticated;
    `);

    // ── business_payment_credentials table (matching M426 schema) ──
    sql(`
      CREATE TABLE IF NOT EXISTS public.business_payment_credentials (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        gateway VARCHAR NOT NULL,
        secret_key TEXT,
        public_key TEXT,
        platform_subaccount_code VARCHAR,
        connect_account_id VARCHAR,
        connection_type VARCHAR DEFAULT 'manual',
        is_active BOOLEAN DEFAULT true,
        verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE public.business_payment_credentials ENABLE ROW LEVEL SECURITY;
    `);

    // Simulate production broad grants — table-level SELECT to authenticated
    sql(`
      GRANT SELECT, INSERT, UPDATE ON TABLE public.business_payment_credentials TO service_role;
      GRANT SELECT ON TABLE public.business_payment_credentials TO authenticated;
    `);

    // RLS policy
    sql(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'business_payment_credentials' AND policyname = 'bpc_owner_select') THEN
          CREATE POLICY bpc_owner_select ON public.business_payment_credentials
            FOR SELECT TO authenticated
            USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
        END IF;
      END $$;
    `);
    sql(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'business_payment_credentials' AND policyname = 'bpc_service_all') THEN
          CREATE POLICY bpc_service_all ON public.business_payment_credentials
            FOR ALL TO service_role WITH CHECK (true);
        END IF;
      END $$;
    `);

    // Seed test data
    sql(`INSERT INTO auth.users (id) VALUES ('${OWNER_ID}') ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.businesses (id, owner_id, name) VALUES ('${BIZ_ID}', '${OWNER_ID}', 'Cred Test Biz') ON CONFLICT (id) DO NOTHING;`);
    sql(`
      SET ROLE service_role;
      INSERT INTO public.business_payment_credentials (business_id, gateway, secret_key, public_key, is_active)
        VALUES ('${BIZ_ID}', 'paystack', 'encrypted_fixture_value_443', 'pub_fixture_443', true)
        ON CONFLICT DO NOTHING;
      RESET ROLE;
    `);
  });

  afterAll(() => {
    sql(`DELETE FROM public.business_payment_credentials WHERE business_id = '${BIZ_ID}';`);
    sql(`DELETE FROM public.businesses WHERE id = '${BIZ_ID}';`);
    sql(`DELETE FROM auth.users WHERE id = '${OWNER_ID}';`);
  });

  // ═══════════════════════════════════════════════════════════════
  // A. Pre-migration: authenticated CAN read secret_key (negative control)
  // ═══════════════════════════════════════════════════════════════

  it('pre-migration: authenticated can SELECT secret_key (negative control)', () => {
    const r = sql(`
      SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'secret_key', 'SELECT');
    `);
    expect(r).toBe('t');
  });

  // ═══════════════════════════════════════════════════════════════
  // B. Apply migration 443
  // ═══════════════════════════════════════════════════════════════

  it('applies migration 443 without error', () => {
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/443_byo_webhook_secret_hash.sql'),
      'utf-8',
    );
    const result = execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A 2>&1`,
      { encoding: 'utf-8', timeout: 15000, input: migrationSql },
    ).trim();
    expect(result).not.toMatch(/M443 FAILED/);
    expect(result).toContain('M443 self-check PASSED');
  });

  // ═══════════════════════════════════════════════════════════════
  // C. Post-migration: authenticated cannot SELECT secret columns
  // ═══════════════════════════════════════════════════════════════

  it('post-migration: authenticated cannot SELECT secret_key (privilege check)', () => {
    const r = sql(`
      SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'secret_key', 'SELECT');
    `);
    expect(r).toBe('f');
  });

  it('post-migration: authenticated cannot SELECT webhook_secret_hash (privilege check)', () => {
    const r = sql(`
      SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'webhook_secret_hash', 'SELECT');
    `);
    expect(r).toBe('f');
  });

  it('post-migration: authenticated gets permission denied on SELECT secret_key', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      SELECT secret_key FROM business_payment_credentials WHERE business_id = '${BIZ_ID}';
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
  });

  it('post-migration: authenticated gets permission denied on SELECT webhook_secret_hash', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      SELECT webhook_secret_hash FROM business_payment_credentials WHERE business_id = '${BIZ_ID}';
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
  });

  it('post-migration: authenticated cannot SELECT public_key (M426 treats as sensitive)', () => {
    const r = sql(`
      SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'public_key', 'SELECT');
    `);
    expect(r).toBe('f');
  });

  // ═══════════════════════════════════════════════════════════════
  // D. Post-migration: anon cannot SELECT any column
  // ═══════════════════════════════════════════════════════════════

  it('post-migration: anon cannot SELECT secret_key', () => {
    const r = sql(`
      SELECT has_column_privilege('anon', 'public.business_payment_credentials', 'secret_key', 'SELECT');
    `);
    expect(r).toBe('f');
  });

  it('post-migration: anon cannot SELECT webhook_secret_hash', () => {
    const r = sql(`
      SELECT has_column_privilege('anon', 'public.business_payment_credentials', 'webhook_secret_hash', 'SELECT');
    `);
    expect(r).toBe('f');
  });

  it('post-migration: anon has no column SELECT on entire table', () => {
    const r = sql(`
      SELECT has_any_column_privilege('anon', 'public.business_payment_credentials', 'SELECT');
    `);
    expect(r).toBe('f');
  });

  // ═══════════════════════════════════════════════════════════════
  // E. Post-migration: authenticated CAN SELECT allowed columns
  // ═══════════════════════════════════════════════════════════════

  it('post-migration: authenticated can SELECT id', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'id', 'SELECT');")).toBe('t');
  });

  it('post-migration: authenticated can SELECT gateway', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'gateway', 'SELECT');")).toBe('t');
  });

  it('post-migration: authenticated can SELECT is_active', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'is_active', 'SELECT');")).toBe('t');
  });

  it('post-migration: authenticated can SELECT allowed columns via actual query', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      SELECT id, gateway, platform_subaccount_code, is_active, verified_at, created_at, connection_type, connect_account_id
        FROM business_payment_credentials WHERE business_id = '${BIZ_ID}';
      COMMIT;
    `);
    expect(r).not.toMatch(/permission denied|42501|ERROR/i);
    expect(r).toContain('paystack');
  });

  // ═══════════════════════════════════════════════════════════════
  // F. Post-migration: service_role retains full access
  // ═══════════════════════════════════════════════════════════════

  it('post-migration: service_role can SELECT secret_key', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT secret_key FROM business_payment_credentials WHERE business_id = '${BIZ_ID}';
      COMMIT;
    `);
    expect(r).not.toMatch(/permission denied|42501|ERROR/i);
    expect(r).toContain('encrypted_fixture_value_443');
  });

  it('post-migration: service_role can SELECT webhook_secret_hash', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT webhook_secret_hash FROM business_payment_credentials WHERE business_id = '${BIZ_ID}';
      COMMIT;
    `);
    expect(r).not.toMatch(/permission denied|42501|ERROR/i);
  });
});
