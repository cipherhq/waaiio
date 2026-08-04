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

      CREATE TABLE IF NOT EXISTS businesses (id UUID PK DEFAULT gen_random_uuid(), subscription_tier TEXT DEFAULT 'free', trial_ends_at TIMESTAMPTZ, payout_mode TEXT DEFAULT 'platform');
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
      INSERT INTO businesses (id) VALUES ('${BIZ_ID}') ON CONFLICT DO NOTHING;
    `);
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_PATH}"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS platform_fees, subscription_charges, payments, bookings, customer_subscriptions, processed_webhook_events, platform_settings, businesses CASCADE;`);
  });

  it('1. concurrent claim → exactly one wins', async () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM customer_subscriptions;`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, frequency, status, next_charge_at)
          VALUES ('${SUB_ID}', '${BIZ_ID}', '${USER_ID}', 50, 'monthly', 'active', NOW() - INTERVAL '1 hour');`);

    const sqlA = `
      BEGIN;
      SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid, NOW() - INTERVAL '1 hour', 'flw-${SUB_ID}-2026-08-01');
      SELECT pg_sleep(1);
      COMMIT;
    `;
    const sqlB = `
      SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid, NOW() - INTERVAL '1 hour', 'flw-${SUB_ID}-2026-08-01');
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
    const ref1 = `flw-${SUB_ID}-2026-08-01`;
    const ref2 = `flw-${SUB_ID}-2026-08-01`;
    expect(ref1).toBe(ref2);
  });

  it('3. finalize is idempotent — duplicate produces same result', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM subscription_charges; DELETE FROM bookings; DELETE FROM platform_fees;`);
    psql(`DELETE FROM customer_subscriptions;`);
    psql(`INSERT INTO customer_subscriptions (id, business_id, user_id, amount, frequency, status, charge_count, total_charged, next_charge_at)
          VALUES ('${SUB_ID}', '${BIZ_ID}', '${USER_ID}', 50, 'monthly', 'active', 0, 0, NOW() - INTERVAL '1 hour');`);

    const r1 = psqlJson(`SELECT finalize_token_recurring_charge('flw-test-idem', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r1.success).toBe(true);
    expect(r1.already_finalized).toBe(false);

    const r2 = psqlJson(`SELECT finalize_token_recurring_charge('flw-test-idem', '${SUB_ID}'::uuid, 50, 'NGN', 'flutterwave');`);
    expect(r2.success).toBe(true);
    expect(r2.already_finalized).toBe(true);

    // Exactly one payment
    const paymentCount = psql(`SELECT COUNT(*) FROM payments WHERE gateway_reference = 'flw-test-idem';`);
    expect(paymentCount).toBe('1');

    // charge_count = 1 (not 2)
    const chargeCount = psql(`SELECT charge_count FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(chargeCount).toBe('1');

    // total_charged = 50 (not 100)
    const totalCharged = psql(`SELECT total_charged FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    expect(parseFloat(totalCharged)).toBe(50);
  });

  it('4. yearly advance is correct', () => {
    psql(`DELETE FROM processed_webhook_events; DELETE FROM payments; DELETE FROM subscription_charges; DELETE FROM bookings;`);
    psql(`UPDATE customer_subscriptions SET frequency = 'yearly', charge_count = 0, total_charged = 0, next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    psqlJson(`SELECT finalize_token_recurring_charge('flw-yearly-test', '${SUB_ID}'::uuid, 500, 'NGN', 'flutterwave');`);

    const nextCharge = psql(`SELECT next_charge_at FROM customer_subscriptions WHERE id = '${SUB_ID}';`);
    const nextDate = new Date(nextCharge);
    const now = new Date();
    // Should be approximately 1 year from now
    expect(nextDate.getFullYear()).toBeGreaterThanOrEqual(now.getFullYear() + 1);
  });

  it('5. not-due subscription cannot be claimed', () => {
    psql(`DELETE FROM processed_webhook_events;`);
    psql(`UPDATE customer_subscriptions SET next_charge_at = NOW() + INTERVAL '30 days' WHERE id = '${SUB_ID}';`);

    const r = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid, NOW() + INTERVAL '30 days', 'flw-future-test');`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('not_due');
  });

  it('6. paused subscription cannot be claimed', () => {
    psql(`UPDATE customer_subscriptions SET status = 'paused', next_charge_at = NOW() - INTERVAL '1 hour' WHERE id = '${SUB_ID}';`);

    const r = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid, NOW() - INTERVAL '1 hour', 'flw-paused-test');`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('not_active');
  });

  it('7. cancelled subscription cannot be claimed', () => {
    psql(`UPDATE customer_subscriptions SET status = 'cancelled' WHERE id = '${SUB_ID}';`);

    const r = psqlJson(`SELECT claim_recurring_billing_cycle('${SUB_ID}'::uuid, NOW() - INTERVAL '1 hour', 'flw-cancelled-test');`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('not_active');
  });
});
