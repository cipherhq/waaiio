/**
 * Migration 441: payout-account atomic swap/disconnect — Real PostgreSQL tests
 *
 * Runs against a disposable Postgres instance (TEST_DATABASE_URL).
 * Fails (not skips) when REQUIRE_PG_TESTS=true and TEST_DATABASE_URL is missing.
 *
 * Creates its own minimal schema, applies migration 441 from disk,
 * then tests concurrency (two pg Client connections), rollback, atomicity,
 * and permissions.
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

const BIZ_ID = '00000000-0000-0000-0000-000000441001';
const BIZ_ID2 = '00000000-0000-0000-0000-000000441002';
const BIZ_ID3 = '00000000-0000-0000-0000-000000441003';
const OWNER_ID = '00000000-0000-0000-0000-000000441010';

describeDb('Migration 441: payout account atomic RPCs', () => {
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

    // Add M080/M446 columns (may already exist from server-only test)
    sql(`ALTER TABLE public.payout_accounts ADD COLUMN IF NOT EXISTS square_merchant_id VARCHAR(100);`);
    sql(`ALTER TABLE public.payout_accounts ADD COLUMN IF NOT EXISTS square_access_token TEXT;`);

    sql(`
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.payout_accounts TO service_role;
    `);

    // Apply migration 441 then 446 from disk
    const m441Sql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/441_payout_account_atomic_swap.sql'),
      'utf-8',
    );
    const m441Result = sql(m441Sql);
    if (m441Result.includes('MIGRATION BLOCKED')) {
      throw new Error(`Migration 441 assertion failed: ${m441Result}`);
    }

    const m446Sql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/446_payout_accounts_server_only.sql'),
      'utf-8',
    );
    const m446Result = sql(m446Sql);
    if (m446Result.includes('VERIFICATION FAILED') || m446Result.includes('ERROR')) {
      throw new Error(`Migration 446 failed: ${m446Result}`);
    }
    // Verify exactly 1 overload after both migrations
    const overloadCount = sql(`SELECT count(*) FROM pg_proc WHERE proname = 'swap_payout_account' AND pronamespace = 'public'::regnamespace;`);
    if (overloadCount !== '1') {
      throw new Error(`Expected 1 swap_payout_account overload after M441+M446, got ${overloadCount}`);
    }

    // Seed test data
    sql(`INSERT INTO auth.users (id) VALUES ('${OWNER_ID}') ON CONFLICT DO NOTHING;`);
    sql(`INSERT INTO public.businesses (id, owner_id, name, payout_mode) VALUES ('${BIZ_ID}', '${OWNER_ID}', 'Swap Test Biz', 'platform_managed') ON CONFLICT (id) DO NOTHING;`);
    sql(`INSERT INTO public.businesses (id, owner_id, name, payout_mode) VALUES ('${BIZ_ID2}', '${OWNER_ID}', 'Swap Test Biz 2', 'direct_split') ON CONFLICT (id) DO NOTHING;`);
    sql(`INSERT INTO public.businesses (id, owner_id, name, payout_mode) VALUES ('${BIZ_ID3}', '${OWNER_ID}', 'Swap Test Biz 3', 'direct_split') ON CONFLICT (id) DO NOTHING;`);
  });

  afterAll(() => {
    sql(`DELETE FROM payout_accounts WHERE business_id IN ('${BIZ_ID}', '${BIZ_ID2}', '${BIZ_ID3}');`);
    sql(`DELETE FROM businesses WHERE id IN ('${BIZ_ID}', '${BIZ_ID2}', '${BIZ_ID3}');`);
    sql(`DELETE FROM auth.users WHERE id = '${OWNER_ID}';`);
  });

  function cleanAccounts(bizId?: string) {
    const ids = bizId ? `'${bizId}'` : `'${BIZ_ID}', '${BIZ_ID2}', '${BIZ_ID3}'`;
    sql(`DELETE FROM payout_accounts WHERE business_id IN (${ids});`);
  }

  function countActive(bizId: string): number {
    return parseInt(sql(`SELECT COUNT(*) FROM payout_accounts WHERE business_id = '${bizId}' AND is_active = true;`), 10);
  }

  // ════════════════════════════════════════════════════════
  // A. Permission tests
  // ════════════════════════════════════════════════════════

  it('swap_payout_account EXECUTE denied to authenticated', () => {
    expect(sql("SELECT has_function_privilege('authenticated', 'swap_payout_account(uuid,text,text,text,text,text,text,timestamptz,text,text,text)', 'EXECUTE');")).toBe('f');
  });

  it('swap_payout_account EXECUTE denied to anon', () => {
    expect(sql("SELECT has_function_privilege('anon', 'swap_payout_account(uuid,text,text,text,text,text,text,timestamptz,text,text,text)', 'EXECUTE');")).toBe('f');
  });

  it('swap_payout_account EXECUTE granted to service_role', () => {
    expect(sql("SELECT has_function_privilege('service_role', 'swap_payout_account(uuid,text,text,text,text,text,text,timestamptz,text,text,text)', 'EXECUTE');")).toBe('t');
  });

  it('disconnect_payout_account EXECUTE denied to authenticated', () => {
    expect(sql("SELECT has_function_privilege('authenticated', 'disconnect_payout_account(uuid)', 'EXECUTE');")).toBe('f');
  });

  it('disconnect_payout_account EXECUTE denied to anon', () => {
    expect(sql("SELECT has_function_privilege('anon', 'disconnect_payout_account(uuid)', 'EXECUTE');")).toBe('f');
  });

  it('disconnect_payout_account EXECUTE granted to service_role', () => {
    expect(sql("SELECT has_function_privilege('service_role', 'disconnect_payout_account(uuid)', 'EXECUTE');")).toBe('t');
  });

  it('anon gets permission denied calling swap_payout_account', () => {
    const r = sql(`BEGIN; SET LOCAL ROLE anon; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '0000000001', 'Name', NULL, NULL); COMMIT;`);
    expect(r).toMatch(/ERROR|permission denied/i);
  });

  it('authenticated gets permission denied calling swap_payout_account', () => {
    const r = sql(`BEGIN; SET LOCAL ROLE authenticated; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '0000000001', 'Name', NULL, NULL); COMMIT;`);
    expect(r).toMatch(/ERROR|permission denied/i);
  });

  // ════════════════════════════════════════════════════════
  // B. service_role happy paths (psql sequential)
  // ════════════════════════════════════════════════════════

  it('service_role can swap with no existing account', () => {
    cleanAccounts(BIZ_ID);
    const r = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Test Bank', '1234567890', 'John Doe', NULL, NOW()); COMMIT;`);
    expect(r).not.toContain('ERROR');
    expect(countActive(BIZ_ID)).toBe(1);
  });

  it('service_role can swap replacing an existing account', () => {
    cleanAccounts(BIZ_ID);
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank A', '1111111111', 'First', NULL, NULL); COMMIT;`);
    const firstId = sql(`SELECT id FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`);

    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank B', '2222222222', 'Second', NULL, NULL); COMMIT;`);
    expect(countActive(BIZ_ID)).toBe(1);
    expect(sql(`SELECT is_active FROM payout_accounts WHERE id = '${firstId}';`)).toBe('f');
    expect(sql(`SELECT account_name FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`)).toBe('Second');
  });

  // ════════════════════════════════════════════════════════
  // C. Missing business raises
  // ════════════════════════════════════════════════════════

  it('swap raises business_not_found for nonexistent business', () => {
    const r = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('00000000-0000-0000-0000-ffffffffffff', 'paystack', '058', 'Bank', '0000000001', 'Name', NULL, NULL); COMMIT;`);
    expect(r).toContain('business_not_found');
  });

  it('disconnect raises business_not_found for nonexistent business', () => {
    const r = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT disconnect_payout_account('00000000-0000-0000-0000-ffffffffffff'); COMMIT;`);
    expect(r).toContain('business_not_found');
  });

  // ════════════════════════════════════════════════════════
  // D. True concurrency — two pg Client connections
  // ════════════════════════════════════════════════════════

  it('concurrent swap: no existing account — client B blocks on row lock, exactly one active at end', async () => {
    cleanAccounts(BIZ_ID);
    const { Client } = await import('pg');
    const clientA = new Client({ connectionString: TEST_DB });
    const clientB = new Client({ connectionString: TEST_DB });
    await clientA.connect();
    await clientB.connect();

    try {
      // Client A: begin + swap, hold transaction open (locks businesses row)
      await clientA.query('BEGIN');
      await clientA.query('SET LOCAL ROLE service_role');
      const resA = await clientA.query(
        `SELECT swap_payout_account($1, 'paystack', '058', 'Bank', '1111111111', 'ClientA', NULL, NULL)`,
        [BIZ_ID],
      );
      expect(resA.rows[0].swap_payout_account).toBeTruthy();

      // Client B: begin + swap — should block because A holds the businesses row lock.
      // We race it with a short timeout to prove blocking.
      await clientB.query('BEGIN');
      await clientB.query('SET LOCAL ROLE service_role');

      let bCompleted = false;
      const bPromise = clientB.query(
        `SELECT swap_payout_account($1, 'paystack', '058', 'Bank', '2222222222', 'ClientB', NULL, NULL)`,
        [BIZ_ID],
      ).then(r => { bCompleted = true; return r; });

      // Give B 200ms to try — it should still be blocked
      await new Promise(r => setTimeout(r, 200));
      expect(bCompleted).toBe(false); // B is blocked on the row lock

      // A commits, releasing the lock
      await clientA.query('COMMIT');

      // Now B unblocks and completes
      const resB = await bPromise;
      await clientB.query('COMMIT');

      // Both succeeded in sequence; exactly one active row at the end
      expect(resA.rows[0].swap_payout_account).toBeTruthy();
      expect(resB.rows[0].swap_payout_account).toBeTruthy();
      expect(countActive(BIZ_ID)).toBe(1);

      // The active one is B's (it ran second, deactivated A's)
      expect(sql(`SELECT account_name FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`)).toBe('ClientB');
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });

  it('concurrent replacement: existing account — client B blocks, exactly one active at end', async () => {
    cleanAccounts(BIZ_ID);
    // Seed an original account
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '0000000000', 'Original', NULL, NULL); COMMIT;`);
    expect(countActive(BIZ_ID)).toBe(1);

    const { Client } = await import('pg');
    const clientA = new Client({ connectionString: TEST_DB });
    const clientB = new Client({ connectionString: TEST_DB });
    await clientA.connect();
    await clientB.connect();

    try {
      // A: replace Original
      await clientA.query('BEGIN');
      await clientA.query('SET LOCAL ROLE service_role');
      await clientA.query(
        `SELECT swap_payout_account($1, 'paystack', '058', 'Bank', '1111111111', 'ReplaceA', NULL, NULL)`,
        [BIZ_ID],
      );

      // B: also tries to replace — blocked by A's lock
      await clientB.query('BEGIN');
      await clientB.query('SET LOCAL ROLE service_role');

      let bDone = false;
      const bPromise = clientB.query(
        `SELECT swap_payout_account($1, 'paystack', '058', 'Bank', '2222222222', 'ReplaceB', NULL, NULL)`,
        [BIZ_ID],
      ).then(r => { bDone = true; return r; });

      await new Promise(r => setTimeout(r, 200));
      expect(bDone).toBe(false); // blocked

      await clientA.query('COMMIT');
      await bPromise;
      await clientB.query('COMMIT');

      // Exactly one active
      expect(countActive(BIZ_ID)).toBe(1);
      expect(sql(`SELECT account_name FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`)).toBe('ReplaceB');
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });

  // ════════════════════════════════════════════════════════
  // E. Swap rollback via trigger: INSERT failure after deactivate
  // ════════════════════════════════════════════════════════

  it('swap rollback: trigger-forced INSERT failure leaves original account active', () => {
    cleanAccounts(BIZ_ID);
    // Create a valid original account
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '1234567890', 'Original', NULL, NULL); COMMIT;`);
    const originalId = sql(`SELECT id FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`);
    expect(originalId).not.toContain('ERROR');

    // Install a BEFORE INSERT trigger that raises on payout_accounts
    sql(`
      CREATE OR REPLACE FUNCTION test_block_payout_insert() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'test_block_insert: deliberate failure';
      END;
      $$;
      CREATE TRIGGER trg_test_block_payout_insert
        BEFORE INSERT ON payout_accounts
        FOR EACH ROW EXECUTE FUNCTION test_block_payout_insert();
    `);

    try {
      // Attempt a swap — the INSERT inside the RPC will fire the trigger and fail.
      // The entire transaction (including the earlier UPDATE that deactivated the original)
      // must roll back.
      const r = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '9999999999', 'ShouldFail', NULL, NULL); COMMIT;`);
      expect(r).toContain('test_block_insert');

      // Original account must still be active
      expect(sql(`SELECT id FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`)).toBe(originalId);
      expect(countActive(BIZ_ID)).toBe(1);
    } finally {
      sql(`DROP TRIGGER IF EXISTS trg_test_block_payout_insert ON payout_accounts;`);
      sql(`DROP FUNCTION IF EXISTS test_block_payout_insert();`);
    }
  });

  // ════════════════════════════════════════════════════════
  // F. Disconnect atomicity via trigger: failure in second statement rolls back first
  // ════════════════════════════════════════════════════════

  it('disconnect atomicity: trigger failure on businesses.payout_mode UPDATE rolls back payout_accounts deactivation', () => {
    cleanAccounts(BIZ_ID3);
    sql(`UPDATE businesses SET payout_mode = 'direct_split' WHERE id = '${BIZ_ID3}';`);
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID3}', 'paystack', '058', 'Bank', '7777777777', 'Active', NULL, NULL); COMMIT;`);
    expect(countActive(BIZ_ID3)).toBe(1);

    // Install a BEFORE UPDATE trigger on businesses that raises when payout_mode changes
    sql(`
      CREATE OR REPLACE FUNCTION test_block_payout_mode_change() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payout_mode IS DISTINCT FROM OLD.payout_mode THEN
          RAISE EXCEPTION 'test_block_mode_change: deliberate failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER trg_test_block_payout_mode
        BEFORE UPDATE ON businesses
        FOR EACH ROW EXECUTE FUNCTION test_block_payout_mode_change();
    `);

    try {
      // disconnect_payout_account does: UPDATE payout_accounts (deactivate) then UPDATE businesses (payout_mode).
      // The trigger fires on the second UPDATE and raises, rolling back everything.
      const r = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT disconnect_payout_account('${BIZ_ID3}'); COMMIT;`);
      expect(r).toContain('test_block_mode_change');

      // The payout account must STILL be active (first UPDATE was rolled back)
      expect(countActive(BIZ_ID3)).toBe(1);
      // payout_mode unchanged
      expect(sql(`SELECT payout_mode FROM businesses WHERE id = '${BIZ_ID3}';`)).toBe('direct_split');
    } finally {
      sql(`DROP TRIGGER IF EXISTS trg_test_block_payout_mode ON businesses;`);
      sql(`DROP FUNCTION IF EXISTS test_block_payout_mode_change();`);
    }
  });

  // ════════════════════════════════════════════════════════
  // G. Disconnect happy path
  // ════════════════════════════════════════════════════════

  it('disconnect deactivates account and resets payout_mode atomically', () => {
    cleanAccounts(BIZ_ID);
    sql(`UPDATE businesses SET payout_mode = 'direct_split' WHERE id = '${BIZ_ID}';`);
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '1234567890', 'Active', NULL, NULL); COMMIT;`);
    expect(countActive(BIZ_ID)).toBe(1);

    const r = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT disconnect_payout_account('${BIZ_ID}'); COMMIT;`);
    expect(r).not.toContain('ERROR');
    expect(countActive(BIZ_ID)).toBe(0);
    expect(sql(`SELECT payout_mode FROM businesses WHERE id = '${BIZ_ID}';`)).toBe('platform_managed');
  });

  // ════════════════════════════════════════════════════════
  // H. Rollback on NULL gateway (NOT NULL constraint failure)
  // ════════════════════════════════════════════════════════

  it('NOT NULL constraint failure preserves the original active account', () => {
    cleanAccounts(BIZ_ID);
    sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', 'paystack', '058', 'Bank', '1234567890', 'Original', NULL, NULL); COMMIT;`);
    const originalId = sql(`SELECT id FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`);

    const r = sql(`BEGIN; SET LOCAL ROLE service_role; SELECT swap_payout_account('${BIZ_ID}', NULL, '058', 'Bank', '9999999999', 'Bad', NULL, NULL); COMMIT;`);
    expect(r).toContain('ERROR');
    expect(sql(`SELECT id FROM payout_accounts WHERE business_id = '${BIZ_ID}' AND is_active = true;`)).toBe(originalId);
    expect(countActive(BIZ_ID)).toBe(1);
  });
});
