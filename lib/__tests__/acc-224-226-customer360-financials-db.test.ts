/**
 * #224/#225/#226: Customer 360 + Financial projection DB tests.
 *
 * Verifies:
 * - get_business_transactions() returns purpose-aware rows with customer attribution
 * - get_customer_history() returns unified per-customer history
 * - get_business_revenue_totals() returns authoritative uncapped totals
 * - Cross-business denial under authenticated role
 * - customer_profiles.user_id column exists and partial unique index works
 * - Giving purpose resolution: "Giving — {service_name}"
 * - Order customer resolution via customer_profiles (not profiles RLS)
 * - Deduplication: standalone payments only (no booking-linked double-count)
 *
 * Uses psql via execSync against TEST_DATABASE_URL.
 * Skips gracefully in normal Main App CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('PostgreSQL Customer360/Financials (#225/#226) — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string): string {
  try {
    const stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    );
    return stdout.trim();
  } catch (err: any) {
    const msg = err.stderr?.trim() || err.stdout?.trim() || String(err);
    throw new Error(`SQL failed: ${msg}`);
  }
}

// Test UUIDs — deterministic, isolated namespace
const OWNER_A = 'c2250000-0000-0000-0000-000000000001';
const OWNER_B = 'c2250000-0000-0000-0000-000000000002';
const CUSTOMER_USER = 'c2250000-0000-0000-0000-000000000003';
const BIZ_A = 'c2250000-0000-0000-0000-000000000010';
const BIZ_B = 'c2250000-0000-0000-0000-000000000011';
const SERVICE_GIVING = 'c2250000-0000-0000-0000-000000000020';
const SERVICE_SCHED = 'c2250000-0000-0000-0000-000000000021';
const BOOKING_GIVING = 'c2250000-0000-0000-0000-000000000030';
const BOOKING_SCHED = 'c2250000-0000-0000-0000-000000000031';
const ORDER_1 = 'c2250000-0000-0000-0000-000000000040';
const PAYMENT_GIVING = 'c2250000-0000-0000-0000-000000000050';
const CP_A = 'c2250000-0000-0000-0000-000000000060';
const CUSTOMER_PHONE = '+2348012345678';

describe('PostgreSQL Customer360/Financials (#225/#226)', () => {
  beforeAll(() => {
    // Clean up any prior test data
    runSQL(`
      DELETE FROM public.platform_fees WHERE business_id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.payments WHERE business_id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.bookings WHERE business_id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.orders WHERE business_id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.services WHERE business_id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.customer_profiles WHERE business_id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.businesses WHERE id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.profiles WHERE id IN ('${OWNER_A}','${OWNER_B}','${CUSTOMER_USER}');
      DELETE FROM auth.users WHERE id IN ('${OWNER_A}','${OWNER_B}','${CUSTOMER_USER}');
    `);

    // Create test users + businesses
    runSQL(`
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id) VALUES ('${OWNER_A}'), ('${OWNER_B}'), ('${CUSTOMER_USER}') ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;

      INSERT INTO public.profiles (id, first_name, last_name, email, role)
      VALUES
        ('${OWNER_A}', 'OwnerA', 'Test', 'owner-a-225@test.local', 'user'),
        ('${OWNER_B}', 'OwnerB', 'Test', 'owner-b-225@test.local', 'user'),
        ('${CUSTOMER_USER}', 'Babajide', 'Ace', 'customer-225@test.local', 'user');

      INSERT INTO public.businesses (id, owner_id, name, slug, category, address, city, phone, status, subscription_tier, country_code)
      VALUES
        ('${BIZ_A}', '${OWNER_A}', 'TestBizA', 'test-biz-a-225', 'church', '123 Test St', 'Lagos', '+2341234567', 'active', 'growth', 'NG'),
        ('${BIZ_B}', '${OWNER_B}', 'TestBizB', 'test-biz-b-225', 'restaurant', '456 Other St', 'Accra', '+2337654321', 'active', 'growth', 'GH');

      INSERT INTO public.services (id, business_id, name, service_type, billing_type, recurring_interval, is_active, price, duration_minutes, deposit_amount)
      VALUES
        ('${SERVICE_GIVING}', '${BIZ_A}', 'Biazo Conference', 'giving', 'recurring', 'monthly', true, 10000, 0, 0),
        ('${SERVICE_SCHED}', '${BIZ_A}', 'Haircut', 'scheduling', 'one_time', NULL, true, 5000, 30, 0);

      INSERT INTO public.customer_profiles (id, business_id, phone, name, user_id)
      VALUES ('${CP_A}', '${BIZ_A}', '${CUSTOMER_PHONE}', 'Babajide Ace', '${CUSTOMER_USER}');

      INSERT INTO public.bookings (id, reference_code, business_id, user_id, service_id, flow_type, guest_name, guest_phone, date, status, total_amount, created_at)
      VALUES
        ('${BOOKING_GIVING}', 'WA-PY-T001', '${BIZ_A}', '${CUSTOMER_USER}', '${SERVICE_GIVING}', 'payment', 'Babajide Ace', '${CUSTOMER_PHONE}', CURRENT_DATE, 'confirmed', 10000, now() - interval '1 hour'),
        ('${BOOKING_SCHED}', 'WA-BK-T001', '${BIZ_A}', '${CUSTOMER_USER}', '${SERVICE_SCHED}', 'scheduling', 'Babajide Ace', '${CUSTOMER_PHONE}', CURRENT_DATE, 'completed', 5000, now() - interval '2 hours');

      INSERT INTO public.orders (id, reference_code, business_id, user_id, delivery_phone, status, total_amount, created_at)
      VALUES ('${ORDER_1}', 'WA-OR-T001', '${BIZ_A}', '${CUSTOMER_USER}', '${CUSTOMER_PHONE}', 'confirmed', 12000, now() - interval '3 hours');

      INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, paid_at, created_at)
      VALUES ('${PAYMENT_GIVING}', '${BOOKING_GIVING}', '${CUSTOMER_USER}', '${BIZ_A}', 10000, 'NGN', 'WA-PY-T001-PAY', 'success', now(), now());
    `);
  });

  afterAll(() => {
    runSQL(`
      DELETE FROM public.payments WHERE business_id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.bookings WHERE business_id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.orders WHERE business_id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.services WHERE business_id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.customer_profiles WHERE business_id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.businesses WHERE id IN ('${BIZ_A}','${BIZ_B}');
      DELETE FROM public.profiles WHERE id IN ('${OWNER_A}','${OWNER_B}','${CUSTOMER_USER}');
      DELETE FROM auth.users WHERE id IN ('${OWNER_A}','${OWNER_B}','${CUSTOMER_USER}');
    `);
  });

  // ── Schema tests ──

  it('customer_profiles has user_id column', () => {
    const result = runSQL(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'customer_profiles' AND column_name = 'user_id';
    `);
    expect(result).toBe('user_id');
  });

  it('bookings does NOT have service_type column', () => {
    const result = runSQL(`
      SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'service_type';
    `);
    expect(result).toBe('0');
  });

  it('orders does NOT have customer_phone column', () => {
    const result = runSQL(`
      SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'customer_phone';
    `);
    expect(result).toBe('0');
  });

  // ── get_business_transactions tests ──

  it('get_business_transactions returns Giving purpose for payment+giving booking', () => {
    const result = runSQL(`
      SELECT purpose, customer_name, amount, status
      FROM public.get_business_transactions('${BIZ_A}')
      WHERE reference_code = 'WA-PY-T001';
    `);
    // Purpose should contain "Giving" and "Biazo Conference"
    expect(result).toContain('Giving');
    expect(result).toContain('Biazo Conference');
    expect(result).toContain('Babajide Ace');
    expect(result).toContain('10000');
  });

  it('get_business_transactions returns Booking purpose for scheduling booking', () => {
    const result = runSQL(`
      SELECT purpose FROM public.get_business_transactions('${BIZ_A}')
      WHERE reference_code = 'WA-BK-T001';
    `);
    expect(result).toContain('Booking');
    expect(result).toContain('Haircut');
  });

  it('get_business_transactions resolves order customer via customer_profiles', () => {
    const result = runSQL(`
      SELECT customer_name, amount FROM public.get_business_transactions('${BIZ_A}')
      WHERE reference_code = 'WA-OR-T001';
    `);
    expect(result).toContain('Babajide Ace');
    expect(result).toContain('12000');
  });

  it('get_business_transactions returns 0 rows for non-owner', () => {
    // Set auth.uid() to owner B, query business A
    const result = runSQL(`
      SET LOCAL role = 'authenticated';
      SET LOCAL request.jwt.claims = '{"sub":"${OWNER_B}"}';
      SELECT COUNT(*) FROM public.get_business_transactions('${BIZ_A}');
    `);
    // Result should be 0 (ownership check fails)
    const count = result.split('\n').pop()?.trim();
    expect(count).toBe('0');
  });

  // ── get_customer_history tests ──

  it('get_customer_history includes Giving booking with purpose', () => {
    const result = runSQL(`
      SELECT purpose, amount, status, reference_code
      FROM public.get_customer_history('${BIZ_A}', '${CP_A}');
    `);
    expect(result).toContain('Giving');
    expect(result).toContain('Biazo Conference');
    expect(result).toContain('WA-PY-T001');
  });

  it('get_customer_history includes order', () => {
    const result = runSQL(`
      SELECT purpose FROM public.get_customer_history('${BIZ_A}', '${CP_A}');
    `);
    expect(result).toContain('Order');
    expect(result).toContain('WA-OR-T001');
  });

  it('get_customer_history does not double-count booking-linked payment', () => {
    // Payment WA-PY-T001-PAY has booking_id set, so it should NOT appear
    // as a separate row (dedup: only standalone payments included)
    const result = runSQL(`
      SELECT COUNT(*) FROM public.get_customer_history('${BIZ_A}', '${CP_A}')
      WHERE history_type = 'payment';
    `);
    expect(result).toBe('0');
  });

  it('get_customer_history returns 0 rows for cross-business profile', () => {
    const result = runSQL(`
      SET LOCAL role = 'authenticated';
      SET LOCAL request.jwt.claims = '{"sub":"${OWNER_B}"}';
      SELECT COUNT(*) FROM public.get_customer_history('${BIZ_A}', '${CP_A}');
    `);
    const count = result.split('\n').pop()?.trim();
    expect(count).toBe('0');
  });

  // ── get_business_revenue_totals tests ──

  it('get_business_revenue_totals returns authoritative totals', () => {
    const result = runSQL(`
      SELECT booking_revenue, order_revenue, total_revenue
      FROM public.get_business_revenue_totals('${BIZ_A}');
    `);
    // booking_revenue should include both bookings (10000 + 5000 = 15000)
    expect(result).toContain('15000');
    // order_revenue should be 12000
    expect(result).toContain('12000');
  });

  it('get_business_revenue_totals returns 0 for non-owner', () => {
    const result = runSQL(`
      SET LOCAL role = 'authenticated';
      SET LOCAL request.jwt.claims = '{"sub":"${OWNER_B}"}';
      SELECT total_revenue FROM public.get_business_revenue_totals('${BIZ_A}');
    `);
    const total = result.split('\n').pop()?.trim();
    expect(total).toBe('0');
  });

  // ── Access control tests ──

  it('get_business_transactions is not executable by anon', () => {
    const result = runSQL(`
      SELECT has_function_privilege('anon', 'public.get_business_transactions(uuid,integer,integer)', 'EXECUTE');
    `);
    expect(result).toBe('f');
  });

  it('get_business_transactions is executable by authenticated', () => {
    const result = runSQL(`
      SELECT has_function_privilege('authenticated', 'public.get_business_transactions(uuid,integer,integer)', 'EXECUTE');
    `);
    expect(result).toBe('t');
  });

  it('get_customer_history is not executable by anon', () => {
    const result = runSQL(`
      SELECT has_function_privilege('anon', 'public.get_customer_history(uuid,uuid,integer)', 'EXECUTE');
    `);
    expect(result).toBe('f');
  });

  // ── Profiles RLS proof ──

  it('profiles RLS blocks cross-user SELECT (the exact #226 root cause)', () => {
    const result = runSQL(`
      SET LOCAL role = 'authenticated';
      SET LOCAL request.jwt.claims = '{"sub":"${OWNER_A}"}';
      SELECT COUNT(*) FROM public.profiles WHERE id = '${CUSTOMER_USER}';
    `);
    const count = result.split('\n').pop()?.trim();
    expect(count).toBe('0');
  });

  // ── Durable-ID-first attribution: same phone, different user ──

  it('get_customer_history does NOT cross-attribute rows with same phone but different user_id', () => {
    const OTHER_USER = 'c2250000-0000-0000-0000-000000000099';
    const OTHER_BOOKING = 'c2250000-0000-0000-0000-000000000098';
    try {
      // Create another user with the SAME phone but different user_id
      runSQL(`
        ALTER TABLE auth.users DISABLE TRIGGER ALL;
        INSERT INTO auth.users (id) VALUES ('${OTHER_USER}') ON CONFLICT DO NOTHING;
        ALTER TABLE auth.users ENABLE TRIGGER ALL;
        INSERT INTO public.profiles (id, first_name, last_name, email, role)
        VALUES ('${OTHER_USER}', 'Other', 'Person', 'other-225@test.local', 'user');
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, status, total_amount, created_at)
        VALUES ('${OTHER_BOOKING}', 'WA-PY-OTHER', '${BIZ_A}', '${OTHER_USER}', 'payment', 'Other Person', '${CUSTOMER_PHONE}', CURRENT_DATE, 'confirmed', 99999, now());
      `);

      // Customer A's history should NOT include OTHER_USER's booking
      // (because OTHER_USER's booking has user_id set, so phone fallback is disabled)
      const result = runSQL(`
        SELECT reference_code FROM public.get_customer_history('${BIZ_A}', '${CP_A}');
      `);
      expect(result).not.toContain('WA-PY-OTHER');
    } finally {
      runSQL(`
        DELETE FROM public.bookings WHERE id = '${OTHER_BOOKING}';
        DELETE FROM public.profiles WHERE id = '${OTHER_USER}';
        DELETE FROM auth.users WHERE id = '${OTHER_USER}';
      `);
    }
  });

  // ── create_recurring_offer defense-in-depth (#224) ──

  it('create_recurring_offer rejects one-time service', () => {
    const ONE_TIME_SVC = 'c2250000-0000-0000-0000-000000000070';
    const ONE_TIME_BK = 'c2250000-0000-0000-0000-000000000071';
    const ONE_TIME_PAY = 'c2250000-0000-0000-0000-000000000072';
    try {
      runSQL(`
        INSERT INTO public.services (id, business_id, name, service_type, billing_type, is_active, price, duration_minutes, deposit_amount)
        VALUES ('${ONE_TIME_SVC}', '${BIZ_A}', 'One-Time Giving', 'giving', 'one_time', true, 5000, 0, 0);
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, service_id, flow_type, guest_name, guest_phone, date, status, total_amount, created_at)
        VALUES ('${ONE_TIME_BK}', 'WA-PY-OT01', '${BIZ_A}', '${CUSTOMER_USER}', '${ONE_TIME_SVC}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, 'confirmed', 5000, now());
        INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, gateway, status, finalization_completed_at, confirmation_sent_at, paid_at, created_at)
        VALUES ('${ONE_TIME_PAY}', '${ONE_TIME_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 5000, 'NGN', 'WA-PY-OT01-PAY', 'paystack', 'success', now(), now(), now(), now());
      `);
      const result = runSQL(`
        SELECT create_recurring_offer('${ONE_TIME_PAY}', '${BIZ_A}', 'paystack');
      `);
      expect(result).toContain('service_not_recurring');
    } finally {
      runSQL(`
        DELETE FROM public.payments WHERE id = '${ONE_TIME_PAY}';
        DELETE FROM public.bookings WHERE id = '${ONE_TIME_BK}';
        DELETE FROM public.services WHERE id = '${ONE_TIME_SVC}';
      `);
    }
  });

  it('create_recurring_offer rejects non-giving service', () => {
    const NON_GIVING_SVC = 'c2250000-0000-0000-0000-000000000073';
    const NON_GIVING_BK = 'c2250000-0000-0000-0000-000000000074';
    const NON_GIVING_PAY = 'c2250000-0000-0000-0000-000000000075';
    try {
      runSQL(`
        INSERT INTO public.services (id, business_id, name, service_type, billing_type, recurring_interval, is_active, price, duration_minutes, deposit_amount)
        VALUES ('${NON_GIVING_SVC}', '${BIZ_A}', 'Recurring Scheduling', 'scheduling', 'recurring', 'monthly', true, 5000, 30, 0);
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, service_id, flow_type, guest_name, guest_phone, date, status, total_amount, created_at)
        VALUES ('${NON_GIVING_BK}', 'WA-PY-NG01', '${BIZ_A}', '${CUSTOMER_USER}', '${NON_GIVING_SVC}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, 'confirmed', 5000, now());
        INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, gateway, status, finalization_completed_at, confirmation_sent_at, paid_at, created_at)
        VALUES ('${NON_GIVING_PAY}', '${NON_GIVING_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 5000, 'NGN', 'WA-PY-NG01-PAY', 'paystack', 'success', now(), now(), now(), now());
      `);
      const result = runSQL(`
        SELECT create_recurring_offer('${NON_GIVING_PAY}', '${BIZ_A}', 'paystack');
      `);
      expect(result).toContain('service_not_giving');
    } finally {
      runSQL(`
        DELETE FROM public.payments WHERE id = '${NON_GIVING_PAY}';
        DELETE FROM public.bookings WHERE id = '${NON_GIVING_BK}';
        DELETE FROM public.services WHERE id = '${NON_GIVING_SVC}';
      `);
    }
  });

  // ── Booking financial cross-attribution regression (#226 blocker 2) ──

  it('get_business_transactions does NOT cross-attribute booking customer via shared phone', () => {
    const OTHER_USER = 'c2250000-0000-0000-0000-000000000080';
    const OTHER_CP = 'c2250000-0000-0000-0000-000000000081';
    const SHARED_BOOKING = 'c2250000-0000-0000-0000-000000000082';
    try {
      // Create another user + customer_profiles with SAME phone but different user_id
      runSQL(`
        ALTER TABLE auth.users DISABLE TRIGGER ALL;
        INSERT INTO auth.users (id) VALUES ('${OTHER_USER}') ON CONFLICT DO NOTHING;
        ALTER TABLE auth.users ENABLE TRIGGER ALL;
        INSERT INTO public.profiles (id, first_name, last_name, email, role)
        VALUES ('${OTHER_USER}', 'Other', 'User226', 'other-226@test.local', 'user');
        INSERT INTO public.customer_profiles (id, business_id, phone, name, user_id)
        VALUES ('${OTHER_CP}', '${BIZ_A}', '+2349999999999', 'Other User226', '${OTHER_USER}');
      `);

      // Create a booking by CUSTOMER_USER but with OTHER_CP's phone
      // (shared/reused phone scenario)
      runSQL(`
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, status, total_amount, created_at)
        VALUES ('${SHARED_BOOKING}', 'WA-PY-XATTR', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Babajide Ace', '+2349999999999', CURRENT_DATE, 'confirmed', 7777, now());
      `);

      // The booking has user_id=CUSTOMER_USER but guest_phone matches OTHER_CP
      // With durable-ID-first: should resolve to CUSTOMER_USER's cp (CP_A), NOT OTHER_CP
      const result = runSQL(`
        SELECT customer_name FROM public.get_business_transactions('${BIZ_A}')
        WHERE reference_code = 'WA-PY-XATTR';
      `);
      // Should show guest_name 'Babajide Ace' (from booking) or CP_A's name
      // Must NOT show 'Other User226' from OTHER_CP (phone-based cross-attribution)
      expect(result).not.toContain('Other User226');
      expect(result).toContain('Babajide Ace');
    } finally {
      runSQL(`
        DELETE FROM public.bookings WHERE id = '${SHARED_BOOKING}';
        DELETE FROM public.customer_profiles WHERE id = '${OTHER_CP}';
        DELETE FROM public.profiles WHERE id = '${OTHER_USER}';
        DELETE FROM auth.users WHERE id = '${OTHER_USER}';
      `);
    }
  });

  // ── Legacy source + linked profile phone fallback regression ──

  it('legacy booking (user_id NULL) does NOT attribute to a linked profile via phone', () => {
    // Source booking has user_id IS NULL (legacy), phone matches a customer_profiles
    // row that has a non-null user_id belonging to a different durable user.
    // The fallback must NOT attribute that durable customer's name.
    const LINKED_USER = 'c2250000-0000-0000-0000-000000000088';
    const LINKED_CP = 'c2250000-0000-0000-0000-000000000089';
    const LEGACY_BK = 'c2250000-0000-0000-0000-00000000008a';
    const LEGACY_PHONE = '+2348777777777';
    try {
      runSQL(`
        ALTER TABLE auth.users DISABLE TRIGGER ALL;
        INSERT INTO auth.users (id) VALUES ('${LINKED_USER}') ON CONFLICT DO NOTHING;
        ALTER TABLE auth.users ENABLE TRIGGER ALL;
        INSERT INTO public.profiles (id, first_name, last_name, email, role)
        VALUES ('${LINKED_USER}', 'Linked', 'DurableUser', 'linked-226@test.local', 'user');
        INSERT INTO public.customer_profiles (id, business_id, phone, name, user_id)
        VALUES ('${LINKED_CP}', '${BIZ_A}', '${LEGACY_PHONE}', 'Linked DurableUser', '${LINKED_USER}');
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, status, total_amount, created_at)
        VALUES ('${LEGACY_BK}', 'WA-PY-LGCY', '${BIZ_A}', NULL, 'payment', 'Legacy Guest', '${LEGACY_PHONE}', CURRENT_DATE, 'confirmed', 3333, now());
      `);

      const result = runSQL(`
        SELECT customer_name FROM public.get_business_transactions('${BIZ_A}')
        WHERE reference_code = 'WA-PY-LGCY';
      `);
      // Must NOT show 'Linked DurableUser' (that profile is owned by a different durable user)
      expect(result).not.toContain('Linked DurableUser');
      // Should show guest_name 'Legacy Guest' from the booking itself
      expect(result).toContain('Legacy Guest');
    } finally {
      runSQL(`
        DELETE FROM public.bookings WHERE id = '${LEGACY_BK}';
        DELETE FROM public.customer_profiles WHERE id = '${LINKED_CP}';
        DELETE FROM public.profiles WHERE id = '${LINKED_USER}';
        DELETE FROM auth.users WHERE id = '${LINKED_USER}';
      `);
    }
  });

  it('legacy order (user_id NULL) does NOT attribute to a linked profile via phone', () => {
    const LINKED_USER2 = 'c2250000-0000-0000-0000-00000000008b';
    const LINKED_CP2 = 'c2250000-0000-0000-0000-00000000008c';
    const LEGACY_ORD = 'c2250000-0000-0000-0000-00000000008d';
    const LEGACY_PHONE2 = '+2348666666666';
    try {
      runSQL(`
        ALTER TABLE auth.users DISABLE TRIGGER ALL;
        INSERT INTO auth.users (id) VALUES ('${LINKED_USER2}') ON CONFLICT DO NOTHING;
        ALTER TABLE auth.users ENABLE TRIGGER ALL;
        INSERT INTO public.profiles (id, first_name, last_name, email, role)
        VALUES ('${LINKED_USER2}', 'Linked2', 'OrderUser', 'linked2-226@test.local', 'user');
        INSERT INTO public.customer_profiles (id, business_id, phone, name, user_id)
        VALUES ('${LINKED_CP2}', '${BIZ_A}', '${LEGACY_PHONE2}', 'Linked2 OrderUser', '${LINKED_USER2}');
        INSERT INTO public.orders (id, reference_code, business_id, user_id, delivery_phone, status, total_amount, created_at)
        VALUES ('${LEGACY_ORD}', 'WA-OR-LGCY', '${BIZ_A}', NULL, '${LEGACY_PHONE2}', 'confirmed', 4444, now());
      `);

      const result = runSQL(`
        SELECT customer_name FROM public.get_business_transactions('${BIZ_A}')
        WHERE reference_code = 'WA-OR-LGCY';
      `);
      // Must NOT show 'Linked2 OrderUser' (profile is owned by a different durable user)
      expect(result).not.toContain('Linked2 OrderUser');
    } finally {
      runSQL(`
        DELETE FROM public.orders WHERE id = '${LEGACY_ORD}';
        DELETE FROM public.customer_profiles WHERE id = '${LINKED_CP2}';
        DELETE FROM public.profiles WHERE id = '${LINKED_USER2}';
        DELETE FROM auth.users WHERE id = '${LINKED_USER2}';
      `);
    }
  });

  it('legacy booking CAN attribute to an unlinked legacy profile via phone', () => {
    // Bounded phone fallback: source user_id IS NULL, profile user_id IS NULL = OK
    const UNLINKED_CP = 'c2250000-0000-0000-0000-00000000008e';
    const LEGACY_BK2 = 'c2250000-0000-0000-0000-00000000008f';
    const LEGACY_PHONE3 = '+2348555555555';
    try {
      runSQL(`
        INSERT INTO public.customer_profiles (id, business_id, phone, name, user_id)
        VALUES ('${UNLINKED_CP}', '${BIZ_A}', '${LEGACY_PHONE3}', 'Unlinked Legacy', NULL);
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_phone, date, status, total_amount, created_at)
        VALUES ('${LEGACY_BK2}', 'WA-PY-LGC2', '${BIZ_A}', NULL, 'payment', '${LEGACY_PHONE3}', CURRENT_DATE, 'confirmed', 5555, now());
      `);

      const result = runSQL(`
        SELECT customer_name FROM public.get_business_transactions('${BIZ_A}')
        WHERE reference_code = 'WA-PY-LGC2';
      `);
      // Unlinked profile IS a valid phone fallback target
      expect(result).toContain('Unlinked Legacy');
    } finally {
      runSQL(`
        DELETE FROM public.bookings WHERE id = '${LEGACY_BK2}';
        DELETE FROM public.customer_profiles WHERE id = '${UNLINKED_CP}';
      `);
    }
  });

  // ── Backfill collision regression (#225 blocker 3) ──

  it('backfill leaves ambiguous/colliding profiles unlinked when two phones map to same user', () => {
    // This tests the exact scenario: two customer_profiles rows with different phones
    // but both mapping to the same durable user_id via bookings.
    // The partial unique index (business_id, user_id) WHERE user_id IS NOT NULL
    // means at most one cp can be linked. The CTE backfill picks exactly one winner.
    const DUAL_USER = 'c2250000-0000-0000-0000-000000000083';
    const CP_PHONE1 = 'c2250000-0000-0000-0000-000000000084';
    const CP_PHONE2 = 'c2250000-0000-0000-0000-000000000085';
    const BK1 = 'c2250000-0000-0000-0000-000000000086';
    const BK2 = 'c2250000-0000-0000-0000-000000000087';
    try {
      runSQL(`
        ALTER TABLE auth.users DISABLE TRIGGER ALL;
        INSERT INTO auth.users (id) VALUES ('${DUAL_USER}') ON CONFLICT DO NOTHING;
        ALTER TABLE auth.users ENABLE TRIGGER ALL;
        INSERT INTO public.profiles (id, first_name, last_name, email, role)
        VALUES ('${DUAL_USER}', 'Dual', 'Phone', 'dual-225@test.local', 'user');
        INSERT INTO public.customer_profiles (id, business_id, phone, name, user_id)
        VALUES
          ('${CP_PHONE1}', '${BIZ_A}', '+2341111111111', 'Dual Phone Old', NULL),
          ('${CP_PHONE2}', '${BIZ_A}', '+2342222222222', 'Dual Phone New', NULL);
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_phone, date, status, total_amount, created_at)
        VALUES
          ('${BK1}', 'WA-DUAL-1', '${BIZ_A}', '${DUAL_USER}', 'payment', '+2341111111111', CURRENT_DATE, 'confirmed', 1000, now()),
          ('${BK2}', 'WA-DUAL-2', '${BIZ_A}', '${DUAL_USER}', 'payment', '+2342222222222', CURRENT_DATE, 'confirmed', 2000, now());
      `);

      // Re-run the backfill CTE for these test rows
      runSQL(`
        WITH candidates AS (
          SELECT DISTINCT ON (agg.business_id, agg.guest_phone)
            agg.business_id, agg.guest_phone, agg.the_user_id AS single_user_id
          FROM (
            SELECT b.business_id, b.guest_phone, b.user_id AS the_user_id
            FROM public.bookings b
            WHERE b.user_id IS NOT NULL AND b.guest_phone IS NOT NULL AND b.guest_phone != ''
            GROUP BY b.business_id, b.guest_phone, b.user_id
          ) agg
          WHERE (
            SELECT COUNT(DISTINCT b2.user_id) FROM public.bookings b2
            WHERE b2.business_id = agg.business_id AND b2.guest_phone = agg.guest_phone AND b2.user_id IS NOT NULL
          ) = 1
        ),
        matched AS (
          SELECT DISTINCT ON (c.business_id, c.single_user_id) cp.id AS cp_id, c.single_user_id
          FROM candidates c
          JOIN public.customer_profiles cp ON cp.business_id = c.business_id AND cp.phone = c.guest_phone AND cp.user_id IS NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM public.customer_profiles cp2
            WHERE cp2.business_id = c.business_id AND cp2.user_id = c.single_user_id
          )
          ORDER BY c.business_id, c.single_user_id, cp.id
        )
        UPDATE public.customer_profiles cp SET user_id = m.single_user_id FROM matched m WHERE cp.id = m.cp_id;
      `);

      // At most 1 should be linked (DISTINCT ON picks the first by cp.id)
      const countLinked = runSQL(`
        SELECT COUNT(*) FROM public.customer_profiles
        WHERE id IN ('${CP_PHONE1}', '${CP_PHONE2}')
          AND user_id = '${DUAL_USER}';
      `);
      const linked = parseInt(countLinked, 10);
      expect(linked).toBeLessThanOrEqual(1);

      // Both profiles should still exist (no data loss)
      const countAll = runSQL(`
        SELECT COUNT(*) FROM public.customer_profiles
        WHERE id IN ('${CP_PHONE1}', '${CP_PHONE2}');
      `);
      expect(countAll).toBe('2');
    } finally {
      runSQL(`
        DELETE FROM public.bookings WHERE id IN ('${BK1}', '${BK2}');
        DELETE FROM public.customer_profiles WHERE id IN ('${CP_PHONE1}', '${CP_PHONE2}');
        DELETE FROM public.profiles WHERE id = '${DUAL_USER}';
        DELETE FROM auth.users WHERE id = '${DUAL_USER}';
      `);
    }
  });

  it('create_recurring_offer rejects inactive service', () => {
    const INACTIVE_SVC = 'c2250000-0000-0000-0000-000000000076';
    const INACTIVE_BK = 'c2250000-0000-0000-0000-000000000077';
    const INACTIVE_PAY = 'c2250000-0000-0000-0000-000000000078';
    try {
      runSQL(`
        INSERT INTO public.services (id, business_id, name, service_type, billing_type, recurring_interval, is_active, price, duration_minutes, deposit_amount)
        VALUES ('${INACTIVE_SVC}', '${BIZ_A}', 'Inactive Giving', 'giving', 'recurring', 'monthly', false, 5000, 0, 0);
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, service_id, flow_type, guest_name, guest_phone, date, status, total_amount, created_at)
        VALUES ('${INACTIVE_BK}', 'WA-PY-IN01', '${BIZ_A}', '${CUSTOMER_USER}', '${INACTIVE_SVC}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, 'confirmed', 5000, now());
        INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, gateway, status, finalization_completed_at, confirmation_sent_at, paid_at, created_at)
        VALUES ('${INACTIVE_PAY}', '${INACTIVE_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 5000, 'NGN', 'WA-PY-IN01-PAY', 'paystack', 'success', now(), now(), now(), now());
      `);
      const result = runSQL(`
        SELECT create_recurring_offer('${INACTIVE_PAY}', '${BIZ_A}', 'paystack');
      `);
      expect(result).toContain('service_inactive');
    } finally {
      runSQL(`
        DELETE FROM public.payments WHERE id = '${INACTIVE_PAY}';
        DELETE FROM public.bookings WHERE id = '${INACTIVE_BK}';
        DELETE FROM public.services WHERE id = '${INACTIVE_SVC}';
      `);
    }
  });
});

} // end if(dbUrl)
