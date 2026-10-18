/**
 * Migration 442: server-managed business columns guard — Real PostgreSQL tests
 *
 * Runs against a disposable Postgres instance (TEST_DATABASE_URL).
 * Fails (not skips) when REQUIRE_PG_TESTS=true and TEST_DATABASE_URL is missing.
 *
 * Builds its own minimal schema, creates the OLD tier trigger (181),
 * runs a negative control (verification_level update succeeds before 442),
 * applies migrations 441, 446, and 442 from disk, then tests all 9 guarded
 * columns plus RPC compatibility (swap_payout_account, disconnect_payout_account).
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

function sqlThrows(query: string): boolean {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  try {
    execSync(`psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`, {
      encoding: 'utf-8', timeout: 15000, input: query,
    });
    return false;
  } catch {
    return true;
  }
}

const describeDb = !TEST_DB ? describe.skip : describe;

const OWNER_ID  = '00000000-0000-4000-f442-000000000001';
const OWNER_ID2 = '00000000-0000-4000-f442-000000000002'; // for owner_id change tests
const BIZ_ID    = '00000000-0000-4000-a442-000000000001';

describeDb('Migration 442: server-managed business columns guard', () => {
  beforeAll(() => {
    // ── Minimal schema ──
    sql(`
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
    `);

    sql(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_app_meta_data JSONB DEFAULT '{}'
      );
    `);

    // businesses with ALL 9 guarded columns
    sql(`
      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID REFERENCES auth.users(id),
        name TEXT NOT NULL DEFAULT 'Test',
        slug TEXT UNIQUE,
        category VARCHAR(50) DEFAULT 'shop',
        country_code VARCHAR(10) DEFAULT 'NG',
        status VARCHAR(20) DEFAULT 'active',
        verification_level VARCHAR(20) DEFAULT 'unverified',
        verification_status VARCHAR(20) DEFAULT 'unverified',
        payout_limit_monthly BIGINT DEFAULT 0,
        payout_mode VARCHAR(20) DEFAULT 'platform_managed',
        custom_fee_percentage DECIMAL(5,2),
        custom_fee_flat INTEGER,
        subscription_tier VARCHAR(20) DEFAULT 'free',
        reseller_id UUID
      );
    `);

    // Add columns if they don't exist (CI template has a minimal businesses table)
    for (const col of [
      "owner_id UUID REFERENCES auth.users(id)",
      "name TEXT NOT NULL DEFAULT 'Test'",
      'slug TEXT',
      "category VARCHAR(50) DEFAULT 'shop'",
      "country_code VARCHAR(10) DEFAULT 'NG'",
      "status VARCHAR(20) DEFAULT 'active'",
      "verification_level VARCHAR(20) DEFAULT 'unverified'",
      "verification_status VARCHAR(20) DEFAULT 'unverified'",
      'payout_limit_monthly BIGINT DEFAULT 0',
      "payout_mode VARCHAR(20) DEFAULT 'platform_managed'",
      'custom_fee_percentage DECIMAL(5,2)',
      'custom_fee_flat INTEGER',
      "subscription_tier VARCHAR(20) DEFAULT 'free'",
      'reseller_id UUID',
    ]) {
      sql(`ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS ${col};`);
    }

    // ── payout_accounts table (needed by migrations 441 + 446) ──
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
        square_merchant_id VARCHAR(100),
        square_access_token TEXT,
        platform_percentage DECIMAL(5,2) NOT NULL DEFAULT 2.5,
        is_active BOOLEAN NOT NULL DEFAULT true,
        verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Add Square OAuth columns if missing (from migration 080)
    sql(`ALTER TABLE public.payout_accounts ADD COLUMN IF NOT EXISTS square_merchant_id VARCHAR(100);`);
    sql(`ALTER TABLE public.payout_accounts ADD COLUMN IF NOT EXISTS square_access_token TEXT;`);

    // Unique partial index required by 441's assertion
    sql(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_accounts_business_active
        ON public.payout_accounts(business_id) WHERE is_active = true;
    `);
    sql(`ALTER TABLE public.payout_accounts ENABLE ROW LEVEL SECURITY;`);

    // Owner policies (needed so 446 can DROP them)
    sql(`
      DROP POLICY IF EXISTS "Business owners can view own payout accounts" ON public.payout_accounts;
      CREATE POLICY "Business owners can view own payout accounts"
        ON public.payout_accounts FOR SELECT
        USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = current_setting('request.jwt.claim.sub', true)::uuid));
    `);
    sql(`
      DROP POLICY IF EXISTS "Business owners can insert own payout accounts" ON public.payout_accounts;
      CREATE POLICY "Business owners can insert own payout accounts"
        ON public.payout_accounts FOR INSERT
        WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = current_setting('request.jwt.claim.sub', true)::uuid));
    `);
    sql(`
      DROP POLICY IF EXISTS "Business owners can update own payout accounts" ON public.payout_accounts;
      CREATE POLICY "Business owners can update own payout accounts"
        ON public.payout_accounts FOR UPDATE
        USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = current_setting('request.jwt.claim.sub', true)::uuid));
    `);

    // Grants for payout_accounts (pre-446 state)
    sql(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.payout_accounts TO service_role;
      GRANT SELECT, INSERT, UPDATE ON public.payout_accounts TO authenticated;
    `);

    // RLS + owner UPDATE policy (production state)
    sql(`ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;`);
    sql(`
      DROP POLICY IF EXISTS "owner_select" ON public.businesses;
      CREATE POLICY "owner_select" ON public.businesses FOR SELECT
        USING (owner_id = current_setting('request.jwt.claim.sub', true)::uuid);
    `);
    sql(`
      DROP POLICY IF EXISTS "owner_update" ON public.businesses;
      CREATE POLICY "owner_update" ON public.businesses FOR UPDATE
        USING (owner_id = current_setting('request.jwt.claim.sub', true)::uuid);
    `);

    // GRANTs matching production
    sql(`
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT USAGE ON SCHEMA auth TO service_role, anon, authenticated;
      GRANT SELECT, UPDATE ON public.businesses TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO service_role;
      GRANT SELECT ON auth.users TO service_role;
    `);

    // ── Create the OLD tier trigger from 181 so 442 can DROP it ──
    sql(`
      CREATE OR REPLACE FUNCTION public.prevent_tier_tampering()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.subscription_tier = NEW.subscription_tier THEN RETURN NEW; END IF;
        IF current_setting('role', true) = 'service_role' THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'subscription_tier cannot be modified directly';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_tier_tampering ON public.businesses;
      CREATE TRIGGER trg_prevent_tier_tampering
        BEFORE UPDATE ON public.businesses
        FOR EACH ROW
        WHEN (OLD.subscription_tier IS DISTINCT FROM NEW.subscription_tier)
        EXECUTE FUNCTION public.prevent_tier_tampering();
    `);

    // ── Seed test data ──
    const seedUser1 = sql(`INSERT INTO auth.users (id) VALUES ('${OWNER_ID}') ON CONFLICT DO NOTHING RETURNING id;`);
    const seedUser2 = sql(`INSERT INTO auth.users (id) VALUES ('${OWNER_ID2}') ON CONFLICT DO NOTHING RETURNING id;`);
    const seedBiz = sql(`
      INSERT INTO public.businesses (id, owner_id, name, slug, verification_level, verification_status, payout_limit_monthly, payout_mode, subscription_tier)
      VALUES ('${BIZ_ID}', '${OWNER_ID}', 'Guard Test', 'guard-test-442', 'basic', 'verified', 500000, 'platform_managed', 'free')
      ON CONFLICT (id) DO NOTHING RETURNING id;
    `);

    // Verify seeds inserted (RETURNING id gives the UUID, ON CONFLICT DO NOTHING gives empty string)
    // Either the id was returned (insert) or no error occurred (conflict = already present)
    expect(seedUser1).not.toContain('ERROR');
    expect(seedUser2).not.toContain('ERROR');
    expect(seedBiz).not.toContain('ERROR');

    // Verify the business row actually exists
    const bizExists = sql(`SELECT count(*) FROM public.businesses WHERE id = '${BIZ_ID}';`);
    expect(bizExists).toBe('1');
  });

  afterAll(() => {
    sql(`DELETE FROM public.payout_accounts WHERE business_id = '${BIZ_ID}';`);
    sql(`DELETE FROM public.businesses WHERE id = '${BIZ_ID}';`);
    sql(`DELETE FROM auth.users WHERE id IN ('${OWNER_ID}', '${OWNER_ID2}');`);
    // Clean up triggers/functions but leave the tables for other tests
    sql(`DROP TRIGGER IF EXISTS trg_guard_server_managed_columns ON public.businesses;`);
    sql(`DROP FUNCTION IF EXISTS public.guard_server_managed_columns();`);
    sql(`DROP FUNCTION IF EXISTS public.swap_payout_account(uuid,text,text,text,text,text,text,timestamptz,text,text,text);`);
    sql(`DROP FUNCTION IF EXISTS public.disconnect_payout_account(uuid);`);
  });

  // ════════════════════════════════════════════════════
  // NEGATIVE CONTROL — before applying 442
  // ════════════════════════════════════════════════════

  it('NEGATIVE CONTROL: before 442, authenticated owner CAN update verification_level', () => {
    const result = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      SET LOCAL request.jwt.claims = '{"sub":"${OWNER_ID}","role":"authenticated"}';
      UPDATE public.businesses SET verification_level = 'standard' WHERE id = '${BIZ_ID}';
      SELECT current_user;
      ROLLBACK;
    `);
    // Should NOT contain an error — the update succeeded
    expect(result).not.toContain('ERROR');
    expect(result).toContain('authenticated');
  });

  // ════════════════════════════════════════════════════
  // APPLY migrations 441, 446, then 442
  // ════════════════════════════════════════════════════

  it('applying migration 441 (payout account RPCs) from disk succeeds', () => {
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/441_payout_account_atomic_swap.sql'),
      'utf-8',
    );
    execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: migrationSql },
    );
    // Verify the 8-arg swap_payout_account was created
    const fnCount = sql(`
      SELECT count(*) FROM pg_proc
      WHERE proname = 'swap_payout_account' AND pronamespace = 'public'::regnamespace;
    `);
    expect(fnCount).toBe('1');
  });

  it('applying migration 446 (payout accounts server-only) from disk succeeds', () => {
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/446_payout_accounts_server_only.sql'),
      'utf-8',
    );
    execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: migrationSql },
    );
    // 446 drops the 8-arg overload and creates the 11-arg version — still exactly 1
    const fnCount = sql(`
      SELECT count(*) FROM pg_proc
      WHERE proname = 'swap_payout_account' AND pronamespace = 'public'::regnamespace;
    `);
    expect(fnCount).toBe('1');

    // Verify the new 11-arg signature (pronargs = 11)
    const argCount = sql(`
      SELECT pronargs FROM pg_proc
      WHERE proname = 'swap_payout_account' AND pronamespace = 'public'::regnamespace;
    `);
    expect(argCount).toBe('11');
  });

  it('applying migration 442 from disk succeeds', () => {
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/442_business_server_managed_columns.sql'),
      'utf-8',
    );
    // psql -t -A sends NOTICEs to stderr. Our sql() helper catches errors and returns
    // stderr content. For a successful migration with RAISE NOTICE, we get clean stdout.
    // Use execSync directly to capture both stdout and stderr.
    const combined = execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: migrationSql },
    );
    // The self-verification DO block uses RAISE NOTICE on success (which goes to stderr
    // in psql) or RAISE EXCEPTION on failure (which would throw execSync).
    // If we reach here without throwing, the migration succeeded.
    // Verify the trigger exists as a secondary check.
    const triggerCount = sql(`
      SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public' AND c.relname = 'businesses'
        AND t.tgname = 'trg_guard_server_managed_columns';
    `);
    expect(triggerCount).toBe('1');
  });

  // ════════════════════════════════════════════════════
  // AFTER: authenticated owner cannot update guarded columns
  // ════════════════════════════════════════════════════

  const guardedColumns: [string, string][] = [
    ['verification_level', "'standard'"],
    ['verification_status', "'rejected'"],
    ['payout_limit_monthly', '2000000'],
    ['payout_mode', "'self_managed'"],
    ['custom_fee_percentage', '5.0'],
    ['custom_fee_flat', '100'],
    ['subscription_tier', "'growth'"],
    ['owner_id', `'${OWNER_ID2}'`],
    ['reseller_id', "'00000000-0000-4000-a442-eeeeeeeeeeee'"],
  ];

  for (const [col, val] of guardedColumns) {
    it(`AFTER: authenticated owner UPDATE of ${col} → raises`, () => {
      const threw = sqlThrows(`
        BEGIN;
        SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
        SET LOCAL request.jwt.claims = '{"sub":"${OWNER_ID}","role":"authenticated"}';
        UPDATE public.businesses SET ${col} = ${val} WHERE id = '${BIZ_ID}';
        COMMIT;
      `);
      expect(threw).toBe(true);
    });
  }

  // ── Owner CAN update normal columns ──

  it('AFTER: authenticated owner UPDATE of name → ok', () => {
    const result = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      SET LOCAL request.jwt.claims = '{"sub":"${OWNER_ID}","role":"authenticated"}';
      UPDATE public.businesses SET name = 'Updated Name' WHERE id = '${BIZ_ID}';
      COMMIT;
    `);
    expect(result).not.toContain('ERROR');

    // Restore
    sql(`UPDATE public.businesses SET name = 'Guard Test' WHERE id = '${BIZ_ID}';`);
  });

  // ── service_role can update all guarded columns ──

  for (const [col, val] of guardedColumns) {
    it(`AFTER: service_role UPDATE of ${col} → ok`, () => {
      const result = sql(`
        SET ROLE service_role;
        UPDATE public.businesses SET ${col} = ${val} WHERE id = '${BIZ_ID}';
        RESET ROLE;
      `);
      expect(result).not.toContain('ERROR');

      // Reset immediately so subsequent tests see the original values
      // (especially owner_id, which affects RLS visibility)
      sql(`
        UPDATE public.businesses SET
          verification_level = 'basic', verification_status = 'verified',
          payout_limit_monthly = 500000, payout_mode = 'platform_managed',
          custom_fee_percentage = NULL, custom_fee_flat = NULL,
          subscription_tier = 'free', reseller_id = NULL,
          owner_id = '${OWNER_ID}'
        WHERE id = '${BIZ_ID}';
      `);
    });
  }

  // ── SECURITY DEFINER function owned by migration owner can update ──

  it('AFTER: SECURITY DEFINER function owned by DB owner can update guarded column', () => {
    // Create a SECURITY DEFINER test function owned by the current user (postgres/test_runner)
    sql(`
      CREATE OR REPLACE FUNCTION public._test_442_secdef_update(p_biz_id UUID)
      RETURNS VOID
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $$
      BEGIN
        UPDATE public.businesses SET payout_mode = 'direct_split' WHERE id = p_biz_id;
      END;
      $$;
    `);
    // Call it as authenticated — the function runs as the DB owner (postgres/test_runner)
    const result = sql(`
      SET ROLE authenticated;
      SELECT public._test_442_secdef_update('${BIZ_ID}');
      RESET ROLE;
    `);
    expect(result).not.toContain('ERROR');

    // Verify the change took effect
    const mode = sql(`SELECT payout_mode FROM public.businesses WHERE id = '${BIZ_ID}';`);
    expect(mode).toBe('direct_split');

    // Cleanup
    sql(`UPDATE public.businesses SET payout_mode = 'platform_managed' WHERE id = '${BIZ_ID}';`);
    sql(`DROP FUNCTION IF EXISTS public._test_442_secdef_update(UUID);`);
  });

  // ── Old trg_prevent_tier_tampering is gone ──

  it('AFTER: old trg_prevent_tier_tampering is gone', () => {
    const count = sql(`
      SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public' AND c.relname = 'businesses' AND t.tgname = 'trg_prevent_tier_tampering';
    `);
    expect(count).toBe('0');
  });

  // ── subscription_tier protection still holds (via new trigger) ──

  it('AFTER: subscription_tier protection still holds via the new guard', () => {
    const threw = sqlThrows(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      SET LOCAL request.jwt.claims = '{"sub":"${OWNER_ID}","role":"authenticated"}';
      UPDATE public.businesses SET subscription_tier = 'business' WHERE id = '${BIZ_ID}';
      COMMIT;
    `);
    expect(threw).toBe(true);
  });

  // ════════════════════════════════════════════════════
  // RPC compatibility: 441/446 RPCs + 442 guard
  // ════════════════════════════════════════════════════

  it('COMPAT: swap_payout_account as service_role succeeds with guard active', () => {
    const result = sql(`
      SET ROLE service_role;
      SELECT swap_payout_account(
        '${BIZ_ID}'::uuid,
        'paystack',
        '058',
        'Test Bank',
        '0123456789',
        'Guard Test Account'
      );
      RESET ROLE;
    `);
    expect(result).not.toContain('ERROR');
    // The result contains SET/RESET command tags plus the UUID
    expect(result).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);

    // Clean up the payout account for subsequent tests
    sql(`DELETE FROM public.payout_accounts WHERE business_id = '${BIZ_ID}';`);
  });

  it('COMPAT: swap_payout_account + payout_mode update as service_role → payout_mode changes', () => {
    // This mirrors the real app flow: call swap_payout_account, then update payout_mode
    const rpcResult = sql(`
      SET ROLE service_role;
      SELECT swap_payout_account(
        '${BIZ_ID}'::uuid,
        'square',
        NULL, NULL, NULL, NULL, NULL, NULL,
        NULL,
        'sq_merchant_test',
        'encrypted_token_test'
      );
      RESET ROLE;
    `);
    expect(rpcResult).not.toContain('ERROR');
    expect(rpcResult).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);

    // Update payout_mode as service_role (what square-callback route does)
    const modeUpdate = sql(`
      SET ROLE service_role;
      UPDATE public.businesses SET payout_mode = 'direct_split' WHERE id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(modeUpdate).not.toContain('ERROR');

    // Verify payout_mode actually changed
    const mode = sql(`SELECT payout_mode FROM public.businesses WHERE id = '${BIZ_ID}';`);
    expect(mode).toBe('direct_split');

    // Clean up
    sql(`DELETE FROM public.payout_accounts WHERE business_id = '${BIZ_ID}';`);
    sql(`UPDATE public.businesses SET payout_mode = 'platform_managed' WHERE id = '${BIZ_ID}';`);
  });

  it('COMPAT: disconnect_payout_account as service_role resets payout_mode with guard active', () => {
    // First create an active payout account so disconnect has something to deactivate
    sql(`
      SET ROLE service_role;
      SELECT swap_payout_account(
        '${BIZ_ID}'::uuid, 'paystack', '058', 'Test Bank', '0123456789', 'Test Account'
      );
      RESET ROLE;
    `);
    // Set payout_mode to direct_split first
    sql(`
      SET ROLE service_role;
      UPDATE public.businesses SET payout_mode = 'direct_split' WHERE id = '${BIZ_ID}';
      RESET ROLE;
    `);

    // Call disconnect_payout_account — this updates payout_mode inside the RPC
    const result = sql(`
      SET ROLE service_role;
      SELECT disconnect_payout_account('${BIZ_ID}'::uuid);
      RESET ROLE;
    `);
    expect(result).not.toContain('ERROR');

    // Verify payout_mode was reset to platform_managed by the RPC
    const mode = sql(`SELECT payout_mode FROM public.businesses WHERE id = '${BIZ_ID}';`);
    expect(mode).toBe('platform_managed');

    // Verify no active payout accounts remain
    const activeCount = sql(`
      SELECT count(*) FROM public.payout_accounts
      WHERE business_id = '${BIZ_ID}' AND is_active = true;
    `);
    expect(activeCount).toBe('0');

    // Clean up
    sql(`DELETE FROM public.payout_accounts WHERE business_id = '${BIZ_ID}';`);
  });

  it('COMPAT: authenticated cannot directly update payout_mode with guard active', () => {
    const threw = sqlThrows(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_ID}';
      SET LOCAL request.jwt.claims = '{"sub":"${OWNER_ID}","role":"authenticated"}';
      UPDATE public.businesses SET payout_mode = 'direct_split' WHERE id = '${BIZ_ID}';
      COMMIT;
    `);
    expect(threw).toBe(true);
  });
});
