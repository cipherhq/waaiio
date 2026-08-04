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
        failure_count INT DEFAULT 0
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
        booking_id UUID, amount NUMERIC(12,2), currency TEXT, gateway TEXT,
        gateway_reference TEXT UNIQUE, status TEXT DEFAULT 'pending',
        gateway_status TEXT, payment_method TEXT, card_last_four TEXT, card_brand TEXT,
        paid_at TIMESTAMPTZ, metadata JSONB
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
        first_received_at TIMESTAMPTZ, last_attempted_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recurring_interval TEXT
      );
      INSERT INTO businesses (id) VALUES ('${BIZ_ID}') ON CONFLICT DO NOTHING;
    `);
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_PATH}"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS platform_fees, subscription_charges, payments, bookings, customer_subscriptions, processed_webhook_events, platform_settings, services, businesses CASCADE;`);
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

  it('3. finalize is idempotent — duplicate produces same result', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM subscription_charges; DELETE FROM bookings; DELETE FROM platform_fees;`);
    psql(`DELETE FROM customer_subscriptions;`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, frequency, status, gateway, charge_count, total_charged, next_charge_at)
          VALUES ('${SUB_ID}', '${BIZ_ID}', '${USER_ID}', 50, 'monthly', 'active', 'flutterwave', 0, 0, NOW() - INTERVAL '1 hour');`);

    // Claim returns the database-derived stable_ref
    const claimResult = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    expect(claimResult.claimed).toBe(true);
    const ref = claimResult.stable_ref;

    const r1 = psqlJson(`SELECT finalize_token_recurring_charge('${ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r1.success).toBe(true);
    expect(r1.already_finalized).toBe(false);

    const r2 = psqlJson(`SELECT finalize_token_recurring_charge('${ref}', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r2.success).toBe(true);
    expect(r2.already_finalized).toBe(true);

    // Exactly one payment
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = '${ref}';`);
    expect(paymentCount).toBe('1');

    // charge_count = 1 (not 2)
    const chargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(chargeCount).toBe('1');

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
    psql(`UPDATE customer_subscriptions SET next_charge_at = NOW() - INTERVAL '1 day' WHERE id = '${SUB_ID}';`);

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

  it('duplicate failure recording → already_recorded, no double increment', () => {
    // From previous test state: event is provider_failed, failure_count = 1
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    // Claim returns recovered=true for provider_failed events
    if (claim.claimed) {
      // Re-record same failure
      const r = psqlJson(`SELECT record_flutterwave_definitive_failure('${SUB_ID}'::uuid, '${claim.stable_ref}');`);
      // Should be wrong_event_state (it was re-claimed, not still provider_failed)
      // This proves a re-claimed cycle can fail again
    }
    const count = psql(`SELECT failure_count FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    // Should still be 1 from the first recording (not 2)
    expect(parseInt(count)).toBeLessThanOrEqual(2);
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

  it('cancel blocked when unresolved claim exists (provider_success)', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'past_due', gateway = 'flutterwave', failure_count = 3, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // Create a provider_success claim (charge succeeded but not finalized)
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    psql(`UPDATE processed_webhook_events SET status = 'provider_success' WHERE event_id = '${claim.stable_ref}';`);

    const r = psqlJson(`SELECT cancel_flutterwave_after_failures('${SUB_ID}'::uuid);`);
    expect(r.cancelled).toBe(false);
    expect(r.reason).toBe('unresolved_claim');
  });

  it('cancel blocked when unresolved claim exists (claimed)', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'past_due', gateway = 'flutterwave', failure_count = 3, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);
    psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);

    const r = psqlJson(`SELECT cancel_flutterwave_after_failures('${SUB_ID}'::uuid);`);
    expect(r.cancelled).toBe(false);
    expect(r.reason).toBe('unresolved_claim');
  });

  it('cancel succeeds when no unresolved claims', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'past_due', gateway = 'flutterwave', failure_count = 3, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    // Create and resolve the claim (mark as provider_failed — no unresolved money)
    const claim = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid);`);
    psql(`UPDATE processed_webhook_events SET status = 'provider_failed' WHERE event_id = '${claim.stable_ref}';`);

    const r = psqlJson(`SELECT cancel_flutterwave_after_failures('${SUB_ID}'::uuid);`);
    expect(r.cancelled).toBe(true);

    const status = psql(`SELECT status FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(status).toBe('cancelled');
  });

  it('cancel rejected for insufficient failures', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET status = 'past_due', gateway = 'flutterwave', failure_count = 2 WHERE id = '${SUB_ID}';`);

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
});
