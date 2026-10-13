/**
 * Migration 442: server-managed business columns guard — Real PostgreSQL tests
 *
 * Runs against a disposable Postgres instance (TEST_DATABASE_URL).
 * Fails (not skips) when REQUIRE_PG_TESTS=true and TEST_DATABASE_URL is missing.
 *
 * Builds its own minimal schema, creates the OLD tier trigger (181),
 * runs a negative control (verification_level update succeeds before 442),
 * applies migration 442 from disk, then tests all 9 guarded columns.
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

const OWNER_ID = '00000000-0000-4000-f442-000000000001';
const BIZ_ID   = '00000000-0000-4000-a442-000000000001';

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

    // Add columns if they don't exist (for re-runs on shared DB)
    for (const col of [
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
    sql(`INSERT INTO auth.users (id) VALUES ('${OWNER_ID}') ON CONFLICT DO NOTHING;`);
    sql(`
      INSERT INTO public.businesses (id, owner_id, name, slug, verification_level, verification_status, payout_limit_monthly, payout_mode, subscription_tier)
      VALUES ('${BIZ_ID}', '${OWNER_ID}', 'Guard Test', 'guard-test-442', 'basic', 'verified', 500000, 'platform_managed', 'free')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    sql(`DELETE FROM public.businesses WHERE id = '${BIZ_ID}';`);
    sql(`DELETE FROM auth.users WHERE id = '${OWNER_ID}';`);
    // Clean up triggers/functions but leave the table for other tests
    sql(`DROP TRIGGER IF EXISTS trg_guard_server_managed_columns ON public.businesses;`);
    sql(`DROP FUNCTION IF EXISTS public.guard_server_managed_columns();`);
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
  // APPLY migration 442
  // ════════════════════════════════════════════════════

  it('applying migration 442 from disk succeeds', () => {
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/442_business_server_managed_columns.sql'),
      'utf-8',
    );
    const result = sql(migrationSql);
    if (result.includes('FAIL')) {
      throw new Error(`Migration 442 self-verification failed: ${result}`);
    }
    expect(result).toContain('PASS');
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
    ['owner_id', `'${OWNER_ID}'`],
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
    });
  }

  // Reset guarded columns after service_role tests
  afterAll(() => {
    sql(`
      UPDATE public.businesses SET
        verification_level = 'basic', verification_status = 'verified',
        payout_limit_monthly = 500000, payout_mode = 'platform_managed',
        custom_fee_percentage = NULL, custom_fee_flat = NULL,
        subscription_tier = 'free', reseller_id = NULL
      WHERE id = '${BIZ_ID}';
    `);
  });

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
});
