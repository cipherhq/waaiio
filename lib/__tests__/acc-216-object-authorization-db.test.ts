/**
 * #216: Object-level authorization DB tests for cancel_booking_with_release RPC.
 *
 * Proves against real PostgreSQL (TEST_DATABASE_URL):
 * 1. Mismatched p_expected_user_id -> denial, no state change
 * 2. Correct p_expected_user_id -> success, booking cancelled
 * 3. NULL p_expected_user_id -> denial (belt-and-suspenders)
 * 4. Legacy unowned overload (uuid-only or uuid,text) no longer exists
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('#216 Object authorization — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string): string {
  try {
    return execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    ).trim();
  } catch (err: any) {
    throw new Error(`SQL failed: ${err.stderr?.trim() || err.stdout?.trim() || err}`);
  }
}

function runSQLSafe(sql: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    ).trim();
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.trim() || '', exitCode: err.status || 1 };
  }
}

function runSQLJson(sql: string): any {
  const raw = runSQL(sql);
  return raw ? JSON.parse(raw) : null;
}

const OWNER = 'a2160000-0000-0000-0000-000000000001';
const BIZ = 'a2160000-0000-0000-0000-000000000010';
const VICTIM = 'a2160000-0000-0000-0000-000000000002';
const ATTACKER = 'a2160000-0000-0000-0000-000000000003';
const BOOKING = 'a2160000-0000-0000-0000-000000000030';
const PAYMENT = 'a2160000-0000-0000-0000-000000000050';
const SERVICE = 'a2160000-0000-0000-0000-000000000020';

describe('#216 Object-level authorization: cancel_booking_with_release', () => {
  beforeAll(() => {
    runSQL(`
      DELETE FROM public.platform_fees WHERE business_id = '${BIZ}';
      DELETE FROM public.payments WHERE business_id = '${BIZ}';
      DELETE FROM public.bookings WHERE business_id = '${BIZ}';
      DELETE FROM public.services WHERE business_id = '${BIZ}';
      DELETE FROM public.businesses WHERE id = '${BIZ}';
      DELETE FROM public.profiles WHERE id IN ('${OWNER}', '${VICTIM}', '${ATTACKER}');
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id IN ('${OWNER}', '${VICTIM}', '${ATTACKER}');
      INSERT INTO auth.users (id) VALUES ('${OWNER}'), ('${VICTIM}'), ('${ATTACKER}') ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;

      INSERT INTO public.profiles (id, first_name, last_name, email)
      VALUES ('${OWNER}', 'AuthOwner', 'Test', 'auth-owner@test.local'),
             ('${VICTIM}', 'AuthVictim', 'Test', 'auth-victim@test.local'),
             ('${ATTACKER}', 'AuthAttacker', 'Test', 'auth-attacker@test.local');

      INSERT INTO public.businesses (id, owner_id, name, slug, category, address, city, phone, status, subscription_tier, country_code)
      VALUES ('${BIZ}', '${OWNER}', 'AuthTestBiz', 'auth-test-216', 'salon', '1 St', 'Lagos', '+2340000216', 'active', 'growth', 'NG');

      INSERT INTO public.services (id, business_id, name, service_type, billing_type, is_active, price, duration_minutes, deposit_amount)
      VALUES ('${SERVICE}', '${BIZ}', 'Auth Haircut', 'appointment', 'one_time', true, 5000, 30, 0);

      INSERT INTO public.bookings (id, reference_code, business_id, user_id, service_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
      VALUES ('${BOOKING}', 'WA-AU-001', '${BIZ}', '${VICTIM}', '${SERVICE}', 'scheduling', 'AuthVictim', '+2340000216', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 5000, now());

      INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, paid_at, created_at)
      VALUES ('${PAYMENT}', '${BOOKING}', '${VICTIM}', '${BIZ}', 5000, 'NGN', 'WA-AU-001-PAY', 'success', now(), now());
    `);
  });

  afterAll(() => {
    runSQL(`
      DELETE FROM public.platform_fees WHERE business_id = '${BIZ}';
      DELETE FROM public.payments WHERE business_id = '${BIZ}';
      DELETE FROM public.bookings WHERE business_id = '${BIZ}';
      DELETE FROM public.services WHERE business_id = '${BIZ}';
      DELETE FROM public.businesses WHERE id = '${BIZ}';
      DELETE FROM public.profiles WHERE id IN ('${OWNER}', '${VICTIM}', '${ATTACKER}');
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id IN ('${OWNER}', '${VICTIM}', '${ATTACKER}');
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
  });

  it('1. mismatched p_expected_user_id -> denial, booking status unchanged', () => {
    // Attacker tries to cancel victim's booking
    const result = runSQLJson(
      `SELECT cancel_booking_with_release('${BOOKING}'::uuid, 'guest'::text, '${ATTACKER}'::uuid);`
    );

    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_owner');

    // Victim's booking must remain confirmed
    const status = runSQL(`SELECT status FROM public.bookings WHERE id = '${BOOKING}';`);
    expect(status).toBe('confirmed');
  });

  it('2. correct p_expected_user_id -> success, booking cancelled', () => {
    // Reset booking to confirmed
    runSQL(`UPDATE public.bookings SET status = 'confirmed', cancelled_at = NULL, cancelled_by = NULL WHERE id = '${BOOKING}';`);

    const result = runSQLJson(
      `SELECT cancel_booking_with_release('${BOOKING}'::uuid, 'guest'::text, '${VICTIM}'::uuid);`
    );

    expect(result.cancelled).toBe(true);

    // Booking should be cancelled now
    const status = runSQL(`SELECT status FROM public.bookings WHERE id = '${BOOKING}';`);
    expect(status).toBe('cancelled');
  });

  it('3. NULL p_expected_user_id -> denial (belt-and-suspenders)', () => {
    // Reset booking
    runSQL(`UPDATE public.bookings SET status = 'confirmed', cancelled_at = NULL, cancelled_by = NULL WHERE id = '${BOOKING}';`);

    const result = runSQLJson(
      `SELECT cancel_booking_with_release('${BOOKING}'::uuid, 'guest'::text, NULL::uuid);`
    );

    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_owner');

    // Booking must remain confirmed
    const status = runSQL(`SELECT status FROM public.bookings WHERE id = '${BOOKING}';`);
    expect(status).toBe('confirmed');
  });

  it('4. legacy unowned overload (uuid-only) does not exist', () => {
    // Calling with 1 arg should fail (function does not exist)
    const result = runSQLSafe(
      `SELECT cancel_booking_with_release('${BOOKING}'::uuid);`
    );
    expect(result.exitCode).not.toBe(0);
  });

  it('5. legacy unowned overload (uuid, text) does not exist', () => {
    // Calling with 2 args should fail (function does not exist)
    const result = runSQLSafe(
      `SELECT cancel_booking_with_release('${BOOKING}'::uuid, 'guest');`
    );
    expect(result.exitCode).not.toBe(0);
  });
});

} // end if (dbUrl)
