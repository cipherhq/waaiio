/**
 * M471 Navigation Cancellation — Real PostgreSQL Payment-Safety Tests
 *
 * Deterministic fixtures with known UUIDs. Tests prove:
 * - Pending unpaid entities are cancelled
 * - Paid entities (successful payment) are atomically preserved
 * - Active finalization (processing_at within 5 min) preserves the entity
 * - Confirmed entities are preserved (not_pending)
 * - Ownership mismatch is rejected (not_owner)
 * - NULL params and nonexistent entities are rejected
 * - Pending-only payments don't block cancellation
 * - Idempotency: re-cancelling returns not_pending
 * - RPC existence, SECURITY DEFINER, and least-privilege grants
 *
 * Lock ordering: entity FOR UPDATE → payments FOR UPDATE
 * (same as cancel_order_immediate; see M471 migration header).
 *
 * Requires: TEST_DATABASE_URL pointing to a disposable PG with all
 * migrations applied (ci-bootstrap-test-db.sh).
 *
 * CI step (shard-a) creates waaiio_m471_test, bootstraps, runs this
 * file, and enforces zero skips.
 */
import { execSync } from 'child_process';
import { describe, it, expect, beforeAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

// ── Deterministic UUIDs ──

const BIZ_ID    = 'a0000000-0000-0000-0000-000000000001';
const USER_A    = 'a0000000-0000-0000-0000-000000000010'; // owner
const USER_B    = 'a0000000-0000-0000-0000-000000000020'; // wrong owner
const NONEXIST  = 'a0000000-0000-0000-0000-ffffffffffff';

// Bookings
const BK_PENDING_UNPAID   = 'b0000000-0000-0000-0000-000000000001';
const BK_PENDING_PAID     = 'b0000000-0000-0000-0000-000000000002';
const BK_PENDING_FINALIZ  = 'b0000000-0000-0000-0000-000000000003';
const BK_CONFIRMED        = 'b0000000-0000-0000-0000-000000000004';
const BK_WRONG_OWNER      = 'b0000000-0000-0000-0000-000000000005';
const BK_PENDING_PEND_PAY = 'b0000000-0000-0000-0000-000000000006';

// Reservations (property)
const RV_PENDING_UNPAID   = 'c0000000-0000-0000-0000-000000000001';
const RV_PENDING_PAID     = 'c0000000-0000-0000-0000-000000000002';
const RV_CONFIRMED        = 'c0000000-0000-0000-0000-000000000003';
const RV_WRONG_OWNER      = 'c0000000-0000-0000-0000-000000000004';

// Payments
const PAY_SUCCESS_BK      = 'd0000000-0000-0000-0000-000000000001';
const PAY_FINALIZING_BK   = 'd0000000-0000-0000-0000-000000000002';
const PAY_PENDING_BK      = 'd0000000-0000-0000-0000-000000000003';
const PAY_SUCCESS_RV      = 'd0000000-0000-0000-0000-000000000004';

// ── Seed deterministic fixtures ──

describe.skipIf(!canRun)('M471: fixture setup', () => {
  beforeAll(() => {
    // Insert fixtures as postgres superuser (service_role lacks table INSERT grants
    // in disposable PG; RPCs are SECURITY DEFINER so they run as owner).
    // Order: auth.users → profiles → businesses → bookings/reservations → payments
    psql(`
      -- Users (must exist before businesses.owner_id FK and bookings.user_id FK)
      INSERT INTO auth.users (id, email) VALUES
        ('${USER_A}', 'nav-user-a@test.local'),
        ('${USER_B}', 'nav-user-b@test.local')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO profiles (id, email) VALUES
        ('${USER_A}', 'nav-user-a@test.local'),
        ('${USER_B}', 'nav-user-b@test.local')
      ON CONFLICT (id) DO NOTHING;

      -- Business (references profiles.id via owner_id)
      INSERT INTO businesses (id, name, slug, owner_id, category, subscription_tier, trial_ends_at, address, city, neighborhood, phone)
      VALUES ('${BIZ_ID}', 'Test Nav Biz', 'test-nav-biz-m471', '${USER_A}', 'restaurant', 'growth', NOW() + INTERVAL '30 days', '1 Test St', 'Lagos', 'VI', '+2340000000000')
      ON CONFLICT (id) DO NOTHING;

      -- Bookings: pending unpaid, pending with successful payment, pending with finalization,
      --           confirmed, wrong owner, pending with only pending payment
      INSERT INTO bookings (id, business_id, user_id, date, time, party_size, status, reference_code)
      VALUES
        ('${BK_PENDING_UNPAID}',   '${BIZ_ID}', '${USER_A}', CURRENT_DATE, '10:00', 2, 'pending',   'BW-T001'),
        ('${BK_PENDING_PAID}',     '${BIZ_ID}', '${USER_A}', CURRENT_DATE, '11:00', 2, 'pending',   'BW-T002'),
        ('${BK_PENDING_FINALIZ}',  '${BIZ_ID}', '${USER_A}', CURRENT_DATE, '12:00', 2, 'pending',   'BW-T003'),
        ('${BK_CONFIRMED}',        '${BIZ_ID}', '${USER_A}', CURRENT_DATE, '13:00', 2, 'confirmed', 'BW-T004'),
        ('${BK_WRONG_OWNER}',      '${BIZ_ID}', '${USER_B}', CURRENT_DATE, '14:00', 2, 'pending',   'BW-T005'),
        ('${BK_PENDING_PEND_PAY}', '${BIZ_ID}', '${USER_A}', CURRENT_DATE, '15:00', 2, 'pending',   'BW-T006')
      ON CONFLICT (id) DO NOTHING;

      -- Reservations (property)
      INSERT INTO reservations (id, business_id, user_id, check_in, check_out, guests, nightly_rate, total_amount, status)
      VALUES
        ('${RV_PENDING_UNPAID}', '${BIZ_ID}', '${USER_A}', CURRENT_DATE, CURRENT_DATE + 1, 1, 5000, 5000, 'pending'),
        ('${RV_PENDING_PAID}',   '${BIZ_ID}', '${USER_A}', CURRENT_DATE, CURRENT_DATE + 1, 1, 5000, 5000, 'pending'),
        ('${RV_CONFIRMED}',      '${BIZ_ID}', '${USER_A}', CURRENT_DATE, CURRENT_DATE + 1, 1, 5000, 5000, 'confirmed'),
        ('${RV_WRONG_OWNER}',    '${BIZ_ID}', '${USER_B}', CURRENT_DATE, CURRENT_DATE + 1, 1, 5000, 5000, 'pending')
      ON CONFLICT (id) DO NOTHING;

    `);

    // Payment fixtures — each INSERT isolated so errors are visible.
    // gateway_reference is UNIQUE NOT NULL.
    psql(`
      INSERT INTO payments (id, booking_id, user_id, amount, currency, gateway_reference, gateway_status, status)
      VALUES ('${PAY_SUCCESS_BK}', '${BK_PENDING_PAID}', '${USER_A}', 5000, 'NGN', 'PAY-NAV-001', 'success', 'success')
      ON CONFLICT (id) DO NOTHING;
    `);
    psql(`
      INSERT INTO payments (id, booking_id, user_id, amount, currency, gateway_reference, gateway_status, status)
      VALUES ('${PAY_PENDING_BK}', '${BK_PENDING_PEND_PAY}', '${USER_A}', 5000, 'NGN', 'PAY-NAV-003', 'pending', 'pending')
      ON CONFLICT (id) DO NOTHING;
    `);
    psql(`
      INSERT INTO payments (id, booking_id, user_id, amount, currency, gateway_reference, gateway_status, status, finalization_processing_at)
      VALUES ('${PAY_FINALIZING_BK}', '${BK_PENDING_FINALIZ}', '${USER_A}', 5000, 'NGN', 'PAY-NAV-002', 'pending', 'pending', NOW())
      ON CONFLICT (id) DO NOTHING;
    `);
    psql(`
      INSERT INTO payments (id, reservation_id, user_id, amount, currency, gateway_reference, gateway_status, status)
      VALUES ('${PAY_SUCCESS_RV}', '${RV_PENDING_PAID}', '${USER_A}', 5000, 'NGN', 'PAY-NAV-004', 'success', 'success')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  it('fixtures seeded correctly', () => {
    const bkCount = psql(`SELECT COUNT(*) FROM bookings WHERE id IN ('${BK_PENDING_UNPAID}','${BK_PENDING_PAID}','${BK_PENDING_FINALIZ}','${BK_CONFIRMED}','${BK_WRONG_OWNER}','${BK_PENDING_PEND_PAY}')`);
    expect(Number(bkCount)).toBe(6);
    const rvCount = psql(`SELECT COUNT(*) FROM reservations WHERE id IN ('${RV_PENDING_UNPAID}','${RV_PENDING_PAID}','${RV_CONFIRMED}','${RV_WRONG_OWNER}')`);
    expect(Number(rvCount)).toBe(4);
    const payCount = psql(`SELECT COUNT(*) FROM payments WHERE id IN ('${PAY_SUCCESS_BK}','${PAY_FINALIZING_BK}','${PAY_PENDING_BK}','${PAY_SUCCESS_RV}')`);
    expect(Number(payCount)).toBe(4);
  });
});

// ── RPC existence and grants ──

describe.skipIf(!canRun)('M471: RPC existence and grants', () => {
  it('cancel_pending_booking_for_navigation is SECURITY DEFINER with safe search_path', () => {
    const result = psql(`
      SELECT prosecdef, proconfig FROM pg_proc
      WHERE proname = 'cancel_pending_booking_for_navigation' AND pronamespace = 'public'::regnamespace;
    `);
    expect(result).toContain('t'); // SECURITY DEFINER
    expect(result).toContain('search_path=public');
  });

  it('cancel_pending_reservation_for_navigation is SECURITY DEFINER with safe search_path', () => {
    const result = psql(`
      SELECT prosecdef, proconfig FROM pg_proc
      WHERE proname = 'cancel_pending_reservation_for_navigation' AND pronamespace = 'public'::regnamespace;
    `);
    expect(result).toContain('t');
    expect(result).toContain('search_path=public');
  });

  it('booking RPC: service_role can execute, anon/authenticated cannot', () => {
    expect(psql(`SELECT has_function_privilege('service_role', 'public.cancel_pending_booking_for_navigation(uuid,uuid)', 'EXECUTE')`)).toBe('t');
    expect(psql(`SELECT has_function_privilege('anon', 'public.cancel_pending_booking_for_navigation(uuid,uuid)', 'EXECUTE')`)).toBe('f');
    expect(psql(`SELECT has_function_privilege('authenticated', 'public.cancel_pending_booking_for_navigation(uuid,uuid)', 'EXECUTE')`)).toBe('f');
  });

  it('reservation RPC: service_role can execute, anon/authenticated cannot', () => {
    expect(psql(`SELECT has_function_privilege('service_role', 'public.cancel_pending_reservation_for_navigation(uuid,uuid)', 'EXECUTE')`)).toBe('t');
    expect(psql(`SELECT has_function_privilege('anon', 'public.cancel_pending_reservation_for_navigation(uuid,uuid)', 'EXECUTE')`)).toBe('f');
    expect(psql(`SELECT has_function_privilege('authenticated', 'public.cancel_pending_reservation_for_navigation(uuid,uuid)', 'EXECUTE')`)).toBe('f');
  });
});

// ── Booking cancellation: payment safety ──

describe.skipIf(!canRun)('M471: Booking payment-safe cancellation', () => {
  it('cancels pending unpaid booking', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_booking_for_navigation('${BK_PENDING_UNPAID}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(true);
    // Verify the booking is actually cancelled in DB
    const status = psql(`SELECT status FROM bookings WHERE id = '${BK_PENDING_UNPAID}'`);
    expect(status).toBe('cancelled');
  });

  it('preserves pending booking with successful payment', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_booking_for_navigation('${BK_PENDING_PAID}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('has_successful_payment');
    // Booking still pending
    const status = psql(`SELECT status FROM bookings WHERE id = '${BK_PENDING_PAID}'`);
    expect(status).toBe('pending');
  });

  it('preserves pending booking with active finalization (processing within 5 min)', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_booking_for_navigation('${BK_PENDING_FINALIZ}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('has_successful_payment');
    const status = psql(`SELECT status FROM bookings WHERE id = '${BK_PENDING_FINALIZ}'`);
    expect(status).toBe('pending');
  });

  it('preserves confirmed booking (not_pending)', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_booking_for_navigation('${BK_CONFIRMED}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_pending');
    expect(result.status).toBe('confirmed');
  });

  it('rejects wrong owner', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_booking_for_navigation('${BK_WRONG_OWNER}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_owner');
    // Booking still pending — not modified
    const status = psql(`SELECT status FROM bookings WHERE id = '${BK_WRONG_OWNER}'`);
    expect(status).toBe('pending');
  });

  it('cancels pending booking with only pending payments (no success, no finalization)', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_booking_for_navigation('${BK_PENDING_PEND_PAY}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(true);
    const status = psql(`SELECT status FROM bookings WHERE id = '${BK_PENDING_PEND_PAY}'`);
    expect(status).toBe('cancelled');
  });

  it('handles NULL params', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_booking_for_navigation(NULL, NULL);`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('missing_params');
  });

  it('handles nonexistent booking', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_booking_for_navigation('${NONEXIST}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('idempotency: re-cancelling returns not_pending', () => {
    // BK_PENDING_UNPAID was cancelled in the first test
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_booking_for_navigation('${BK_PENDING_UNPAID}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_pending');
    expect(result.status).toBe('cancelled');
  });
});

// ── Reservation cancellation: payment safety ──

describe.skipIf(!canRun)('M471: Reservation payment-safe cancellation', () => {
  it('cancels pending unpaid reservation', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_reservation_for_navigation('${RV_PENDING_UNPAID}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(true);
    const status = psql(`SELECT status FROM reservations WHERE id = '${RV_PENDING_UNPAID}'`);
    expect(status).toBe('cancelled');
  });

  it('preserves pending reservation with successful payment', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_reservation_for_navigation('${RV_PENDING_PAID}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('has_successful_payment');
    const status = psql(`SELECT status FROM reservations WHERE id = '${RV_PENDING_PAID}'`);
    expect(status).toBe('pending');
  });

  it('preserves confirmed reservation (not_pending)', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_reservation_for_navigation('${RV_CONFIRMED}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_pending');
    expect(result.status).toBe('confirmed');
  });

  it('rejects wrong owner', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_reservation_for_navigation('${RV_WRONG_OWNER}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_owner');
    const status = psql(`SELECT status FROM reservations WHERE id = '${RV_WRONG_OWNER}'`);
    expect(status).toBe('pending');
  });

  it('handles NULL params', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_reservation_for_navigation(NULL, NULL);`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('missing_params');
  });

  it('handles nonexistent reservation', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_reservation_for_navigation('${NONEXIST}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('idempotency: re-cancelling returns not_pending', () => {
    const raw = psql(`SET ROLE service_role; SELECT cancel_pending_reservation_for_navigation('${RV_PENDING_UNPAID}', '${USER_A}');`);
    const result = JSON.parse(raw);
    expect(result.cancelled).toBe(false);
    expect(result.reason).toBe('not_pending');
    expect(result.status).toBe('cancelled');
  });
});
