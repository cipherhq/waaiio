/**
 * Stripe Recurring Finalization — Real PostgreSQL Database Tests (#177)
 *
 * Proves finalize_stripe_recurring_charge is concurrent-safe, idempotent, and
 * produces correct financial records. Applies ALL real repo migrations (same as CI).
 *
 * Requires TEST_DATABASE_URL (always — no skip allowed).
 *
 * Local:
 *   docker run --rm -d --name stripe-fin-test -p 54324:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54324/postgres npx vitest run lib/__tests__/stripe-recurring-finalization-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const dbUrl = process.env.TEST_DATABASE_URL;

// ── psql helpers (same pattern as recurring-billing-db.test.ts) ──

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  });
  return raw.split('\n').filter(l => {
    const t = l.trim();
    return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT|NOTICE)\b/.test(t);
  }).join('\n').trim();
}

function psqlJson(sql: string): any {
  const raw = psql(sql);
  return raw ? JSON.parse(raw) : null;
}

function runTwoSessions(
  sqlA: string,
  sqlB: string,
): Promise<{ a: { stdout: string }; b: { stdout: string } }> {
  const { exec } = require('child_process') as typeof import('child_process');
  function execPsql(sql: string): Promise<{ stdout: string }> {
    return new Promise((resolve) => {
      const child = exec(
        `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
        { timeout: 15000, encoding: 'utf-8' },
        (_error, stdout) => resolve({ stdout: (stdout || '').trim() }),
      );
      child.stdin!.write(sql);
      child.stdin!.end();
    });
  }
  return new Promise(async (resolve) => {
    const promiseA = execPsql(sqlA);
    await new Promise(r => setTimeout(r, 500));
    const promiseB = execPsql(sqlB);
    const [a, b] = await Promise.all([promiseA, promiseB]);
    resolve({ a, b });
  });
}

// ── Fixed UUIDs ──
const BIZ_ID   = '77aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID  = '77bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SUB_ID_A = '77cccccc-cccc-cccc-cccc-cccccccccc01';
const SUB_ID_B = '77cccccc-cccc-cccc-cccc-cccccccccc02';

// CI enforces zero skips via the workflow step. Local runs without TEST_DATABASE_URL skip gracefully.
describe.skipIf(!dbUrl)('Stripe Recurring Finalization: Real PostgreSQL database tests (#177)', () => {
  beforeAll(() => {
    // ── 1 & 2. Apply schema stubs + all migrations ──
    // In CI, MIGRATIONS_PRE_APPLIED=1 is set by the workflow step (which applies
    // stubs + all migrations via bash before invoking vitest — faster and avoids
    // vitest hookTimeout issues with synchronous execSync blocking 60+ seconds).
    // Locally, we apply everything here.
    if (!process.env.MIGRATIONS_PRE_APPLIED) {
      psql(`
        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE SCHEMA IF NOT EXISTS extensions;
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
          SELECT '00000000-0000-0000-0000-000000000000'::UUID;
        $$ LANGUAGE SQL STABLE;
        CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
          SELECT 'authenticated'::TEXT;
        $$ LANGUAGE SQL STABLE;
        CREATE TABLE IF NOT EXISTS auth.users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT,
          raw_app_meta_data JSONB DEFAULT '{}'
        );
        DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
        DO $$ BEGIN CREATE PUBLICATION supabase_realtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        CREATE SCHEMA IF NOT EXISTS storage;
        CREATE TABLE IF NOT EXISTS storage.buckets (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, public BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS storage.objects (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id TEXT REFERENCES storage.buckets(id),
          name TEXT, owner UUID, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
        CREATE OR REPLACE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[] AS $$
          SELECT string_to_array(name, '/');
        $$ LANGUAGE SQL IMMUTABLE;
      `);
      const migrationsDir = path.resolve('supabase/migrations');
      execSync(
        `for f in "${migrationsDir}"/*.sql; do psql "${dbUrl}" -q -v ON_ERROR_STOP=1 -f "$f" || exit 1; done`,
        { encoding: 'utf-8', timeout: 300000, shell: '/bin/bash' },
      );
    }

    // ── 3. Insert fixture data (requires auth.users + profiles for NOT NULL FKs) ──
    psql(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id, email) VALUES ('${USER_ID}', 'stripe-fin-test@test.local')
        ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;

      INSERT INTO profiles (id, first_name, last_name, email)
        VALUES ('${USER_ID}', 'Test', 'User', 'stripe-fin-test@test.local')
        ON CONFLICT DO NOTHING;

      INSERT INTO businesses (id, owner_id, name, slug, address, city, neighborhood, phone,
        status, subscription_tier, trial_ends_at, payout_mode, country_code)
        VALUES ('${BIZ_ID}', '${USER_ID}', 'Stripe Fin Test Biz', 'stripe-fin-test-177',
          '1 Test St', 'Lagos', 'VI', '+10000000000',
          'active', 'free', NOW() - INTERVAL '1 day', 'platform', 'US')
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO platform_settings (key, value)
        VALUES ('pricing_tiers', '{"free":{"feePercentage":2.5,"feeFlat":0},"growth":{"feePercentage":1.5,"feeFlat":0},"business":{"feePercentage":1.5,"feeFlat":0}}'::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    `);

    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });
    createSub(SUB_ID_B, { code: 'sub_test_yyy', amount: 50 });
  }, 120000); // Migration application can take 30+ seconds in CI

  afterAll(() => {
    if (!dbUrl) return;
    psql(`
      DELETE FROM stripe_recurring_finalizations;
      DELETE FROM payment_spend_applications;
      DELETE FROM platform_fees;
      DELETE FROM subscription_charges;
      DELETE FROM payments;
      DELETE FROM bookings;
      DELETE FROM customer_subscriptions WHERE business_id = '${BIZ_ID}';
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM profiles WHERE id = '${USER_ID}';
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id = '${USER_ID}';
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
      DELETE FROM platform_settings WHERE key = 'pricing_tiers';
    `);
  });

  // ── Fixture helpers ──

  function createSub(
    subId: string,
    opts: { gateway?: string; status?: string; code?: string; amount?: number } = {},
  ) {
    psql(`
      INSERT INTO customer_subscriptions (
        id, business_id, user_id, amount, currency, frequency,
        status, gateway, gateway_subscription_code,
        customer_name, customer_phone,
        next_charge_at, charge_count, total_charged, failure_count
      ) VALUES (
        '${subId}', '${BIZ_ID}', '${USER_ID}',
        ${opts.amount ?? 50}, 'USD', 'monthly',
        '${opts.status ?? 'active'}', '${opts.gateway ?? 'stripe'}',
        '${opts.code ?? ('sub_test_' + subId.slice(-4))}',
        'Test Customer', '+1234567890',
        NOW() - INTERVAL '1 day', 0, 0, 0
      ) ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        gateway = EXCLUDED.gateway,
        gateway_subscription_code = EXCLUDED.gateway_subscription_code,
        amount = EXCLUDED.amount,
        charge_count = 0,
        total_charged = 0,
        failure_count = 0,
        next_charge_at = NOW() - INTERVAL '1 day';
    `);
  }

  function cleanFinData() {
    psql(`
      DELETE FROM stripe_recurring_finalizations;
      DELETE FROM payment_spend_applications;
      DELETE FROM platform_fees;
      DELETE FROM subscription_charges;
      DELETE FROM payments;
      DELETE FROM bookings WHERE business_id = '${BIZ_ID}';
    `);
    // Reset subscription counters
    psql(`
      UPDATE customer_subscriptions SET
        charge_count = 0, total_charged = 0, failure_count = 0,
        next_charge_at = NOW() - INTERVAL '1 day'
      WHERE business_id = '${BIZ_ID}';
    `);
  }

  // ─────────────────────────────────────────────────────────
  // a. Fresh finalization: full write proof
  // ─────────────────────────────────────────────────────────
  it('a. fresh finalization — full write proof', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid,
        'in_fresh_001',
        'sub_test_xxx',
        5000, 'USD', 'pi_fresh_001'
      );
    `);

    expect(result.success).toBe(true);
    expect(result.already_finalized).toBe(false);
    expect(result.payment_id).toBeTruthy();
    expect(result.booking_id).toBeTruthy();
    expect(result.booking_ref).toBeTruthy();

    // Booking exists
    const bookCount = psql(`SELECT COUNT(*) FROM bookings WHERE id = '${result.booking_id}'`);
    expect(bookCount).toBe('1');

    // Payment exists with gateway_reference = PI ID
    const payRef = psql(`SELECT gateway_reference FROM payments WHERE id = '${result.payment_id}'`);
    expect(payRef).toBe('pi_fresh_001');

    // Subscription charge record
    const chargeCount = psql(`SELECT COUNT(*) FROM subscription_charges WHERE payment_id = '${result.payment_id}'`);
    expect(chargeCount).toBe('1');

    // Platform fee record
    const feeCount = psql(`SELECT COUNT(*) FROM platform_fees WHERE booking_id = '${result.booking_id}'`);
    expect(feeCount).toBe('1');

    // Spend marker (payment_spend_applications)
    const spendCount = psql(`SELECT COUNT(*) FROM payment_spend_applications WHERE payment_id = '${result.payment_id}'`);
    expect(spendCount).toBe('1');

    // Finalization marker
    const finCount = psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_fresh_001'`);
    expect(finCount).toBe('1');

    // Subscription counters updated
    const subParts = psql(
      `SELECT charge_count, total_charged FROM customer_subscriptions WHERE id = '${SUB_ID_A}'`,
    ).split('|');
    expect(parseInt(subParts[0])).toBe(1);
    expect(parseFloat(subParts[1])).toBe(50);
  });

  // ─────────────────────────────────────────────────────────
  // b. Exact replay: same params → already_finalized=true, zero additional rows
  // ─────────────────────────────────────────────────────────
  it('b. exact replay — already_finalized=true, same canonical IDs, zero additional rows', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    const fresh = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_replay_001', 'sub_test_xxx',
        5000, 'USD', 'pi_replay_001'
      );
    `);
    expect(fresh.success).toBe(true);
    expect(fresh.already_finalized).toBe(false);

    // Replay with identical params
    const replay = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_replay_001', 'sub_test_xxx',
        5000, 'USD', 'pi_replay_001'
      );
    `);
    expect(replay.success).toBe(true);
    expect(replay.already_finalized).toBe(true);
    expect(replay.payment_id).toBe(fresh.payment_id);
    expect(replay.booking_id).toBe(fresh.booking_id);
    expect(replay.booking_ref).toBe(fresh.booking_ref);

    // Zero additional rows of any kind
    expect(psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_replay_001'`)).toBe('1');
    expect(psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'pi_replay_001'`)).toBe('1');
    expect(psql(`SELECT COUNT(*) FROM bookings WHERE business_id = '${BIZ_ID}'`)).toBe('1');
    expect(psql(`SELECT COUNT(*) FROM subscription_charges WHERE subscription_id = '${SUB_ID_A}'`)).toBe('1');

    // Counters not double-incremented
    const subParts = psql(
      `SELECT charge_count, total_charged FROM customer_subscriptions WHERE id = '${SUB_ID_A}'`,
    ).split('|');
    expect(parseInt(subParts[0])).toBe(1);
    expect(parseFloat(subParts[1])).toBe(50);
  });

  // ─────────────────────────────────────────────────────────
  // c. All replay mismatches: each returns success=false with specific reason
  // ─────────────────────────────────────────────────────────
  it('c. replay amount mismatch → success=false, reason=replay_amount_mismatch', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_mismatch_amount', 'sub_test_xxx',
        5000, 'USD', 'pi_mismatch_amount_001'
      );
    `);

    const replay = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_mismatch_amount', 'sub_test_xxx',
        9900, 'USD', 'pi_mismatch_amount_001'
      );
    `);
    expect(replay.success).toBe(false);
    expect(replay.reason).toBe('replay_amount_mismatch');
  });

  it('c. replay currency mismatch → success=false, reason=replay_currency_mismatch', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_mismatch_currency', 'sub_test_xxx',
        5000, 'USD', 'pi_mismatch_currency_001'
      );
    `);

    const replay = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_mismatch_currency', 'sub_test_xxx',
        5000, 'GBP', 'pi_mismatch_currency_001'
      );
    `);
    expect(replay.success).toBe(false);
    expect(replay.reason).toBe('replay_currency_mismatch');
  });

  it('c. replay subscription mismatch → success=false, reason=replay_subscription_mismatch', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });
    createSub(SUB_ID_B, { code: 'sub_test_yyy', amount: 50 });

    psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_mismatch_sub', 'sub_test_xxx',
        5000, 'USD', 'pi_mismatch_sub_001'
      );
    `);

    const replay = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_B}'::uuid, 'in_mismatch_sub', 'sub_test_yyy',
        5000, 'USD', 'pi_mismatch_sub_001'
      );
    `);
    expect(replay.success).toBe(false);
    expect(replay.reason).toBe('replay_subscription_mismatch');
  });

  it('c. replay PI ref mismatch → success=false, reason=replay_provider_ref_mismatch', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_mismatch_pi', 'sub_test_xxx',
        5000, 'USD', 'pi_correct_001'
      );
    `);

    const replay = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_mismatch_pi', 'sub_test_xxx',
        5000, 'USD', 'pi_wrong_002'
      );
    `);
    expect(replay.success).toBe(false);
    expect(replay.reason).toBe('replay_provider_ref_mismatch');

    // Finalization row retains original PI
    const finRef = psql(`SELECT provider_payment_ref FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_mismatch_pi'`);
    expect(finRef).toBe('pi_correct_001');
  });

  // ─────────────────────────────────────────────────────────
  // d. Same invoice concurrent: advisory lock — one fresh, one replay
  // ─────────────────────────────────────────────────────────
  it('d. same invoice concurrent → one fresh, one replay with canonical IDs', async () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    const rpcCall = () => `
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid,
        'in_concurrent_001',
        'sub_test_xxx',
        5000, 'USD', 'pi_concurrent_001'
      );
    `;

    const { a, b } = await runTwoSessions(rpcCall(), rpcCall());
    const resultA = JSON.parse(a.stdout || '{}');
    const resultB = JSON.parse(b.stdout || '{}');

    // Both succeed
    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);

    // Exactly one is fresh, the other is replay
    const fresh = [resultA, resultB].find(r => !r.already_finalized);
    const replay = [resultA, resultB].find(r => r.already_finalized);
    expect(fresh).toBeDefined();
    expect(replay).toBeDefined();

    // Canonical IDs match
    expect(replay!.payment_id).toBe(fresh!.payment_id);
    expect(replay!.booking_id).toBe(fresh!.booking_id);

    // Exactly one finalization row
    const finCount = psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_concurrent_001'`);
    expect(finCount).toBe('1');

    // Counter incremented exactly once
    const subParts = psql(
      `SELECT charge_count, total_charged FROM customer_subscriptions WHERE id = '${SUB_ID_A}'`,
    ).split('|');
    expect(parseInt(subParts[0])).toBe(1);
    expect(parseFloat(subParts[1])).toBe(50);
  });

  // ─────────────────────────────────────────────────────────
  // e. Same invoice different subscription: mismatch, zero mutation for wrong sub
  // ─────────────────────────────────────────────────────────
  it('e. same invoice different subscription → one succeeds, one gets replay_subscription_mismatch', async () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_concurrent_a', amount: 50 });
    createSub(SUB_ID_B, { code: 'sub_test_concurrent_b', amount: 50 });

    const rpcCallA = `
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_diff_sub_same_inv', 'sub_test_concurrent_a',
        5000, 'USD', 'pi_diff_sub_001'
      );
    `;
    const rpcCallB = `
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_B}'::uuid, 'in_diff_sub_same_inv', 'sub_test_concurrent_b',
        5000, 'USD', 'pi_diff_sub_001'
      );
    `;

    const { a, b } = await runTwoSessions(rpcCallA, rpcCallB);
    const resultA = JSON.parse(a.stdout || '{}');
    const resultB = JSON.parse(b.stdout || '{}');

    // One succeeds (fresh), one fails with subscription mismatch
    const succeeded = [resultA, resultB].filter(r => r.success === true);
    const failed = [resultA, resultB].filter(r => r.success === false);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBe('replay_subscription_mismatch');

    // Only one finalization row
    const finCount = psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_diff_sub_same_inv'`);
    expect(finCount).toBe('1');
  });

  // ─────────────────────────────────────────────────────────
  // f. Different invoices same subscription: both finalize, charge_count=2, total=100
  // ─────────────────────────────────────────────────────────
  it('f. different invoices same subscription → both finalize, charge_count=2, total_charged=100', async () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    const rpcCallA = `
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_diff_inv_001', 'sub_test_xxx',
        5000, 'USD', 'pi_diff_inv_001'
      );
    `;
    const rpcCallB = `
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_diff_inv_002', 'sub_test_xxx',
        5000, 'USD', 'pi_diff_inv_002'
      );
    `;

    const { a, b } = await runTwoSessions(rpcCallA, rpcCallB);
    const resultA = JSON.parse(a.stdout || '{}');
    const resultB = JSON.parse(b.stdout || '{}');

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);
    expect(resultA.already_finalized).toBe(false);
    expect(resultB.already_finalized).toBe(false);

    // Two finalization rows
    const finCount = psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE customer_subscription_id = '${SUB_ID_A}'`);
    expect(finCount).toBe('2');

    // Counters: charge_count=2, total_charged=100
    const subParts = psql(
      `SELECT charge_count, total_charged FROM customer_subscriptions WHERE id = '${SUB_ID_A}'`,
    ).split('|');
    expect(parseInt(subParts[0])).toBe(2);
    expect(parseFloat(subParts[1])).toBe(100);
  });

  // ─────────────────────────────────────────────────────────
  // g. Spend rollback: NULL from apply_payment_spend_once → no finalization marker, no payment
  // ─────────────────────────────────────────────────────────
  it('g. spend rollback — NULL from apply_payment_spend_once rolls back all writes', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    // Temporarily replace apply_payment_spend_once with a stub that returns NULL
    psql(`
      CREATE OR REPLACE FUNCTION apply_payment_spend_once(p_payment_id UUID) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN RETURN NULL; END;
      $$;
    `);

    try {
      // Expect the RPC to RAISE EXCEPTION (rolls back entire transaction)
      let threw = false;
      try {
        psqlJson(`
          SELECT finalize_stripe_recurring_charge(
            '${SUB_ID_A}'::uuid, 'in_spend_rollback', 'sub_test_xxx',
            5000, 'USD', 'pi_spend_rollback_001'
          );
        `);
      } catch {
        threw = true;
      }
      // psql with ON_ERROR_STOP=1 will throw when RAISE EXCEPTION fires
      expect(threw).toBe(true);

      // No finalization marker — the terminal marker was never inserted
      const finCount = psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_spend_rollback'`);
      expect(finCount).toBe('0');

      // No payment record — all writes rolled back
      const payCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'pi_spend_rollback_001'`);
      expect(payCount).toBe('0');

      // Subscription counters unchanged
      const chargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${SUB_ID_A}'`);
      expect(parseInt(chargeCount)).toBe(0);
    } finally {
      // IMMEDIATELY restore the real apply_payment_spend_once from migration 334
      execSync(
        `psql "${dbUrl}" -q -v ON_ERROR_STOP=1 -f "${path.resolve('supabase/migrations/334_payment_spend_marker.sql')}"`,
        { encoding: 'utf-8', timeout: 30000 },
      );
    }
  });

  // ─────────────────────────────────────────────────────────
  // h. Wrong gateway: gateway='paystack' → success=false, reason=wrong_gateway
  // ─────────────────────────────────────────────────────────
  it('h. wrong gateway (paystack) → success=false, reason=wrong_gateway', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50, gateway: 'paystack' });

    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_wrong_gw', 'sub_test_xxx',
        5000, 'USD', 'pi_wrong_gw_001'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('wrong_gateway');

    // Restore correct gateway for subsequent tests
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50, gateway: 'stripe' });
  });

  // ─────────────────────────────────────────────────────────
  // i. Wrong status: status='cancelled' → success=false, reason=wrong_status
  // ─────────────────────────────────────────────────────────
  it('i. wrong status (cancelled) → success=false, reason=wrong_status', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50, status: 'cancelled' });

    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_wrong_status', 'sub_test_xxx',
        5000, 'USD', 'pi_wrong_status_001'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('wrong_status');

    // Restore active status
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50, status: 'active' });
  });

  // ─────────────────────────────────────────────────────────
  // j. Subscription code mismatch: pass wrong sub_ code → success=false
  // ─────────────────────────────────────────────────────────
  it('j. subscription code mismatch → success=false, reason=subscription_code_mismatch', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_code_mismatch', 'sub_wrong_code_zzz',
        5000, 'USD', 'pi_code_mismatch_001'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('subscription_code_mismatch');
  });

  // ─────────────────────────────────────────────────────────
  // k. Amount mismatch: exact equality, NO tolerance
  // ─────────────────────────────────────────────────────────
  it('k. amount mismatch — exact cents equality, no tolerance → success=false', () => {
    cleanFinData();
    // Subscription has amount=50.00 USD → expects exactly 5000 cents
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    // Pass 5001 cents (1 cent off)
    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_amount_mismatch', 'sub_test_xxx',
        5001, 'USD', 'pi_amount_mismatch_001'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('amount_mismatch');
    expect(result.expected_cents).toBe(5000);
    expect(result.received_cents).toBe(5001);
  });

  // ─────────────────────────────────────────────────────────
  // l. Currency mismatch: pass wrong currency → success=false
  // ─────────────────────────────────────────────────────────
  it('l. currency mismatch → success=false, reason=currency_mismatch', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 }); // currency='USD'

    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_currency_mismatch', 'sub_test_xxx',
        5000, 'GBP', 'pi_currency_mismatch_001'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('currency_mismatch');
  });

  // ─────────────────────────────────────────────────────────
  // m. Input validation: null/invalid fields → specific reasons
  // ─────────────────────────────────────────────────────────
  it('m. null invoice ID → invalid_invoice_id', () => {
    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, NULL, 'sub_test_xxx',
        5000, 'USD', 'pi_val_001'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_invoice_id');
  });

  it('m. invoice ID without in_ prefix → invalid_invoice_id', () => {
    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'bad_invoice_id', 'sub_test_xxx',
        5000, 'USD', 'pi_val_002'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_invoice_id');
  });

  it('m. null subscription code → invalid_subscription_code', () => {
    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_val_003', NULL,
        5000, 'USD', 'pi_val_003'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_subscription_code');
  });

  it('m. subscription code without sub_ prefix → invalid_subscription_code', () => {
    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_val_004', 'bad_code',
        5000, 'USD', 'pi_val_004'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_subscription_code');
  });

  it('m. null PaymentIntent → invalid_payment_intent_id', () => {
    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_val_005', 'sub_test_xxx',
        5000, 'USD', NULL
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_payment_intent_id');
  });

  it('m. PI without pi_ prefix → invalid_payment_intent_id', () => {
    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_val_006', 'sub_test_xxx',
        5000, 'USD', 'ch_not_a_pi'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_payment_intent_id');
  });

  it('m. zero amount → invalid_amount', () => {
    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_val_007', 'sub_test_xxx',
        0, 'USD', 'pi_val_007'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_amount');
  });

  it('m. negative amount → invalid_amount', () => {
    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_val_008', 'sub_test_xxx',
        -100, 'USD', 'pi_val_008'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_amount');
  });

  it('m. empty currency → invalid_currency', () => {
    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_val_009', 'sub_test_xxx',
        5000, '', 'pi_val_009'
      );
    `);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_currency');
  });

  // ─────────────────────────────────────────────────────────
  // n. Canonical marker NOT NULL invariant
  // ─────────────────────────────────────────────────────────
  it('n. canonical columns in stripe_recurring_finalizations are all NOT NULL', () => {
    const cols = psql(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'stripe_recurring_finalizations'
        AND column_name IN (
          'canonical_payment_id',
          'canonical_booking_id',
          'canonical_booking_ref',
          'provider_payment_ref',
          'stripe_invoice_id',
          'customer_subscription_id',
          'stripe_subscription_code',
          'finalized_amount_cents',
          'finalized_currency'
        )
      ORDER BY column_name;
    `);
    expect(cols).not.toBe('');
    const lines = cols.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const [colName, nullable] = line.split('|');
      expect(nullable, `Column ${colName} must be NOT NULL`).toBe('NO');
    }
  });

  // ─────────────────────────────────────────────────────────
  // o. Service_role only privileges
  // ─────────────────────────────────────────────────────────
  it('o. anon cannot execute finalize_stripe_recurring_charge', () => {
    const result = psql(`SELECT has_function_privilege('anon', 'finalize_stripe_recurring_charge(uuid,text,text,int,text,text)', 'EXECUTE')`);
    expect(result).toBe('f');
  });

  it('o. authenticated cannot execute finalize_stripe_recurring_charge', () => {
    const result = psql(`SELECT has_function_privilege('authenticated', 'finalize_stripe_recurring_charge(uuid,text,text,int,text,text)', 'EXECUTE')`);
    expect(result).toBe('f');
  });

  it('o. service_role CAN execute finalize_stripe_recurring_charge', () => {
    const result = psql(`SELECT has_function_privilege('service_role', 'finalize_stripe_recurring_charge(uuid,text,text,int,text,text)', 'EXECUTE')`);
    expect(result).toBe('t');
  });

  // ─────────────────────────────────────────────────────────
  // Correction Round 2: nullable business fields + platform fee regressions
  // ─────────────────────────────────────────────────────────

  // q. trial_ends_at = NULL → not in trial → expected fee row with correct amount
  it('q. trial_ends_at = NULL → finalization succeeds with expected platform_fees row', () => {
    cleanFinData();
    // Set trial_ends_at to NULL (the common production case for non-trial businesses)
    psql(`UPDATE businesses SET trial_ends_at = NULL, payout_mode = 'platform', subscription_tier = 'free' WHERE id = '${BIZ_ID}'`);
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_null_trial_001', 'sub_test_xxx',
        5000, 'USD', 'pi_null_trial_001'
      );
    `);

    expect(result.success).toBe(true);
    expect(result.already_finalized).toBe(false);

    // Platform fee row MUST exist (null trial = not in trial = normal fee)
    const feeRow = psql(`SELECT fee_percentage, fee_total, tier FROM platform_fees WHERE booking_id = '${result.booking_id}'`);
    expect(feeRow).not.toBe('');
    const [feePct, feeTotal, feeTier] = feeRow.split('|');
    expect(parseFloat(feePct)).toBe(2.5);        // free tier default
    expect(parseInt(feeTotal)).toBe(1);           // ROUND(50 * 2.5 / 100) = 1
    expect(feeTier).toBe('free');

    // Finalization marker committed
    const finCount = psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_null_trial_001'`);
    expect(finCount).toBe('1');

    // Restore trial_ends_at for other tests
    psql(`UPDATE businesses SET trial_ends_at = NOW() - INTERVAL '1 day' WHERE id = '${BIZ_ID}'`);
  });

  // r. Expired trial → expected fee row (trial_ends_at in the past)
  it('r. expired trial → finalization succeeds with expected platform_fees row', () => {
    cleanFinData();
    psql(`UPDATE businesses SET trial_ends_at = NOW() - INTERVAL '30 days', payout_mode = 'platform', subscription_tier = 'free' WHERE id = '${BIZ_ID}'`);
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_expired_trial_001', 'sub_test_xxx',
        5000, 'USD', 'pi_expired_trial_001'
      );
    `);

    expect(result.success).toBe(true);

    // Platform fee exists (expired trial = not in trial = normal fee)
    const feeCount = psql(`SELECT COUNT(*) FROM platform_fees WHERE booking_id = '${result.booking_id}'`);
    expect(feeCount).toBe('1');

    const feeTotal = psql(`SELECT fee_total FROM platform_fees WHERE booking_id = '${result.booking_id}'`);
    expect(parseInt(feeTotal)).toBe(1);           // ROUND(50 * 2.5 / 100) = 1

    // Restore
    psql(`UPDATE businesses SET trial_ends_at = NOW() - INTERVAL '1 day' WHERE id = '${BIZ_ID}'`);
  });

  // s. Active trial → zero-fee semantics (trial_ends_at in the future)
  it('s. active trial → finalization succeeds with zero platform_fees', () => {
    cleanFinData();
    psql(`UPDATE businesses SET trial_ends_at = NOW() + INTERVAL '30 days', payout_mode = 'platform', subscription_tier = 'free' WHERE id = '${BIZ_ID}'`);
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_active_trial_001', 'sub_test_xxx',
        5000, 'USD', 'pi_active_trial_001'
      );
    `);

    expect(result.success).toBe(true);

    // Fee row exists but with zero amounts (active trial = no fees charged)
    const feeRow = psql(`SELECT fee_percentage, fee_flat, fee_total FROM platform_fees WHERE booking_id = '${result.booking_id}'`);
    expect(feeRow).not.toBe('');
    const [feePct, feeFlat, feeTotal] = feeRow.split('|');
    expect(parseFloat(feePct)).toBe(0);
    expect(parseFloat(feeFlat)).toBe(0);
    expect(parseFloat(feeTotal)).toBe(0);

    // Restore
    psql(`UPDATE businesses SET trial_ends_at = NOW() - INTERVAL '1 day' WHERE id = '${BIZ_ID}'`);
  });

  // t. direct_split → no platform_fees row
  it('t. direct_split payout_mode → finalization succeeds with NO platform_fees row', () => {
    cleanFinData();
    psql(`UPDATE businesses SET payout_mode = 'direct_split', trial_ends_at = NOW() - INTERVAL '1 day', subscription_tier = 'free' WHERE id = '${BIZ_ID}'`);
    createSub(SUB_ID_A, { code: 'sub_test_xxx', amount: 50 });

    const result = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_direct_split_001', 'sub_test_xxx',
        5000, 'USD', 'pi_direct_split_001'
      );
    `);

    expect(result.success).toBe(true);

    // NO platform_fees row for direct_split
    const feeCount = psql(`SELECT COUNT(*) FROM platform_fees WHERE booking_id = '${result.booking_id}'`);
    expect(feeCount).toBe('0');

    // But finalization marker IS committed
    const finCount = psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_direct_split_001'`);
    expect(finCount).toBe('1');

    // Restore
    psql(`UPDATE businesses SET payout_mode = 'platform' WHERE id = '${BIZ_ID}'`);
  });

  // u. Missing business → full rollback (no finalization marker, no payment)
  // FK constraint business_id → businesses(id) ON DELETE CASCADE normally prevents
  // orphan subscriptions. This test disables FK triggers to simulate a data anomaly
  // and prove the RPC fails closed with RAISE EXCEPTION + full rollback.
  it('u. missing business → RAISE EXCEPTION, full rollback, no finalization marker', () => {
    cleanFinData();
    const GHOST_SUB = '77eeeeee-eeee-eeee-eeee-eeeeeeeeee01';

    // Insert subscription then orphan it by deleting business with triggers disabled
    createSub(GHOST_SUB, { code: 'sub_ghost_001', amount: 50 });
    psql(`
      ALTER TABLE customer_subscriptions DISABLE TRIGGER ALL;
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      ALTER TABLE customer_subscriptions ENABLE TRIGGER ALL;
    `);

    let threw = false;
    try {
      psqlJson(`
        SELECT finalize_stripe_recurring_charge(
          '${GHOST_SUB}'::uuid, 'in_missing_biz_001', 'sub_ghost_001',
          5000, 'USD', 'pi_missing_biz_001'
        );
      `);
    } catch {
      threw = true;
    }

    // Must throw (RAISE EXCEPTION → full rollback)
    expect(threw).toBe(true);

    // No finalization marker (transaction rolled back)
    const finCount = psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_missing_biz_001'`);
    expect(finCount).toBe('0');

    // No payment record
    const payCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'pi_missing_biz_001'`);
    expect(payCount).toBe('0');

    // Restore the business for subsequent tests
    psql(`
      INSERT INTO businesses (id, owner_id, name, slug, address, city, neighborhood, phone,
        status, subscription_tier, trial_ends_at, payout_mode, country_code)
        VALUES ('${BIZ_ID}', '${USER_ID}', 'Stripe Fin Test Biz', 'stripe-fin-test-177',
          '1 Test St', 'Lagos', 'VI', '+10000000000',
          'active', 'free', NOW() - INTERVAL '1 day', 'platform', 'US')
        ON CONFLICT (id) DO NOTHING;
    `);

    // Clean up ghost subscription
    psql(`DELETE FROM customer_subscriptions WHERE id = '${GHOST_SUB}'`);
  });

  // ─────────────────────────────────────────────────────────
  // p. Fee parity: ROUND(x) matches Math.round for representative amounts
  // ─────────────────────────────────────────────────────────
  it('p. fee parity — ROUND(x) integer rounding matches Math.round for representative amounts', () => {
    // Representative amounts and their expected 2.5% fees (free tier)
    // Math.round(amount * 2.5 / 100) — same formula as SQL ROUND(v_amount * v_fee_pct / 100)
    const cases: Array<{ amountCents: number; expectedFeeCents: number }> = [
      { amountCents: 5000, expectedFeeCents: Math.round(50 * 2.5 / 100) },   // 50.00 → 1.25 → round=1
      { amountCents: 10000, expectedFeeCents: Math.round(100 * 2.5 / 100) }, // 100.00 → 2.50 → round=3 (JS bankers? no, Math.round rounds .5 up)
      { amountCents: 20000, expectedFeeCents: Math.round(200 * 2.5 / 100) }, // 200.00 → 5.00 → round=5
      { amountCents: 9999, expectedFeeCents: Math.round(99.99 * 2.5 / 100) }, // 99.99 → 2.499... → round=2
      { amountCents: 1, expectedFeeCents: Math.round(0.01 * 2.5 / 100) },    // 0.01 → 0 → round=0
    ];

    for (const { amountCents, expectedFeeCents } of cases) {
      // SQL: ROUND(amount * 2.5 / 100) where amount is in dollars
      const amount = amountCents / 100;
      const sqlFee = psql(`SELECT ROUND(${amount} * 2.5 / 100)::int`);
      const dbFee = parseInt(sqlFee, 10);
      expect(dbFee, `Amount ${amountCents} cents: DB fee ${dbFee} ≠ Math.round fee ${expectedFeeCents}`).toBe(expectedFeeCents);
    }
  });
});
