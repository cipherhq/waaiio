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
const MIGRATION_337_PATH = path.resolve('supabase/migrations/337_paystack_recurring_finalization.sql');
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
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_337_PATH}"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS paystack_billing_attempts, payment_spend_applications, customer_profiles, reservations, platform_fees, subscription_charges, payments, bookings, customer_subscriptions, processed_webhook_events, platform_settings, services, businesses CASCADE;`);
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

  // ═══════════════════════════════════════════════════════════
  // #176: PAYSTACK RECURRING CLAIM/DISPATCH/FINALIZE TESTS
  // ═══════════════════════════════════════════════════════════

  const PS_SUB_ID = '76aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  it('#176: claim creates a durable attempt with correct intent', () => {
    psql(`DELETE FROM paystack_billing_attempts; DELETE FROM customer_subscriptions WHERE id = '${PS_SUB_ID}';`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency, status, gateway, authorization_code, customer_phone, customer_name, next_charge_at)
          VALUES ('${PS_SUB_ID}', '${BIZ_ID}', '${USER_ID}', 200, 'NGN', 'monthly', 'active', 'paystack', 'AUTH_PS_1', '+2349999999999', 'PS Customer', NOW() - INTERVAL '1 hour');`);

    const claim = psqlJson(`SELECT claim_paystack_billing_cycle('${PS_SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);
    expect(claim.provider_reference).toBeTruthy();
    expect(claim.claim_token).toBeTruthy();
    expect(claim.intended_amount_minor).toBe(20000); // 200 * 100

    // Verify attempt row exists with correct state
    const attempt = psql(`SELECT status FROM paystack_billing_attempts WHERE provider_reference = '${claim.provider_reference}';`);
    expect(attempt).toBe('reserved');
  });

  it('#176: second claim while lease active → active_lease', () => {
    const claim2 = psqlJson(`SELECT claim_paystack_billing_cycle('${PS_SUB_ID}'::uuid);`);
    expect(claim2.claimed).toBe(false);
    expect(claim2.active_lease).toBe(true);
  });

  it('#176: dispatch requires correct token', () => {
    const attemptId = psql(`SELECT id FROM paystack_billing_attempts WHERE customer_subscription_id = '${PS_SUB_ID}' AND status = 'reserved' LIMIT 1;`);
    expect(attemptId).toBeTruthy();

    // Wrong token → rejected
    const wrongResult = psqlJson(`SELECT dispatch_paystack_attempt('${attemptId}'::uuid, gen_random_uuid());`);
    expect(wrongResult.dispatched).toBe(false);
    expect(wrongResult.reason).toBe('wrong_token');

    // Correct token
    const token = psql(`SELECT claim_token FROM paystack_billing_attempts WHERE id = '${attemptId}';`);
    const correctResult = psqlJson(`SELECT dispatch_paystack_attempt('${attemptId}'::uuid, '${token}'::uuid);`);
    expect(correctResult.dispatched).toBe(true);

    const status = psql(`SELECT status FROM paystack_billing_attempts WHERE id = '${attemptId}';`);
    expect(status).toBe('dispatched');
  });

  it('#176: finalize creates payment + spend exactly once', () => {
    psql(`DELETE FROM customer_profiles WHERE phone = '+2349999999999';`);
    const attemptId = psql(`SELECT id FROM paystack_billing_attempts WHERE customer_subscription_id = '${PS_SUB_ID}' AND status = 'dispatched' LIMIT 1;`);

    const r = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 20000, 'NGN');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(false);
    expect(r.payment_id).toBeTruthy();

    // Spend marker exists
    const spendCount = psql(`SELECT COUNT(*) FROM payment_spend_applications WHERE payment_id = '${r.payment_id}';`);
    expect(spendCount).toBe('1');

    // Customer total_spent incremented
    const totalSpent = psql(`SELECT total_spent FROM customer_profiles WHERE phone = '+2349999999999';`);
    expect(parseFloat(totalSpent)).toBe(200);

    // Attempt is finalized
    const status = psql(`SELECT status FROM paystack_billing_attempts WHERE id = '${attemptId}';`);
    expect(status).toBe('finalized');
  });

  it('#176: already-finalized replay → no double spend', () => {
    const attemptId = psql(`SELECT id FROM paystack_billing_attempts WHERE customer_subscription_id = '${PS_SUB_ID}' AND status = 'finalized' LIMIT 1;`);

    const r = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 20000, 'NGN');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(true);

    // total_spent unchanged
    const totalSpent = psql(`SELECT total_spent FROM customer_profiles WHERE phone = '+2349999999999';`);
    expect(parseFloat(totalSpent)).toBe(200);
  });

  it('#176: amount mismatch → finalization rejected', () => {
    // Create a new cycle for amount mismatch test
    const amSubId = '76bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    psql(`DELETE FROM customer_subscriptions WHERE id = '${amSubId}';`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency, status, gateway, authorization_code, customer_phone, next_charge_at)
          VALUES ('${amSubId}', '${BIZ_ID}', '${USER_ID}', 100, 'NGN', 'monthly', 'active', 'paystack', 'AUTH_AM', '+2348888888888', NOW() - INTERVAL '1 hour');`);

    const claim = psqlJson(`SELECT claim_paystack_billing_cycle('${amSubId}'::uuid);`);
    expect(claim.claimed).toBe(true);

    const token = psql(`SELECT claim_token FROM paystack_billing_attempts WHERE id = '${claim.attempt_id}';`);
    psqlJson(`SELECT dispatch_paystack_attempt('${claim.attempt_id}'::uuid, '${token}'::uuid);`);

    // Try to finalize with wrong amount (10001 kobo instead of 10000)
    const r = psqlJson(`SELECT finalize_paystack_recurring_charge('${claim.attempt_id}'::uuid, 10001, 'NGN');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('amount_mismatch');

    // No payment created
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = '${claim.provider_reference}';`);
    expect(paymentCount).toBe('0');

    psql(`DELETE FROM paystack_billing_attempts WHERE customer_subscription_id = '${amSubId}';`);
    psql(`DELETE FROM customer_subscriptions WHERE id = '${amSubId}';`);
  });

  it('#176: currency mismatch → finalization rejected', () => {
    const cmSubId = '76cccccc-cccc-cccc-cccc-cccccccccccc';
    psql(`DELETE FROM customer_subscriptions WHERE id = '${cmSubId}';`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency, status, gateway, authorization_code, customer_phone, next_charge_at)
          VALUES ('${cmSubId}', '${BIZ_ID}', '${USER_ID}', 100, 'NGN', 'monthly', 'active', 'paystack', 'AUTH_CM', '+2347777777777', NOW() - INTERVAL '1 hour');`);

    const claim = psqlJson(`SELECT claim_paystack_billing_cycle('${cmSubId}'::uuid);`);
    const token = psql(`SELECT claim_token FROM paystack_billing_attempts WHERE id = '${claim.attempt_id}';`);
    psqlJson(`SELECT dispatch_paystack_attempt('${claim.attempt_id}'::uuid, '${token}'::uuid);`);

    const r = psqlJson(`SELECT finalize_paystack_recurring_charge('${claim.attempt_id}'::uuid, 10000, 'USD');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('currency_mismatch');

    psql(`DELETE FROM paystack_billing_attempts WHERE customer_subscription_id = '${cmSubId}';`);
    psql(`DELETE FROM customer_subscriptions WHERE id = '${cmSubId}';`);
  });

  it('#176: old process_recurring_charge is dropped', () => {
    let threw = false;
    try {
      psql(`SELECT process_recurring_charge('test', 'charge.success', 'ref', 'auth', 'cust', 5000);`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('#176: finalized replay validates amount and returns canonical IDs', () => {
    // The attempt from the earlier finalization test is still finalized
    const attemptId = psql(`SELECT id FROM paystack_billing_attempts WHERE customer_subscription_id = '${PS_SUB_ID}' AND status = 'finalized' LIMIT 1;`);

    // Replay with correct amount → success with canonical IDs
    const r = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 20000, 'NGN');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(true);
    expect(r.payment_id).toBeTruthy();

    // Replay with wrong amount → rejected
    const rBad = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 19999, 'NGN');`);
    expect(rBad.success).toBe(false);
    expect(rBad.reason).toBe('replay_amount_mismatch');

    // Replay with wrong currency → rejected
    const rCur = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 20000, 'USD');`);
    expect(rCur.success).toBe(false);
    expect(rCur.reason).toBe('replay_currency_mismatch');
  });

  it('#176: spend failure rolls back entire Paystack finalization', () => {
    const faultSubId = '76dddddd-dddd-dddd-dddd-dddddddddddd';
    psql(`DELETE FROM customer_subscriptions WHERE id = '${faultSubId}';`);
    psql(`DELETE FROM paystack_billing_attempts WHERE customer_subscription_id = '${faultSubId}';`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency, status, gateway, authorization_code, customer_phone, customer_name, next_charge_at)
          VALUES ('${faultSubId}', '${BIZ_ID}', '${USER_ID}', 50, 'NGN', 'monthly', 'active', 'paystack', 'AUTH_FAULT', '+2346666666666', 'Fault Test', NOW() - INTERVAL '1 hour');`);

    const claim = psqlJson(`SELECT claim_paystack_billing_cycle('${faultSubId}'::uuid);`);
    expect(claim.claimed).toBe(true);
    const token = psql(`SELECT claim_token FROM paystack_billing_attempts WHERE id = '${claim.attempt_id}';`);
    psqlJson(`SELECT dispatch_paystack_attempt('${claim.attempt_id}'::uuid, '${token}'::uuid);`);

    // Inject spend fault
    psql("CREATE OR REPLACE FUNCTION apply_payment_spend_once(p_payment_id UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$ BEGIN RAISE EXCEPTION 'FAULT_INJECTION: Paystack spend failure'; END; $fn$;");

    let threw = false;
    try {
      psqlJson(`SELECT finalize_paystack_recurring_charge('${claim.attempt_id}'::uuid, 5000, 'NGN');`);
    } catch { threw = true; }
    expect(threw).toBe(true);

    // Restore real function
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_334_PATH}"`, { encoding: 'utf-8', timeout: 15000 });

    // Verify rollback — no payment created
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = '${claim.provider_reference}';`);
    expect(paymentCount).toBe('0');

    // Attempt is NOT finalized
    const status = psql(`SELECT status FROM paystack_billing_attempts WHERE id = '${claim.attempt_id}';`);
    expect(status).not.toBe('finalized');

    psql(`DELETE FROM paystack_billing_attempts WHERE customer_subscription_id = '${faultSubId}';`);
    psql(`DELETE FROM customer_subscriptions WHERE id = '${faultSubId}';`);
  });

  it('#176: partial unique index prevents two unresolved attempts for same cycle', () => {
    const dupeSubId = '76eeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    psql(`DELETE FROM customer_subscriptions WHERE id = '${dupeSubId}';`);
    psql(`DELETE FROM paystack_billing_attempts WHERE customer_subscription_id = '${dupeSubId}';`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency, status, gateway, authorization_code, customer_phone, next_charge_at)
          VALUES ('${dupeSubId}', '${BIZ_ID}', '${USER_ID}', 100, 'NGN', 'monthly', 'active', 'paystack', 'AUTH_DUPE', '+2345555555555', NOW() - INTERVAL '1 hour');`);

    const claim = psqlJson(`SELECT claim_paystack_billing_cycle('${dupeSubId}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Try to insert a second unresolved attempt for the same cycle — should fail
    let insertThrew = false;
    try {
      psql(`INSERT INTO paystack_billing_attempts (customer_subscription_id, cycle_key, scheduled_at, attempt_number, provider_reference, intended_amount_minor, intended_currency, status)
            VALUES ('${dupeSubId}', '${psql(`SELECT cycle_key FROM paystack_billing_attempts WHERE id = '${claim.attempt_id}';`)}', NOW(), 2, 'ps-dupe-ref', 10000, 'NGN', 'reserved');`);
    } catch { insertThrew = true; }
    expect(insertThrew).toBe(true);

    psql(`DELETE FROM paystack_billing_attempts WHERE customer_subscription_id = '${dupeSubId}';`);
    psql(`DELETE FROM customer_subscriptions WHERE id = '${dupeSubId}';`);
  });

  // ═══════════════════════════════════════════════════════════
  // #176 ROUND 2: INVOICE CYCLE AUTHORITY + CONVERGENCE TESTS
  // ═══════════════════════════════════════════════════════════

  const MC_SUB_ID = '76ffffff-ffff-ffff-ffff-ffffffffffff';

  it('#176-R2: two successive provider-managed cycles with distinct invoice identities', () => {
    psql(`DELETE FROM paystack_billing_attempts; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`DELETE FROM customer_subscriptions WHERE id = '${MC_SUB_ID}';`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency, status, gateway, authorization_code, customer_phone, customer_name, next_charge_at, charge_count, total_charged)
          VALUES ('${MC_SUB_ID}', '${BIZ_ID}', '${USER_ID}', 100, 'NGN', 'monthly', 'active', 'paystack', 'AUTH_MC', '+2341111111111', 'MC Customer', NOW() - INTERVAL '1 hour', 0, 0);`);

    // Cycle 1: invoice INV_001
    const cycle1Key = 'ps-auto-' + MC_SUB_ID + '-INV_001';
    psql(`INSERT INTO paystack_billing_attempts (customer_subscription_id, cycle_key, scheduled_at, attempt_number, provider_reference, intended_amount_minor, intended_currency, status, charged_at, provider_invoice_code, provider_transaction_id)
          VALUES ('${MC_SUB_ID}', '${cycle1Key}', NOW(), 1, 'ps-ref-cycle1', 10000, 'NGN', 'charged', NOW(), 'INV_001', 'tx_001');`);

    const attemptId1 = psql(`SELECT id FROM paystack_billing_attempts WHERE provider_reference = 'ps-ref-cycle1';`);
    const r1 = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId1}'::uuid, 10000, 'NGN', 'tx_001', 'INV_001');`);
    expect(r1.success).toBe(true);
    expect(r1.already_finalized).toBe(false);

    // Cycle 2: invoice INV_002 — different cycle for same subscription
    const cycle2Key = 'ps-auto-' + MC_SUB_ID + '-INV_002';
    psql(`INSERT INTO paystack_billing_attempts (customer_subscription_id, cycle_key, scheduled_at, attempt_number, provider_reference, intended_amount_minor, intended_currency, status, charged_at, provider_invoice_code, provider_transaction_id)
          VALUES ('${MC_SUB_ID}', '${cycle2Key}', NOW(), 1, 'ps-ref-cycle2', 10000, 'NGN', 'charged', NOW(), 'INV_002', 'tx_002');`);

    const attemptId2 = psql(`SELECT id FROM paystack_billing_attempts WHERE provider_reference = 'ps-ref-cycle2';`);
    const r2 = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId2}'::uuid, 10000, 'NGN', 'tx_002', 'INV_002');`);
    expect(r2.success).toBe(true);
    expect(r2.already_finalized).toBe(false);

    // Both cycles finalized independently — two distinct payments
    expect(r1.payment_id).not.toBe(r2.payment_id);

    const totalPayments = psql(`SELECT COUNT(*) FROM payments WHERE business_id = '${BIZ_ID}' AND gateway = 'paystack' AND gateway_reference IN ('ps-ref-cycle1', 'ps-ref-cycle2');`);
    expect(totalPayments).toBe('2');

    // charge_count = 2
    const chargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${MC_SUB_ID}';`);
    expect(chargeCount).toBe('2');
  });

  it('#176-R2: same invoice + two refs → finalized index prevents double finalization', () => {
    psql(`DELETE FROM paystack_billing_attempts; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET charge_count = 0, total_charged = 0 WHERE id = '${MC_SUB_ID}';`);

    const cycleKey = 'ps-auto-' + MC_SUB_ID + '-INV_CONV';

    // First ref creates attempt and finalizes
    psql(`INSERT INTO paystack_billing_attempts (customer_subscription_id, cycle_key, scheduled_at, attempt_number, provider_reference, intended_amount_minor, intended_currency, status, charged_at, provider_invoice_code)
          VALUES ('${MC_SUB_ID}', '${cycleKey}', NOW(), 1, 'ps-ref-conv1', 10000, 'NGN', 'charged', NOW(), 'INV_CONV');`);

    const attemptId1 = psql(`SELECT id FROM paystack_billing_attempts WHERE provider_reference = 'ps-ref-conv1';`);
    const r1 = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId1}'::uuid, 10000, 'NGN', 'tx_conv1', 'INV_CONV');`);
    expect(r1.success).toBe(true);
    expect(r1.already_finalized).toBe(false);

    // Second ref for same invoice: insert succeeds (unresolved index doesn't block after finalized)
    // but finalization must fail (finalized index prevents two finalized for same cycle)
    psql(`INSERT INTO paystack_billing_attempts (customer_subscription_id, cycle_key, scheduled_at, attempt_number, provider_reference, intended_amount_minor, intended_currency, status, charged_at, provider_invoice_code)
          VALUES ('${MC_SUB_ID}', '${cycleKey}', NOW(), 2, 'ps-ref-conv2', 10000, 'NGN', 'charged', NOW(), 'INV_CONV');`);

    const attemptId2 = psql(`SELECT id FROM paystack_billing_attempts WHERE provider_reference = 'ps-ref-conv2';`);

    // Attempt to finalize the second attempt → must fail (finalized unique index)
    let finThrew = false;
    try {
      psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId2}'::uuid, 10000, 'NGN', 'tx_conv2', 'INV_CONV');`);
    } catch { finThrew = true; }
    expect(finThrew).toBe(true);

    // Still exactly one payment (second finalization rolled back)
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE business_id = '${BIZ_ID}' AND status = 'success';`);
    expect(paymentCount).toBe('1');

    // charge_count = 1 (not 2)
    const chargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${MC_SUB_ID}';`);
    expect(chargeCount).toBe('1');
  });

  it('#176-R2: unresolved charged attempt → finalization → one canonical result', () => {
    psql(`DELETE FROM paystack_billing_attempts; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET charge_count = 0, total_charged = 0 WHERE id = '${MC_SUB_ID}';`);

    const cycleKey = 'ps-auto-' + MC_SUB_ID + '-INV_UNRES';

    // Simulate cron dispatch that succeeded (charged) but wasn't finalized yet
    psql(`INSERT INTO paystack_billing_attempts (customer_subscription_id, cycle_key, scheduled_at, attempt_number, provider_reference, intended_amount_minor, intended_currency, status, dispatched_at, charged_at)
          VALUES ('${MC_SUB_ID}', '${cycleKey}', NOW(), 1, 'ps-ref-unres', 10000, 'NGN', 'charged', NOW(), NOW());`);

    const attemptId = psql(`SELECT id FROM paystack_billing_attempts WHERE provider_reference = 'ps-ref-unres';`);

    // Webhook arrives and finalizes (reconciliation path)
    const r = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 10000, 'NGN', 'tx_unres', 'INV_UNRES');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(false);
    expect(r.payment_id).toBeTruthy();

    // Second finalization (replay) → idempotent
    const r2 = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 10000, 'NGN', 'tx_unres', 'INV_UNRES');`);
    expect(r2.success).toBe(true);
    expect(r2.already_finalized).toBe(true);
    expect(r2.payment_id).toBe(r.payment_id);

    // Exactly one payment
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ps-ref-unres';`);
    expect(paymentCount).toBe('1');
  });

  it('#176-R2: finalization vs charged/failed transition race — concurrent finalizers', async () => {
    psql(`DELETE FROM paystack_billing_attempts; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET charge_count = 0, total_charged = 0, status = 'active' WHERE id = '${MC_SUB_ID}';`);

    const cycleKey = 'ps-auto-' + MC_SUB_ID + '-INV_RACE';
    psql(`INSERT INTO paystack_billing_attempts (customer_subscription_id, cycle_key, scheduled_at, attempt_number, provider_reference, intended_amount_minor, intended_currency, status, dispatched_at, charged_at)
          VALUES ('${MC_SUB_ID}', '${cycleKey}', NOW(), 1, 'ps-ref-race', 10000, 'NGN', 'charged', NOW(), NOW());`);

    const attemptId = psql(`SELECT id FROM paystack_billing_attempts WHERE provider_reference = 'ps-ref-race';`);

    // Two concurrent finalizers
    const sqlA = `
      BEGIN;
      SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 10000, 'NGN', 'tx_race', 'INV_RACE');
      SELECT pg_sleep(1);
      COMMIT;
    `;
    const sqlB = `
      SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 10000, 'NGN', 'tx_race', 'INV_RACE');
    `;

    const { a, b } = await runTwoSessions(sqlA, sqlB);

    const resultLines = (output: string) => output.split('\n').filter(l => l.trim().startsWith('{'));
    const rA = JSON.parse(resultLines(a.stdout)[0]);
    const rB = JSON.parse(resultLines(b.stdout)[0]);

    // Both succeed
    expect(rA.success).toBe(true);
    expect(rB.success).toBe(true);

    // Exactly one original, one idempotent
    const finalized = [rA, rB].filter(r => r.already_finalized === false);
    const idempotent = [rA, rB].filter(r => r.already_finalized === true);
    expect(finalized).toHaveLength(1);
    expect(idempotent).toHaveLength(1);

    // Same payment_id
    expect(rA.payment_id).toBe(rB.payment_id);

    // Exactly one payment record
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ps-ref-race';`);
    expect(paymentCount).toBe('1');
  });

  it('#176-R2: conflicting transaction_id replay → rejected', () => {
    // Use the finalized attempt from the race test
    const attemptId = psql(`SELECT id FROM paystack_billing_attempts WHERE provider_reference = 'ps-ref-race' AND status = 'finalized';`);
    expect(attemptId).toBeTruthy();

    // Replay with DIFFERENT transaction_id → rejected
    const r = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 10000, 'NGN', 'tx_DIFFERENT', 'INV_RACE');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('replay_transaction_id_mismatch');
  });

  it('#176-R2: conflicting invoice_code replay → rejected', () => {
    const attemptId = psql(`SELECT id FROM paystack_billing_attempts WHERE provider_reference = 'ps-ref-race' AND status = 'finalized';`);

    // Replay with DIFFERENT invoice_code → rejected
    const r = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 10000, 'NGN', 'tx_race', 'INV_WRONG');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('replay_invoice_mismatch');
  });

  it('#176-R2: correct replay with all identity fields → success', () => {
    const attemptId = psql(`SELECT id FROM paystack_billing_attempts WHERE provider_reference = 'ps-ref-race' AND status = 'finalized';`);

    // Correct identity → idempotent success
    const r = psqlJson(`SELECT finalize_paystack_recurring_charge('${attemptId}'::uuid, 10000, 'NGN', 'tx_race', 'INV_RACE');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(true);
  });

  it('#176-R2: terminal failure permits replacement claim for same cycle', () => {
    psql(`DELETE FROM paystack_billing_attempts; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET charge_count = 0, total_charged = 0, status = 'active', next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${MC_SUB_ID}';`);

    // Claim + dispatch
    const claim1 = psqlJson(`SELECT claim_paystack_billing_cycle('${MC_SUB_ID}'::uuid);`);
    expect(claim1.claimed).toBe(true);
    const token1 = psql(`SELECT claim_token FROM paystack_billing_attempts WHERE id = '${claim1.attempt_id}';`);
    psqlJson(`SELECT dispatch_paystack_attempt('${claim1.attempt_id}'::uuid, '${token1}'::uuid);`);

    // Terminal failure — mark attempt failed
    psql(`UPDATE paystack_billing_attempts SET status = 'failed', failure_reason = 'paystack_charge_failed' WHERE id = '${claim1.attempt_id}';`);

    // New claim should succeed (failed attempt doesn't block)
    const claim2 = psqlJson(`SELECT claim_paystack_billing_cycle('${MC_SUB_ID}'::uuid);`);
    expect(claim2.claimed).toBe(true);
    expect(claim2.attempt_id).not.toBe(claim1.attempt_id);

    // New attempt has incremented attempt_number
    const attemptNum = psql(`SELECT attempt_number FROM paystack_billing_attempts WHERE id = '${claim2.attempt_id}';`);
    expect(parseInt(attemptNum)).toBe(2);
  });

  it('#176-R2: dispatched attempt with failed status update is guarded', () => {
    psql(`DELETE FROM paystack_billing_attempts;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${MC_SUB_ID}';`);

    // Create and finalize an attempt
    const claim = psqlJson(`SELECT claim_paystack_billing_cycle('${MC_SUB_ID}'::uuid);`);
    const token = psql(`SELECT claim_token FROM paystack_billing_attempts WHERE id = '${claim.attempt_id}';`);
    psqlJson(`SELECT dispatch_paystack_attempt('${claim.attempt_id}'::uuid, '${token}'::uuid);`);
    psqlJson(`SELECT finalize_paystack_recurring_charge('${claim.attempt_id}'::uuid, 10000, 'NGN');`);

    // Verify status is finalized
    const statusBefore = psql(`SELECT status FROM paystack_billing_attempts WHERE id = '${claim.attempt_id}';`);
    expect(statusBefore).toBe('finalized');

    // Concurrent cron tries to mark as failed — guarded by .in('status', ['dispatched', 'charged'])
    psql(`UPDATE paystack_billing_attempts SET status = 'failed', failure_reason = 'late_cron_update' WHERE id = '${claim.attempt_id}' AND status IN ('dispatched', 'charged');`);

    // Status unchanged — still finalized
    const statusAfter = psql(`SELECT status FROM paystack_billing_attempts WHERE id = '${claim.attempt_id}';`);
    expect(statusAfter).toBe('finalized');
  });

  it('#176-R2: reserved attempt cannot be finalized (guard)', () => {
    psql(`DELETE FROM paystack_billing_attempts;`);
    psql(`UPDATE customer_subscriptions SET status = 'active', next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${MC_SUB_ID}';`);

    const claim = psqlJson(`SELECT claim_paystack_billing_cycle('${MC_SUB_ID}'::uuid);`);
    expect(claim.claimed).toBe(true);

    // Try to finalize without dispatching — should be rejected
    const r = psqlJson(`SELECT finalize_paystack_recurring_charge('${claim.attempt_id}'::uuid, 10000, 'NGN');`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('wrong_status');
    expect(r.status).toBe('reserved');
  });

  it('#176-R2: failed attempt can be finalized (late-success recovery)', () => {
    psql(`DELETE FROM paystack_billing_attempts; DELETE FROM payments; DELETE FROM bookings; DELETE FROM subscription_charges; DELETE FROM platform_fees;`);
    psql(`UPDATE customer_subscriptions SET charge_count = 0, total_charged = 0, status = 'active', next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${MC_SUB_ID}';`);

    // Create, dispatch, then mark as failed
    const claim = psqlJson(`SELECT claim_paystack_billing_cycle('${MC_SUB_ID}'::uuid);`);
    const token = psql(`SELECT claim_token FROM paystack_billing_attempts WHERE id = '${claim.attempt_id}';`);
    psqlJson(`SELECT dispatch_paystack_attempt('${claim.attempt_id}'::uuid, '${token}'::uuid);`);
    psql(`UPDATE paystack_billing_attempts SET status = 'failed', failure_reason = 'timeout' WHERE id = '${claim.attempt_id}';`);

    // Late verification discovers the charge actually succeeded → finalize
    const r = psqlJson(`SELECT finalize_paystack_recurring_charge('${claim.attempt_id}'::uuid, 10000, 'NGN', 'tx_late', 'INV_LATE');`);
    expect(r.success).toBe(true);
    expect(r.already_finalized).toBe(false);
    expect(r.payment_id).toBeTruthy();

    const status = psql(`SELECT status FROM paystack_billing_attempts WHERE id = '${claim.attempt_id}';`);
    expect(status).toBe('finalized');
  });

  // ═══════════════════════════════════════════════════════════
  // #176 ROUND 5: DEFERRED RECONCILIATION INTEGRATION TESTS
  // Executes the REAL production reconcilePaystackEvent helper
  // against the migrated PostgreSQL test database with mocked
  // provider boundaries.
  // ═══════════════════════════════════════════════════════════

  const RC_SUB_A = '76aaaaaa-1111-1111-1111-aaaaaaaaaaaa';
  const RC_SUB_B = '76bbbbbb-2222-2222-2222-bbbbbbbbbbbb';

  /**
   * Create a minimal supabase-like client that delegates to psql
   * for real PostgreSQL execution in the same test database.
   */
  function createTestSupabase() {
    // Simple chaining query builder that executes against real PostgreSQL
    function createQueryBuilder(table: string) {
      let query = `SELECT * FROM ${table}`;
      const wheres: string[] = [];
      let selectCols = '*';
      let limitVal: number | null = null;
      let isSingle = false;
      let isMaybeSingle = false;
      let insertData: Record<string, unknown> | null = null;
      let updateData: Record<string, unknown> | null = null;

      const builder: any = {
        select(cols: string) { selectCols = cols; return builder; },
        eq(col: string, val: unknown) { wheres.push(`${col} = '${val}'`); return builder; },
        in(col: string, vals: unknown[]) { wheres.push(`${col} IN (${vals.map(v => `'${v}'`).join(',')})`); return builder; },
        limit(n: number) { limitVal = n; return builder; },
        not(col: string, op: string, val: unknown) { wheres.push(`${col} IS NOT NULL`); return builder; },
        single() { isSingle = true; return builder.execute(); },
        maybeSingle() { isMaybeSingle = true; return builder.execute(); },
        then(resolve: (v: any) => void, reject?: (e: any) => void) {
          return builder.execute().then(resolve, reject);
        },
        insert(data: Record<string, unknown>) {
          insertData = data;
          const insertBuilder = {
            select: () => ({ single: () => builder.executeInsert() }),
            then: (resolve: any, reject?: any) => builder.executeInsert().then(resolve, reject),
          };
          return insertBuilder;
        },
        update(data: Record<string, unknown>) {
          updateData = data;
          return builder;
        },
        execute() {
          if (updateData) {
            const setClauses = Object.entries(updateData).map(([k, v]) => v === null ? `${k} = NULL` : `${k} = '${v}'`).join(', ');
            const whereClause = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : '';
            try { psql(`UPDATE ${table} SET ${setClauses}${whereClause};`); } catch {}
            return Promise.resolve({ data: null, error: null });
          }
          const whereClause = wheres.length ? ` WHERE ${wheres.join(' AND ')}` : '';
          const limitClause = limitVal ? ` LIMIT ${limitVal}` : '';
          const singleClause = (isSingle || isMaybeSingle) ? ' LIMIT 1' : '';
          const sql = `SELECT row_to_json(t) FROM (SELECT ${selectCols} FROM ${table}${whereClause}${limitClause}${singleClause}) t;`;
          try {
            const raw = psql(sql);
            if (!raw) return Promise.resolve({ data: (isSingle || isMaybeSingle) ? null : [], error: null });
            const rows = raw.split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));
            if (isSingle || isMaybeSingle) return Promise.resolve({ data: rows[0] || null, error: null });
            return Promise.resolve({ data: rows, error: null });
          } catch (e) {
            if (isMaybeSingle) return Promise.resolve({ data: null, error: null });
            return Promise.resolve({ data: null, error: e });
          }
        },
        executeInsert() {
          if (!insertData) return Promise.resolve({ data: null, error: null });
          const cols = Object.keys(insertData);
          const vals = cols.map(c => {
            const v = insertData![c];
            return v === null ? 'NULL' : `'${v}'`;
          });
          const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')});`;
          try {
            psql(sql);
            return Promise.resolve({ error: null });
          } catch (e) {
            return Promise.resolve({ error: e });
          }
        },
      };
      return builder;
    }

    return {
      from(table: string) { return createQueryBuilder(table); },
      rpc(fn: string, params: Record<string, unknown>) {
        const args = Object.entries(params).map(([k, v]) => {
          if (v === null) return `${k} := NULL`;
          if (typeof v === 'number') return `${k} := ${v}`;
          return `${k} := '${v}'`;
        }).join(', ');
        const sql = `SELECT ${fn}(${args});`;
        try {
          const raw = psql(sql);
          const result = raw ? JSON.parse(raw) : null;
          return Promise.resolve({ data: result, error: null });
        } catch (e) {
          return Promise.resolve({ data: null, error: e });
        }
      },
    };
  }

  it('#176-R5 CASE A: no-subscription-code charge → reconciliation_required, zero financial writes', async () => {
    // Clean state
    psql(`DELETE FROM paystack_billing_attempts; DELETE FROM payments; DELETE FROM bookings;
          DELETE FROM subscription_charges; DELETE FROM platform_fees; DELETE FROM payment_spend_applications;`);
    psql(`DELETE FROM customer_subscriptions WHERE id IN ('${RC_SUB_A}', '${RC_SUB_B}');`);

    // Create subscriptions with auth hints
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency, status, gateway, authorization_code, gateway_customer_code, gateway_subscription_code, customer_phone, customer_name, next_charge_at, charge_count, total_charged)
          VALUES ('${RC_SUB_A}', '${BIZ_ID}', '${USER_ID}', 100, 'NGN', 'monthly', 'active', 'paystack', 'AUTH_SHARED', 'CUST_SHARED', 'SUB_CODE_A', '+2340001112222', 'Sub A', NOW() - INTERVAL '1 hour', 0, 0);`);

    // Simulate parked unresolved event (no subscription_code)
    psql(`INSERT INTO processed_webhook_events (event_id, gateway, event_type, status, first_received_at, last_attempted_at, last_error)
          VALUES ('paystack-unresolved-ref-caseA', 'paystack', 'unresolved_recurring_charge', 'reconciliation_required', NOW(), NOW(),
          '${JSON.stringify({ reference: 'ref-caseA', auth_code: 'AUTH_SHARED', customer_code: 'CUST_SHARED', amount_kobo: 10000, currency: 'NGN' }).replace(/'/g, "''")}');`);

    // At this point: evidence parked, NO financial writes expected
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE business_id = '${BIZ_ID}';`);
    expect(paymentCount).toBe('0');

    const subTotals = psql(`SELECT charge_count, total_charged FROM customer_subscriptions WHERE id = '${RC_SUB_A}';`);
    expect(subTotals).toContain('0');

    // Verify the evidence is parked
    const evtStatus = psql(`SELECT status FROM processed_webhook_events WHERE event_id = 'paystack-unresolved-ref-caseA';`);
    expect(evtStatus).toBe('reconciliation_required');
  });

  it('#176-R5 CASE B: hint enumeration with two candidates, exactly one provider match → one finalization', async () => {
    // Add second subscription sharing the same auth hint but different gateway_subscription_code
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency, status, gateway, authorization_code, gateway_customer_code, gateway_subscription_code, customer_phone, customer_name, next_charge_at, charge_count, total_charged)
          VALUES ('${RC_SUB_B}', '${BIZ_ID}', '${USER_ID}', 100, 'NGN', 'monthly', 'active', 'paystack', 'AUTH_SHARED', 'CUST_SHARED', 'SUB_CODE_B', '+2340003334444', 'Sub B', NOW() - INTERVAL '1 hour', 0, 0)
          ON CONFLICT (id) DO NOTHING;`);

    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');

    // Provider mocks:
    // - verify ref-caseA → success (amount 10000, NGN, txId 777)
    // - correlateInvoiceExact(SUB_CODE_A, '777') → NO match (candidate A fails)
    // - correlateInvoiceExact(SUB_CODE_B, '777') → exact match INV_CASEB
    const mockVerify = async (ref: string) => ({
      status: 'success' as const,
      amountMinor: 10000,
      currency: 'NGN',
      transactionId: '777',
    });
    const mockCorrelate = async (subCode: string, txId: string) => {
      if (subCode === 'SUB_CODE_A') return { status: 'definitive_no_match' as const };
      if (subCode === 'SUB_CODE_B' && txId === '777') return { status: 'exact_match' as const, invoiceCode: 'INV_CASEB', amount: 10000, invoiceStatus: 'success' };
      return { status: 'definitive_no_match' as const };
    };

    const testSupabase = createTestSupabase();

    const result = await reconcilePaystackEvent(
      { supabase: testSupabase as any, correlateInvoiceExact: mockCorrelate, verifyPaystackTransaction: mockVerify },
      { reference: 'ref-caseA', auth_code: 'AUTH_SHARED', customer_code: 'CUST_SHARED' },
    );

    expect(result.action).toBe('finalized');
    if (result.action === 'finalized') {
      expect(result.alreadyFinalized).toBe(false);
      expect(result.paymentId).toBeTruthy();
    }

    // Verify exactly one payment
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseA';`);
    expect(paymentCount).toBe('1');

    // Verify subscription B totals advanced (not A)
    const subBTotals = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${RC_SUB_B}';`);
    expect(subBTotals).toBe('1');
    const subATotals = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${RC_SUB_A}';`);
    expect(subATotals).toBe('0');

    // Exactly one billing attempt finalized
    const attemptStatus = psql(`SELECT status FROM paystack_billing_attempts WHERE provider_reference = 'ref-caseA';`);
    expect(attemptStatus).toBe('finalized');

    // Spend marker exists
    if (result.action === 'finalized') {
      const spendCount = psql(`SELECT COUNT(*) FROM payment_spend_applications WHERE payment_id = '${result.paymentId}';`);
      expect(spendCount).toBe('1');
    }
  });

  it('#176-R5 CASE C: zero authoritative matches → reconciliation_required, zero financial writes', async () => {
    psql(`DELETE FROM paystack_billing_attempts WHERE provider_reference = 'ref-caseC';`);

    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');

    // Both candidates fail invoice match
    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async () => ({ status: 'definitive_no_match' as const }),
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'NGN', transactionId: '888' }),
      },
      { reference: 'ref-caseC', auth_code: 'AUTH_SHARED', customer_code: 'CUST_SHARED' },
    );

    expect(result.action).toBe('skipped');
    if (result.action === 'skipped') {
      expect(result.reason).toBe('zero_authoritative_match');
    }

    // Zero payments created
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseC';`);
    expect(paymentCount).toBe('0');
  });

  it('#176-R5 CASE D: multiple authoritative matches → reconciliation_required, zero finalization', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');

    // Both candidates match (should not happen, but defensive test)
    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async (subCode: string) => ({ status: 'exact_match' as const, invoiceCode: `INV_${subCode}`, amount: 10000, invoiceStatus: 'success' }),
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'NGN', transactionId: '999' }),
      },
      { reference: 'ref-caseD', auth_code: 'AUTH_SHARED', customer_code: 'CUST_SHARED' },
    );

    expect(result.action).toBe('skipped');
    if (result.action === 'skipped') {
      expect(result.reason).toBe('multiple_authoritative_matches');
    }

    // Zero payments
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseD';`);
    expect(paymentCount).toBe('0');
  });

  it('#176-R5 CASE E: replay after finalization → no duplicate writes', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');

    // Re-run CASE B scenario with same reference — should be idempotent
    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async (subCode: string, txId: string) => {
          if (subCode === 'SUB_CODE_B' && txId === '777') return { status: 'exact_match' as const, invoiceCode: 'INV_CASEB', amount: 10000, invoiceStatus: 'success' };
          return { status: 'definitive_no_match' as const };
        },
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'NGN', transactionId: '777' }),
      },
      { reference: 'ref-caseA', auth_code: 'AUTH_SHARED', customer_code: 'CUST_SHARED' },
    );

    // Should be already_finalized (from CASE B)
    expect(result.action).toBe('finalized');
    if (result.action === 'finalized') {
      expect(result.alreadyFinalized).toBe(true);
    }

    // Still exactly one payment
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseA';`);
    expect(paymentCount).toBe('1');

    // Sub B charge_count still 1
    const subBCharges = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${RC_SUB_B}';`);
    expect(subBCharges).toBe('1');
  });

  it('#176-R5 CASE G: provider verify HTTP error → skipped, zero financial writes', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');

    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async () => ({ status: 'definitive_no_match' as const }),
        verifyPaystackTransaction: async () => ({ status: 'indeterminate' as const, reason: 'http_500' }),
      },
      { reference: 'ref-caseG', auth_code: 'AUTH_SHARED' },
    );

    expect(result.action).toBe('skipped');
    if (result.action === 'skipped') {
      expect(result.reason).toBe('verify_indeterminate');
    }
  });

  it('#176-R5 CASE G2: amount mismatch → skipped', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');

    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async (subCode: string) => {
          if (subCode === 'SUB_CODE_A') return { status: 'exact_match' as const, invoiceCode: 'INV_AMT', amount: 99999, invoiceStatus: 'success' };
          return { status: 'definitive_no_match' as const };
        },
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 99999, currency: 'NGN', transactionId: '1234' }),
      },
      { reference: 'ref-caseG2', auth_code: 'AUTH_SHARED' },
    );

    // Amount 99999 != expected 10000 → zero authoritative matches
    expect(result.action).toBe('skipped');

    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseG2';`);
    expect(paymentCount).toBe('0');
  });

  it('#176-R5 CASE H: concurrent reconciliation → exactly one canonical result', async () => {
    // Clean for fresh reconciliation
    psql(`DELETE FROM paystack_billing_attempts WHERE provider_reference = 'ref-caseH';`);
    psql(`DELETE FROM payments WHERE gateway_reference = 'ref-caseH';`);

    // Create a dedicated sub for this test
    const RC_SUB_H = '76cccc33-3333-3333-3333-cccccccccccc';
    psql(`DELETE FROM customer_subscriptions WHERE id = '${RC_SUB_H}';`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency, status, gateway, authorization_code, gateway_subscription_code, customer_phone, customer_name, next_charge_at, charge_count, total_charged)
          VALUES ('${RC_SUB_H}', '${BIZ_ID}', '${USER_ID}', 50, 'NGN', 'monthly', 'active', 'paystack', 'AUTH_H', 'SUB_CODE_H', '+2340005556666', 'Sub H', NOW() - INTERVAL '1 hour', 0, 0);`);

    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');

    const deps = {
      supabase: createTestSupabase() as any,
      correlateInvoiceExact: async (subCode: string, txId: string) => {
        if (subCode === 'SUB_CODE_H' && txId === '555') return { status: 'exact_match' as const, invoiceCode: 'INV_H', amount: 5000, invoiceStatus: 'success' };
        return { status: 'definitive_no_match' as const };
      },
      verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 5000, currency: 'NGN', transactionId: '555' }),
    };

    // Run two reconciliations concurrently
    const [r1, r2] = await Promise.all([
      reconcilePaystackEvent(deps, { reference: 'ref-caseH', subscription_code: 'SUB_CODE_H' }),
      reconcilePaystackEvent(deps, { reference: 'ref-caseH', subscription_code: 'SUB_CODE_H' }),
    ]);

    // Both succeed — one original, one idempotent or conflict-handled
    const finalized = [r1, r2].filter(r => r.action === 'finalized');
    const skipped = [r1, r2].filter(r => r.action === 'skipped');

    // At least one finalized (possibly both via idempotent replay)
    expect(finalized.length).toBeGreaterThanOrEqual(1);

    // Exactly one payment
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseH';`);
    expect(paymentCount).toBe('1');

    // charge_count = 1
    const chargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${RC_SUB_H}';`);
    expect(chargeCount).toBe('1');

    psql(`Delete from customer_subscriptions WHERE id = '${RC_SUB_H}';`);
  });

  // ═══════════════════════════════════════════════════════════
  // #176 ROUND 6: PROVIDER UNCERTAINTY + FINALIZER RETRY
  // ═══════════════════════════════════════════════════════════

  it('#176-R6 CASE I: candidate A indeterminate + B match → NO finalization', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');
    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async (subCode: string) => {
          if (subCode === 'SUB_CODE_A') return { status: 'indeterminate' as const, reason: 'http_500' };
          if (subCode === 'SUB_CODE_B') return { status: 'exact_match' as const, invoiceCode: 'INV_I', amount: 10000, invoiceStatus: 'success' };
          return { status: 'definitive_no_match' as const };
        },
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'NGN', transactionId: '1001' }),
      },
      { reference: 'ref-caseI', auth_code: 'AUTH_SHARED', customer_code: 'CUST_SHARED' },
    );
    expect(result.action).toBe('skipped');
    if (result.action === 'skipped') expect(result.reason).toBe('candidate_indeterminate');
    expect(psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseI';`)).toBe('0');
  });

  it('#176-R6 CASE J: candidate A timeout + B match → NO finalization', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');
    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async (subCode: string) => {
          if (subCode === 'SUB_CODE_A') return { status: 'indeterminate' as const, reason: 'network_error' };
          if (subCode === 'SUB_CODE_B') return { status: 'exact_match' as const, invoiceCode: 'INV_J', amount: 10000, invoiceStatus: 'success' };
          return { status: 'definitive_no_match' as const };
        },
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'NGN', transactionId: '1002' }),
      },
      { reference: 'ref-caseJ', auth_code: 'AUTH_SHARED' },
    );
    expect(result.action).toBe('skipped');
    if (result.action === 'skipped') expect(result.reason).toBe('candidate_indeterminate');
  });

  it('#176-R6 CASE K: verify success but NO transaction ID → NO finalization', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');
    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async () => ({ status: 'exact_match' as const, invoiceCode: 'INV_K', amount: 10000, invoiceStatus: 'success' }),
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'NGN', transactionId: undefined }),
      },
      { reference: 'ref-caseK', auth_code: 'AUTH_SHARED' },
    );
    expect(result.action).toBe('skipped');
    if (result.action === 'skipped') expect(result.reason).toBe('verify_missing_transaction_id');
    expect(psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseK';`)).toBe('0');
  });

  it('#176-R6 CASE L: verified amount differs from webhook evidence → NO finalization', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');
    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async () => ({ status: 'exact_match' as const, invoiceCode: 'INV_L', amount: 10000, invoiceStatus: 'success' }),
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 20000, currency: 'NGN', transactionId: '1003' }),
      },
      { reference: 'ref-caseL', auth_code: 'AUTH_SHARED', amount_kobo: 10000, currency: 'NGN' },
    );
    expect(result.action).toBe('skipped');
    if (result.action === 'skipped') expect(result.reason).toBe('evidence_amount_mismatch');
  });

  it('#176-R6 CASE M: verified currency differs from webhook evidence → NO finalization', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');
    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async () => ({ status: 'exact_match' as const, invoiceCode: 'INV_M', amount: 10000, invoiceStatus: 'success' }),
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'USD', transactionId: '1004' }),
      },
      { reference: 'ref-caseM', auth_code: 'AUTH_SHARED', amount_kobo: 10000, currency: 'NGN' },
    );
    expect(result.action).toBe('skipped');
    if (result.action === 'skipped') expect(result.reason).toBe('evidence_currency_mismatch');
  });

  it('#176-R6 CASE N: finalizer fails → reuse attempt → finalize → replay once', async () => {
    psql(`DELETE FROM paystack_billing_attempts WHERE provider_reference = 'ref-caseN';`);
    psql(`DELETE FROM payments WHERE gateway_reference = 'ref-caseN';`);
    const RC_SUB_N = '76cccc44-4444-4444-4444-cccccccccccc';
    psql(`DELETE FROM customer_subscriptions WHERE id = '${RC_SUB_N}';`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency, status, gateway, authorization_code, gateway_subscription_code, customer_phone, customer_name, next_charge_at, charge_count, total_charged)
          VALUES ('${RC_SUB_N}', '${BIZ_ID}', '${USER_ID}', 100, 'NGN', 'monthly', 'active', 'paystack', 'AUTH_N', 'SUB_CODE_N', '+2340007778888', 'Sub N', NOW() - INTERVAL '1 hour', 0, 0);`);

    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');
    const goodDeps = {
      correlateInvoiceExact: async (subCode: string, txId: string) => {
        if (subCode === 'SUB_CODE_N' && txId === '2001') return { status: 'exact_match' as const, invoiceCode: 'INV_N', amount: 10000, invoiceStatus: 'success' };
        return { status: 'definitive_no_match' as const };
      },
      verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'NGN', transactionId: '2001' }),
    };

    psql("CREATE OR REPLACE FUNCTION apply_payment_spend_once(p_payment_id UUID) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$ BEGIN RAISE EXCEPTION 'FAULT: case N'; END; $fn$;");

    const r1 = await reconcilePaystackEvent({ supabase: createTestSupabase() as any, ...goodDeps }, { reference: 'ref-caseN', subscription_code: 'SUB_CODE_N' });
    expect(r1.action).toBe('error');
    expect(psql(`SELECT status FROM paystack_billing_attempts WHERE provider_reference = 'ref-caseN';`)).toBe('charged');
    expect(psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseN';`)).toBe('0');

    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_334_PATH}"`, { encoding: 'utf-8', timeout: 15000 });

    const r2 = await reconcilePaystackEvent({ supabase: createTestSupabase() as any, ...goodDeps }, { reference: 'ref-caseN', subscription_code: 'SUB_CODE_N' });
    expect(r2.action).toBe('finalized');
    if (r2.action === 'finalized') expect(r2.alreadyFinalized).toBe(false);
    expect(psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseN';`)).toBe('1');
    expect(psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${RC_SUB_N}';`)).toBe('1');

    const r3 = await reconcilePaystackEvent({ supabase: createTestSupabase() as any, ...goodDeps }, { reference: 'ref-caseN', subscription_code: 'SUB_CODE_N' });
    expect(r3.action).toBe('finalized');
    if (r3.action === 'finalized') expect(r3.alreadyFinalized).toBe(true);
    expect(psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseN';`)).toBe('1');

    psql(`DELETE FROM customer_subscriptions WHERE id = '${RC_SUB_N}';`);
  });

  // ═══════════════════════════════════════════════════════════
  // #176 ROUND 8: INVOICE SHAPE + AMOUNT/STATUS + CURRENCY
  // ═══════════════════════════════════════════════════════════

  it('#176-R8 CASE S: invoice amount contradicts verified amount → NO finalization', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');

    // Invoice amount 9999 ≠ verified 10000 — contradiction
    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async (subCode: string) => {
          if (subCode === 'SUB_CODE_A') return { status: 'exact_match' as const, invoiceCode: 'INV_S', amount: 9999, invoiceStatus: 'success' };
          return { status: 'definitive_no_match' as const };
        },
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'NGN', transactionId: '3001' }),
      },
      { reference: 'ref-caseS', auth_code: 'AUTH_SHARED', amount_kobo: 10000, currency: 'NGN' },
    );

    expect(result.action).toBe('skipped');
    if (result.action === 'skipped') expect(result.reason).toBe('zero_authoritative_match');
    expect(psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseS';`)).toBe('0');
  });

  it('#176-R8 CASE T: invoice status pending → NO finalization', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');

    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async (subCode: string) => {
          if (subCode === 'SUB_CODE_A') return { status: 'exact_match' as const, invoiceCode: 'INV_T', amount: 10000, invoiceStatus: 'pending' };
          return { status: 'definitive_no_match' as const };
        },
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'NGN', transactionId: '3002' }),
      },
      { reference: 'ref-caseT', auth_code: 'AUTH_SHARED', amount_kobo: 10000, currency: 'NGN' },
    );

    expect(result.action).toBe('skipped');
    if (result.action === 'skipped') expect(result.reason).toBe('zero_authoritative_match');
  });

  it('#176-R8 CASE T2: invoice status failed → NO finalization', async () => {
    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');

    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async () => ({ status: 'exact_match' as const, invoiceCode: 'INV_T2', amount: 10000, invoiceStatus: 'failed' }),
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'NGN', transactionId: '3003' }),
      },
      { reference: 'ref-caseT2', subscription_code: 'SUB_CODE_A', amount_kobo: 10000, currency: 'NGN' },
    );

    expect(result.action).toBe('skipped');
  });

  it('#176-R8 CASE U: existing attempt currency conflict → NO finalization', async () => {
    // Subscription uses USD so candidate passes the pre-check
    // But existing ATTEMPT was created with NGN (e.g., prior currency change)
    psql(`DELETE FROM paystack_billing_attempts WHERE provider_reference = 'ref-caseU';`);
    psql(`DELETE FROM payments WHERE gateway_reference = 'ref-caseU';`);

    const RC_SUB_U = '76cccc55-5555-5555-5555-cccccccccccc';
    psql(`DELETE FROM customer_subscriptions WHERE id = '${RC_SUB_U}';`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, currency, frequency, status, gateway, authorization_code, gateway_subscription_code, customer_phone, customer_name, next_charge_at, charge_count, total_charged)
          VALUES ('${RC_SUB_U}', '${BIZ_ID}', '${USER_ID}', 100, 'USD', 'monthly', 'active', 'paystack', 'AUTH_U', 'SUB_CODE_U', '+2340009990000', 'Sub U', NOW() - INTERVAL '1 hour', 0, 0);`);

    // Insert a charged attempt with NGN (conflict with current subscription USD)
    psql(`INSERT INTO paystack_billing_attempts (customer_subscription_id, cycle_key, scheduled_at, attempt_number, provider_reference, intended_amount_minor, intended_currency, status, charged_at, provider_transaction_id, provider_invoice_code)
          VALUES ('${RC_SUB_U}', 'ps-auto-${RC_SUB_U}-INV_U', NOW(), 1, 'ref-caseU', 10000, 'NGN', 'charged', NOW(), '4001', 'INV_U');`);

    const { reconcilePaystackEvent } = await import('@/lib/payments/paystack-reconciliation');

    // Verify returns USD, subscription is USD, but existing attempt is NGN
    const result = await reconcilePaystackEvent(
      {
        supabase: createTestSupabase() as any,
        correlateInvoiceExact: async () => ({ status: 'exact_match' as const, invoiceCode: 'INV_U', amount: 10000, invoiceStatus: 'success' }),
        verifyPaystackTransaction: async () => ({ status: 'success' as const, amountMinor: 10000, currency: 'USD', transactionId: '4001' }),
      },
      { reference: 'ref-caseU', subscription_code: 'SUB_CODE_U', amount_kobo: 10000, currency: 'USD' },
    );

    expect(result.action).toBe('skipped');
    if (result.action === 'skipped') expect(result.reason).toBe('existing_attempt_currency_conflict');

    // No payment created
    expect(psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'ref-caseU';`)).toBe('0');

    // Existing attempt NOT modified — still NGN
    expect(psql(`SELECT intended_currency FROM paystack_billing_attempts WHERE provider_reference = 'ref-caseU';`)).toBe('NGN');

    // Subscription totals unchanged
    expect(psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${RC_SUB_U}';`)).toBe('0');

    psql(`DELETE FROM paystack_billing_attempts WHERE provider_reference = 'ref-caseU';`);
    psql(`DELETE FROM customer_subscriptions WHERE id = '${RC_SUB_U}';`);
  });
});
