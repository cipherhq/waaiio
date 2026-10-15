/**
 * Migration 443: least-privilege grants on business_payment_credentials
 *
 * Runs against a disposable Postgres instance (TEST_DATABASE_URL).
 * Skips when TEST_DATABASE_URL is absent (main-app job has no PG).
 * FAILS (not skips) when REQUIRE_PG_TESTS=true and TEST_DATABASE_URL is missing.
 *
 * Starts from production-shaped ACL (table-level ALL to anon/authenticated,
 * owner CRUD policy for role public, service read policy), applies M443,
 * then verifies least-privilege grants are in effect.
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
const ROW_ID = '00000000-0000-0000-0000-000000443099';

describeDb('Migration 443: least-privilege grants on payment credentials', () => {
  beforeAll(() => {
    // ── Roles ──
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

    // ── businesses ──
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

    // ── business_payment_credentials (M426 schema) ──
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

    // ── Production-shaped ACL: broad grants ──
    // Simulates historical Supabase defaults where all roles had broad access
    sql(`
      GRANT ALL ON TABLE public.business_payment_credentials TO anon;
      GRANT ALL ON TABLE public.business_payment_credentials TO authenticated;
      GRANT SELECT, INSERT, UPDATE ON TABLE public.business_payment_credentials TO service_role;
    `);

    // Owner CRUD policy (FOR ALL, role public — matches historical production shape)
    sql(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'business_payment_credentials' AND policyname = 'owner_crud') THEN
          CREATE POLICY owner_crud ON public.business_payment_credentials
            FOR ALL
            USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
            WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
        END IF;
      END $$;
    `);
    // Service read policy
    sql(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'business_payment_credentials' AND policyname = 'bpc_service_all') THEN
          CREATE POLICY bpc_service_all ON public.business_payment_credentials
            FOR ALL TO service_role WITH CHECK (true);
        END IF;
      END $$;
    `);

    // Seed
    sql(`INSERT INTO auth.users (id) VALUES ('${OWNER_ID}') ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.businesses (id, owner_id, name) VALUES ('${BIZ_ID}', '${OWNER_ID}', 'Cred Test Biz') ON CONFLICT (id) DO NOTHING;`);
    sql(`
      SET ROLE service_role;
      INSERT INTO public.business_payment_credentials (id, business_id, gateway, secret_key, public_key, is_active, connection_type, platform_subaccount_code)
        VALUES ('${ROW_ID}', '${BIZ_ID}', 'paystack', 'encrypted_fixture_value_443', 'pub_fixture_443', true, 'manual', 'SUB_TEST')
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
  // A. Pre-migration negative controls: production-shaped ACL is broad
  // ═══════════════════════════════════════════════════════════════

  it('pre-migration: authenticated has table-level SELECT (negative control)', () => {
    expect(sql("SELECT has_table_privilege('authenticated', 'public.business_payment_credentials', 'SELECT');")).toBe('t');
  });

  it('pre-migration: authenticated has INSERT (negative control)', () => {
    expect(sql("SELECT has_table_privilege('authenticated', 'public.business_payment_credentials', 'INSERT');")).toBe('t');
  });

  it('pre-migration: anon has table-level SELECT (negative control)', () => {
    expect(sql("SELECT has_table_privilege('anon', 'public.business_payment_credentials', 'SELECT');")).toBe('t');
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
  // C. Post-migration: authenticated read restrictions
  // ═══════════════════════════════════════════════════════════════

  it('post-migration: authenticated cannot SELECT secret_key (privilege)', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'secret_key', 'SELECT');")).toBe('f');
  });

  it('post-migration: authenticated cannot SELECT webhook_secret_hash (privilege)', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'webhook_secret_hash', 'SELECT');")).toBe('f');
  });

  it('post-migration: authenticated cannot SELECT public_key (privilege)', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'public_key', 'SELECT');")).toBe('f');
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

  // ═══════════════════════════════════════════════════════════════
  // D. Post-migration: authenticated write restrictions (owner JWT)
  // ═══════════════════════════════════════════════════════════════

  it('post-migration: owner cannot INSERT', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      INSERT INTO business_payment_credentials (business_id, gateway, secret_key)
        VALUES ('${BIZ_ID}', 'paystack', 'attempt');
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
  });

  it('post-migration: owner cannot UPDATE verified_at', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      UPDATE business_payment_credentials SET verified_at = NOW() WHERE id = '${ROW_ID}';
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
  });

  it('post-migration: owner cannot UPDATE platform_subaccount_code', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      UPDATE business_payment_credentials SET platform_subaccount_code = 'HACK' WHERE id = '${ROW_ID}';
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
  });

  it('post-migration: owner cannot UPDATE connection_type', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      UPDATE business_payment_credentials SET connection_type = 'connect' WHERE id = '${ROW_ID}';
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
  });

  it('post-migration: owner cannot UPDATE secret_key', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      UPDATE business_payment_credentials SET secret_key = 'stolen' WHERE id = '${ROW_ID}';
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
  });

  it('post-migration: owner cannot DELETE own row', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      DELETE FROM business_payment_credentials WHERE id = '${ROW_ID}';
      COMMIT;
    `);
    expect(r).toMatch(/permission denied|42501/i);
  });

  // ═══════════════════════════════════════════════════════════════
  // E. Post-migration: anon has no access at all
  // ═══════════════════════════════════════════════════════════════

  it('post-migration: anon has no column SELECT', () => {
    expect(sql("SELECT has_any_column_privilege('anon', 'public.business_payment_credentials', 'SELECT');")).toBe('f');
  });

  it('post-migration: anon has no INSERT', () => {
    expect(sql("SELECT has_table_privilege('anon', 'public.business_payment_credentials', 'INSERT');")).toBe('f');
  });

  it('post-migration: anon has no UPDATE', () => {
    expect(sql("SELECT has_table_privilege('anon', 'public.business_payment_credentials', 'UPDATE');")).toBe('f');
  });

  it('post-migration: anon has no DELETE', () => {
    expect(sql("SELECT has_table_privilege('anon', 'public.business_payment_credentials', 'DELETE');")).toBe('f');
  });

  // ═══════════════════════════════════════════════════════════════
  // F. Post-migration: authenticated CAN SELECT allowed metadata columns
  // ═══════════════════════════════════════════════════════════════

  it('post-migration: authenticated can SELECT id', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'id', 'SELECT');")).toBe('t');
  });

  it('post-migration: authenticated can SELECT gateway', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'gateway', 'SELECT');")).toBe('t');
  });

  it('post-migration: authenticated can SELECT the GET route column list', () => {
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
  // G. Post-migration: service_role retains full access
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

  it('post-migration: service_role can INSERT', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO business_payment_credentials (business_id, gateway, secret_key, connect_account_id)
        VALUES ('${BIZ_ID}', 'flutterwave', 'svc_test', 'conn_test')
        RETURNING id;
      COMMIT;
    `);
    expect(r).not.toMatch(/permission denied|42501|ERROR/i);
    expect(r).toMatch(/[0-9a-f]{8}-/);
    // Clean up
    sql(`DELETE FROM business_payment_credentials WHERE gateway = 'flutterwave' AND business_id = '${BIZ_ID}';`);
  });

  it('post-migration: service_role can UPDATE', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE business_payment_credentials SET verified_at = NOW() WHERE id = '${ROW_ID}';
      COMMIT;
    `);
    expect(r).not.toMatch(/permission denied|42501|ERROR/i);
  });

  // ═══════════════════════════════════════════════════════════════
  // H. Finding 3 — column-level INSERT/UPDATE grant escape
  // ═══════════════════════════════════════════════════════════════

  it('F3: column-level UPDATE grant on secret_key to authenticated is removed by migration', () => {
    // This test documents whether the old table-level REVOKE removed a column-level UPDATE grant.
    // Outcome: without the explicit column REVOKE added in this fix, the grant survives.
    // With the fix (REVOKE UPDATE (...) ON TABLE ... FROM authenticated), it is removed.

    // Re-grant a column-level UPDATE on secret_key (simulating a pre-M443 column grant)
    sql(`GRANT UPDATE (secret_key) ON TABLE public.business_payment_credentials TO authenticated;`);

    // Verify the grant exists (pre-revoke state)
    const before = sql(`SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'secret_key', 'UPDATE');`);
    expect(before).toBe('t');

    // Re-apply migration 443 (idempotent: ADD COLUMN IF NOT EXISTS is a no-op; grants/revokes re-execute)
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/443_byo_webhook_secret_hash.sql'),
      'utf-8',
    );
    const result = execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A 2>&1`,
      { encoding: 'utf-8', timeout: 15000, input: migrationSql },
    ).trim();
    expect(result).toContain('M443 self-check PASSED');

    // Verify the grant is now gone
    const after = sql(`SELECT has_column_privilege('authenticated', 'public.business_payment_credentials', 'secret_key', 'UPDATE');`);
    expect(after).toBe('f');
  });

  it('F3: self-check fails when a sensitive-column SELECT grant is reintroduced', () => {
    // Reintroduce a SELECT grant on secret_key to authenticated
    sql(`GRANT SELECT (secret_key) ON TABLE public.business_payment_credentials TO authenticated;`);

    // Extract and run only the self-check DO block from M443
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/443_byo_webhook_secret_hash.sql'),
      'utf-8',
    );
    // Extract the DO $$ ... $$ block
    const doBlockMatch = migrationSql.match(/DO \$\$[\s\S]*?\$\$;/);
    expect(doBlockMatch).not.toBeNull();
    const doBlock = doBlockMatch![0];

    const result = sql(doBlock);
    expect(result).toMatch(/M443 FAILED.*authenticated can SELECT secret_key/i);

    // Clean up: revoke the grant so subsequent tests are not affected
    sql(`REVOKE SELECT (secret_key) ON TABLE public.business_payment_credentials FROM authenticated;`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// platform_fees: authenticated SELECT grants and is_direct_transfer coverage
//
// The balance endpoint and dashboard/financials page call platform_fees as the
// authenticated role. They select is_direct_transfer (custody classification)
// plus transaction_amount, fee_total, gateway_fee, waived.
//
// This test verifies:
//   1. authenticated has table-level SELECT on platform_fees (Supabase project default)
//   2. is_direct_transfer column exists and is selectable by authenticated
//   3. RLS policy restricts rows to the owning business
// ═══════════════════════════════════════════════════════════════════════════

const PF_BIZ_ID = '00000000-0000-0000-0000-000000628001';
const PF_OWNER_ID = '00000000-0000-0000-0000-000000628010';
const PF_OTHER_BIZ_ID = '00000000-0000-0000-0000-000000628002';
const PF_OTHER_OWNER_ID = '00000000-0000-0000-0000-000000628011';

describeDb('platform_fees: authenticated SELECT grants and is_direct_transfer coverage', () => {
  beforeAll(() => {
    // Roles already exist from the previous suite; create tables fresh
    sql(`
      CREATE TABLE IF NOT EXISTS public.platform_fees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        transaction_amount NUMERIC DEFAULT 0,
        fee_total NUMERIC DEFAULT 0,
        gateway_fee NUMERIC DEFAULT 0,
        waived BOOLEAN DEFAULT false,
        is_direct_transfer BOOLEAN DEFAULT false,
        refunded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE public.platform_fees ENABLE ROW LEVEL SECURITY;
    `);

    // Supabase project-default: authenticated gets table-level SELECT
    sql(`GRANT SELECT ON public.platform_fees TO authenticated;`);
    sql(`GRANT SELECT, INSERT ON public.platform_fees TO service_role;`);

    // RLS policy matching migration 002 (owners view own fees)
    sql(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'platform_fees' AND policyname = 'owners_view_own_fees') THEN
          CREATE POLICY owners_view_own_fees ON public.platform_fees
            FOR SELECT USING (
              business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
            );
        END IF;
      END $$;
    `);

    // Seed
    sql(`INSERT INTO auth.users (id) VALUES ('${PF_OWNER_ID}'), ('${PF_OTHER_OWNER_ID}') ON CONFLICT DO NOTHING;`);
    sql(`
      INSERT INTO public.businesses (id, owner_id, name) VALUES
        ('${PF_BIZ_ID}', '${PF_OWNER_ID}', 'PF Test Biz'),
        ('${PF_OTHER_BIZ_ID}', '${PF_OTHER_OWNER_ID}', 'Other Biz')
      ON CONFLICT (id) DO NOTHING;
    `);
    sql(`
      SET ROLE service_role;
      INSERT INTO public.platform_fees
        (business_id, transaction_amount, fee_total, gateway_fee, waived, is_direct_transfer)
      VALUES
        ('${PF_BIZ_ID}',       10000, 500, 50, false, false),
        ('${PF_BIZ_ID}',        5000, 250, 25, true,  false),
        ('${PF_BIZ_ID}',        8000, 400, 40, false, true),
        ('${PF_OTHER_BIZ_ID}', 9000,  450, 45, false, false);
      RESET ROLE;
    `);
  });

  afterAll(() => {
    sql(`DELETE FROM public.platform_fees WHERE business_id IN ('${PF_BIZ_ID}', '${PF_OTHER_BIZ_ID}');`);
    sql(`DELETE FROM public.businesses WHERE id IN ('${PF_BIZ_ID}', '${PF_OTHER_BIZ_ID}');`);
    sql(`DELETE FROM auth.users WHERE id IN ('${PF_OWNER_ID}', '${PF_OTHER_OWNER_ID}');`);
  });

  it('authenticated has table-level SELECT on platform_fees', () => {
    expect(sql("SELECT has_table_privilege('authenticated', 'public.platform_fees', 'SELECT');")).toBe('t');
  });

  it('authenticated does NOT have INSERT on platform_fees', () => {
    expect(sql("SELECT has_table_privilege('authenticated', 'public.platform_fees', 'INSERT');")).toBe('f');
  });

  it('is_direct_transfer column exists and is selectable by authenticated', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.platform_fees', 'is_direct_transfer', 'SELECT');")).toBe('t');
  });

  it('gateway_fee column is selectable by authenticated', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.platform_fees', 'gateway_fee', 'SELECT');")).toBe('t');
  });

  it('waived column is selectable by authenticated', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.platform_fees', 'waived', 'SELECT');")).toBe('t');
  });

  it('transaction_amount column is selectable by authenticated', () => {
    expect(sql("SELECT has_column_privilege('authenticated', 'public.platform_fees', 'transaction_amount', 'SELECT');")).toBe('t');
  });

  it('RLS: owner sees only own rows (not other business rows)', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${PF_OWNER_ID}';
      SELECT count(*) FROM public.platform_fees;
      COMMIT;
    `);
    // Owner has 3 rows; other biz has 1 — RLS should return only 3
    expect(r).toContain('3');
  });

  it('RLS: owner can select is_direct_transfer from own rows', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${PF_OWNER_ID}';
      SELECT transaction_amount, fee_total, gateway_fee, waived, is_direct_transfer
        FROM public.platform_fees
        WHERE business_id = '${PF_BIZ_ID}'
        ORDER BY transaction_amount;
      COMMIT;
    `);
    expect(r).not.toMatch(/permission denied|42501|ERROR/i);
    // Should contain the three seeded rows
    expect(r).toContain('5000');
    expect(r).toContain('8000');
    expect(r).toContain('10000');
  });
});
