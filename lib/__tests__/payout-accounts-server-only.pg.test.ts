/**
 * M446: payout_accounts server-only privileges — real PostgreSQL tests.
 *
 * Creates its own minimal schema, reproduces pre-446 production state,
 * runs a negative control (INSERT as authenticated succeeds before M446),
 * applies M441 + M446 from disk, then verifies all privilege changes.
 *
 * Uses psql/execSync like payout-account-swap.pg.test.ts for consistency.
 * File order: swap runs first (alphabetical), then this file. Safe because
 * this file re-applies M441 (CREATE OR REPLACE) then M446 (drops 8-arg,
 * creates 11-arg). Swap's tests already completed against the 8-arg.
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

const BIZ_ID = '00000000-0000-0000-0000-000000446001';
const OWNER_ID = '00000000-0000-0000-0000-000000446010';

describeDb('M446: payout_accounts server-only privileges (real PG)', () => {
  let preInsertResult: string;

  beforeAll(() => {
    // ── Minimal schema (IF NOT EXISTS — safe with swap test) ──
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

    // auth.uid() — only create if absent (bootstrap may already have it)
    sql(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = 'auth' AND p.proname = 'uid') THEN
          EXECUTE 'CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $fn$ SELECT NULLIF(current_setting(''request.jwt.claims'', true)::json->>''sub'', '''')::UUID $fn$';
        END IF;
      END $$;
    `);

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
    sql(`ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS payout_mode VARCHAR(20) NOT NULL DEFAULT 'platform_managed';`);

    sql(`
      CREATE TABLE IF NOT EXISTS public.payout_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
        gateway VARCHAR(20) NOT NULL,
        subaccount_code VARCHAR(100),
        stripe_account_id VARCHAR(100),
        square_merchant_id VARCHAR(100),
        square_access_token TEXT,
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

    sql(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_accounts_business_active
        ON public.payout_accounts(business_id) WHERE is_active = true;
    `);

    // ── Pre-446 production state ──
    sql(`ALTER TABLE public.payout_accounts ENABLE ROW LEVEL SECURITY;`);
    sql(`
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT USAGE ON SCHEMA auth TO service_role, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.payout_accounts TO service_role;
      GRANT SELECT, INSERT, UPDATE ON public.payout_accounts TO authenticated;
    `);

    // M009-style owner policies (pre-446)
    sql(`DROP POLICY IF EXISTS "Business owners can view own payout accounts" ON public.payout_accounts;`);
    sql(`CREATE POLICY "Business owners can view own payout accounts" ON public.payout_accounts FOR SELECT USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));`);
    sql(`DROP POLICY IF EXISTS "Business owners can insert own payout accounts" ON public.payout_accounts;`);
    sql(`CREATE POLICY "Business owners can insert own payout accounts" ON public.payout_accounts FOR INSERT WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));`);
    sql(`DROP POLICY IF EXISTS "Business owners can update own payout accounts" ON public.payout_accounts;`);
    sql(`CREATE POLICY "Business owners can update own payout accounts" ON public.payout_accounts FOR UPDATE USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));`);

    // Seed test data
    sql(`INSERT INTO auth.users (id) VALUES ('${OWNER_ID}') ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.businesses (id, owner_id, name, slug) VALUES ('${BIZ_ID}', '${OWNER_ID}', 'M446 Test Biz', 'm446-test') ON CONFLICT (id) DO NOTHING;`);

    // ── PRE-446 NEGATIVE CONTROL ──
    // Prove authenticated CAN insert before M446 revokes the privilege.
    // Also set request.jwt.claim.sub (Supabase v2 format) for auth.uid().
    const insertResult = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims', '{"sub":"${OWNER_ID}","role":"authenticated"}', true);
      SELECT set_config('request.jwt.claim.sub', '${OWNER_ID}', true);
      SELECT set_config('request.jwt.claim.sub', '${OWNER_ID}', true);
      DO $$ BEGIN IF current_user != 'authenticated' THEN RAISE EXCEPTION 'wrong role: %', current_user; END IF; END $$;
      INSERT INTO public.payout_accounts (business_id, gateway) VALUES ('${BIZ_ID}', 'paystack') RETURNING id;
      ROLLBACK;
    `);
    if (insertResult.startsWith('ERROR')) {
      throw new Error(`PRE-446 negative control FAILED: authenticated INSERT should succeed before M446. Got: ${insertResult}`);
    }
    preInsertResult = insertResult;

    // ── Apply M441 then M446 from disk ──
    const m441 = readFileSync(resolve(process.cwd(), 'supabase/migrations/441_payout_account_atomic_swap.sql'), 'utf-8');
    const m441Result = sql(m441);
    if (m441Result.includes('MIGRATION BLOCKED')) {
      throw new Error(`M441 assertion failed: ${m441Result}`);
    }

    const m446 = readFileSync(resolve(process.cwd(), 'supabase/migrations/446_payout_accounts_server_only.sql'), 'utf-8');
    const m446Result = sql(m446);
    if (m446Result.includes('VERIFICATION FAILED')) {
      throw new Error(`M446 verification failed: ${m446Result}`);
    }
  });

  afterAll(() => {
    sql(`DELETE FROM payout_accounts WHERE business_id = '${BIZ_ID}';`);
    sql(`DELETE FROM businesses WHERE id = '${BIZ_ID}';`);
    sql(`DELETE FROM auth.users WHERE id = '${OWNER_ID}';`);
    sql(`DELETE FROM oauth_connect_states WHERE business_id = '${BIZ_ID}';`);
  });

  // ── Pre-446 control ──

  it('PRE-446: authenticated INSERT succeeded (negative control)', () => {
    expect(preInsertResult).not.toContain('ERROR');
    expect(preInsertResult.length).toBeGreaterThan(0);
  });

  // ── Post-446 privilege checks ──

  it('POST-446: authenticated INSERT raises 42501', () => {
    const result = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims', '{"sub":"${OWNER_ID}","role":"authenticated"}', true);
      SELECT set_config('request.jwt.claim.sub', '${OWNER_ID}', true);
      DO $$ BEGIN IF current_user != 'authenticated' THEN RAISE EXCEPTION 'wrong role: %', current_user; END IF; END $$;
      INSERT INTO public.payout_accounts (business_id, gateway) VALUES ('${BIZ_ID}', 'paystack');
      ROLLBACK;
    `);
    expect(result).toContain('42501');
  });

  it('POST-446: authenticated UPDATE raises 42501', () => {
    sql(`INSERT INTO public.payout_accounts (id, business_id, gateway, is_active) VALUES (gen_random_uuid(), '${BIZ_ID}', 'paystack', true);`);
    const result = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims', '{"sub":"${OWNER_ID}","role":"authenticated"}', true);
      SELECT set_config('request.jwt.claim.sub', '${OWNER_ID}', true);
      DO $$ BEGIN IF current_user != 'authenticated' THEN RAISE EXCEPTION 'wrong role: %', current_user; END IF; END $$;
      UPDATE public.payout_accounts SET bank_name = 'hacked' WHERE business_id = '${BIZ_ID}';
      ROLLBACK;
    `);
    expect(result).toContain('42501');
    sql(`DELETE FROM payout_accounts WHERE business_id = '${BIZ_ID}';`);
  });

  it('POST-446: authenticated SELECT square_access_token raises 42501', () => {
    sql(`INSERT INTO public.payout_accounts (id, business_id, gateway, square_access_token, is_active) VALUES (gen_random_uuid(), '${BIZ_ID}', 'square', 'secret_token', true);`);
    const result = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims', '{"sub":"${OWNER_ID}","role":"authenticated"}', true);
      SELECT set_config('request.jwt.claim.sub', '${OWNER_ID}', true);
      DO $$ BEGIN IF current_user != 'authenticated' THEN RAISE EXCEPTION 'wrong role: %', current_user; END IF; END $$;
      SELECT square_access_token FROM public.payout_accounts WHERE business_id = '${BIZ_ID}';
      ROLLBACK;
    `);
    expect(result).toContain('42501');
    sql(`DELETE FROM payout_accounts WHERE business_id = '${BIZ_ID}';`);
  });

  it('POST-446: authenticated owner can SELECT granted columns', () => {
    sql(`INSERT INTO public.payout_accounts (id, business_id, gateway, bank_name, account_number, is_active) VALUES (gen_random_uuid(), '${BIZ_ID}', 'paystack', 'Test Bank', '1234567890', true);`);
    const result = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims', '{"sub":"${OWNER_ID}","role":"authenticated"}', true);
      SELECT set_config('request.jwt.claim.sub', '${OWNER_ID}', true);
      DO $$ BEGIN IF current_user != 'authenticated' THEN RAISE EXCEPTION 'wrong role: %', current_user; END IF; END $$;
      SELECT bank_name, account_number FROM public.payout_accounts WHERE business_id = '${BIZ_ID}';
      ROLLBACK;
    `);
    expect(result).toContain('Test Bank');
    expect(result).toContain('1234567890');
    sql(`DELETE FROM payout_accounts WHERE business_id = '${BIZ_ID}';`);
  });

  it('POST-446: service_role INSERT + SELECT succeeds (positive control)', () => {
    const result = sql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      DO $$ BEGIN IF current_user != 'service_role' THEN RAISE EXCEPTION 'wrong role: %', current_user; END IF; END $$;
      INSERT INTO public.payout_accounts (id, business_id, gateway, square_access_token, is_active) VALUES (gen_random_uuid(), '${BIZ_ID}', 'square', 'service_secret', true) RETURNING id;
      ROLLBACK;
    `);
    expect(result).not.toContain('ERROR');
    expect(result.length).toBeGreaterThan(10);
  });

  it('POST-446: oauth_connect_states not readable by authenticated', () => {
    const result = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims', '{"sub":"${OWNER_ID}","role":"authenticated"}', true);
      SELECT set_config('request.jwt.claim.sub', '${OWNER_ID}', true);
      DO $$ BEGIN IF current_user != 'authenticated' THEN RAISE EXCEPTION 'wrong role: %', current_user; END IF; END $$;
      SELECT * FROM public.oauth_connect_states;
      ROLLBACK;
    `);
    expect(result).toContain('42501');
  });

  it('POST-446: exactly 1 swap_payout_account overload in pg_proc', () => {
    const count = sql(`SELECT count(*) FROM pg_proc WHERE proname = 'swap_payout_account' AND pronamespace = 'public'::regnamespace;`);
    expect(count).toBe('1');
  });
});
