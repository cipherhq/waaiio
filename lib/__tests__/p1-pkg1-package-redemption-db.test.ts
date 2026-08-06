/**
 * P1-PKG-1 — Real PostgreSQL contention tests for package redemption
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
          if (error && !stdout) reject(new Error(`psql failed: ${stderr || error.message}`));
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

const BIZ = '66aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PKG = '66bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ENR = '66cccccc-cccc-cccc-cccc-cccccccccccc';
const BK1 = '66dddddd-dddd-dddd-dddd-dddddddddddd';
const BK2 = '66eeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const SVC = '66ffffff-ffff-ffff-ffff-ffffffffffff';

describe.skipIf(!dbUrl)('P1-PKG-1: PostgreSQL package redemption', () => {
  beforeAll(() => {
    if (!dbUrl) return;
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role;
      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY, owner_id UUID);
      DO $$ BEGIN CREATE TYPE flow_type AS ENUM ('scheduling','ordering','ticketing','reservation','payment','queue','chat','waitlist'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE booking_channel AS ENUM ('whatsapp','web','api','recurring'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE reservation_status AS ENUM ('pending','confirmed','cancelled','completed','in_progress','no_show'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE deposit_status AS ENUM ('none','pending','paid','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE payment_source AS ENUM ('whatsapp','web','api','subscription','invoice','manual'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE IF NOT EXISTS payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), reference_code TEXT UNIQUE,
        business_id UUID, user_id UUID, service_id UUID, date DATE, time TEXT,
        party_size INT DEFAULT 1, flow_type flow_type DEFAULT 'scheduling',
        channel booking_channel DEFAULT 'whatsapp', deposit_amount NUMERIC(12,2) DEFAULT 0,
        deposit_status deposit_status DEFAULT 'none', status reservation_status DEFAULT 'pending',
        total_amount NUMERIC(12,2) DEFAULT 0, quantity INT DEFAULT 1,
        guest_name TEXT, guest_phone TEXT, confirmed_at TIMESTAMPTZ, notes TEXT,
        payment_source payment_source DEFAULT 'whatsapp'
      );
      INSERT INTO businesses (id) VALUES ('${BIZ}') ON CONFLICT DO NOTHING;
    `);
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_154}"`, { encoding: 'utf-8', timeout: 15000 });
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1 -f "${MIGRATION_308}"`, { encoding: 'utf-8', timeout: 15000 });
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`DROP TABLE IF EXISTS package_redemptions, package_enrollments, service_packages, bookings, payments, businesses CASCADE;`);
  });

  function resetFixtures(sessionsTotal = 10, sessionsUsed = 0) {
    psql(`DELETE FROM package_redemptions; DELETE FROM package_enrollments; DELETE FROM service_packages; DELETE FROM bookings;`);
    psql(`INSERT INTO service_packages (id, business_id, name, price, num_sessions, service_ids, is_active) VALUES ('${PKG}', '${BIZ}', 'Test Pkg', 500, ${sessionsTotal}, '{}', true);`);
    psql(`INSERT INTO package_enrollments (id, business_id, customer_phone, package_id, sessions_total, sessions_used, is_active) VALUES ('${ENR}', '${BIZ}', '+234123', '${PKG}', ${sessionsTotal}, ${sessionsUsed}, true);`);
    psql(`INSERT INTO bookings (id, business_id, status) VALUES ('${BK1}', '${BIZ}', 'confirmed');`);
    psql(`INSERT INTO bookings (id, business_id, status) VALUES ('${BK2}', '${BIZ}', 'confirmed');`);
  }

  it('1. eligible claim succeeds', () => {
    resetFixtures(10, 0);
    const r = psqlJson(`SELECT claim_package_session('${ENR}'::uuid, '${BK1}'::uuid, '${BIZ}'::uuid);`);
    expect(r.claimed).toBe(true);
    expect(r.already_claimed).toBe(false);
    const used = psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`);
    expect(used).toBe('1');
  });

  it('2. duplicate claim is idempotent', () => {
    const r = psqlJson(`SELECT claim_package_session('${ENR}'::uuid, '${BK1}'::uuid, '${BIZ}'::uuid);`);
    expect(r.claimed).toBe(true);
    expect(r.already_claimed).toBe(true);
    const used = psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`);
    expect(used).toBe('1'); // NOT 2
  });

  it('3. exhausted package rejects claim', () => {
    resetFixtures(1, 1);
    const r = psqlJson(`SELECT claim_package_session('${ENR}'::uuid, '${BK2}'::uuid, '${BIZ}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('no_sessions_remaining');
  });

  it('4. inactive enrollment rejected', () => {
    resetFixtures(10, 0);
    psql(`UPDATE package_enrollments SET is_active = false WHERE id = '${ENR}';`);
    const r = psqlJson(`SELECT claim_package_session('${ENR}'::uuid, '${BK1}'::uuid, '${BIZ}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('enrollment_inactive');
  });

  it('5. expired enrollment rejected', () => {
    resetFixtures(10, 0);
    psql(`UPDATE package_enrollments SET expires_at = NOW() - INTERVAL '1 day' WHERE id = '${ENR}';`);
    const r = psqlJson(`SELECT claim_package_session('${ENR}'::uuid, '${BK1}'::uuid, '${BIZ}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('enrollment_expired');
  });

  it('6. wrong business rejected', () => {
    resetFixtures(10, 0);
    const r = psqlJson(`SELECT claim_package_session('${ENR}'::uuid, '${BK1}'::uuid, '99999999-9999-9999-9999-999999999999'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('wrong_business');
  });

  it('7. ineligible service rejected', () => {
    resetFixtures(10, 0);
    psql(`UPDATE service_packages SET service_ids = '{${SVC}}' WHERE id = '${PKG}';`); // Only SVC eligible
    const r = psqlJson(`SELECT claim_package_session('${ENR}'::uuid, '${BK1}'::uuid, '${BIZ}'::uuid, '99999999-0000-0000-0000-000000000000'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('service_not_eligible');
  });

  it('8. eligible service with service_ids filter succeeds', () => {
    resetFixtures(10, 0);
    psql(`UPDATE service_packages SET service_ids = '{${SVC}}' WHERE id = '${PKG}';`);
    const r = psqlJson(`SELECT claim_package_session('${ENR}'::uuid, '${BK1}'::uuid, '${BIZ}'::uuid, '${SVC}'::uuid);`);
    expect(r.claimed).toBe(true);
  });

  it('9. release returns session', () => {
    resetFixtures(10, 0);
    psqlJson(`SELECT claim_package_session('${ENR}'::uuid, '${BK1}'::uuid, '${BIZ}'::uuid);`);
    expect(psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`)).toBe('1');

    const r = psqlJson(`SELECT release_package_session('${BK1}'::uuid);`);
    expect(r.released).toBe(true);
    expect(psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`)).toBe('0');
  });

  it('10. duplicate release is safe', () => {
    const r = psqlJson(`SELECT release_package_session('${BK1}'::uuid);`);
    expect(r.released).toBe(false);
    expect(r.reason).toBe('no_active_redemption');
    expect(psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`)).toBe('0');
  });

  it('11. concurrent final-session claim — exactly one wins', async () => {
    resetFixtures(1, 0); // Only 1 session
    const sqlA = `BEGIN; SELECT claim_package_session('${ENR}'::uuid, '${BK1}'::uuid, '${BIZ}'::uuid); SELECT pg_sleep(1); COMMIT;`;
    const sqlB = `SELECT claim_package_session('${ENR}'::uuid, '${BK2}'::uuid, '${BIZ}'::uuid);`;

    const { a, b } = await runTwoSessions(sqlA, sqlB);
    const parse = (s: string) => JSON.parse(s.split('\n').filter(l => l.trim().startsWith('{'))[0]);
    const rA = parse(a.stdout);
    const rB = parse(b.stdout);

    const claimed = [rA, rB].filter(r => r.claimed && !r.already_claimed);
    expect(claimed).toHaveLength(1);

    const used = psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`);
    expect(used).toBe('1'); // Never exceeds sessions_total
  });

  it('12. sessions_used never exceeds sessions_total', () => {
    resetFixtures(2, 2); // Already full
    const r = psqlJson(`SELECT claim_package_session('${ENR}'::uuid, '${BK1}'::uuid, '${BIZ}'::uuid);`);
    expect(r.claimed).toBe(false);
    const used = psql(`SELECT sessions_used FROM package_enrollments WHERE id = '${ENR}';`);
    expect(used).toBe('2');
  });

  it('13. inactive package rejected', () => {
    resetFixtures(10, 0);
    psql(`UPDATE service_packages SET is_active = false WHERE id = '${PKG}';`);
    const r = psqlJson(`SELECT claim_package_session('${ENR}'::uuid, '${BK1}'::uuid, '${BIZ}'::uuid);`);
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('package_inactive');
  });
});
