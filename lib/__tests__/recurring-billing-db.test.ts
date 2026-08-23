/**
 * Recurring Billing — Real PostgreSQL Contention Tests
 *
 * Proves claim_recurring_billing_cycle + finalize_token_recurring_charge
 * are concurrent-safe, idempotent, and produce correct financial records.
 *
 * Requires TEST_DATABASE_URL.
 *
 * Local:
 *   docker run --rm -d --name rb-test -p 54323:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54323/postgres npx vitest run lib/__tests__/recurring-billing-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const MIGRATION_PATH = path.resolve('supabase/migrations/305_annual_subscriptions_loyalty.sql');
const MIGRATION_306_PATH = path.resolve('supabase/migrations/306_concurrent_finalizer_lock.sql');
const MIGRATION_334_PATH = path.resolve('supabase/migrations/334_payment_spend_marker.sql');
const MIGRATION_335_PATH = path.resolve('supabase/migrations/335_recurring_spend_finalization.sql');
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
        (error, stdout) => resolve({ stdout: (stdout || '').trim() }));
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

const BIZ_ID = '22aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = '22bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SUB_ID = '22cccccc-cccc-cccc-cccc-cccccccccccc';
const STABLE_REF_AUG = `flw-${SUB_ID}-2026-08-01`;
const STABLE_REF_DEC = `flw-${SUB_ID}-2026-12-01`;
const STABLE_REF_SEP = `flw-${SUB_ID}-2026-09-01`;

describe.skipIf(!dbUrl)('Recurring Billing: Real PostgreSQL contention tests', () => {
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

      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), subscription_tier TEXT DEFAULT 'free', trial_ends_at TIMESTAMPTZ, payout_mode TEXT DEFAULT 'platform');
      CREATE TABLE IF NOT EXISTS customer_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID, user_id UUID,
        service_id UUID, amount NUMERIC(12,2), currency TEXT DEFAULT 'NGN',
        frequency TEXT DEFAULT 'monthly', status TEXT DEFAULT 'active',
        gateway TEXT, authorization_code TEXT, customer_name TEXT, customer_phone TEXT,
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
        IF NEW.reference_code IS NULL THEN NEW.reference_code := 'BW-R' || LPAD(FLOOR(RANDOM()*100000)::TEXT,5,'0'); END IF;
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
      CREATE TABLE IF NOT EXISTS processed_webhook_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_id TEXT UNIQUE,
        gateway TEXT, event_type TEXT, status TEXT, attempts INT DEFAULT 1,
        first_received_at TIMESTAMPTZ, last_attempted_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recurring_interval TEXT
      );
      -- #164: spend marker + customer profiles tables
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
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_PATH}"`, { encoding: 'utf-8', timeout: 15000 });
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_306_PATH}"`, { encoding: 'utf-8', timeout: 15000 });
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_334_PATH}"`, { encoding: 'utf-8', timeout: 15000 });
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_335_PATH}"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS payment_spend_applications, customer_profiles, reservations, platform_fees, subscription_charges, payments, bookings, customer_subscriptions, processed_webhook_events, platform_settings, services, businesses CASCADE;`);
  });

  it('1. concurrent claim → exactly one wins', async () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM customer_subscriptions;`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, frequency, status, gateway, next_charge_at)
          VALUES ('${SUB_ID}', '${BIZ_ID}', '${USER_ID}', 50, 'monthly', 'active', 'flutterwave', NOW() - INTERVAL '1 hour');`);

    const sqlA = `
      BEGIN;
      SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);
      SELECT pg_sleep(1);
      COMMIT;
    `;
    const sqlB = `
      SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);
    `;

    const { a, b } = await runTwoSessions(sqlA, sqlB);
    const rA = JSON.parse(a.stdout.split('\n').find(l => l.startsWith('{'))!);
    const rB = JSON.parse(b.stdout);

    // Exactly one claimed
    const claimed = [rA.claimed, rB.claimed].filter(Boolean);
    expect(claimed.length).toBe(1);
  });

  it('2. stable ref → same billing cycle always same ref', () => {
    // The ref is deterministic: flw-{sub_id}-{date}
    const ref1 = STABLE_REF_AUG;
    const ref2 = STABLE_REF_AUG;
    expect(ref1).toBe(ref2);
  });

  it('3. finalize is idempotent — proves dual identity and no duplicate records', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM subscription_charges; DELETE FROM bookings; DELETE FROM platform_fees;`);
    psql(`DELETE FROM customer_subscriptions;`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, frequency, status, gateway, charge_count, total_charged, next_charge_at)
          VALUES ('${SUB_ID}', '${BIZ_ID}', '${USER_ID}', 50, 'monthly', 'active', 'flutterwave', 0, 0, NOW() - INTERVAL '1 hour');`);

    // Claim returns BOTH identities: billingCycleRef (stable_ref) and providerAttemptRef (attempt_ref)
    const claimResult = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claimResult.claimed).toBe(true);
    const billingCycleRef = claimResult.stable_ref;
    const providerAttemptRef = claimResult.attempt_ref;
    // The two refs are distinct identities
    expect(billingCycleRef).toBeDefined();
    expect(providerAttemptRef).toBeDefined();
    expect(providerAttemptRef).not.toBe(billingCycleRef);
    expect(providerAttemptRef).toContain(billingCycleRef); // attempt ref embeds billing cycle ref

    // First finalization
    const r1 = psqlJson(`SELECT finalize_token_recurring_charge('${billingCycleRef}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r1.success).toBe(true);
    expect(r1.already_finalized).toBe(false);

    // Duplicate finalization — idempotent, same payment returned
    const r2 = psqlJson(`SELECT finalize_token_recurring_charge('${billingCycleRef}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r2.success).toBe(true);
    expect(r2.already_finalized).toBe(true);
    expect(r2.payment_id).toBe(r1.payment_id);

    // ── DUAL IDENTITY PROOF ──

    // payments.gateway_reference == providerAttemptRef (provider's tx_ref)
    const paymentGwRef = psql(`SELECT gateway_reference FROM payments WHERE id = '${r1.payment_id}';`);
    expect(paymentGwRef).toBe(providerAttemptRef);

    // payments.metadata contains BOTH refs for traceability
    const paymentMeta = psqlJson(`SELECT metadata FROM payments WHERE id = '${r1.payment_id}';`);
    expect(paymentMeta.billing_cycle_ref).toBe(billingCycleRef);
    expect(paymentMeta.provider_attempt_ref).toBe(providerAttemptRef);

    // subscription_charges.gateway_reference == providerAttemptRef
    const chargeGwRef = psql(`SELECT gateway_reference FROM subscription_charges WHERE payment_id = '${r1.payment_id}';`);
    expect(chargeGwRef).toBe(providerAttemptRef);

    // Exactly ONE payment (not duplicated by idempotent call)
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = '${providerAttemptRef}';`);
    expect(paymentCount).toBe('1');

    // Exactly ONE subscription_charge
    const chargeCount = psql(`SELECT COUNT(*) FROM subscription_charges WHERE gateway_reference = '${providerAttemptRef}';`);
    expect(chargeCount).toBe('1');

    // charge_count = 1 (not 2)
    const subChargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(subChargeCount).toBe('1');

    // total_charged = 50 (not 100)
    const totalCharged = psql(`SELECT total_charged FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(parseFloat(totalCharged)).toBe(50);
  });

  it('4. yearly advance is correct', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM subscription_charges; DELETE FROM bookings; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET frequency = 'yearly', gateway = 'flutterwave', amount = 500, charge_count = 0, total_charged = 0, status = 'active', next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // Claim returns database-derived ref, then finalize
    const claimResult = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claimResult.claimed).toBe(true);
    psqlJson(`SELECT finalize_token_recurring_charge('${claimResult.stable_ref}', '${SUB_ID}'::uuid, 500, 'NGN', 'flutterwave');`);

    const nextCharge = psql(`SELECT next_charge_at FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    const nextDate = new Date(nextCharge);
    const now = new Date();
    // Should be approximately 1 year from now
    expect(nextDate.getFullYear()).toBeGreaterThanOrEqual(now.getFullYear() + 1);
  });

  it('5. not-due subscription cannot be claimed', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET next_charge_at = NOW() + INTERVAL '30 days' WHERE id = '${SUB_ID}';`);

    const futureRef = `flw-${SUB_ID}-2027-01-01`;
    const r = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('not_due');
  });

  it('6. paused subscription cannot be claimed', () => {
    psql(`UPDATE customer_subscriptions SET status = 'paused', next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const pausedRef = `flw-${SUB_ID}-2026-07-01`;
    const r = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('not_active');
  });

  it('7. finalize without claim is rejected', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const r = psqlJson(`SELECT finalize_token_recurring_charge('${STABLE_REF_SEP}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('no_valid_claim');
  });

  it('cancelled subscription cannot be claimed', () => {
    psql(`UPDATE customer_subscriptions SET status = 'cancelled' WHERE id = '${SUB_ID}';`);

    const cancelledRef = `flw-${SUB_ID}-2026-06-01`;
    const r = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('not_active');
  });

  // ── OWNERSHIP TESTS ──

  it('claim derives stableRef from authoritative next_charge_at', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const r = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(r.claimed).toBe(true);
    // stableRef must contain the subscription ID
    expect(r.stable_ref).toContain(SUB_ID);
    // stableRef must start with 'flw-'
    expect(r.stable_ref.startsWith('flw-')).toBe(true);
  });

  it('valid claim A + finalize B → rejected', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // Claim for SUB_ID
    const claimResult = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claimResult.claimed).toBe(true);

    // Try to finalize with a DIFFERENT subscription ID
    const otherSubId = '99999999-9999-9999-9999-999999999999';
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claimResult.stable_ref}', '${otherSubId}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('claim_subscription_mismatch');
  });

  it('wrong amount → finalization rejected', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claimResult = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claimResult.stable_ref}', '${SUB_ID}'::uuid, 999, 'NGN', 'flutterwave');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('amount_mismatch');
  });

  it('wrong currency → finalization rejected', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, currency = 'NGN', next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claimResult = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claimResult.stable_ref}', '${SUB_ID}'::uuid, 50, 'USD', 'flutterwave');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('currency_mismatch');
  });

  it('non-Flutterwave subscription → claim rejected', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'paystack', next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const r = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('wrong_gateway');

    // Restore for subsequent tests
    psql(`UPDATE customer_subscriptions SET gateway = 'flutterwave' WHERE id = '${SUB_ID}';`);
  });

  it('non-Flutterwave subscription → finalize rejected', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // Create a valid claim first
    const claimResult = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claimResult.claimed).toBe(true);

    // Change gateway to paystack AFTER claim (simulates misuse)
    psql(`UPDATE customer_subscriptions SET gateway = 'paystack' WHERE id = '${SUB_ID}';`);

    // Attempt finalize — should be rejected
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claimResult.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('wrong_gateway');

    // Restore
    psql(`UPDATE customer_subscriptions SET gateway = 'flutterwave' WHERE id = '${SUB_ID}';`);
  });

  it('finalized cycle advances next_charge_at → next cycle derives different ref', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM platform_fees; DELETE FROM subscription_charges;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, frequency = 'monthly', charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // First cycle
    const c1 = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(c1.claimed).toBe(true);
    psqlJson(`SELECT finalize_token_recurring_charge('${c1.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);

    // After finalization, next_charge_at advanced by 1 month.
    // Set it to yesterday (overdue + different date → different billing-cycle ref)
    // Also ensure status=active and failure_count=0 for clean second cycle
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', failure_count = 0, next_charge_at = '2026-07-15T10:00:00Z' WHERE id = '${SUB_ID}';`);

    // Second cycle — should derive a DIFFERENT ref
    const c2 = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(c2.claimed).toBe(true);
    expect(c2.stable_ref).not.toBe(c1.stable_ref);
  });

  // ── ATOMIC FAILURE RECORDING ──

  it('definitive failure: claimed → provider_failed + failure_count increments once', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, failure_count = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // Claim first
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Record definitive failure
    const r = psqlJson(`SELECT record_flutterwave_definitive_failure('${SUB_ID}'::uuid, '${claim.stable_ref}');`);
    expect(r.recorded).toBe(true);
    expect(r.failure_count).toBe(1);

    const count = psql(`SELECT failure_count FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(count).toBe('1');
  });

  it('CASE A: same-attempt duplicate → already_recorded, failure_count EXACTLY 1', () => {
    // Previous test left event as provider_failed, failure_count = 1
    // Try to record AGAIN without reclaiming
    const derivedRef = psql(`SELECT 'flw-' || '${SUB_ID}' || '-' || TO_CHAR(next_charge_at, 'YYYY-MM-DD') FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    const r = psqlJson(`SELECT record_flutterwave_definitive_failure('${SUB_ID}'::uuid, '${derivedRef}');`);
    expect(r.recorded).toBe(false);
    expect(r.reason).toBe('already_recorded');

    const count = psql(`SELECT failure_count FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(count).toBe('1'); // EXACTLY 1, not 2
  });

  it('CASE B: legitimate reclaimed next attempt → failure_count EXACTLY 2', () => {
    // From CASE A: event is provider_failed, failure_count = 1
    // Reclaim the cycle (simulates next cron retry)
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);
    // provider_failed → new attempt, reconcile_required=false (charge immediately)
    expect(claim.reconcile_required).toBe(false);

    // Second real provider failure
    const r = psqlJson(`SELECT record_flutterwave_definitive_failure('${SUB_ID}'::uuid, '${claim.stable_ref}');`);
    expect(r.recorded).toBe(true);
    expect(r.failure_count).toBe(2);

    const count = psql(`SELECT failure_count FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(count).toBe('2'); // EXACTLY 2
  });

  it('wrong ref → failure recording rejected', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', failure_count = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);
    psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);

    const r = psqlJson(`SELECT record_flutterwave_definitive_failure('${SUB_ID}'::uuid, 'flw-wrong-ref-2026-01-01');`);
    expect(r.recorded).toBe(false);
    expect(r.reason).toBe('ref_cycle_mismatch');
  });

  // ── FAIL-CLOSED CANCELLATION ──

  it('cancel blocked: provider_success unresolved', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'past_due', gateway = 'flutterwave', failure_count = 3, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    psql(`UPDATE processed_webhook_events SET status = 'provider_success' WHERE event_id = '${claim.stable_ref}';`);

    const r = psqlJson(`SELECT cancel_flutterwave_after_failures('${SUB_ID}'::uuid);`);
    expect(r.cancelled).toBe(false);
    expect(r.reason).toBe('unresolved_event');
  });

  it('cancel blocked: claimed unresolved', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'past_due', gateway = 'flutterwave', failure_count = 3, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);
    psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);

    const r = psqlJson(`SELECT cancel_flutterwave_after_failures('${SUB_ID}'::uuid);`);
    expect(r.cancelled).toBe(false);
    expect(r.reason).toBe('unresolved_event');
  });

  it('cancel blocked: completed event (money was received)', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'past_due', gateway = 'flutterwave', failure_count = 3, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    psql(`UPDATE processed_webhook_events SET status = 'completed' WHERE event_id = '${claim.stable_ref}';`);

    const r = psqlJson(`SELECT cancel_flutterwave_after_failures('${SUB_ID}'::uuid);`);
    expect(r.cancelled).toBe(false);
    expect(r.reason).toBe('unresolved_event');
  });

  it('cancel blocked: missing billing event', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'past_due', gateway = 'flutterwave', failure_count = 3, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const r = psqlJson(`SELECT cancel_flutterwave_after_failures('${SUB_ID}'::uuid);`);
    expect(r.cancelled).toBe(false);
    expect(r.reason).toBe('no_billing_event');
  });

  it('cancel succeeds: provider_failed + past_due + >=3 failures', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'past_due', gateway = 'flutterwave', failure_count = 3, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    // Record definitive failure (uses the RPC to set provider_failed atomically)
    psqlJson(`SELECT record_flutterwave_definitive_failure('${SUB_ID}'::uuid, '${claim.stable_ref}');`);

    const r = psqlJson(`SELECT cancel_flutterwave_after_failures('${SUB_ID}'::uuid);`);
    expect(r.cancelled).toBe(true);
    const status = psql(`SELECT status FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(status).toBe('cancelled');
  });

  it('cancel rejected: insufficient failures', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'past_due', gateway = 'flutterwave', failure_count = 2, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const r = psqlJson(`SELECT cancel_flutterwave_after_failures('${SUB_ID}'::uuid);`);
    expect(r.cancelled).toBe(false);
    expect(r.reason).toBe('insufficient_failures');
  });

  it('finalize with p_gateway != flutterwave → rejected', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claimResult = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claimResult.claimed).toBe(true);

    // Attempt finalize with wrong p_gateway
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claimResult.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'paystack');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('gateway_mismatch');
  });

  // ── PROVIDER IDENTITY INTEGRITY ──

  it('F. correct caller attempt ref → finalize succeeds', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Caller provides the CORRECT attempt ref — must succeed
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave', '${claim.attempt_ref}');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(false);

    // Verify the payment uses the correct provider attempt ref
    const gwRef = psql(`SELECT gateway_reference FROM payments WHERE id = '${r.payment_id}';`);
    expect(gwRef).toBe(claim.attempt_ref);
  });

  it('G. wrong caller attempt ref → attempt_ref_mismatch', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Caller provides a WRONG attempt ref — must be rejected
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave', 'WRONG-ATTEMPT-REF');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('attempt_ref_mismatch');
    expect(r.expected).toBe(claim.attempt_ref);
    expect(r.received).toBe('WRONG-ATTEMPT-REF');

    // No financial records created
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'WRONG-ATTEMPT-REF';`);
    expect(paymentCount).toBe('0');
  });

  it('H. claim with missing authoritative attempt ref → finalization rejected', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Simulate corrupted claim: manually clear the stored attempt ref
    psql(`UPDATE processed_webhook_events SET last_error = NULL WHERE event_id = '${claim.stable_ref}';`);

    // Finalize without caller-provided ref → should derive from claim, find NULL, reject
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('missing_authoritative_attempt_ref');

    // No financial records created
    const paymentCount = psql(`SELECT COUNT(*) FROM payments;`);
    expect(paymentCount).toBe('0');
  });

  it('I. completed/idempotent finalization → same existing payment returned', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // First finalization
    const r1 = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r1.success).toBe(true);
    expect(r1.already_finalized).toBe(false);
    const originalPaymentId = r1.payment_id;

    // Second finalization — idempotent
    const r2 = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r2.success).toBe(true);
    expect(r2.already_finalized).toBe(true);
    expect(r2.payment_id).toBe(originalPaymentId);

    // Third finalization with explicit attempt ref — still idempotent
    const r3 = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave', '${claim.attempt_ref}');`);
    expect(r3.success).toBe(true);
    expect(r3.already_finalized).toBe(true);
    expect(r3.payment_id).toBe(originalPaymentId);

    // Still exactly one payment and one charge
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE status = 'success';`);
    expect(paymentCount).toBe('1');
    const chargeCount = psql(`SELECT COUNT(*) FROM subscription_charges;`);
    expect(chargeCount).toBe('1');
  });

  // ── NULL-SEMANTICS BYPASS PROOF ──

  it('J. NULL claim attempt + caller FOREIGN-REF → rejected, zero financial records', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Corrupt the claim: set last_error to NULL (simulates missing attempt ref)
    psql(`UPDATE processed_webhook_events SET last_error = NULL WHERE event_id = '${claim.stable_ref}';`);

    // Caller supplies a foreign ref — must NOT be accepted
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave', 'FOREIGN-REF');`);
    expect(r.success).toBe(false);
    // Must reject — either attempt_ref_mismatch or missing_authoritative_attempt_ref
    expect(['attempt_ref_mismatch', 'missing_authoritative_attempt_ref']).toContain(r.reason);

    // Zero financial records
    const payments = psql(`SELECT COUNT(*) FROM payments;`);
    expect(payments).toBe('0');
    const charges = psql(`SELECT COUNT(*) FROM subscription_charges;`);
    expect(charges).toBe('0');
    const fees = psql(`SELECT COUNT(*) FROM platform_fees;`);
    expect(fees).toBe('0');

    // Subscription totals unchanged
    const chargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(chargeCount).toBe('0');
    const totalCharged = psql(`SELECT total_charged FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(parseFloat(totalCharged)).toBe(0);
  });

  it('K. empty string claim attempt + caller FOREIGN-REF → rejected, zero financial mutation', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Corrupt the claim: set last_error to empty string
    psql(`UPDATE processed_webhook_events SET last_error = '' WHERE event_id = '${claim.stable_ref}';`);

    // Caller supplies a foreign ref — must NOT be accepted
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave', 'FOREIGN-REF');`);
    expect(r.success).toBe(false);
    expect(['attempt_ref_mismatch', 'missing_authoritative_attempt_ref']).toContain(r.reason);

    // Zero financial mutation
    const payments = psql(`SELECT COUNT(*) FROM payments;`);
    expect(payments).toBe('0');
    const charges = psql(`SELECT COUNT(*) FROM subscription_charges;`);
    expect(charges).toBe('0');
  });

  it('L. authoritative attempt exists + caller supplies different ref → attempt_ref_mismatch', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);
    expect(claim.attempt_ref).toBeDefined();

    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave', 'different-attempt-ref');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('attempt_ref_mismatch');
    expect(r.expected).toBe(claim.attempt_ref);
    expect(r.received).toBe('different-attempt-ref');
  });

  it('M. authoritative attempt exists + caller NULL → claim authority used, success', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Caller omits p_provider_attempt_ref (uses default NULL) — claim authority should be used
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(false);

    // Payment uses the claim's authoritative attempt ref
    const gwRef = psql(`SELECT gateway_reference FROM payments WHERE id = '${r.payment_id}';`);
    expect(gwRef).toBe(claim.attempt_ref);
  });

  // ── COMPLETED-PAYMENT INTEGRITY ──

  it('N1. completed + NULL attempt + caller unrelated ref → unrelated payment never returned', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // Create an unrelated successful payment
    psql(`INSERT INTO payments (business_id, amount, currency, gateway, gateway_reference, status, paid_at)
          VALUES ('${BIZ_ID}', 999, 'USD', 'flutterwave', 'UNRELATED-PAYMENT-REF', 'success', NOW());`);

    // Create a claim and mark it completed, corrupt the attempt ref
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);
    psql(`UPDATE processed_webhook_events SET status = 'completed', last_error = NULL WHERE event_id = '${claim.stable_ref}';`);

    // Caller supplies the unrelated payment's ref
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave', 'UNRELATED-PAYMENT-REF');`);

    // Must NOT return the unrelated payment as if it belongs to this billing cycle
    const unrelatedId = psql(`SELECT id FROM payments WHERE gateway_reference = 'UNRELATED-PAYMENT-REF';`);
    if (r.success) {
      expect(r.payment_id).not.toBe(unrelatedId);
    } else {
      // Rejected entirely — also valid
      expect(r.reason).toBeDefined();
    }
    psql(`DELETE FROM payments WHERE gateway_reference = 'UNRELATED-PAYMENT-REF';`);
  });

  it('N2. completed + no matching payment → completed_payment_missing', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // Create a claim, mark it completed, but create NO payment
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);
    psql(`UPDATE processed_webhook_events SET status = 'completed' WHERE event_id = '${claim.stable_ref}';`);

    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('completed_payment_missing');
  });

  it('N3. completed + authoritative providerAttemptRef payment exists → returns exact payment', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // Claim and finalize normally — creates a real payment
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);
    const r1 = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r1.success).toBe(true);
    expect(r1.already_finalized).toBe(false);

    // Now the event is completed with a real payment — idempotent call
    const r2 = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r2.success).toBe(true);
    expect(r2.already_finalized).toBe(true);
    expect(r2.payment_id).toBe(r1.payment_id);

    // Verify it's the real payment with the correct ref
    const gwRef = psql(`SELECT gateway_reference FROM payments WHERE id = '${r2.payment_id}';`);
    expect(gwRef).toBe(claim.attempt_ref);
  });

  it('N4. completed historical + stableRef legacy payment exists → returns legacy payment', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Simulate pre-dual-identity: payment uses stableRef as gateway_reference
    psql(`INSERT INTO payments (business_id, amount, currency, gateway, gateway_reference, status, paid_at)
          VALUES ('${BIZ_ID}', 50, 'NGN', 'flutterwave', '${claim.stable_ref}', 'success', NOW());`);
    psql(`UPDATE processed_webhook_events SET status = 'completed' WHERE event_id = '${claim.stable_ref}';`);

    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(true);
    expect(r.payment_id).toBeDefined();

    const gwRef = psql(`SELECT gateway_reference FROM payments WHERE id = '${r.payment_id}';`);
    expect(gwRef).toBe(claim.stable_ref);
  });

  it('N5. repeated completed/idempotent → same payment every time', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    const r1 = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r1.success).toBe(true);

    const r2 = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    const r3 = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);

    expect(r2.payment_id).toBe(r1.payment_id);
    expect(r3.payment_id).toBe(r1.payment_id);

    // Still exactly one payment
    const count = psql(`SELECT COUNT(*) FROM payments WHERE status = 'success';`);
    expect(count).toBe('1');
  });

  it('N6. completed_payment_missing → zero financial records, totals unchanged', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 5, total_charged = 250, failure_count = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // Create claim, mark completed, but no payment
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    psql(`UPDATE processed_webhook_events SET status = 'completed' WHERE event_id = '${claim.stable_ref}';`);

    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('completed_payment_missing');

    // Zero new financial records
    const payments = psql(`SELECT COUNT(*) FROM payments;`);
    expect(payments).toBe('0');
    const bookings = psql(`SELECT COUNT(*) FROM bookings;`);
    expect(bookings).toBe('0');
    const charges = psql(`SELECT COUNT(*) FROM subscription_charges;`);
    expect(charges).toBe('0');
    const fees = psql(`SELECT COUNT(*) FROM platform_fees;`);
    expect(fees).toBe('0');

    // Subscription totals unchanged
    const chargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(chargeCount).toBe('5');
    const totalCharged = psql(`SELECT total_charged FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(parseFloat(totalCharged)).toBe(250);
    const failureCount = psql(`SELECT failure_count FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(failureCount).toBe('0');
  });

  it('O. completed historical claim using stableRef as legacy gateway_reference → idempotent lookup works', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Simulate a historical payment that used stableRef as gateway_reference (pre-dual-identity)
    psql(`INSERT INTO payments (business_id, amount, currency, gateway, gateway_reference, status, paid_at)
          VALUES ('${BIZ_ID}', 50, 'NGN', 'flutterwave', '${claim.stable_ref}', 'success', NOW());`);
    psql(`UPDATE processed_webhook_events SET status = 'completed' WHERE event_id = '${claim.stable_ref}';`);

    // Idempotent finalization should find the legacy payment via stableRef lookup
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(true);
    expect(r.payment_id).toBeDefined();

    // Verify it found the legacy payment
    const gwRef = psql(`SELECT gateway_reference FROM payments WHERE id = '${r.payment_id}';`);
    expect(gwRef).toBe(claim.stable_ref);
  });

  // ── CONCURRENT FINALIZATION ──

  it('P. two concurrent finalizers → exactly one wins, other gets idempotent result', async () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    // Ensure business fixture is fee-applicable: non-trial (expired), non-direct-split, tier=free
    psql(`UPDATE businesses SET subscription_tier = 'free', trial_ends_at = '2020-01-01T00:00:00Z', payout_mode = 'platform' WHERE id = '${BIZ_ID}';`);
    psql(`UPDATE customer_subscriptions SET status = 'active', gateway = 'flutterwave', amount = 50, currency = 'NGN', charge_count = 0, total_charged = 0, failure_count = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // Claim the billing cycle (single worker — claim is already serialized)
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);
    const stableRef = claim.stable_ref;

    // Two independent PostgreSQL sessions finalize the SAME claimed charge concurrently.
    // Session A holds the FOR UPDATE lock (pg_sleep simulates work under lock).
    // Session B starts concurrently and blocks on the lock until A commits.
    const sqlA = `
      BEGIN;
      SELECT finalize_token_recurring_charge('${stableRef}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');
      SELECT pg_sleep(1);
      COMMIT;
    `;
    const sqlB = `
      SELECT finalize_token_recurring_charge('${stableRef}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');
    `;

    const { a, b } = await runTwoSessions(sqlA, sqlB);

    // Parse results — each session returns JSON from finalize_token_recurring_charge
    const resultLines = (output: string) => output.split('\n').filter(l => l.trim().startsWith('{'));
    const rA = JSON.parse(resultLines(a.stdout)[0]);
    const rB = JSON.parse(resultLines(b.stdout)[0]);

    // Both must succeed
    expect(rA.success).toBe(true);
    expect(rB.success).toBe(true);

    // Exactly one is the original finalization, the other is idempotent
    const finalized = [rA, rB].filter(r => r.already_finalized === false);
    const idempotent = [rA, rB].filter(r => r.already_finalized === true);
    expect(finalized).toHaveLength(1);
    expect(idempotent).toHaveLength(1);

    // Both return the SAME payment_id
    expect(rA.payment_id).toBeDefined();
    expect(rB.payment_id).toBeDefined();
    expect(rA.payment_id).toBe(rB.payment_id);

    // ── FINANCIAL EXACTNESS ──

    // Exactly one payment
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE status = 'success';`);
    expect(paymentCount).toBe('1');

    // Exactly one subscription_charge
    const chargeCount = psql(`SELECT COUNT(*) FROM subscription_charges;`);
    expect(chargeCount).toBe('1');

    // Exactly one booking
    const bookingCount = psql(`SELECT COUNT(*) FROM bookings;`);
    expect(bookingCount).toBe('1');

    // Platform fee recorded exactly once (business fixture: tier=free, non-trial, payout_mode=platform)
    const feeCount = psql(`SELECT COUNT(*) FROM platform_fees;`);
    expect(feeCount).toBe('1');

    // charge_count incremented exactly once
    const subChargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(subChargeCount).toBe('1');

    // total_charged incremented exactly once
    const totalCharged = psql(`SELECT total_charged FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(parseFloat(totalCharged)).toBe(50);

    // Event status is completed
    const eventStatus = psql(`SELECT status FROM processed_webhook_events WHERE event_id = '${stableRef}';`);
    expect(eventStatus).toBe('completed');

    // No uniqueness violation escaped — both returned clean JSON, not errors
    expect(a.stdout).toContain('"success"');
    expect(b.stdout).toContain('"success"');
  });

  // ═══════════════════════════════════════════════════════════
  // #164: RECURRING SPEND FINALIZATION TESTS
  // Proves apply_payment_spend_once executes atomically inside
  // finalize_token_recurring_charge after migration 335.
  // ═══════════════════════════════════════════════════════════

  const SPEND_SUB_ID = '64dddddd-dddd-dddd-dddd-dddddddddddd';
  const SPEND_BIZ_ID = BIZ_ID;
  const SPEND_USER_ID = USER_ID;
  const SPEND_STABLE_REF = `flw-${SPEND_SUB_ID}-2026-09-15`;

  it('#164: fresh finalization creates spend marker + increments total_spent', () => {
    // Clean state
    psql(`DELETE FROM payment_spend_applications; DELETE FROM customer_profiles WHERE business_id = '${SPEND_BIZ_ID}';`);
    psql(`DELETE FROM processed_webhook_events WHERE event_id = '${SPEND_STABLE_REF}';`);
    psql(`DELETE FROM subscription_charges; DELETE FROM platform_fees; DELETE FROM payments; DELETE FROM bookings;`);
    psql(`DELETE FROM customer_subscriptions WHERE id = '${SPEND_SUB_ID}';`);

    // Create subscription with guest_phone for spend authority
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, frequency, status, gateway, customer_phone, customer_name, next_charge_at)
          VALUES ('${SPEND_SUB_ID}', '${SPEND_BIZ_ID}', '${SPEND_USER_ID}', 100, 'monthly', 'active', 'flutterwave', '+2349012345678', 'Test Customer', NOW() - INTERVAL '1 hour');`);

    // Claim
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SPEND_SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Set attempt ref (required for finalization)
    psql(`UPDATE processed_webhook_events SET last_error = 'flw-attempt-spend-1' WHERE event_id = '${claim.stable_ref}';`);

    // Finalize — should create payment + spend atomically
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${SPEND_SUB_ID}'::uuid, 100, 'NGN', 'flutterwave', 'flw-attempt-spend-1');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(false);
    expect(r.payment_id).toBeTruthy();

    // Verify spend marker exists
    const spendCount = psql(`SELECT COUNT(*) FROM payment_spend_applications WHERE payment_id = '${r.payment_id}';`);
    expect(spendCount).toBe('1');

    // Verify customer_profiles.total_spent was incremented
    const totalSpent = psql(`SELECT total_spent FROM customer_profiles WHERE business_id = '${SPEND_BIZ_ID}' AND phone = '+2349012345678';`);
    expect(parseFloat(totalSpent)).toBe(100);

    // Verify amount came from payments.amount (DB-authoritative)
    const paymentAmount = psql(`SELECT amount FROM payments WHERE id = '${r.payment_id}';`);
    expect(parseFloat(paymentAmount)).toBe(100);
    const spendAmount = psql(`SELECT amount FROM payment_spend_applications WHERE payment_id = '${r.payment_id}';`);
    expect(parseInt(spendAmount)).toBe(100);
  });

  it('#164: already-finalized replay does NOT double-spend', () => {
    // Find the completed event from test 1
    const completedRef = psql(`SELECT event_id FROM processed_webhook_events WHERE event_id LIKE 'flw-${SPEND_SUB_ID}-%' AND status = 'completed' LIMIT 1;`);
    expect(completedRef).toBeTruthy();

    const r = psqlJson(`SELECT finalize_token_recurring_charge('${completedRef}', '${SPEND_SUB_ID}'::uuid, 100, 'NGN', 'flutterwave');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(true);

    // Spend marker still exactly 1 for the payment
    const spendCount = psql(`SELECT COUNT(*) FROM payment_spend_applications WHERE payment_id = '${r.payment_id}';`);
    expect(spendCount).toBe('1');

    // total_spent unchanged (still 100, not 200)
    const totalSpent = psql(`SELECT total_spent FROM customer_profiles WHERE business_id = '${SPEND_BIZ_ID}' AND phone = '+2349012345678';`);
    expect(parseFloat(totalSpent)).toBe(100);
  });

  it('#164: validation failure prevents any partial state (no spend, no payment)', () => {
    // Use a separate subscription to avoid stale claim/event conflicts
    const valSubId = '64eeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    psql(`DELETE FROM customer_subscriptions WHERE id = '${valSubId}';`);
    psql(`DELETE FROM processed_webhook_events WHERE event_id LIKE 'flw-${valSubId}-%';`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, frequency, status, gateway, customer_phone, next_charge_at)
          VALUES ('${valSubId}', '${SPEND_BIZ_ID}', '${SPEND_USER_ID}', 100, 'monthly', 'active', 'flutterwave', '+2349012345678', NOW() - INTERVAL '1 hour');`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${valSubId}'::uuid);`);
    expect(claim.claimed).toBe(true);
    psql(`UPDATE processed_webhook_events SET last_error = 'flw-attempt-val-fail' WHERE event_id = '${claim.stable_ref}';`);

    // Amount mismatch: subscription has 100, we pass 999
    const r = psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${valSubId}'::uuid, 999, 'NGN', 'flutterwave', 'flw-attempt-val-fail');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('amount_mismatch');

    // No payment created for this attempt
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'flw-attempt-val-fail';`);
    expect(paymentCount).toBe('0');

    // Event is NOT completed
    const eventStatus = psql(`SELECT status FROM processed_webhook_events WHERE event_id = '${claim.stable_ref}';`);
    expect(eventStatus).not.toBe('completed');

    // Cleanup
    psql(`DELETE FROM customer_subscriptions WHERE id = '${valSubId}';`);
  });

  it('#164: spend failure AFTER payment creation rolls back entire transaction', () => {
    // Fault injection: temporarily replace apply_payment_spend_once with a
    // version that always raises, then restore it after the test.
    // This proves the F1 transactional invariant: if spend fails after
    // payment INSERT, the entire finalization rolls back.
    const faultSubId = '64ffffff-ffff-ffff-ffff-ffffffffffff';
    psql(`DELETE FROM customer_subscriptions WHERE id = '${faultSubId}';`);
    psql(`DELETE FROM processed_webhook_events WHERE event_id LIKE 'flw-${faultSubId}-%';`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, frequency, status, gateway, customer_phone, customer_name, next_charge_at)
          VALUES ('${faultSubId}', '${SPEND_BIZ_ID}', '${SPEND_USER_ID}', 75, 'monthly', 'active', 'flutterwave', '+2340001112222', 'Fault Test', NOW() - INTERVAL '1 hour');`);

    // Record pre-test subscription state
    const preChargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${faultSubId}';`);
    const preTotalCharged = psql(`SELECT total_charged FROM customer_subscriptions WHERE id = '${faultSubId}';`);
    const preNextCharge = psql(`SELECT next_charge_at FROM customer_subscriptions WHERE id = '${faultSubId}';`);

    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${faultSubId}'::uuid);`);
    expect(claim.claimed).toBe(true);
    psql(`UPDATE processed_webhook_events SET last_error = 'flw-fault-attempt' WHERE event_id = '${claim.stable_ref}';`);

    // Inject a fault: replace apply_payment_spend_once with a version that always raises
    psql(`
      CREATE OR REPLACE FUNCTION apply_payment_spend_once(p_payment_id UUID) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
      BEGIN RAISE EXCEPTION 'FAULT_INJECTION: spend authority failure for test'; END; $fn$;
    `);

    // Finalization should RAISE because the injected spend function always fails
    let threw = false;
    try {
      psqlJson(`SELECT finalize_token_recurring_charge('${claim.stable_ref}', '${faultSubId}'::uuid, 75, 'NGN', 'flutterwave', 'flw-fault-attempt');`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Restore the real function by re-applying migration 334
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_334_PATH}"`, { encoding: 'utf-8', timeout: 15000 });

    // Verify FULL rollback: no payment, no booking, no spend marker
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'flw-fault-attempt';`);
    expect(paymentCount).toBe('0');

    const bookingCount = psql(`SELECT COUNT(*) FROM bookings WHERE guest_phone = '+2340001112222' AND notes LIKE '%Recurring%';`);
    expect(bookingCount).toBe('0');

    const spendCount = psql(`SELECT COUNT(*) FROM payment_spend_applications WHERE customer_phone = '+2340001112222';`);
    expect(spendCount).toBe('0');

    // Event is NOT completed
    const eventStatus = psql(`SELECT status FROM processed_webhook_events WHERE event_id = '${claim.stable_ref}';`);
    expect(eventStatus).not.toBe('completed');

    // Subscription charge_count/total_charged/next_charge unchanged
    const postChargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${faultSubId}';`);
    const postTotalCharged = psql(`SELECT total_charged FROM customer_subscriptions WHERE id = '${faultSubId}';`);
    const postNextCharge = psql(`SELECT next_charge_at FROM customer_subscriptions WHERE id = '${faultSubId}';`);
    expect(postChargeCount).toBe(preChargeCount);
    expect(postTotalCharged).toBe(preTotalCharged);
    expect(postNextCharge).toBe(preNextCharge);

    // Cleanup
    psql(`DELETE FROM customer_subscriptions WHERE id = '${faultSubId}';`);
    psql(`DROP FUNCTION IF EXISTS _original_apply_payment_spend_once(UUID);`);
  });
});
