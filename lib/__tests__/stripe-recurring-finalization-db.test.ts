/**
 * Stripe Recurring Finalization — Real PostgreSQL Contention Tests (#177)
 *
 * Proves finalize_stripe_recurring_charge is concurrent-safe, idempotent,
 * and produces correct financial records with the advisory-lock design.
 *
 * Requires TEST_DATABASE_URL.
 *
 * Local:
 *   docker run --rm -d --name stripe-fin-test -p 54324:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54324/postgres npx vitest run lib/__tests__/stripe-recurring-finalization-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const MIGRATION_334_PATH = path.resolve('supabase/migrations/334_payment_spend_marker.sql');
const MIGRATION_339_PATH = path.resolve('supabase/migrations/339_stripe_recurring_finalization.sql');
const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  });
  return raw.split('\n').filter(l => {
    const t = l.trim();
    return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t);
  }).join('\n').trim();
}

function psqlJson(sql: string): any {
  const raw = psql(sql);
  return raw ? JSON.parse(raw) : null;
}

function runTwoSessions(sqlA: string, sqlB: string): Promise<{ a: { stdout: string }; b: { stdout: string } }> {
  const { exec } = require('child_process') as typeof import('child_process');
  function execPsql(sql: string): Promise<{ stdout: string }> {
    return new Promise((resolve) => {
      const child = exec(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`, { timeout: 15000, encoding: 'utf-8' },
        (_error, stdout) => resolve({ stdout: (stdout || '').trim() }));
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

const BIZ_ID = '77aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = '77bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SUB_ID_A = '77cccccc-cccc-cccc-cccc-cccccccccc01';
const SUB_ID_B = '77cccccc-cccc-cccc-cccc-cccccccccc02';

describe.skipIf(!dbUrl)('Stripe Recurring Finalization: Real PostgreSQL contention tests (#177)', () => {
  beforeAll(() => {
    if (!dbUrl) return;
    psql(`
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE TYPE flow_type AS ENUM ('scheduling','ordering','ticketing','reservation','payment','queue','chat','waitlist'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE booking_channel AS ENUM ('whatsapp','web','api','recurring'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE reservation_status AS ENUM ('pending','confirmed','cancelled','completed','in_progress','no_show'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE deposit_status AS ENUM ('none','pending','paid','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE payment_source AS ENUM ('whatsapp','web','api','subscription','invoice','manual'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), subscription_tier TEXT DEFAULT 'free', trial_ends_at TIMESTAMPTZ DEFAULT NOW() - INTERVAL '1 day', payout_mode TEXT DEFAULT 'platform');
      CREATE TABLE IF NOT EXISTS customer_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, user_id UUID,
        service_id UUID, amount NUMERIC(12,2), currency TEXT DEFAULT 'USD',
        frequency TEXT DEFAULT 'monthly', status TEXT DEFAULT 'active',
        gateway TEXT, authorization_code TEXT, gateway_customer_code TEXT,
        gateway_subscription_code TEXT, customer_name TEXT, customer_phone TEXT,
        customer_email TEXT, card_last_four TEXT, card_brand TEXT,
        next_charge_at TIMESTAMPTZ, last_charged_at TIMESTAMPTZ,
        charge_count INT DEFAULT 0, total_charged NUMERIC(12,2) DEFAULT 0,
        failure_count INT DEFAULT 0, cancelled_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), reference_code TEXT UNIQUE,
        business_id UUID, user_id UUID, service_id UUID, date DATE, time TEXT,
        party_size INT DEFAULT 1, flow_type flow_type DEFAULT 'payment',
        channel booking_channel DEFAULT 'recurring', payment_source payment_source DEFAULT 'subscription',
        deposit_amount NUMERIC(12,2), deposit_status deposit_status DEFAULT 'paid',
        status reservation_status DEFAULT 'confirmed', total_amount NUMERIC(12,2),
        quantity INT DEFAULT 1, guest_name TEXT, guest_phone TEXT, confirmed_at TIMESTAMPTZ, notes TEXT
      );
      CREATE OR REPLACE FUNCTION generate_booking_reference() RETURNS TRIGGER AS $t$
      DECLARE new_code TEXT; BEGIN
        IF NEW.reference_code IS NULL THEN NEW.reference_code := 'REF-' || LPAD(FLOOR(RANDOM()*100000)::TEXT,5,'0'); END IF;
        RETURN NEW;
      END; $t$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_booking_ref ON bookings;
      CREATE TRIGGER trg_booking_ref BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION generate_booking_reference();

      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, user_id UUID,
        booking_id UUID, reservation_id UUID, amount NUMERIC(12,2), currency TEXT, gateway TEXT,
        gateway_reference TEXT UNIQUE, status TEXT DEFAULT 'pending',
        gateway_status TEXT, payment_method TEXT, card_last_four TEXT, card_brand TEXT,
        paid_at TIMESTAMPTZ, metadata JSONB, payment_authority_version INT
      );
      CREATE TABLE IF NOT EXISTS subscription_charges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id UUID,
        business_id UUID, user_id UUID, amount NUMERIC(12,2), currency TEXT,
        status TEXT, gateway TEXT, gateway_reference TEXT, payment_id UUID,
        booking_id UUID, charged_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS platform_fees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID,
        booking_id UUID, transaction_amount NUMERIC(12,2), fee_percentage NUMERIC(5,2),
        fee_flat NUMERIC(12,2), fee_total NUMERIC(12,2), tier TEXT
      );
      CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value JSONB);
      CREATE TABLE IF NOT EXISTS services (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), recurring_interval TEXT);
      CREATE TABLE IF NOT EXISTS payment_spend_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID NOT NULL UNIQUE,
        source_type TEXT NOT NULL CHECK (source_type IN ('booking', 'reservation')),
        source_id UUID NOT NULL,
        business_id UUID NOT NULL,
        customer_phone TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS customer_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        phone TEXT NOT NULL,
        name TEXT,
        total_spent NUMERIC(12,2) DEFAULT 0,
        total_visits INT DEFAULT 0,
        total_bookings INT DEFAULT 0,
        last_seen_at TIMESTAMPTZ,
        first_seen_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        UNIQUE(business_id, phone)
      );
      CREATE TABLE IF NOT EXISTS reservations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, guest_phone TEXT, guest_name TEXT, status TEXT DEFAULT 'pending'
      );

      INSERT INTO businesses (id) VALUES ('${BIZ_ID}') ON CONFLICT DO NOTHING;
    `);
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_334_PATH}"`, { encoding: 'utf-8', timeout: 15000 });
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_339_PATH}"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    // Clean up test data
    psql(`
      DELETE FROM stripe_recurring_finalizations;
      DELETE FROM payment_spend_applications;
      DELETE FROM platform_fees;
      DELETE FROM subscription_charges;
      DELETE FROM payments;
      DELETE FROM bookings;
      DELETE FROM customer_subscriptions WHERE business_id = '${BIZ_ID}';
    `);
  });

  function createSub(subId: string, opts: { gateway?: string; status?: string; code?: string; amount?: number } = {}) {
    psql(`
      INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency,
        status, gateway, gateway_subscription_code, customer_name, customer_phone,
        next_charge_at, charge_count, total_charged, failure_count)
      VALUES ('${subId}', '${BIZ_ID}', '${USER_ID}', ${opts.amount ?? 50}, 'USD', 'monthly',
        '${opts.status ?? 'active'}', '${opts.gateway ?? 'stripe'}',
        '${opts.code ?? 'sub_test_' + subId.slice(-4)}',
        'Test Customer', '+1234567890',
        NOW() - INTERVAL '1 day', 0, 0, 0)
      ON CONFLICT DO NOTHING;
    `);
  }

  function cleanFinData() {
    psql(`
      DELETE FROM stripe_recurring_finalizations;
      DELETE FROM payment_spend_applications;
      DELETE FROM platform_fees;
      DELETE FROM subscription_charges;
      DELETE FROM payments;
      DELETE FROM bookings;
      DELETE FROM customer_subscriptions WHERE business_id = '${BIZ_ID}';
    `);
  }

  // ── Test 1: Same invoice + same subscription (concurrent) ──
  it('same invoice + same subscription concurrent → one finalization + canonical replay', async () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_concurrent' });

    const rpcCall = (label: string) => `
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid,
        'in_test_concurrent_inv_001',
        'sub_test_concurrent',
        5000, 'USD', 'pi_test_concurrent_001'
      );
    `;

    const { a, b } = await runTwoSessions(rpcCall('A'), rpcCall('B'));
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
    const finCount = psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_test_concurrent_inv_001'`);
    expect(finCount).toBe('1');

    // Counter incremented exactly once
    const sub = psqlJson(`SELECT charge_count, total_charged FROM customer_subscriptions WHERE id = '${SUB_ID_A}'`);
    // psql returns pipe-delimited when using -t -A
    const subParts = psql(`SELECT charge_count, total_charged FROM customer_subscriptions WHERE id = '${SUB_ID_A}'`).split('|');
    expect(parseInt(subParts[0])).toBe(1);
    expect(parseFloat(subParts[1])).toBe(50);
  });

  // ── Test 2: Same invoice + different subscription ──
  it('same invoice + different subscription → mismatch, zero mutation for wrong sub', async () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_inv_mismatch_a' });
    createSub(SUB_ID_B, { code: 'sub_test_inv_mismatch_b' });

    const rpcCallA = `
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_test_inv_mismatch', 'sub_test_inv_mismatch_a',
        5000, 'USD', 'pi_test_mismatch_001'
      );
    `;
    const rpcCallB = `
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_B}'::uuid, 'in_test_inv_mismatch', 'sub_test_inv_mismatch_b',
        5000, 'USD', 'pi_test_mismatch_001'
      );
    `;

    const { a, b } = await runTwoSessions(rpcCallA, rpcCallB);
    const resultA = JSON.parse(a.stdout || '{}');
    const resultB = JSON.parse(b.stdout || '{}');

    // One succeeds (fresh), one fails with subscription mismatch
    const succeeded = [resultA, resultB].filter(r => r.success);
    const failed = [resultA, resultB].filter(r => !r.success);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBe('replay_subscription_mismatch');

    // Only one finalization row
    const finCount = psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_test_inv_mismatch'`);
    expect(finCount).toBe('1');
  });

  // ── Test 3: Different invoices + same subscription ──
  it('different invoices + same subscription → both finalize, no lost counter update', async () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_diff_inv' });

    const rpcCallA = `
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_test_diff_inv_001', 'sub_test_diff_inv',
        5000, 'USD', 'pi_test_diff_001'
      );
    `;
    const rpcCallB = `
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_test_diff_inv_002', 'sub_test_diff_inv',
        5000, 'USD', 'pi_test_diff_002'
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

    // Counters: charge_count=2, total=100
    const subParts = psql(`SELECT charge_count, total_charged FROM customer_subscriptions WHERE id = '${SUB_ID_A}'`).split('|');
    expect(parseInt(subParts[0])).toBe(2);
    expect(parseFloat(subParts[1])).toBe(100);
  });

  // ── Test 4: PaymentIntent mismatch on replay ──
  it('replay with different PaymentIntent → fail closed, zero mutation', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_pi_mismatch' });

    // Fresh finalization
    const fresh = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_test_pi_mismatch', 'sub_test_pi_mismatch',
        5000, 'USD', 'pi_correct_001'
      );
    `);
    expect(fresh.success).toBe(true);
    expect(fresh.already_finalized).toBe(false);

    // Replay with wrong PI
    const replay = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_test_pi_mismatch', 'sub_test_pi_mismatch',
        5000, 'USD', 'pi_wrong_002'
      );
    `);
    expect(replay.success).toBe(false);
    expect(replay.reason).toBe('replay_provider_ref_mismatch');

    // Finalization row retains correct PI
    const finRef = psql(`SELECT provider_payment_ref FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_test_pi_mismatch'`);
    expect(finRef).toBe('pi_correct_001');
  });

  // ── Test 5: Spend hard-gate failure rolls back all writes ──
  it('spend failure rolls back entire transaction — no finalization marker', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_spend_fail' });

    // Sabotage: make apply_payment_spend_once fail by inserting a booking with no guest_phone
    // We'll override the function temporarily to return null
    psql(`
      CREATE OR REPLACE FUNCTION apply_payment_spend_once_backup(p UUID) RETURNS JSONB
      LANGUAGE plpgsql AS $$ BEGIN RETURN apply_payment_spend_once(p); END; $$;
    `);
    psql(`
      CREATE OR REPLACE FUNCTION apply_payment_spend_once(p_payment_id UUID) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN RETURN NULL; END;
      $$;
    `);

    try {
      // This should fail because spend returns NULL
      const result = psqlJson(`
        SELECT finalize_stripe_recurring_charge(
          '${SUB_ID_A}'::uuid, 'in_test_spend_fail', 'sub_test_spend_fail',
          5000, 'USD', 'pi_spend_fail_001'
        );
      `);
      // If we get here, the RPC didn't raise — it should have
      expect(result).toBeNull(); // Should not reach
    } catch {
      // Expected: RAISE EXCEPTION rolls back
    }

    // No finalization marker
    const finCount = psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_test_spend_fail'`);
    expect(finCount).toBe('0');

    // No payment
    const payCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'pi_spend_fail_001'`);
    expect(payCount).toBe('0');

    // No booking created (rolled back)
    const bookCount = psql(`SELECT COUNT(*) FROM bookings WHERE business_id = '${BIZ_ID}'`);
    expect(bookCount).toBe('0');

    // Subscription unchanged
    const subParts = psql(`SELECT charge_count, total_charged FROM customer_subscriptions WHERE id = '${SUB_ID_A}'`).split('|');
    expect(parseInt(subParts[0])).toBe(0);
  });

  afterAll(() => {
    if (!dbUrl) return;
    // Restore original spend function
    try {
      psql(`
        DROP FUNCTION IF EXISTS apply_payment_spend_once(UUID);
      `);
      execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_334_PATH}"`, { encoding: 'utf-8', timeout: 15000 });
    } catch { /* best effort */ }
  });

  // ── Test 6: Incomplete terminal marker cannot exist ──
  it('finalization marker has NOT NULL canonical IDs — cannot represent incomplete state', () => {
    // The table constraint enforces this at the schema level
    const cols = psql(`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'stripe_recurring_finalizations'
        AND column_name IN ('canonical_payment_id', 'canonical_booking_id', 'canonical_booking_ref', 'provider_payment_ref')
      ORDER BY column_name;
    `);
    // Each line: column_name|is_nullable
    const lines = cols.split('\n');
    for (const line of lines) {
      const [col, nullable] = line.split('|');
      expect(nullable).toBe('NO');
    }
  });

  // ── Test 7: Replay creates no duplicate records ──
  it('replay creates no duplicate booking, payment, charge, fee, or spend', () => {
    cleanFinData();
    createSub(SUB_ID_A, { code: 'sub_test_replay_dedup' });

    // Fresh
    const fresh = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_test_replay_dedup', 'sub_test_replay_dedup',
        5000, 'USD', 'pi_replay_dedup_001'
      );
    `);
    expect(fresh.success).toBe(true);
    expect(fresh.already_finalized).toBe(false);

    // Replay (identical params)
    const replay = psqlJson(`
      SELECT finalize_stripe_recurring_charge(
        '${SUB_ID_A}'::uuid, 'in_test_replay_dedup', 'sub_test_replay_dedup',
        5000, 'USD', 'pi_replay_dedup_001'
      );
    `);
    expect(replay.success).toBe(true);
    expect(replay.already_finalized).toBe(true);
    expect(replay.payment_id).toBe(fresh.payment_id);
    expect(replay.booking_id).toBe(fresh.booking_id);

    // Exactly 1 of each
    expect(psql(`SELECT COUNT(*) FROM bookings WHERE business_id = '${BIZ_ID}'`)).toBe('1');
    expect(psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'pi_replay_dedup_001'`)).toBe('1');
    expect(psql(`SELECT COUNT(*) FROM subscription_charges WHERE subscription_id = '${SUB_ID_A}'`)).toBe('1');
    expect(psql(`SELECT COUNT(*) FROM stripe_recurring_finalizations WHERE stripe_invoice_id = 'in_test_replay_dedup'`)).toBe('1');

    // Counter incremented once
    const subParts = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${SUB_ID_A}'`);
    expect(parseInt(subParts)).toBe(1);
  });

  // ── Test 8: Privilege verification ──
  it('RPC is service_role only; anon and authenticated denied', () => {
    const anonCheck = psql(`SELECT has_function_privilege('anon', 'finalize_stripe_recurring_charge(uuid,text,text,int,text,text)', 'EXECUTE')`);
    expect(anonCheck).toBe('f');

    const authCheck = psql(`SELECT has_function_privilege('authenticated', 'finalize_stripe_recurring_charge(uuid,text,text,int,text,text)', 'EXECUTE')`);
    expect(authCheck).toBe('f');

    const serviceCheck = psql(`SELECT has_function_privilege('service_role', 'finalize_stripe_recurring_charge(uuid,text,text,int,text,text)', 'EXECUTE')`);
    expect(serviceCheck).toBe('t');
  });
});
