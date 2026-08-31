/**
 * #216: Object-level authorization DB tests for cancel_booking_with_release RPC.
 *
 * Proves against real PostgreSQL (TEST_DATABASE_URL) under SET ROLE service_role:
 *
 * 1. Mismatched p_expected_user_id -> denial; booking status, package redemption,
 *    enrollment sessions_used, and booking-slot capacity ALL remain unchanged.
 * 2. Correct p_expected_user_id -> success; booking cancelled, package redemption
 *    released, enrollment sessions_used decremented, booking-slot capacity decremented
 *    — exactly once.
 * 3. NULL p_expected_user_id -> denial (belt-and-suspenders), all state unchanged.
 * 4. Legacy unowned overload (uuid-only) does not exist.
 * 5. Legacy unowned overload (uuid, text) does not exist.
 * 6. ACL: anon/authenticated CANNOT execute; service_role CAN execute.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('#216 Object authorization — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

/** Run SQL as superuser (for setup/teardown only). */
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

/** Run SQL as service_role (the actual privileged execution boundary). */
function runAsServiceRole(sql: string): string {
  return runSQL(`SET ROLE service_role;\n${sql}\nRESET ROLE;`);
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

/** Run RPC as service_role and parse JSON result. */
function rpcAsServiceRole(sql: string): any {
  const raw = runAsServiceRole(sql);
  return raw ? JSON.parse(raw) : null;
}

const OWNER = 'a2160000-0000-0000-0000-000000000001';
const BIZ = 'a2160000-0000-0000-0000-000000000010';
const VICTIM = 'a2160000-0000-0000-0000-000000000002';
const ATTACKER = 'a2160000-0000-0000-0000-000000000003';
const BOOKING = 'a2160000-0000-0000-0000-000000000030';
const PAYMENT = 'a2160000-0000-0000-0000-000000000050';
const SERVICE = 'a2160000-0000-0000-0000-000000000020';
const PKG = 'a2160000-0000-0000-0000-000000000040';
const ENROLLMENT = 'a2160000-0000-0000-0000-000000000060';
const REDEMPTION = 'a2160000-0000-0000-0000-000000000070';

/** Reset booking + package + slot state to the canonical test baseline. */
function resetAllState() {
  runSQL(`
    -- Reset booking to confirmed with victim ownership
    UPDATE public.bookings
    SET status = 'confirmed', cancelled_at = NULL, cancelled_by = NULL
    WHERE id = '${BOOKING}';

    -- Reset package redemption to active
    UPDATE public.package_redemptions
    SET status = 'active', released_at = NULL
    WHERE id = '${REDEMPTION}';

    -- Reset enrollment sessions_used to 1 (one active redemption)
    UPDATE public.package_enrollments
    SET sessions_used = 1
    WHERE id = '${ENROLLMENT}';

    -- Reset booking slot capacity to 1 (one active booking)
    UPDATE public.booking_slots
    SET current_bookings = 1
    WHERE business_id = '${BIZ}' AND date = CURRENT_DATE AND start_time = '10:00'::time;
  `);
}

describe('#216 Object-level authorization: cancel_booking_with_release', () => {
  beforeAll(() => {
    // Clean up any prior test data (reverse dependency order)
    runSQL(`
      DELETE FROM public.package_redemptions WHERE business_id = '${BIZ}';
      DELETE FROM public.platform_fees WHERE business_id = '${BIZ}';
      DELETE FROM public.payments WHERE business_id = '${BIZ}';
      DELETE FROM public.bookings WHERE business_id = '${BIZ}';
      DELETE FROM public.package_enrollments WHERE business_id = '${BIZ}';
      DELETE FROM public.service_packages WHERE business_id = '${BIZ}';
      DELETE FROM public.booking_slots WHERE business_id = '${BIZ}';
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

      -- Service package + enrollment for package-session release proof
      INSERT INTO public.service_packages (id, business_id, name, price, num_sessions, service_ids, is_active)
      VALUES ('${PKG}', '${BIZ}', 'Test Package', 25000, 5, ARRAY['${SERVICE}']::uuid[], true);

      INSERT INTO public.package_enrollments (id, business_id, customer_phone, package_id, sessions_total, sessions_used, is_active)
      VALUES ('${ENROLLMENT}', '${BIZ}', '+2340000216', '${PKG}', 5, 1, true);

      -- Booking with victim ownership
      INSERT INTO public.bookings (id, reference_code, business_id, user_id, service_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
      VALUES ('${BOOKING}', 'WA-AU-001', '${BIZ}', '${VICTIM}', '${SERVICE}', 'scheduling', 'AuthVictim', '+2340000216', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 5000, now());

      -- Package redemption linking booking to enrollment
      INSERT INTO public.package_redemptions (id, enrollment_id, booking_id, business_id, status)
      VALUES ('${REDEMPTION}', '${ENROLLMENT}', '${BOOKING}', '${BIZ}', 'active');

      -- Booking slot with capacity = 1 (representing the one active booking)
      INSERT INTO public.booking_slots (business_id, date, start_time, end_time, max_bookings, current_bookings)
      VALUES ('${BIZ}', CURRENT_DATE, '10:00', '10:30', 10, 1);

      INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, paid_at, created_at)
      VALUES ('${PAYMENT}', '${BOOKING}', '${VICTIM}', '${BIZ}', 5000, 'NGN', 'WA-AU-001-PAY', 'success', now(), now());
    `);
  });

  afterAll(() => {
    runSQL(`
      DELETE FROM public.package_redemptions WHERE business_id = '${BIZ}';
      DELETE FROM public.platform_fees WHERE business_id = '${BIZ}';
      DELETE FROM public.payments WHERE business_id = '${BIZ}';
      DELETE FROM public.bookings WHERE business_id = '${BIZ}';
      DELETE FROM public.package_enrollments WHERE business_id = '${BIZ}';
      DELETE FROM public.service_packages WHERE business_id = '${BIZ}';
      DELETE FROM public.booking_slots WHERE business_id = '${BIZ}';
      DELETE FROM public.services WHERE business_id = '${BIZ}';
      DELETE FROM public.businesses WHERE id = '${BIZ}';
      DELETE FROM public.profiles WHERE id IN ('${OWNER}', '${VICTIM}', '${ATTACKER}');
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id IN ('${OWNER}', '${VICTIM}', '${ATTACKER}');
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
  });

  it('1. mismatched owner under service_role: denial + ALL state unchanged', () => {
    resetAllState();

    // Attacker tries to cancel victim's booking via service_role
    const result = rpcAsServiceRole(
      `SELECT cancel_booking_with_release('${BOOKING}'::uuid, 'guest'::text, '${ATTACKER}'::uuid);`
    );

    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_owner');

    // Booking status unchanged
    const status = runSQL(`SELECT status FROM public.bookings WHERE id = '${BOOKING}';`);
    expect(status).toBe('confirmed');

    // Package redemption still active
    const redemptionStatus = runSQL(`SELECT status FROM public.package_redemptions WHERE id = '${REDEMPTION}';`);
    expect(redemptionStatus).toBe('active');

    // Enrollment sessions_used unchanged at 1
    const sessionsUsed = runSQL(`SELECT sessions_used FROM public.package_enrollments WHERE id = '${ENROLLMENT}';`);
    expect(sessionsUsed).toBe('1');

    // Booking slot capacity unchanged at 1
    const slotBookings = runSQL(
      `SELECT current_bookings FROM public.booking_slots WHERE business_id = '${BIZ}' AND date = CURRENT_DATE AND start_time = '10:00'::time;`
    );
    expect(slotBookings).toBe('1');
  });

  it('2. correct owner under service_role: cancellation + exact-once resource release', () => {
    resetAllState();

    // Correct owner cancels their own booking via service_role
    const result = rpcAsServiceRole(
      `SELECT cancel_booking_with_release('${BOOKING}'::uuid, 'guest'::text, '${VICTIM}'::uuid);`
    );

    expect(result.cancelled).toBe(true);
    expect(result.session_released).toBe(true);

    // Booking cancelled
    const status = runSQL(`SELECT status FROM public.bookings WHERE id = '${BOOKING}';`);
    expect(status).toBe('cancelled');

    // Package redemption released
    const redemptionStatus = runSQL(`SELECT status FROM public.package_redemptions WHERE id = '${REDEMPTION}';`);
    expect(redemptionStatus).toBe('released');

    // Enrollment sessions_used decremented from 1 to 0
    const sessionsUsed = runSQL(`SELECT sessions_used FROM public.package_enrollments WHERE id = '${ENROLLMENT}';`);
    expect(sessionsUsed).toBe('0');

    // Booking slot capacity decremented from 1 to 0
    const slotBookings = runSQL(
      `SELECT current_bookings FROM public.booking_slots WHERE business_id = '${BIZ}' AND date = CURRENT_DATE AND start_time = '10:00'::time;`
    );
    expect(slotBookings).toBe('0');
  });

  it('3. NULL owner under service_role: denial + all state unchanged', () => {
    resetAllState();

    const result = rpcAsServiceRole(
      `SELECT cancel_booking_with_release('${BOOKING}'::uuid, 'guest'::text, NULL::uuid);`
    );

    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_owner');

    // All state unchanged
    const status = runSQL(`SELECT status FROM public.bookings WHERE id = '${BOOKING}';`);
    expect(status).toBe('confirmed');

    const redemptionStatus = runSQL(`SELECT status FROM public.package_redemptions WHERE id = '${REDEMPTION}';`);
    expect(redemptionStatus).toBe('active');

    const sessionsUsed = runSQL(`SELECT sessions_used FROM public.package_enrollments WHERE id = '${ENROLLMENT}';`);
    expect(sessionsUsed).toBe('1');

    const slotBookings = runSQL(
      `SELECT current_bookings FROM public.booking_slots WHERE business_id = '${BIZ}' AND date = CURRENT_DATE AND start_time = '10:00'::time;`
    );
    expect(slotBookings).toBe('1');
  });

  it('4. legacy unowned overload (uuid-only) does not exist', () => {
    const result = runSQLSafe(
      `SELECT cancel_booking_with_release('${BOOKING}'::uuid);`
    );
    expect(result.exitCode).not.toBe(0);
  });

  it('5. legacy unowned overload (uuid, text) does not exist', () => {
    const result = runSQLSafe(
      `SELECT cancel_booking_with_release('${BOOKING}'::uuid, 'guest');`
    );
    expect(result.exitCode).not.toBe(0);
  });

  it('6. ACL: anon and authenticated DENIED, service_role ALLOWED', () => {
    // anon cannot execute
    const anonResult = runSQLSafe(
      `SET ROLE anon; SELECT cancel_booking_with_release('${BOOKING}'::uuid, 'guest'::text, '${VICTIM}'::uuid); RESET ROLE;`
    );
    expect(anonResult.exitCode).not.toBe(0);

    // authenticated cannot execute
    const authResult = runSQLSafe(
      `SET ROLE authenticated; SELECT cancel_booking_with_release('${BOOKING}'::uuid, 'guest'::text, '${VICTIM}'::uuid); RESET ROLE;`
    );
    expect(authResult.exitCode).not.toBe(0);

    // service_role CAN execute (proven by test 1-3, but also confirm privilege exists)
    const hasPrivilege = runSQL(
      `SELECT has_function_privilege('service_role', 'cancel_booking_with_release(uuid, text, uuid)', 'EXECUTE');`
    );
    expect(hasPrivilege).toBe('t');
  });
});

} // end if (dbUrl)
