/**
 * Migration 448: business_bank_accounts server-only writes — Real PostgreSQL tests
 *
 * Runs against a disposable Postgres instance (TEST_DATABASE_URL).
 * Fails (not skips) when REQUIRE_PG_TESTS=true and TEST_DATABASE_URL is missing.
 *
 * Creates minimal schema, verifies authenticated CAN write BEFORE M448,
 * applies M448 from disk, then verifies authenticated gets 42501 and
 * service_role still writes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB && process.env.REQUIRE_PG_TESTS === 'true') {
  throw new Error('TEST_DATABASE_URL is required — cannot skip DB tests (REQUIRE_PG_TESTS=true)');
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

const OWNER_ID = '00000000-0000-0000-0000-000000448010';
const BIZ_ID   = '00000000-0000-0000-0000-000000448001';

describeDb('Migration 448: business_bank_accounts server-only', () => {
  beforeAll(() => {
    // ── Minimal schema ──
    sql(`
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
      ALTER ROLE service_role BYPASSRLS;
    `);

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

    sql(`
      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID,
        name TEXT NOT NULL DEFAULT 'Test',
        slug TEXT,
        status TEXT DEFAULT 'active'
      );
    `);

    // Create business_bank_accounts matching M209
    sql(`
      CREATE TABLE IF NOT EXISTS public.business_bank_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        bank_name VARCHAR(100) NOT NULL,
        account_number VARCHAR(20) NOT NULL,
        account_name VARCHAR(200) NOT NULL,
        bank_code VARCHAR(10),
        is_default BOOLEAN DEFAULT true,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Enable RLS (M209)
    sql(`ALTER TABLE public.business_bank_accounts ENABLE ROW LEVEL SECURITY;`);

    // M209 policies
    sql(`
      CREATE POLICY "Owners manage bank accounts" ON business_bank_accounts
        FOR ALL USING (
          business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
        );
    `);
    sql(`
      CREATE POLICY "Service role manages bank accounts" ON business_bank_accounts
        FOR ALL TO service_role WITH CHECK (true);
    `);

    // Grants: service_role (M415) + authenticated (simulate default Supabase grants)
    sql(`
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE ON public.business_bank_accounts TO service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_bank_accounts TO authenticated;
      GRANT SELECT ON public.businesses TO service_role, authenticated;
    `);

    // Seed
    sql(`INSERT INTO auth.users (id) VALUES ('${OWNER_ID}') ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.businesses (id, owner_id, name) VALUES ('${BIZ_ID}', '${OWNER_ID}', 'Bank Test Biz') ON CONFLICT (id) DO NOTHING;`);
  });

  afterAll(() => {
    sql(`DELETE FROM business_bank_accounts WHERE business_id = '${BIZ_ID}';`);
    sql(`DELETE FROM businesses WHERE id = '${BIZ_ID}';`);
    sql(`DELETE FROM auth.users WHERE id = '${OWNER_ID}';`);
  });

  // ═══════════════════════════════════════════════════════════════
  // A. Pre-migration: authenticated CAN write
  // ═══════════════════════════════════════════════════════════════

  it('pre-migration: authenticated can INSERT (negative control)', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      SELECT current_user;
      INSERT INTO business_bank_accounts (business_id, bank_name, account_number, account_name)
        VALUES ('${BIZ_ID}', 'Pre Bank', '1234567890', 'Pre Account')
        RETURNING id;
      COMMIT;
    `);
    expect(r).not.toMatch(/permission denied|42501/i);
    // Prove the role switch took effect
    expect(r).toContain('authenticated');
    // Prove a row was actually inserted (UUID returned)
    expect(r).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    // Clean up
    sql(`DELETE FROM business_bank_accounts WHERE business_id = '${BIZ_ID}' AND bank_name = 'Pre Bank';`);
  });

  // ═══════════════════════════════════════════════════════════════
  // B. Apply migration 448
  // ═══════════════════════════════════════════════════════════════

  it('applies migration 448 without error', () => {
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/448_business_bank_accounts_server_only.sql'),
      'utf-8',
    );
    // Apply with 2>&1 so RAISE NOTICE (stderr) is captured alongside stdout.
    // execSync throws on non-zero exit, so reaching the assertions proves exit code 0.
    const result = execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A 2>&1`,
      { encoding: 'utf-8', timeout: 15000, input: migrationSql },
    ).trim();
    expect(result).not.toMatch(/M448 FAILED/);
    expect(result).toContain('M448 self-check PASSED');
  });

  // ═══════════════════════════════════════════════════════════════
  // C. Post-migration: authenticated gets 42501 on writes
  // ═══════════════════════════════════════════════════════════════

  it('post-migration: authenticated cannot INSERT (42501)', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      INSERT INTO business_bank_accounts (business_id, bank_name, account_number, account_name)
        VALUES ('${BIZ_ID}', 'Blocked Bank', '9999999999', 'Blocked Account');
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
  });

  it('post-migration: authenticated cannot UPDATE (42501)', () => {
    // First insert via service_role so there's a row to update
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO business_bank_accounts (id, business_id, bank_name, account_number, account_name)
        VALUES ('00000000-0000-0000-0000-000000448099', '${BIZ_ID}', 'Update Test', '1111111111', 'Update Acct');
      COMMIT;
    `);
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      UPDATE business_bank_accounts SET bank_name = 'Hacked' WHERE id = '00000000-0000-0000-0000-000000448099';
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
    sql(`DELETE FROM business_bank_accounts WHERE id = '00000000-0000-0000-0000-000000448099';`);
  });

  it('post-migration: authenticated cannot DELETE (42501)', () => {
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO business_bank_accounts (id, business_id, bank_name, account_number, account_name)
        VALUES ('00000000-0000-0000-0000-000000448098', '${BIZ_ID}', 'Del Test', '2222222222', 'Del Acct');
      COMMIT;
    `);
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      DELETE FROM business_bank_accounts WHERE id = '00000000-0000-0000-0000-000000448098';
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
    sql(`DELETE FROM business_bank_accounts WHERE id = '00000000-0000-0000-0000-000000448098';`);
  });

  it('post-migration: anon cannot INSERT (42501)', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE anon;
      INSERT INTO business_bank_accounts (business_id, bank_name, account_number, account_name)
        VALUES ('${BIZ_ID}', 'Anon Bank', '3333333333', 'Anon Acct');
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
  });

  // ═══════════════════════════════════════════════════════════════
  // D. Post-migration: service_role still writes
  // ═══════════════════════════════════════════════════════════════

  it('post-migration: service_role can INSERT', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO business_bank_accounts (business_id, bank_name, account_number, account_name)
        VALUES ('${BIZ_ID}', 'Service Bank', '5555555555', 'Service Acct');
      COMMIT;
    `);
    expect(r).not.toMatch(/permission denied|42501|ERROR/i);
    sql(`DELETE FROM business_bank_accounts WHERE business_id = '${BIZ_ID}' AND bank_name = 'Service Bank';`);
  });

  it('post-migration: service_role can UPDATE', () => {
    sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO business_bank_accounts (id, business_id, bank_name, account_number, account_name)
        VALUES ('00000000-0000-0000-0000-000000448097', '${BIZ_ID}', 'Upd Test', '6666666666', 'Upd Acct');
      COMMIT;
    `);
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE business_bank_accounts SET bank_name = 'Updated Bank' WHERE id = '00000000-0000-0000-0000-000000448097';
      COMMIT;
    `);
    expect(r).not.toMatch(/permission denied|42501|ERROR/i);
    expect(sql(`SELECT bank_name FROM business_bank_accounts WHERE id = '00000000-0000-0000-0000-000000448097';`)).toBe('Updated Bank');
    sql(`DELETE FROM business_bank_accounts WHERE id = '00000000-0000-0000-0000-000000448097';`);
  });

  // ═══════════════════════════════════════════════════════════════
  // E. Grant verification via has_table_privilege
  // ═══════════════════════════════════════════════════════════════

  it('authenticated has no INSERT privilege', () => {
    expect(sql("SELECT has_table_privilege('authenticated', 'public.business_bank_accounts', 'INSERT');")).toBe('f');
  });

  it('authenticated has no UPDATE privilege', () => {
    expect(sql("SELECT has_table_privilege('authenticated', 'public.business_bank_accounts', 'UPDATE');")).toBe('f');
  });

  it('authenticated has no DELETE privilege', () => {
    expect(sql("SELECT has_table_privilege('authenticated', 'public.business_bank_accounts', 'DELETE');")).toBe('f');
  });

  it('anon has no INSERT privilege', () => {
    expect(sql("SELECT has_table_privilege('anon', 'public.business_bank_accounts', 'INSERT');")).toBe('f');
  });

  it('anon has no SELECT privilege', () => {
    expect(sql("SELECT has_table_privilege('anon', 'public.business_bank_accounts', 'SELECT');")).toBe('f');
  });

  it('authenticated retains SELECT privilege (admin panel reads via RLS)', () => {
    expect(sql("SELECT has_table_privilege('authenticated', 'public.business_bank_accounts', 'SELECT');")).toBe('t');
  });

  it('service_role has SELECT privilege', () => {
    expect(sql("SELECT has_table_privilege('service_role', 'public.business_bank_accounts', 'SELECT');")).toBe('t');
  });

  it('service_role has INSERT privilege', () => {
    expect(sql("SELECT has_table_privilege('service_role', 'public.business_bank_accounts', 'INSERT');")).toBe('t');
  });

  it('service_role has UPDATE privilege', () => {
    expect(sql("SELECT has_table_privilege('service_role', 'public.business_bank_accounts', 'UPDATE');")).toBe('t');
  });

  // ═══════════════════════════════════════════════════════════════
  // F. Policy verification: owner/reseller write policies dropped
  // ═══════════════════════════════════════════════════════════════

  it('"Owners manage bank accounts" policy is dropped', () => {
    const r = sql(`
      SELECT COUNT(*) FROM pg_policies
      WHERE tablename = 'business_bank_accounts'
        AND policyname = 'Owners manage bank accounts';
    `);
    expect(r).toBe('0');
  });

  it('"Resellers manage sub-account bank accounts" policy is dropped', () => {
    const r = sql(`
      SELECT COUNT(*) FROM pg_policies
      WHERE tablename = 'business_bank_accounts'
        AND policyname = 'Resellers manage sub-account bank accounts';
    `);
    expect(r).toBe('0');
  });

  it('"Service role manages bank accounts" policy still exists', () => {
    const r = sql(`
      SELECT COUNT(*) FROM pg_policies
      WHERE tablename = 'business_bank_accounts'
        AND policyname = 'Service role manages bank accounts';
    `);
    expect(r).toBe('1');
  });
});
