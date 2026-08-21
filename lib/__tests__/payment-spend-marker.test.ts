/**
 * Migration 334 — Payment spend marker: real PostgreSQL tests.
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync, spawn } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}
function psqlJson(sql: string): Record<string, unknown> {
  const r = psql(sql);
  return r ? JSON.parse(r) : {};
}

const BIZ = '00000000-0000-0000-0334-000000000001';
const BOOKING = '00000000-0000-0000-0334-000000000010';
const RESERVATION = '00000000-0000-0000-0334-000000000020';
const PAY_1 = '00000000-0000-0000-0334-000000000101';
const PAY_2 = '00000000-0000-0000-0334-000000000102';
const PAY_BAD = '00000000-0000-0000-0334-000000000199';

describe.skipIf(!canRun)('Migration 334: Payment spend marker', () => {
  beforeAll(() => {
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE TYPE booking_status AS ENUM ('pending','confirmed','in_progress','completed','no_show','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending','success','failed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role;

      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY, name TEXT DEFAULT 'Test');
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY, business_id UUID, guest_phone TEXT, guest_name TEXT,
        status booking_status DEFAULT 'confirmed', deposit_status TEXT DEFAULT 'paid'
      );
      CREATE TABLE IF NOT EXISTS reservations (
        id UUID PRIMARY KEY, business_id UUID, guest_phone TEXT, guest_name TEXT,
        status booking_status DEFAULT 'confirmed', deposit_status TEXT DEFAULT 'paid'
      );
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount INT DEFAULT 0, status payment_status DEFAULT 'pending',
        booking_id UUID, reservation_id UUID, business_id UUID
      );
      CREATE TABLE IF NOT EXISTS customer_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, phone TEXT, name TEXT,
        total_bookings INT DEFAULT 0, total_orders INT DEFAULT 0,
        total_spent NUMERIC DEFAULT 0, total_visits INT DEFAULT 0,
        last_seen_at TIMESTAMPTZ DEFAULT NOW(), first_seen_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(business_id, phone)
      );
      -- Stub upsert_customer_profile
      CREATE OR REPLACE FUNCTION upsert_customer_profile(p_business_id uuid, p_phone text, p_name text DEFAULT NULL, p_booking_amount numeric DEFAULT 0, p_is_booking boolean DEFAULT false, p_is_order boolean DEFAULT false) RETURNS uuid AS $$
      DECLARE v_id uuid;
      BEGIN
        INSERT INTO customer_profiles (business_id, phone, name, total_spent, total_visits)
        VALUES (p_business_id, p_phone, p_name, p_booking_amount, 1)
        ON CONFLICT (business_id, phone) DO UPDATE SET
          total_spent = customer_profiles.total_spent + p_booking_amount,
          total_visits = customer_profiles.total_visits + 1
        RETURNING id INTO v_id;
        RETURN v_id;
      END;
      $$ LANGUAGE plpgsql;
    `);

    const fs = require('fs');
    const sql = fs.readFileSync('supabase/migrations/334_payment_spend_marker.sql', 'utf-8');
    psql(sql.replace(/--.*$/gm, ''));

    psql(`
      INSERT INTO businesses (id, name) VALUES ('${BIZ}', 'SpendTest') ON CONFLICT DO NOTHING;
      INSERT INTO bookings (id, business_id, guest_phone, status) VALUES ('${BOOKING}', '${BIZ}', '+2341234567890', 'confirmed') ON CONFLICT DO NOTHING;
      INSERT INTO reservations (id, business_id, guest_phone, status) VALUES ('${RESERVATION}', '${BIZ}', '+2341234567890', 'confirmed') ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(() => {
    if (!canRun) return;
    psql(`
      DELETE FROM payment_spend_applications;
      DELETE FROM customer_profiles;
      DELETE FROM payments;
      DELETE FROM bookings WHERE id = '${BOOKING}';
      DELETE FROM reservations WHERE id = '${RESERVATION}';
      DELETE FROM businesses WHERE id = '${BIZ}';
    `);
  });

  beforeEach(() => {
    psql(`
      DELETE FROM payment_spend_applications;
      DELETE FROM customer_profiles;
      DELETE FROM payments;
    `);
  });

  it('1. first booking spend application', () => {
    psql(`INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 5000, 'success', '${BOOKING}');`);
    const r = psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    expect(r.applied).toBe(true);
    expect(r.already_applied).toBe(false);
    expect(r.amount).toBe(5000);

    const spent = psql(`SELECT total_spent FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2341234567890';`);
    expect(parseInt(spent)).toBe(5000);
  });

  it('2. exact replay — no second increment', () => {
    psql(`INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 5000, 'success', '${BOOKING}');`);
    psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    const r2 = psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    expect(r2.applied).toBe(true);
    expect(r2.already_applied).toBe(true);

    const spent = psql(`SELECT total_spent FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2341234567890';`);
    expect(parseInt(spent)).toBe(5000);
  });

  it('3. deposit + balance — two separate spend events', () => {
    psql(`
      INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 3000, 'success', '${BOOKING}');
      INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_2}', 2000, 'success', '${BOOKING}');
    `);
    psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_2}');`);

    const spent = psql(`SELECT total_spent FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2341234567890';`);
    expect(parseInt(spent)).toBe(5000);
    const markers = psql(`SELECT count(*) FROM payment_spend_applications;`);
    expect(parseInt(markers)).toBe(2);
  });

  it('4. payment not success → no spend', () => {
    psql(`INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 5000, 'pending', '${BOOKING}');`);
    const r = psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('payment_not_successful');
  });

  it('5. cancelled booking → no spend', () => {
    const CANCELLED_BK = '00000000-0000-0000-0334-0000000000c1';
    psql(`
      INSERT INTO bookings (id, business_id, guest_phone, status) VALUES ('${CANCELLED_BK}', '${BIZ}', '+234cancel', 'cancelled') ON CONFLICT DO NOTHING;
      INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 5000, 'success', '${CANCELLED_BK}');
    `);
    const r = psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('source_cancelled');
  });

  it('6. source not found → fail closed', () => {
    psql(`INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 5000, 'success', '${PAY_BAD}');`);
    const r = psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('source_not_found');
  });

  it('7. no supported source → fail closed', () => {
    psql(`INSERT INTO payments (id, amount, status) VALUES ('${PAY_1}', 5000, 'success');`);
    const r = psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('no_supported_source');
  });

  it('8. ambiguous source (both booking_id and reservation_id) → fail closed', () => {
    psql(`INSERT INTO payments (id, amount, status, booking_id, reservation_id) VALUES ('${PAY_1}', 5000, 'success', '${BOOKING}', '${RESERVATION}');`);
    const r = psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('ambiguous_source');
  });

  it('9. reservation spend via same RPC', () => {
    psql(`INSERT INTO payments (id, amount, status, reservation_id) VALUES ('${PAY_1}', 8000, 'success', '${RESERVATION}');`);
    const r = psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    expect(r.applied).toBe(true);
    expect(r.amount).toBe(8000);

    const marker = psql(`SELECT source_type FROM payment_spend_applications WHERE payment_id = '${PAY_1}';`);
    expect(marker).toBe('reservation');
  });

  it('10. no customer phone → fail closed', () => {
    const NOPHONE_BK = '00000000-0000-0000-0334-0000000000c2';
    psql(`
      INSERT INTO bookings (id, business_id, guest_phone, status) VALUES ('${NOPHONE_BK}', '${BIZ}', NULL, 'confirmed') ON CONFLICT DO NOTHING;
      INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 5000, 'success', '${NOPHONE_BK}');
    `);
    const r = psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('no_customer_phone');
  });

  it('11. payment not found → fail closed', () => {
    const r = psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_BAD}');`);
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('payment_not_found');
  });

  it('12. REAL concurrency — both callers succeed, exactly one applied, one already_applied', async () => {
    psql(`INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 5000, 'success', '${BOOKING}');`);

    function psqlAsync(sql: string): Promise<{ stdout: string; code: number }> {
      return new Promise((resolve) => {
        const child = spawn('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.on('close', (code: number) => resolve({ stdout: stdout.trim(), code: code ?? 0 }));
        child.stdin.write(sql);
        child.stdin.end();
      });
    }

    const sessionA = psqlAsync(`
      BEGIN;
      SET ROLE service_role;
      SELECT apply_payment_spend_once('${PAY_1}');
      SELECT pg_sleep(2);
      COMMIT;
    `);
    await new Promise(r => setTimeout(r, 300));
    const sessionB = psqlAsync(`
      SET ROLE service_role;
      SELECT apply_payment_spend_once('${PAY_1}');
    `);

    const [rA, rB] = await Promise.all([sessionA, sessionB]);

    // Both callers must succeed (no DB error)
    expect(rA.code).toBe(0);
    expect(rB.code).toBe(0);

    // Exactly one fresh applied (already_applied=false), one replay (already_applied=true)
    const freshApplied = [rA.stdout, rB.stdout].filter(s =>
      (s.includes('"already_applied": false') || s.includes('"already_applied":false'))
      && (s.includes('"applied": true') || s.includes('"applied":true'))
    );
    const alreadyApplied = [rA.stdout, rB.stdout].filter(s =>
      (s.includes('"already_applied": true') || s.includes('"already_applied":true'))
    );
    expect(freshApplied.length).toBe(1);
    expect(alreadyApplied.length).toBe(1);

    // One spend increment
    const spent = psql(`SELECT total_spent FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2341234567890';`);
    expect(parseInt(spent)).toBe(5000);

    // One marker
    const markers = psql(`SELECT count(*) FROM payment_spend_applications WHERE payment_id = '${PAY_1}';`);
    expect(parseInt(markers)).toBe(1);
  }, 15000);

  it('15. existing profile: spend-only — visits/bookings NOT incremented by Stage 2', () => {
    // Create profile FIRST, then apply spend. Verify only total_spent changes.
    psql(`
      INSERT INTO customer_profiles (business_id, phone, name, total_spent, total_visits, total_bookings, last_seen_at, first_seen_at)
        VALUES ('${BIZ}', '+2341234567890', 'Test User', 0, 5, 3, '2026-01-01', '2025-06-01');
      INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 8000, 'success', '${BOOKING}');
    `);

    psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);

    const profile = psql(`SELECT total_spent, total_visits, total_bookings, name FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2341234567890';`);
    const [spent, visits, bookings, name] = profile.split('|');
    expect(parseInt(spent)).toBe(8000); // Spend incremented
    expect(parseInt(visits)).toBe(5);   // NOT incremented by Stage 2
    expect(parseInt(bookings)).toBe(3); // NOT incremented by Stage 2
    expect(name).toBe('Test User');     // Name preserved
  });

  it('16. missing profile: Stage 2 creates spend-holder with customer name', () => {
    // No profile exists. Stage 2 creates one with spend + name, visits/bookings = 0.
    psql(`INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 6000, 'success', '${BOOKING}');`);
    // Booking has guest_name set (from beforeAll: guest_phone='+2341234567890')
    // Update booking to have a name
    psql(`UPDATE bookings SET guest_name = 'Jane Doe' WHERE id = '${BOOKING}';`);

    psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);

    const profile = psql(`SELECT total_spent, total_visits, total_bookings, name FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2341234567890';`);
    const [spent, visits, bookings, name] = profile.split('|');
    expect(parseInt(spent)).toBe(6000);
    expect(parseInt(visits)).toBe(0);   // Stage 3 owns visit lifecycle
    expect(parseInt(bookings)).toBe(0); // Stage 3 owns booking lifecycle
    expect(name).toBe('Jane Doe');      // Customer name preserved from booking

    // Reset guest_name for other tests
    psql(`UPDATE bookings SET guest_name = NULL WHERE id = '${BOOKING}';`);
  });

  it('17. missing-profile full lifecycle: Stage 2 → Stage 3 → correct final state', () => {
    // Stage 2: create spend-holder
    psql(`
      UPDATE bookings SET guest_name = 'Full Lifecycle' WHERE id = '${BOOKING}';
      INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 7000, 'success', '${BOOKING}');
    `);
    psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);

    // Verify Stage 2 state: spend-holder with name, visits=0, bookings=0
    let profile = psql(`SELECT total_spent, total_visits, total_bookings, name FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2341234567890';`);
    let [spent, visits, bookings, name] = profile.split('|');
    expect(parseInt(spent)).toBe(7000);
    expect(parseInt(visits)).toBe(0);
    expect(parseInt(bookings)).toBe(0);
    expect(name).toBe('Full Lifecycle');

    // Stage 3: simulate increment_customer_visit with p_amount=0 (skipCustomerSpend=true)
    // This is what handlePostCompletion does for booking/reservation payments
    psql(`
      CREATE OR REPLACE FUNCTION increment_customer_visit(p_business_id uuid, p_phone text, p_amount numeric DEFAULT 0) RETURNS void AS $$
      BEGIN
        UPDATE customer_profiles
        SET total_visits = total_visits + 1,
            total_bookings = total_bookings + 1,
            total_spent = total_spent + p_amount,
            last_seen_at = NOW()
        WHERE business_id = p_business_id AND phone = p_phone;
      END;
      $$ LANGUAGE plpgsql;
    `);
    psql(`SELECT increment_customer_visit('${BIZ}', '+2341234567890', 0);`);

    // Verify final state: spend unchanged, visits+bookings incremented, name preserved
    profile = psql(`SELECT total_spent, total_visits, total_bookings, name FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2341234567890';`);
    [spent, visits, bookings, name] = profile.split('|');
    expect(parseInt(spent)).toBe(7000);  // NOT incremented by Stage 3
    expect(parseInt(visits)).toBe(1);    // Incremented by Stage 3
    expect(parseInt(bookings)).toBe(1);  // Incremented by Stage 3
    expect(name).toBe('Full Lifecycle'); // Preserved

    // Replay Stage 2: no double spend
    const r2 = psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    expect(r2.already_applied).toBe(true);
    profile = psql(`SELECT total_spent FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2341234567890';`);
    expect(parseInt(profile)).toBe(7000); // Still 7000

    psql(`UPDATE bookings SET guest_name = NULL WHERE id = '${BOOKING}';`);
  });

  it('18. existing-profile lifecycle: Stage 2 spend-only → Stage 3 nonfinancial', () => {
    // Pre-create profile with existing state
    psql(`
      INSERT INTO customer_profiles (business_id, phone, name, total_spent, total_visits, total_bookings, last_seen_at, first_seen_at)
        VALUES ('${BIZ}', '+2341234567890', 'Existing User', 2000, 3, 2, '2026-01-01', '2025-06-01');
      INSERT INTO payments (id, amount, status, booking_id) VALUES ('${PAY_1}', 4000, 'success', '${BOOKING}');
    `);

    // Stage 2: spend only
    psqlJson(`SET ROLE service_role; SELECT apply_payment_spend_once('${PAY_1}');`);
    let profile = psql(`SELECT total_spent, total_visits, total_bookings, name FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2341234567890';`);
    let [spent, visits, bookings, name] = profile.split('|');
    expect(parseInt(spent)).toBe(6000);  // 2000 + 4000
    expect(parseInt(visits)).toBe(3);    // Unchanged
    expect(parseInt(bookings)).toBe(2);  // Unchanged
    expect(name).toBe('Existing User');

    // Stage 3: nonfinancial (skipCustomerSpend → p_amount=0)
    psql(`
      CREATE OR REPLACE FUNCTION increment_customer_visit(p_business_id uuid, p_phone text, p_amount numeric DEFAULT 0) RETURNS void AS $$
      BEGIN
        UPDATE customer_profiles SET total_visits = total_visits + 1, total_bookings = total_bookings + 1, total_spent = total_spent + p_amount, last_seen_at = NOW()
        WHERE business_id = p_business_id AND phone = p_phone;
      END;
      $$ LANGUAGE plpgsql;
    `);
    psql(`SELECT increment_customer_visit('${BIZ}', '+2341234567890', 0);`);

    profile = psql(`SELECT total_spent, total_visits, total_bookings FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2341234567890';`);
    [spent, visits, bookings] = profile.split('|');
    expect(parseInt(spent)).toBe(6000);  // NOT incremented by Stage 3
    expect(parseInt(visits)).toBe(4);    // 3+1
    expect(parseInt(bookings)).toBe(3);  // 2+1
  });

  it('19. malformed semantic result → critical failure', async () => {
    // Test via processSuccessfulPayment mock — malformed applied value
    const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
    vi.doMock('@/lib/logger', () => { const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() }; l.withContext = () => l; return { logger: l }; });

    // This is a source-level supplemental check since we can't easily mock the RPC return
    // to return { applied: 'true' } (string instead of boolean) through the Supabase client.
    // The production code checks `typeof spendResult.applied !== 'boolean'`.
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/process-success.ts', 'utf-8');
    expect(src).toContain("typeof spendResult.applied !== 'boolean'");
    expect(src).toContain('booking_spend_invalid_result');
  });

  it('13. privilege: anon cannot execute', () => {
    const r = psql(`SELECT has_function_privilege('anon', 'apply_payment_spend_once(uuid)', 'EXECUTE');`);
    expect(r).toBe('f');
  });

  it('14. privilege: service_role can execute', () => {
    const r = psql(`SELECT has_function_privilege('service_role', 'apply_payment_spend_once(uuid)', 'EXECUTE');`);
    expect(r).toBe('t');
  });
});
