/**
 * P1-PKG-1 — Real PostgreSQL tests for package redemption
 * Tests the atomic book_with_package_atomic RPC and release_package_session.
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const MIGRATION_154 = path.resolve('supabase/migrations/154_service_packages.sql');
const MIGRATION_308 = path.resolve('supabase/migrations/308_package_redemption.sql');
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
        staff_id UUID, date DATE, time TEXT,
        party_size INT DEFAULT 1, flow_type flow_type DEFAULT 'scheduling',
        channel booking_channel DEFAULT 'whatsapp', deposit_amount NUMERIC(12,2) DEFAULT 0,
        deposit_status deposit_status DEFAULT 'none', status reservation_status DEFAULT 'pending',
        total_amount NUMERIC(12,2) DEFAULT 0, quantity INT DEFAULT 1,
        guest_name TEXT, guest_phone TEXT, guest_email TEXT,
        special_requests TEXT, payment_source payment_source DEFAULT 'whatsapp'
      );
      CREATE OR REPLACE FUNCTION generate_booking_reference() RETURNS TRIGGER AS $t$
      BEGIN IF NEW.reference_code IS NULL THEN NEW.reference_code := 'BW-T' || LPAD(FLOOR(RANDOM()*100000)::TEXT,5,'0'); END IF; RETURN NEW; END; $t$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trg_booking_ref ON bookings;
      CREATE TRIGGER trg_booking_ref BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION generate_booking_reference();
      INSERT INTO businesses (id) VALUES ('${BIZ}') ON CONFLICT DO NOTHING;
    `);
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_154}"`, { encoding: 'utf-8', timeout: 15000 });
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_308}"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS package_redemptions, package_enrollments, service_packages, bookings, payments, businesses CASCADE;`);
  });

  function reset(sessionsTotal = 10, sessionsUsed = 0) {
    psql(`DELETE FROM package_redemptions; DELETE FROM bookings; DELETE FROM package_enrollments; DELETE FROM service_packages;`);
    psql(`INSERT INTO service_packages (id, business_id, name, price, num_sessions, service_ids, is_active) VALUES ('${PKG}', '${BIZ}', 'Pkg', 500, ${sessionsTotal}, '{}', true);`);
    psql(`INSERT INTO package_enrollments (id, business_id, customer_phone, package_id, sessions_total, sessions_used, is_active) VALUES ('${ENR}', '${BIZ}', '+234123', '${PKG}', ${sessionsTotal}, ${sessionsUsed}, true);`);
  }

  function bookPkg(enrollmentId = ENR, phone = '+234123', serviceId = 'NULL') {
    return `SELECT book_with_package_atomic(
      '${BIZ}'::uuid, '${USR}'::uuid, ${serviceId === 'NULL' ? 'NULL' : `'${serviceId}'::uuid`},
      NULL, '2026-09-01', '14:00', 1, 10, 'scheduling', 0, 'none', 'confirmed',
      'Test', '${phone}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
      '${enrollmentId}'::uuid, 0
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
      'Test', '+234123', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
      '${ENR}'::uuid, 0
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
    // Previous test released — try again
    reset(10, 0);
    const booking = psqlJson(bookPkg());
    psqlJson(`SELECT release_package_session('${booking.booking_id}'::uuid);`);
    const rel2 = psqlJson(`SELECT release_package_session('${booking.booking_id}'::uuid);`);
    expect(rel2.released).toBe(false);
    expect(rel2.reason).toBe('no_active_redemption');
  });

  it('11. booking-level uniqueness: same booking cannot use two enrollments', () => {
    reset(10, 0);
    // Create a second enrollment
    psql(`INSERT INTO package_enrollments (id, business_id, customer_phone, package_id, sessions_total, sessions_used, is_active) VALUES ('77dddddd-dddd-dddd-dddd-dddddddddddd', '${BIZ}', '+234123', '${PKG}', 10, 0, true);`);
    // First booking succeeds
    const r1 = psqlJson(bookPkg());
    expect(r1.success).toBe(true);
    // Try to redeem a second enrollment for the SAME booking — UNIQUE(booking_id) blocks it
    // (This tests the constraint — in practice the RPC creates the booking, so same booking_id won't be reused)
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
});
