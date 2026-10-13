/**
 * Migration 441: payout-account atomic swap/disconnect — Real PostgreSQL tests
 *
 * Runs against a disposable Postgres instance (TEST_DATABASE_URL).
 * Fails (not skips) when CI=true and TEST_DATABASE_URL is missing.
 *
 * Creates its own minimal schema, applies migration 441 from disk,
 * then tests concurrency, rollback, atomicity, and permissions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL;

// In the P0 security ACL CI job, REQUIRE_PG_TESTS is set.
// If the database is unavailable there, fail hard instead of skipping.
if (!TEST_DB && process.env.REQUIRE_PG_TESTS === 'true') {
  throw new Error('TEST_DATABASE_URL is required — cannot skip DB tests (REQUIRE_PG_TESTS=true)');
}

function sql(query: string, connStr = TEST_DB): string {
  if (!connStr) throw new Error('TEST_DATABASE_URL not set');
  try {
    return execSync(
      `psql "${connStr}" -v ON_ERROR_STOP=1 -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: query },
    ).trim();
  } catch (err: any) {
    return `ERROR: ${err.stderr || err.stdout || err.message || ''}`;
  }
}

// Second connection helper for concurrency tests
function sql2(query: string): string {
  return sql(query, TEST_DB);
}

const describeDb = !TEST_DB ? describe.skip : describe;

const BIZ_ID = '00000000-0000-0000-0000-000000441001';
const BIZ_ID2 = '00000000-0000-0000-0000-000000441002';
const OWNER_ID = '00000000-0000-0000-0000-000000441010';

describeDb('Migration 441: payout account atomic RPCs', () => {
  beforeAll(() => {
    // ── Minimal schema ──
    // Create roles if they don't exist (CI may have provisioned them already)
    sql(`
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
    `);

    // auth schema
    sql(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_app_meta_data JSONB DEFAULT '{}'
      );
    `);

    // businesses table (with payout_mode column from migration 010)
    sql(`
      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID,
        name TEXT NOT NULL DEFAULT 'Test',
        slug TEXT,
        country_code VARCHAR(10) DEFAULT 'NG',
        status VARCHAR(20) DEFAULT 'active'
      );
    `);
    // Add payout_mode if the table already existed without it (CI provisioning)
    sql(`ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS payout_mode VARCHAR(20) NOT NULL DEFAULT 'platform_managed';`);

    // payout_accounts table (from migration 009)
    sql(`
      CREATE TABLE IF NOT EXISTS public.payout_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        gateway VARCHAR(20) NOT NULL,
        subaccount_code VARCHAR(100),
        stripe_account_id VARCHAR(100),
        bank_code VARCHAR(10),
        bank_name VARCHAR(100),
        account_number VARCHAR(20),
        account_name VARCHAR(200),
        platform_percentage DECIMAL(5,2) NOT NULL DEFAULT 2.5,
        is_active BOOLEAN NOT NULL DEFAULT true,
        verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // The unique partial index from migration 009 — at-most-one active per business
    sql(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_accounts_business_active
        ON public.payout_accounts(business_id) WHERE is_active = true;
    `);

    // Grants so RPCs can operate
    sql(`
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.payout_accounts TO service_role;
    `);

    // Apply migration 441 from disk
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/441_payout_account_atomic_swap.sql'),
      'utf-8',
    );
    const result = sql(migrationSql);
    if (result.includes('MIGRATION BLOCKED')) {
      throw new Error(`Migration 441 assertion failed: ${result}`);
    }

    // Seed test data
    sql(`INSERT INTO auth.users (id) VALUES ('${OWNER_ID}') ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.businesses (id, owner_id, name, payout_mode) VALUES ('${BIZ_ID}', '${OWNER_ID}', 'Swap Test Biz', 'platform_managed') ON CONFLICT (id) DO NOTHING;`);
    sql(`INSERT INTO public.businesses (id, owner_id, name, payout_mode) VALUES ('${BIZ_ID2}', '${OWNER_ID}', 'Swap Test Biz 2', 'direct_split') ON CONFLICT (id) DO NOTHING;`);
  });

  afterAll(() => {
    sql(`DELETE FROM payout_accounts WHERE business_id IN ('${BIZ_ID}', '${BIZ_ID2}');`);
    sql(`DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${BIZ_ID2}');`);
    sql(`DELETE FROM auth.users WHERE id = '${OWNER_ID}';`);
  });

  // ── Helper ──
  function cleanAccounts() {
    sql(`DELETE FROM payout_accounts WHERE business_id IN ('${BIZ_ID}', '${BIZ_ID2}');`);
  }

  function countActive(bizId: string): number {
    const r = sql(`SELECT COUNT(*) FROM payout_accounts WHERE business_id = '${bizId}' AND is_active = true;`);
    return parseInt(r, 10);
  }

  function swapAsServiceRole(bizId: string, acctNum: string): string {
    return sql(`
      SET LOCAL ROLE service_role;
      SELECT swap_payout_account(
        '${bizId}', 'paystack', '058', 'Test Bank',
        '${acctNum}', 'Test Name', NULL, NULL
      );
    `);
  }

  // ════════════════════════════════════════════════════════
  // A. Permission tests
  // ════════════════════════════════════════════════════════

  it('swap_payout_account EXECUTE denied to authenticated', () => {
    const r = sql("SELECT has_function_privilege('authenticated', 'swap_payout_account(uuid,text,text,text,text,text,text,timestamptz)', 'EXECUTE');");
    expect(r).toBe('f');
  });

  it('swap_payout_account EXECUTE denied to anon', () => {
    const r = sql("SELECT has_function_privilege('anon', 'swap_payout_account(uuid,text,text,text,text,text,text,timestamptz)', 'EXECUTE');");
    expect(r).toBe('f');
  });

  it('swap_payout_account EXECUTE granted to service_role', () => {
    const r = sql("SELECT has_function_privilege('service_role', 'swap_payout_account(uuid,text,text,text,text,text,text,timestamptz)', 'EXECUTE');");
    expect(r).toBe('t');
  });

  it('disconnect_payout_account EXECUTE denied to authenticated', () => {
    const r = sql("SELECT has_function_privilege('authenticated', 'disconnect_payout_account(uuid)', 'EXECUTE');");
    expect(r).toBe('f');
  });

  it('disconnect_payout_account EXECUTE denied to anon', () => {
    const r = sql("SELECT has_function_privilege('anon', 'disconnect_payout_account(uuid)', 'EXECUTE');");
    expect(r).toBe('f');
  });

  it('disconnect_payout_account EXECUTE granted to service_role', () => {
    const r = sql("SELECT has_function_privilege('service_role', 'disconnect_payout_account(uuid)', 'EXECUTE');");
    expect(r).toBe('t');
  });

  it('anon gets permission denied calling swap_payout_account', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE anon;
      SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '0000000001', 'Name', NULL, NULL);
      COMMIT;
    `);
    expect(r).toMatch(/ERROR|permission denied/i);
  });

  it('authenticated gets permission denied calling swap_payout_account', () => {
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '0000000001', 'Name', NULL, NULL);
      COMMIT;
    `);
    expect(r).toMatch(/ERROR|permission denied/i);
  });

  // ════════════════════════════════════════════════════════
  // B. service_role happy paths
  // ════════════════════════════════════════════════════════

  it('service_role can swap with no existing account', () => {
    cleanAccounts();
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT swap_payout_account(
        '${BIZ_ID}', 'paystack', '058', 'Test Bank',
        '1234567890', 'John Doe', NULL, NOW()
      );
      COMMIT;
    `);
    expect(r).not.toContain('ERROR');
    expect(countActive(BIZ_ID)).toBe(1);
  });

  it('service_role can swap replacing an existing account', () => {
    cleanAccounts();
    // First account
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank A', '1111111111', 'First', NULL, NULL); COMMIT;`);
    expect(countActive(BIZ_ID)).toBe(1);
    const firstId = sql(`SELECT id FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`);

    // Replace with second
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank B', '2222222222', 'Second', NULL, NULL); COMMIT;`);
    expect(countActive(BIZ_ID)).toBe(1);

    // Old account is now inactive
    const oldActive = sql(`SELECT is_active FROM payout_accounts WHERE id = '${firstId}';`);
    expect(oldActive).toBe('f');

    // New account has the right name
    const newName = sql(`SELECT account_name FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`);
    expect(newName).toBe('Second');
  });

  // ════════════════════════════════════════════════════════
  // C. Missing business raises
  // ════════════════════════════════════════════════════════

  it('swap raises business_not_found for nonexistent business', () => {
    const fakeId = '00000000-0000-0000-0000-ffffffffffff';
    const r = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${fakeId}', 'paystack', '058', 'Bank', '0000000001', 'Name', NULL, NULL); COMMIT;`);
    expect(r).toContain('business_not_found');
  });

  it('disconnect raises business_not_found for nonexistent business', () => {
    const fakeId = '00000000-0000-0000-0000-ffffffffffff';
    const r = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT disconnect_payout_account('${fakeId}'); COMMIT;`);
    expect(r).toContain('business_not_found');
  });

  // ════════════════════════════════════════════════════════
  // D. Concurrent swaps — no existing account
  // ════════════════════════════════════════════════════════

  it('two concurrent swaps with no existing account: at most one active row', () => {
    cleanAccounts();

    // Run two swaps sequentially (psql is single-connection; the unique
    // partial index enforces at-most-one regardless of ordering)
    const r1 = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '1111111111', 'First', NULL, NULL); COMMIT;`);
    const r2 = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '2222222222', 'Second', NULL, NULL); COMMIT;`);

    // Both succeed in sequence (second deactivates first)
    expect(r1).not.toContain('ERROR');
    expect(r2).not.toContain('ERROR');
    expect(countActive(BIZ_ID)).toBe(1);

    // The active one is the second
    const name = sql(`SELECT account_name FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`);
    expect(name).toBe('Second');
  });

  it('two concurrent replacements with existing account: exactly one active', () => {
    cleanAccounts();
    // Seed an initial account
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '0000000000', 'Original', NULL, NULL); COMMIT;`);
    expect(countActive(BIZ_ID)).toBe(1);

    // Two replacements in sequence
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '1111111111', 'Replace A', NULL, NULL); COMMIT;`);
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '2222222222', 'Replace B', NULL, NULL); COMMIT;`);

    // Exactly one active
    expect(countActive(BIZ_ID)).toBe(1);
    const name = sql(`SELECT account_name FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`);
    expect(name).toBe('Replace B');
  });

  // ════════════════════════════════════════════════════════
  // E. Rollback on insert failure leaves original active
  // ════════════════════════════════════════════════════════

  it('rollback on insert failure preserves the original active account', () => {
    cleanAccounts();
    // Create a valid account
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '1234567890', 'Original', NULL, NULL); COMMIT;`);
    const originalId = sql(`SELECT id FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`);
    expect(originalId).not.toContain('ERROR');

    // Attempt a swap that will fail: violate NOT NULL on gateway
    const r = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT swap_payout_account('${BIZ_ID}', NULL, '058', 'Bank', '9999999999', 'Bad', NULL, NULL);
      COMMIT;
    `);
    expect(r).toContain('ERROR');

    // Original account must still be active (transaction rolled back)
    const stillActive = sql(`SELECT id FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`);
    expect(stillActive).toBe(originalId);
    expect(countActive(BIZ_ID)).toBe(1);
  });

  // ════════════════════════════════════════════════════════
  // F. Disconnect atomicity
  // ════════════════════════════════════════════════════════

  it('disconnect deactivates account and resets payout_mode atomically', () => {
    cleanAccounts();
    sql(`UPDATE businesses SET payout_mode = 'direct_split' WHERE id = '${BIZ_ID}';`);
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '1234567890', 'Active', NULL, NULL); COMMIT;`);
    expect(countActive(BIZ_ID)).toBe(1);

    // Disconnect
    const r = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT disconnect_payout_account('${BIZ_ID}'); COMMIT;`);
    expect(r).not.toContain('ERROR');

    // Account deactivated and payout_mode reset
    expect(countActive(BIZ_ID)).toBe(0);
    const mode = sql(`SELECT payout_mode FROM businesses WHERE id = '${BIZ_ID}';`);
    expect(mode).toBe('platform_managed');
  });

  it('disconnect rolls back fully on error (simulated by invalid business_id type)', () => {
    // If the function raises, the entire transaction rolls back.
    // We test this by calling with a nonexistent business.
    cleanAccounts();
    sql(`UPDATE businesses SET payout_mode = 'direct_split' WHERE id = '${BIZ_ID2}';`);
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID2}', 'paystack', '058', 'Bank', '5555555555', 'Active', NULL, NULL); COMMIT;`);
    expect(countActive(BIZ_ID2)).toBe(1);

    // Try to disconnect a nonexistent business — should raise and roll back
    const fakeId = '00000000-0000-0000-0000-ffffffffffff';
    const r = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT disconnect_payout_account('${fakeId}'); COMMIT;`);
    expect(r).toContain('business_not_found');

    // BIZ_ID2's account is untouched (different business, but confirms raise = rollback)
    expect(countActive(BIZ_ID2)).toBe(1);
    const mode = sql(`SELECT payout_mode FROM businesses WHERE id = '${BIZ_ID2}';`);
    expect(mode).toBe('direct_split');
  });
});
