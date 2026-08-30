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
      INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data, aud, role, instance_id, created_at, updated_at)
      VALUES
        ('${OWNER_A}', 'owner-a-225@test.local', '{"provider":"email"}', '{}', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', now(), now()),
        ('${OWNER_B}', 'owner-b-225@test.local', '{"provider":"email"}', '{}', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', now(), now()),
        ('${CUSTOMER_USER}', 'customer-225@test.local', '{"provider":"email"}', '{}', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', now(), now());

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

  // ── Profiles RLS proof: business owner cannot read customer profiles table ──

  it('profiles RLS blocks cross-user SELECT (the exact #226 root cause)', () => {
    const result = runSQL(`
      SET LOCAL role = 'authenticated';
      SET LOCAL request.jwt.claims = '{"sub":"${OWNER_A}"}';
      SELECT COUNT(*) FROM public.profiles WHERE id = '${CUSTOMER_USER}';
    `);
    const count = result.split('\n').pop()?.trim();
    expect(count).toBe('0');
  });
});

} // end if(dbUrl)
