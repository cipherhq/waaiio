/**
 * P1-PKG-1 — Real PostgreSQL tests for package redemption
 * Tests the atomic book_with_package_atomic, cancel_booking_with_release,
 * and release_package_session RPCs.
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const MIGRATION_154 = path.resolve('supabase/migrations/154_service_packages.sql');
const MIGRATION_308 = path.resolve('supabase/migrations/308_package_redemption.sql');
const MIGRATION_357 = path.resolve('supabase/migrations/357_owner_bound_booking_cancel.sql');
const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 15000 });
  return raw.split('\n').filter(l => { const t = l.trim(); return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t); }).join('\n').trim();
}
function psqlJson(sql: string): any { const r = psql(sql); return r ? JSON.parse(r) : null; }

function runTwoSessions(sqlA: string, sqlB: string): Promise<{ a: { stdout: string }; b: { stdout: string } }> {
  const { exec } = require('child_process') as typeof import('child_process');
  function execPsql(sql: string): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = exec(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`, { timeout: 15000, encoding: 'utf-8' },
        (error, stdout, stderr) => {
          if (error && !stdout) reject(new Error(`psql: ${stderr || error.message}`));
          else resolve({ stdout: (stdout || '').trim() });
        });
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

const BIZ = '77aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PKG = '77bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ENR = '77cccccc-cccc-cccc-cccc-cccccccccccc';
const SVC = '77ffffff-ffff-ffff-ffff-ffffffffffff';
const USR = '77eeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

describe.skipIf(!dbUrl)('P1-PKG-1: Atomic package booking + release', () => {
  beforeAll(() => {
    if (!dbUrl) return;
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT gen_random_uuid(); $$;
      CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY, owner_id UUID);
      DO $$ BEGIN CREATE TYPE flow_type AS ENUM ('scheduling','ordering','ticketing','reservation','payment','queue','chat','waitlist'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE booking_channel AS ENUM ('whatsapp','web','api','recurring'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE reservation_status AS ENUM ('pending','confirmed','cancelled','completed','in_progress','no_show'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE deposit_status AS ENUM ('none','pending','paid','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE payment_source AS ENUM ('whatsapp','web','api','subscription','invoice','manual'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE IF NOT EXISTS payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), reference_code TEXT UNIQUE,
        business_id UUID, user_id UUID, service_id UUID, appointment_id UUID,
        staff_id UUID, staff_name TEXT, date DATE, time TIME,
        party_size INT DEFAULT 1, flow_type flow_type DEFAULT 'scheduling',
        channel booking_channel DEFAULT 'whatsapp', deposit_amount NUMERIC(12,2) DEFAULT 0,
        deposit_status deposit_status DEFAULT 'none', status reservation_status DEFAULT 'pending',
        total_amount NUMERIC(12,2) DEFAULT 0, quantity INT DEFAULT 1,
        guest_name TEXT, guest_phone TEXT, guest_email TEXT,
        special_requests TEXT, venue_address TEXT, end_date DATE,
        addons_snapshot JSONB, promo_code_id UUID, location_id UUID,
        bot_session_id UUID, cancelled_at TIMESTAMPTZ, cancelled_by TEXT,
        payment_source payment_source DEFAULT 'whatsapp'
      );
      CREATE OR REPLACE FUNCTION generate_booking_reference() RETURNS TRIGGER AS $t$
      BEGIN IF NEW.reference_code IS NULL THEN NEW.reference_code := 'BW-T' || LPAD(FLOOR(RANDOM()*100000)::TEXT,5,'0'); END IF; RETURN NEW; END; $t$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_booking_ref ON bookings;
      CREATE TRIGGER trg_booking_ref BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION generate_booking_reference();
      INSERT INTO businesses (id) VALUES ('${BIZ}') ON CONFLICT DO NOTHING;
    `);
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_154}"`, { encoding: 'utf-8', timeout: 15000 });
    // Apply only book_slot_atomic from migration 304 (full migration needs tables not in test DB)
    psql(`
      CREATE OR REPLACE FUNCTION public.book_slot_atomic(
        p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
        p_date date, p_time text, p_party_size int, p_max_capacity int,
        p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
        p_guest_name text, p_guest_phone text, p_guest_email text,
        p_special_requests text, p_venue_address text, p_end_date date,
        p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
        p_location_id uuid DEFAULT NULL,
        p_appointment_id uuid DEFAULT NULL,
        p_buffer_minutes integer DEFAULT 0,
        p_duration integer DEFAULT 30,
        p_bot_session_id uuid DEFAULT NULL
      ) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_count int; v_buffer_count int; v_booking_id uuid; v_ref text;
        v_lock_key bigint;
      BEGIN
        v_lock_key := abs(hashtext(p_business_id::text || '|' || p_date::text || '|' || p_time));
        PERFORM pg_advisory_xact_lock(v_lock_key);
        IF p_bot_session_id IS NOT NULL THEN
          SELECT id, bookings.reference_code INTO v_booking_id, v_ref
          FROM bookings WHERE bot_session_id = p_bot_session_id AND status IN ('pending', 'confirmed') LIMIT 1;
          IF FOUND THEN RETURN QUERY SELECT v_booking_id, v_ref, true; RETURN; END IF;
        END IF;
        SELECT COUNT(*) INTO v_count FROM bookings
        WHERE business_id = p_business_id AND date = p_date AND time = p_time::time
          AND status IN ('confirmed', 'pending', 'in_progress')
          AND (p_staff_id IS NULL OR staff_id = p_staff_id);
        IF v_count >= p_max_capacity THEN
          RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN;
        END IF;
        INSERT INTO bookings (
          business_id, user_id, service_id, appointment_id, staff_id, staff_name,
          date, time, party_size, flow_type, channel,
          deposit_amount, deposit_status, status,
          guest_name, guest_phone, guest_email,
          special_requests, venue_address, end_date,
          addons_snapshot, promo_code_id, total_amount, quantity,
          location_id, bot_session_id
        ) VALUES (
          p_business_id, p_user_id,
          CASE WHEN p_appointment_id IS NOT NULL THEN NULL ELSE p_service_id END,
          p_appointment_id,
          p_staff_id, p_staff_name,
          p_date, p_time::time, p_party_size,
          p_flow_type::flow_type, 'whatsapp'::booking_channel,
          p_deposit_amount, p_deposit_status::deposit_status, p_status::reservation_status,
          p_guest_name, p_guest_phone, p_guest_email,
          p_special_requests, p_venue_address, p_end_date,
          p_addons_snapshot, p_promo_code_id, p_total_amount, p_party_size,
          p_location_id, p_bot_session_id
        )
        RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;
        RETURN QUERY SELECT v_booking_id, v_ref, true;
      END;
      $$;
      DO $$ BEGIN
        REVOKE ALL ON FUNCTION public.book_slot_atomic FROM PUBLIC;
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.book_slot_atomic TO service_role';
      EXCEPTION WHEN undefined_object THEN NULL;
      END $$;
    `);
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_308}"`, { encoding: 'utf-8', timeout: 15000 });
    // Stub booking_slots table and cancelled_by enum (referenced by migration 357)
    psql(`
      CREATE TABLE IF NOT EXISTS booking_slots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, date DATE, start_time TIME,
        staff_id UUID, location_id UUID, current_bookings INT DEFAULT 0
      );
      DO $$ BEGIN CREATE TYPE cancelled_by AS ENUM ('diner', 'restaurant', 'system'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_357}"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS package_redemptions, package_enrollments, service_packages, booking_slots, bookings, payments, businesses CASCADE;`);
  });

  function reset(sessionsTotal = 10, sessionsUsed = 0) {
    psql(`DELETE FROM package_redemptions; DELETE FROM bookings; DELETE FROM package_enrollments; DELETE FROM service_packages;`);
    psql(`INSERT INTO service_packages (id, business_id, name, price, num_sessions, service_ids, is_active) VALUES ('${PKG}', '${BIZ}', 'Pkg', 500, ${sessionsTotal}, '{}', true);`);
    psql(`INSERT INTO package_enrollments (id, business_id, customer_phone, package_id, sessions_total, sessions_used, is_active) VALUES ('${ENR}', '${BIZ}', '+234123', '${PKG}', ${sessionsTotal}, ${sessionsUsed}, true);`);
  }

  function bookPkg(enrollmentId = ENR, phone = '+234123', serviceId = 'NULL', status = 'confirmed') {
    return `SELECT book_with_package_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, ${serviceId === 'NULL' ? 'NULL' : `'${serviceId}'::uuid`},
      NULL, '2026-09-01', '14:00', 1, 10, 'scheduling', 0, 'none', '${status}',
      'Test', '${phone}', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 30, NULL,
      '${enrollmentId}'::uuid
    );`;
  }

  it('1. eligible booking succeeds atomically', () => {
    reset(10, 0);
    const r = psqlJson(bookPkg());
    expect(r.success).toBe(true);
    expect(r.booking_id).toBeDefined();
    expect(r.package_covered).toBe(true);
    // Exactly one redemption
    const redemptions = psql(`SELECT COUNT(*) FROM package_redemptions WHERE enrollment_id = '${ENR}';`);
    expect(redemptions).toBe('1');
    // sessions_used incremented
    const used = psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`);
    expect(used).toBe('1');
  });

  it('2. concurrent final session — exactly one wins', async () => {
    reset(1, 0);
    const sqlA = `BEGIN; ${bookPkg()} SELECT pg_sleep(1); COMMIT;`;
    const sqlB = bookPkg();
    const { a, b } = await runTwoSessions(sqlA, sqlB);
    const parse = (s: string) => JSON.parse(s.split('\n').filter(l => l.trim().startsWith('{'))[0]);
    const rA = parse(a.stdout);
    const rB = parse(b.stdout);
    const successes = [rA, rB].filter(r => r.success);
    expect(successes).toHaveLength(1);
    const used = psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`);
    expect(used).toBe('1');
  });

  it('3. exhausted package rejected', () => {
    reset(5, 5);
    const r = psqlJson(bookPkg());
    expect(r.success).toBe(false);
    expect(r.reason).toBe('no_sessions_remaining');
  });

  it('4. inactive enrollment rejected', () => {
    reset(10, 0);
    psql(`UPDATE package_enrollments SET is_active = false WHERE id = '${ENR}';`);
    const r = psqlJson(bookPkg());
    expect(r.success).toBe(false);
    expect(r.reason).toBe('enrollment_inactive');
  });

  it('5. expired enrollment rejected', () => {
    reset(10, 0);
    psql(`UPDATE package_enrollments SET expires_at = NOW() - INTERVAL '1 day' WHERE id = '${ENR}';`);
    const r = psqlJson(bookPkg());
    expect(r.success).toBe(false);
    expect(r.reason).toBe('enrollment_expired');
  });

  it('6. wrong customer rejected', () => {
    reset(10, 0);
    const r = psqlJson(bookPkg(ENR, '+999OTHER'));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('wrong_customer');
  });

  it('7. wrong business rejected', () => {
    reset(10, 0);
    const r = psqlJson(`SELECT book_with_package_atomic(
      '99999999-9999-9999-9999-999999999999'::uuid, '${USR}'::uuid, NULL,
      NULL, '2026-09-01', '14:00', 1, 10, 'scheduling', 0, 'none', 'confirmed',
      'Test', '+234123', NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL,
      NULL, NULL, 0, 30, NULL,
      '${ENR}'::uuid
    );`);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('wrong_business');
  });

  it('8. ineligible service rejected', () => {
    reset(10, 0);
    psql(`UPDATE service_packages SET service_ids = '{${SVC}}' WHERE id = '${PKG}';`);
    const r = psqlJson(bookPkg(ENR, '+234123', '99999999-0000-0000-0000-000000000000'));
    expect(r.success).toBe(false);
    expect(r.reason).toBe('service_not_eligible');
  });

  it('9. release returns session exactly once', () => {
    reset(10, 0);
    const booking = psqlJson(bookPkg());
    expect(booking.success).toBe(true);
    expect(psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`)).toBe('1');

    const rel = psqlJson(`SELECT release_package_session('${booking.booking_id}'::uuid);`);
    expect(rel.released).toBe(true);
    expect(psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`)).toBe('0');
  });

  it('10. duplicate release is safe', () => {
    reset(10, 0);
    const booking = psqlJson(bookPkg());
    psqlJson(`SELECT release_package_session('${booking.booking_id}'::uuid);`);
    const rel2 = psqlJson(`SELECT release_package_session('${booking.booking_id}'::uuid);`);
    expect(rel2.released).toBe(false);
    expect(rel2.reason).toBe('no_active_redemption');
  });

  it('11. booking-level uniqueness: same booking cannot use two enrollments', () => {
    reset(10, 0);
    psql(`INSERT INTO package_enrollments (id, business_id, customer_phone, package_id, sessions_total, sessions_used, is_active) VALUES ('77dddddd-dddd-dddd-dddd-dddddddddddd', '${BIZ}', '+234123', '${PKG}', 10, 0, true);`);
    const r1 = psqlJson(bookPkg());
    expect(r1.success).toBe(true);
    const bookingId = r1.booking_id;
    const count = psql(`SELECT COUNT(*) FROM package_redemptions WHERE booking_id = '${bookingId}';`);
    expect(count).toBe('1');
  });

  it('12. inactive package rejected', () => {
    reset(10, 0);
    psql(`UPDATE service_packages SET is_active = false WHERE id = '${PKG}';`);
    const r = psqlJson(bookPkg());
    expect(r.success).toBe(false);
    expect(r.reason).toBe('package_inactive');
  });

  it('13. sessions_used never exceeds sessions_total', () => {
    reset(2, 2);
    const r = psqlJson(bookPkg());
    expect(r.success).toBe(false);
    const used = psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`);
    expect(used).toBe('2');
  });

  it('14. cancel_booking_with_release atomically cancels + releases session', () => {
    reset(10, 0);
    const booking = psqlJson(bookPkg());
    expect(booking.success).toBe(true);
    expect(psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`)).toBe('1');

    const cancel = psqlJson(`SELECT cancel_booking_with_release('${booking.booking_id}'::uuid, 'guest'::text, '${USR}'::uuid);`);
    expect(cancel.cancelled).toBe(true);
    expect(cancel.session_released).toBe(true);

    // Booking is cancelled
    const status = psql(`SELECT status FROM bookings WHERE id = '${booking.booking_id}';`);
    expect(status).toBe('cancelled');
    // Session returned
    expect(psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`)).toBe('0');
    // Redemption marked released
    const redemptionStatus = psql(`SELECT status FROM package_redemptions WHERE booking_id = '${booking.booking_id}';`);
    expect(redemptionStatus).toBe('released');
  });

  it('15. cancel non-cancellable booking rejected', () => {
    reset(10, 0);
    const booking = psqlJson(bookPkg());
    // Complete the booking first
    psql(`UPDATE bookings SET status = 'completed' WHERE id = '${booking.booking_id}';`);
    const cancel = psqlJson(`SELECT cancel_booking_with_release('${booking.booking_id}'::uuid, 'guest'::text, '${USR}'::uuid);`);
    expect(cancel.cancelled).toBe(false);
    expect(cancel.reason).toBe('not_cancellable');
  });

  it('16. auto-approval preserved: pending status passes through to booking', () => {
    reset(10, 0);
    const r = psqlJson(bookPkg(ENR, '+234123', 'NULL', 'pending'));
    expect(r.success).toBe(true);
    const status = psql(`SELECT status FROM bookings WHERE id = '${r.booking_id}';`);
    expect(status).toBe('pending');
  });

  it('17. no-show does NOT release package session', () => {
    reset(10, 0);
    const booking = psqlJson(bookPkg());
    expect(booking.success).toBe(true);
    // Mark as no-show directly (no-show is a business action, not a cancellation)
    psql(`UPDATE bookings SET status = 'no_show' WHERE id = '${booking.booking_id}';`);
    // Package session should still be consumed
    const used = psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`);
    expect(used).toBe('1');
    // Redemption still active
    const redemptionStatus = psql(`SELECT status FROM package_redemptions WHERE booking_id = '${booking.booking_id}';`);
    expect(redemptionStatus).toBe('active');
  });

  it('18. cancel booking without package — no session release needed', () => {
    reset(10, 0);
    // Insert a plain booking (no package redemption)
    psql(`INSERT INTO bookings (id, business_id, user_id, status, date, time) VALUES ('77aaaaaa-0000-0000-0000-000000000001', '${BIZ}', '${USR}', 'confirmed', '2026-09-01', '15:00');`);
    const cancel = psqlJson(`SELECT cancel_booking_with_release('77aaaaaa-0000-0000-0000-000000000001'::uuid, 'business'::text, '${USR}'::uuid);`);
    expect(cancel.cancelled).toBe(true);
    expect(cancel.session_released).toBe(false);
  });
});
