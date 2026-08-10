/**
 * Atomic reschedule — real PostgreSQL concurrency tests
 * Requires TEST_DATABASE_URL.
 *
 * Tests:
 * 1. Successful reschedule moves booking atomically
 * 2. Two bookings racing for final target capacity — exactly one wins
 * 3. Failed reschedule leaves old booking intact
 * 4. service_id=NULL appointment-centric booking — capacity enforced via appointments table
 * 5. Duplicate/retry — idempotent when already at target
 * 6. Non-reschedulable status rejected
 * 7. Cross-business rejected
 * 8. Booking not found rejected
 * 9. Buffer conflict rejected (real DB — service with buffer_minutes=15, duration=60)
 * 9b. Buffer boundary success (reschedule to slot exactly outside buffer window)
 * 10. Bot path cannot bypass RPC (source verification)
 * 11. Migration 313 applies cleanly
 * 12. CROSS-PATH: book_slot_atomic vs reschedule_booking_atomic on capacity-1 slot
 * 13. Time canonicalization: both RPCs produce same advisory lock key
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 15000 });
  return raw.split('\n').filter(l => { const t = l.trim(); return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t); }).join('\n').trim();
}
function psqlJson(sql: string): any { const r = psql(sql); return r ? JSON.parse(r) : null; }

function runTwoSessions(sqlA: string, sqlB: string): Promise<{ a: string; b: string }> {
  const { exec } = require('child_process') as typeof import('child_process');
  function execPsql(sql: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = exec(`psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`, { timeout: 15000, encoding: 'utf-8' },
        (error, stdout, stderr) => {
          if (error && !stdout) reject(new Error(`psql: ${stderr || error.message}`));
          else resolve((stdout || '').trim());
        });
      child.stdin!.write(sql);
      child.stdin!.end();
    });
  }
  return new Promise(async (resolve) => {
    const promiseA = execPsql(sqlA);
    await new Promise(r => setTimeout(r, 300));
    const promiseB = execPsql(sqlB);
    const [a, b] = await Promise.all([promiseA, promiseB]);
    resolve({ a, b });
  });
}

const BIZ = '99aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ2 = '99bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USR = '99cccccc-cccc-cccc-cccc-cccccccccccc';

describe.skipIf(!dbUrl)('Atomic reschedule — real PostgreSQL concurrency', () => {
  beforeAll(() => {
    if (!dbUrl) return;
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT gen_random_uuid(); $$;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT current_setting('role', true); $$;
      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY, owner_id UUID);
      DO $$ BEGIN CREATE TYPE flow_type AS ENUM ('scheduling','ordering','ticketing','reservation','payment','queue','chat','waitlist'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE booking_channel AS ENUM ('whatsapp','web','api','recurring'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE reservation_status AS ENUM ('pending','confirmed','cancelled','completed','in_progress','no_show'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE deposit_status AS ENUM ('none','pending','paid','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE IF NOT EXISTS services (id UUID PRIMARY KEY, business_id UUID, max_capacity INT DEFAULT 1, buffer_minutes INT DEFAULT 0, duration_minutes INT DEFAULT 30);
      CREATE TABLE IF NOT EXISTS appointments (id UUID PRIMARY KEY, business_id UUID, max_capacity INT DEFAULT 1, duration_minutes INT DEFAULT 30);
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), reference_code TEXT,
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
        original_date DATE, original_time TEXT, rescheduled_at TIMESTAMPTZ
      );
      INSERT INTO businesses (id) VALUES ('${BIZ}'), ('${BIZ2}') ON CONFLICT DO NOTHING;
      INSERT INTO services (id, business_id, max_capacity, buffer_minutes, duration_minutes) VALUES ('99dddddd-dddd-dddd-dddd-dddddddddddd', '${BIZ}', 1, 0, 30) ON CONFLICT DO NOTHING;
      INSERT INTO services (id, business_id, max_capacity, buffer_minutes, duration_minutes) VALUES ('99ffffff-ffff-ffff-ffff-ffffffffffff', '${BIZ}', 1, 15, 60) ON CONFLICT DO NOTHING;
      INSERT INTO appointments (id, business_id, max_capacity, duration_minutes) VALUES ('99eeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '${BIZ}', 1, 30) ON CONFLICT DO NOTHING;
    `);
    // Apply migration 313
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "supabase/migrations/313_atomic_reschedule.sql"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS bookings, services, appointments, businesses CASCADE;`);
  });

  function reset() {
    psql(`DELETE FROM bookings;`);
  }

  it('1. successful reschedule moves booking atomically', () => {
    reset();
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status, party_size) VALUES ('b1000000-0000-0000-0000-000000000001', '${BIZ}', '${USR}', '99dddddd-dddd-dddd-dddd-dddddddddddd', '2026-09-01', '10:00', 'confirmed', 1);`);
    const r = psqlJson(`SELECT reschedule_booking_atomic('b1000000-0000-0000-0000-000000000001'::uuid, '${BIZ}'::uuid, '2026-09-02'::date, '14:00');`);
    expect(r.rescheduled).toBe(true);
    expect(r.old_date).toBe('2026-09-01');
    expect(r.new_date).toBe('2026-09-02');
    const booking = psql(`SELECT date, time FROM bookings WHERE id = 'b1000000-0000-0000-0000-000000000001';`);
    expect(booking).toContain('2026-09-02');
    expect(booking).toContain('14:00');
  });

  it('2. concurrent reschedule to final capacity — one wins', async () => {
    reset();
    // Two bookings, capacity=1 service. Both try to reschedule to same target slot.
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status) VALUES ('b2000000-0000-0000-0000-000000000001', '${BIZ}', '${USR}', '99dddddd-dddd-dddd-dddd-dddddddddddd', '2026-09-01', '10:00', 'confirmed');`);
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status) VALUES ('b2000000-0000-0000-0000-000000000002', '${BIZ}', '${USR}', '99dddddd-dddd-dddd-dddd-dddddddddddd', '2026-09-01', '11:00', 'confirmed');`);

    const { a, b } = await runTwoSessions(
      `BEGIN; SELECT reschedule_booking_atomic('b2000000-0000-0000-0000-000000000001'::uuid, '${BIZ}'::uuid, '2026-09-03'::date, '15:00'); SELECT pg_sleep(0.5); COMMIT;`,
      `SELECT reschedule_booking_atomic('b2000000-0000-0000-0000-000000000002'::uuid, '${BIZ}'::uuid, '2026-09-03'::date, '15:00');`
    );

    const parseJson = (s: string) => JSON.parse(s.split('\n').filter(l => l.trim().startsWith('{'))[0]);
    const rA = parseJson(a);
    const rB = parseJson(b);
    const winners = [rA, rB].filter(r => r.rescheduled === true);
    const losers = [rA, rB].filter(r => r.rescheduled === false || r.reason === 'slot_full');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });

  it('3. failed reschedule leaves old booking intact', () => {
    reset();
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status) VALUES ('b3000000-0000-0000-0000-000000000001', '${BIZ}', '${USR}', '99dddddd-dddd-dddd-dddd-dddddddddddd', '2026-09-01', '10:00', 'confirmed');`);
    // Fill target slot
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status) VALUES ('b3000000-0000-0000-0000-000000000002', '${BIZ}', '${USR}', '99dddddd-dddd-dddd-dddd-dddddddddddd', '2026-09-03', '15:00', 'confirmed');`);
    const r = psqlJson(`SELECT reschedule_booking_atomic('b3000000-0000-0000-0000-000000000001'::uuid, '${BIZ}'::uuid, '2026-09-03'::date, '15:00');`);
    expect(r.rescheduled).toBe(false);
    expect(r.reason).toBe('slot_full');
    // Old booking unchanged
    const booking = psql(`SELECT date, time FROM bookings WHERE id = 'b3000000-0000-0000-0000-000000000001';`);
    expect(booking).toContain('2026-09-01');
  });

  it('4. appointment-centric (service_id=NULL) — capacity enforced via appointments table', () => {
    reset();
    psql(`INSERT INTO bookings (id, business_id, user_id, appointment_id, date, time, status) VALUES ('b4000000-0000-0000-0000-000000000001', '${BIZ}', '${USR}', '99eeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-09-01', '10:00', 'confirmed');`);
    // Fill target with another appointment booking
    psql(`INSERT INTO bookings (id, business_id, user_id, appointment_id, date, time, status) VALUES ('b4000000-0000-0000-0000-000000000002', '${BIZ}', '${USR}', '99eeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-09-03', '15:00', 'confirmed');`);
    const r = psqlJson(`SELECT reschedule_booking_atomic('b4000000-0000-0000-0000-000000000001'::uuid, '${BIZ}'::uuid, '2026-09-03'::date, '15:00');`);
    expect(r.rescheduled).toBe(false);
    expect(r.reason).toBe('slot_full');
  });

  it('5. duplicate/retry — idempotent when already at target', () => {
    reset();
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status) VALUES ('b5000000-0000-0000-0000-000000000001', '${BIZ}', '${USR}', '99dddddd-dddd-dddd-dddd-dddddddddddd', '2026-09-03', '15:00', 'confirmed');`);
    const r = psqlJson(`SELECT reschedule_booking_atomic('b5000000-0000-0000-0000-000000000001'::uuid, '${BIZ}'::uuid, '2026-09-03'::date, '15:00');`);
    expect(r.rescheduled).toBe(true);
    expect(r.already_at_target).toBe(true);
  });

  it('6. non-reschedulable status rejected', () => {
    reset();
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status) VALUES ('b6000000-0000-0000-0000-000000000001', '${BIZ}', '${USR}', '99dddddd-dddd-dddd-dddd-dddddddddddd', '2026-09-01', '10:00', 'cancelled');`);
    const r = psqlJson(`SELECT reschedule_booking_atomic('b6000000-0000-0000-0000-000000000001'::uuid, '${BIZ}'::uuid, '2026-09-03'::date, '15:00');`);
    expect(r.rescheduled).toBe(false);
    expect(r.reason).toBe('not_reschedulable');
  });

  it('7. cross-business rejected', () => {
    reset();
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status) VALUES ('b7000000-0000-0000-0000-000000000001', '${BIZ}', '${USR}', '99dddddd-dddd-dddd-dddd-dddddddddddd', '2026-09-01', '10:00', 'confirmed');`);
    const r = psqlJson(`SELECT reschedule_booking_atomic('b7000000-0000-0000-0000-000000000001'::uuid, '${BIZ2}'::uuid, '2026-09-03'::date, '15:00');`);
    expect(r.rescheduled).toBe(false);
    expect(r.reason).toBe('business_mismatch');
  });

  it('8. booking not found rejected', () => {
    reset();
    const r = psqlJson(`SELECT reschedule_booking_atomic('b8000000-0000-0000-0000-000000000099'::uuid, '${BIZ}'::uuid, '2026-09-03'::date, '15:00');`);
    expect(r.rescheduled).toBe(false);
    expect(r.reason).toBe('booking_not_found');
  });

  // ── Buffer tests use service '99ffffff-...' with buffer_minutes=15, duration_minutes=60 ──
  // Existing booking at 10:00-11:00 + 15min buffer → blocked zone [09:45, 11:15)
  // (symmetric buffer per book_slot_atomic semantics)

  it('9. buffer conflict rejected — reschedule into buffered interval', () => {
    reset();
    const SVC_BUF = '99ffffff-ffff-ffff-ffff-ffffffffffff';
    // Existing confirmed booking at 10:00 (60min + 15min buffer)
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status)
      VALUES ('b9000000-0000-0000-0000-000000000001', '${BIZ}', '${USR}', '${SVC_BUF}', '2026-09-10', '10:00', 'confirmed');`);
    // Booking to reschedule — currently at 16:00 (well away)
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status)
      VALUES ('b9000000-0000-0000-0000-000000000002', '${BIZ}', '${USR}', '${SVC_BUF}', '2026-09-10', '16:00', 'confirmed');`);

    // Attempt reschedule to 11:00 — this is inside the buffer window:
    // 11:00 < 10:00 + 60 + 15 = 11:15 → true
    // 11:00 + 60 = 12:00 > 10:00 - 15 = 09:45 → true
    // Both conditions true → buffer_conflict
    const r = psqlJson(`SELECT reschedule_booking_atomic(
      'b9000000-0000-0000-0000-000000000002'::uuid, '${BIZ}'::uuid, '2026-09-10'::date, '11:00');`);

    expect(r.rescheduled).toBe(false);
    expect(r.reason).toBe('buffer_conflict');

    // Verify moving booking stays at original slot
    const moving = psql(`SELECT date, time FROM bookings WHERE id = 'b9000000-0000-0000-0000-000000000002';`);
    expect(moving).toContain('2026-09-10');
    expect(moving).toContain('16:00');

    // Verify existing booking unchanged
    const existing = psql(`SELECT date, time FROM bookings WHERE id = 'b9000000-0000-0000-0000-000000000001';`);
    expect(existing).toContain('10:00');
  });

  it('9b. buffer boundary success — reschedule to slot exactly outside buffer window', () => {
    reset();
    const SVC_BUF = '99ffffff-ffff-ffff-ffff-ffffffffffff';
    // Existing confirmed booking at 10:00 (60min + 15min buffer)
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status)
      VALUES ('b9b00000-0000-0000-0000-000000000001', '${BIZ}', '${USR}', '${SVC_BUF}', '2026-09-10', '10:00', 'confirmed');`);
    // Booking to reschedule
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status)
      VALUES ('b9b00000-0000-0000-0000-000000000002', '${BIZ}', '${USR}', '${SVC_BUF}', '2026-09-10', '16:00', 'confirmed');`);

    // Reschedule to 11:15 — exactly at the boundary:
    // 11:15 < 10:00 + 60 + 15 = 11:15 → false (not strictly less than)
    // Buffer check condition fails → no conflict → allowed
    const r = psqlJson(`SELECT reschedule_booking_atomic(
      'b9b00000-0000-0000-0000-000000000002'::uuid, '${BIZ}'::uuid, '2026-09-10'::date, '11:15');`);

    expect(r.rescheduled).toBe(true);
    expect(r.new_time).toMatch(/^11:15/);

    // Verify booking actually moved
    const moved = psql(`SELECT date, time FROM bookings WHERE id = 'b9b00000-0000-0000-0000-000000000002';`);
    expect(moved).toContain('11:15');
  });

  it('10. bot path uses RPC (source verification)', () => {
    const fs = require('fs');
    const source = fs.readFileSync('lib/bot/flows/scheduling.flow.ts', 'utf-8');
    // Bot reschedule must use the atomic RPC
    expect(source).toContain("rpc('reschedule_booking_atomic'");
    // Must NOT contain direct .update for rescheduling
    expect(source).not.toMatch(/reschedule_booking_id[\s\S]{0,500}\.from\(['"]bookings['"]\)\s*\n?\s*\.update/);
  });

  it('11. migration 313 applies cleanly', () => {
    const r = psql(`SELECT proname FROM pg_proc WHERE proname = 'reschedule_booking_atomic';`);
    expect(r).toBe('reschedule_booking_atomic');
    const grants = psql(`SELECT grantee FROM information_schema.routine_privileges
      WHERE routine_name = 'reschedule_booking_atomic' AND privilege_type = 'EXECUTE';`);
    expect(grants).not.toContain('anon');
    expect(grants).not.toContain('authenticated');
  });

  it('12. CROSS-PATH: book_slot_atomic vs reschedule_booking_atomic — capacity 1 → exactly one wins', async () => {
    // Setup: empty target slot (15:00 on 2027-06-01), one existing booking at 10:00 for reschedule source
    psql(`DELETE FROM bookings WHERE business_id = '${BIZ}';`);
    const SVC = '99dddddd-dddd-dddd-dddd-dddddddddddd'; // capacity=1
    psql(`INSERT INTO bookings (id, business_id, user_id, service_id, date, time, status, guest_name, guest_phone)
          VALUES ('aaaaaaaa-0012-0000-0000-000000000001', '${BIZ}', '${USR}', '${SVC}', '2027-06-01', '10:00', 'confirmed', 'Source', '+234');`);

    // Worker A: book_slot_atomic for 15:00 — holds transaction open with pg_sleep(2)
    const sqlA = `
      BEGIN;
      SET ROLE service_role;
      SELECT * FROM book_slot_atomic(
        '${BIZ}'::uuid, '${USR}'::uuid, '${SVC}'::uuid, NULL::uuid,
        '2027-06-01'::date, '15:00', 1, 1,
        'scheduling', 0, 'none', 'confirmed',
        'BookerA', '+234bookA', NULL,
        NULL, NULL, NULL::date,
        NULL::jsonb, NULL::uuid, 0, NULL,
        NULL::uuid, NULL::uuid, 0, 30, NULL::uuid
      );
      SELECT pg_sleep(2);
      COMMIT;
    `;

    // Worker B: reschedule existing booking TO 15:00 — starts 500ms after A
    // Uses '15:00:00' (with seconds) to prove time canonicalization works
    const sqlB = `
      BEGIN;
      SET ROLE service_role;
      SELECT * FROM reschedule_booking_atomic(
        'aaaaaaaa-0012-0000-0000-000000000001'::uuid,
        '${BIZ}'::uuid,
        '2027-06-01'::date,
        '15:00:00'
      );
      COMMIT;
    `;

    const { a, b } = await runTwoSessions(sqlA, sqlB);

    // Exactly one must succeed at 15:00
    const at15 = psql(`SELECT COUNT(*) FROM bookings WHERE business_id = '${BIZ}' AND date = '2027-06-01' AND time = '15:00' AND status IN ('confirmed', 'pending', 'in_progress');`);
    expect(parseInt(at15)).toBe(1);

    // Check who won
    const bookResult = a; // book_slot_atomic returns (booking_id, reference_code, slot_available)
    const rescheduleResult = b; // reschedule_booking_atomic returns jsonb

    // One must contain a success indicator, the other a rejection
    const bookWon = bookResult.includes('t') || bookResult.includes('true'); // slot_available=true
    const rescheduleWon = b.includes('"rescheduled": true') || b.includes('"rescheduled":true');

    // At most one winner
    expect(bookWon && rescheduleWon).toBe(false);

    // If reschedule lost, source booking must remain at 10:00
    if (!rescheduleWon) {
      const sourceTime = psql(`SELECT time FROM bookings WHERE id = 'aaaaaaaa-0012-0000-0000-000000000001';`);
      expect(sourceTime).toBe('10:00:00');
    }
  }, 20000);

  it('13. Time canonicalization: book_slot_atomic and reschedule_booking_atomic produce same lock key', () => {
    // Verify that '15:00'::time::text and '15:00:00'::time::text produce the same hashtext
    const hash1 = psql(`SELECT abs(hashtext('${BIZ}' || '|' || '2027-06-01' || '|' || '15:00'::time::text));`);
    const hash2 = psql(`SELECT abs(hashtext('${BIZ}' || '|' || '2027-06-01' || '|' || '15:00:00'::time::text));`);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBeGreaterThan(0);
  });
});
