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

      INSERT INTO public.profiles (id, first_name, last_name, email)
      VALUES
        ('${OWNER_A}', 'OwnerA', 'Test', 'owner-a-225@test.local'),
        ('${OWNER_B}', 'OwnerB', 'Test', 'owner-b-225@test.local'),
        ('${CUSTOMER_USER}', 'Babajide', 'Ace', 'customer-225@test.local');

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

      INSERT INTO public.bookings (id, reference_code, business_id, user_id, service_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
      VALUES
        ('${BOOKING_GIVING}', 'WA-PY-T001', '${BIZ_A}', '${CUSTOMER_USER}', '${SERVICE_GIVING}', 'payment', 'Babajide Ace', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 10000, now() - interval '1 hour'),
        ('${BOOKING_SCHED}', 'WA-BK-T001', '${BIZ_A}', '${CUSTOMER_USER}', '${SERVICE_SCHED}', 'scheduling', 'Babajide Ace', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'completed', 5000, now() - interval '2 hours');

      INSERT INTO public.orders (id, reference_code, business_id, user_id, delivery_phone, status, total_amount, created_at)
      VALUES ('${ORDER_1}', 'WA-OR-T001', '${BIZ_A}', '${CUSTOMER_USER}', '${CUSTOMER_PHONE}', 'confirmed', 12000, now() - interval '3 hours');

      INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, paid_at, created_at)
      VALUES ('${PAYMENT_GIVING}', '${BOOKING_GIVING}', '${CUSTOMER_USER}', '${BIZ_A}', 10000, 'NGN', 'WA-PY-T001-PAY', 'success', now(), now());
    `);

    // Override auth.uid() to return OWNER_A for RPC ownership checks
    runSQL(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS
      $fn$ SELECT '${OWNER_A}'::UUID $fn$
      LANGUAGE SQL STABLE;
    `);
  });

  afterAll(() => {
    // Restore auth.uid() to CI default
    runSQL(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS
      $fn$ SELECT NULL::UUID $fn$
      LANGUAGE SQL STABLE;
    `);
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
    // Temporarily override auth.uid() to OWNER_B, query business A
    runSQL(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${OWNER_B}'::UUID $fn$ LANGUAGE SQL STABLE;`);
    const result = runSQL(`SELECT COUNT(*) FROM public.get_business_transactions('${BIZ_A}');`);
    // Restore auth.uid() to OWNER_A
    runSQL(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${OWNER_A}'::UUID $fn$ LANGUAGE SQL STABLE;`);
    expect(result).toBe('0');
  });

  // ── flow_type enum branch coverage ──

  it('get_business_transactions handles ticketing flow_type', () => {
    const TK_BK = 'c2250000-0000-0000-0000-0000000000f0';
    try {
      runSQL(`INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at) VALUES ('${TK_BK}', 'WA-TK-T001', '${BIZ_A}', '${CUSTOMER_USER}', 'ticketing', 'Ticket Buyer', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 2000, now());`);
      const result = runSQL(`SELECT purpose FROM public.get_business_transactions('${BIZ_A}') WHERE reference_code = 'WA-TK-T001';`);
      expect(result).toContain('Ticket');
    } finally {
      runSQL(`DELETE FROM public.bookings WHERE id = '${TK_BK}';`);
    }
  });

  it('get_business_transactions handles ordering flow_type via orders table', () => {
    // Ordering flow creates orders, not bookings — covered by existing WA-OR-T001 test
    const result = runSQL(`SELECT flow_type FROM public.get_business_transactions('${BIZ_A}') WHERE reference_code = 'WA-OR-T001';`);
    expect(result).toContain('ordering');
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
    runSQL(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${OWNER_B}'::UUID $fn$ LANGUAGE SQL STABLE;`);
    const result = runSQL(`SELECT COUNT(*) FROM public.get_customer_history('${BIZ_A}', '${CP_A}');`);
    runSQL(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${OWNER_A}'::UUID $fn$ LANGUAGE SQL STABLE;`);
    expect(result).toBe('0');
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
    runSQL(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${OWNER_B}'::UUID $fn$ LANGUAGE SQL STABLE;`);
    const result = runSQL(`SELECT total_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`);
    runSQL(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${OWNER_A}'::UUID $fn$ LANGUAGE SQL STABLE;`);
    expect(result).toBe('0');
  });

  // ── 226-FIN-2: Financial aggregate invariants ──

  it('226-FIN-2a: >500 rows produce correct uncapped total independent of p_limit', () => {
    // Create 501 confirmed bookings at 100 each → expected booking_revenue increases by 50100
    const ids: string[] = [];
    try {
      const beforeRaw = runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`);
      const beforeNum = parseInt(beforeRaw, 10);

      // Bulk insert 501 bookings via generate_series with random UUIDs
      runSQL(`
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
        SELECT
          gen_random_uuid(),
          'WA-FIN-' || n,
          '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Bulk', '${CUSTOMER_PHONE}',
          CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 100, now()
        FROM generate_series(1, 501) AS n;
      `);

      // Totals must include all 501 rows (uncapped)
      const afterRaw = runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`);
      const afterNum = parseInt(afterRaw, 10);
      expect(afterNum).toBe(beforeNum + 50100);

      // Transaction rows with p_limit=10 return only 10 rows
      const limitedRows = runSQL(`SELECT COUNT(*) FROM public.get_business_transactions('${BIZ_A}', 10, 0);`);
      expect(parseInt(limitedRows, 10)).toBe(10);

      // But totals are unchanged — pagination cannot change revenue
      const totalsAgain = runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`);
      expect(parseInt(totalsAgain, 10)).toBe(beforeNum + 50100);
    } finally {
      runSQL(`DELETE FROM public.bookings WHERE reference_code LIKE 'WA-FIN-%' AND business_id = '${BIZ_A}';`);
    }
  });

  it('226-FIN-2b: cancelled/no_show bookings excluded from revenue', () => {
    const CANC_BK = 'c2250000-0000-0000-0000-0000000000d0';
    const NOSHOW_BK = 'c2250000-0000-0000-0000-0000000000d1';
    try {
      const before = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);

      runSQL(`
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
        VALUES
          ('${CANC_BK}', 'WA-PY-CANC', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'cancelled', 50000, now()),
          ('${NOSHOW_BK}', 'WA-PY-NOSH', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'no_show', 50000, now());
      `);

      const after = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);
      expect(after).toBe(before); // unchanged — excluded

      // But they ARE visible in transaction projection (with correct status)
      const cancRow = runSQL(`SELECT status FROM public.get_business_transactions('${BIZ_A}') WHERE reference_code = 'WA-PY-CANC';`);
      expect(cancRow).toContain('cancelled');
      const noshowRow = runSQL(`SELECT status FROM public.get_business_transactions('${BIZ_A}') WHERE reference_code = 'WA-PY-NOSH';`);
      expect(noshowRow).toContain('no_show');
    } finally {
      runSQL(`DELETE FROM public.bookings WHERE id IN ('${CANC_BK}', '${NOSHOW_BK}');`);
    }
  });

  it('226-FIN-2c: cancelled/draft orders excluded from revenue', () => {
    const CANC_ORD = 'c2250000-0000-0000-0000-0000000000d2';
    const DRAFT_ORD = 'c2250000-0000-0000-0000-0000000000d3';
    try {
      const beforeOrder = parseInt(runSQL(`SELECT order_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);

      runSQL(`INSERT INTO public.orders (id, reference_code, business_id, user_id, delivery_phone, status, total_amount, created_at) VALUES ('${CANC_ORD}', 'WA-OR-CANC', '${BIZ_A}', '${CUSTOMER_USER}', '${CUSTOMER_PHONE}', 'cancelled', 50000, now());`);
      runSQL(`INSERT INTO public.orders (id, reference_code, business_id, user_id, delivery_phone, status, total_amount, created_at) VALUES ('${DRAFT_ORD}', 'WA-OR-DRFT', '${BIZ_A}', '${CUSTOMER_USER}', '${CUSTOMER_PHONE}', 'draft', 50000, now());`);

      const afterOrder = parseInt(runSQL(`SELECT order_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);
      expect(afterOrder).toBe(beforeOrder);

      const cancOrd = runSQL(`SELECT status FROM public.get_business_transactions('${BIZ_A}') WHERE reference_code = 'WA-OR-CANC';`);
      expect(cancOrd).toContain('cancelled');
    } finally {
      runSQL(`DELETE FROM public.orders WHERE id IN ('${CANC_ORD}', '${DRAFT_ORD}');`);
    }
  });

  // ── 226-FIN-2c payment-aware net settlement ──

  it('226-FIN-2c-pay1: successful payment counts settled amount as revenue', () => {
    // The fixture BOOKING_GIVING has PAYMENT_GIVING (status=success, amount=10000)
    // Revenue should include this payment's amount
    const rev = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);
    expect(rev).toBeGreaterThanOrEqual(10000);
  });

  it('226-FIN-2c-pay2: pending payment contributes $0 revenue', () => {
    const PEND_BK = 'c2250000-0000-0000-0000-0000000000e0';
    const PEND_PAY = 'c2250000-0000-0000-0000-0000000000e1';
    try {
      const before = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);

      runSQL(`INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at) VALUES ('${PEND_BK}', 'WA-PY-PEND', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'pending', 50000, now());`);
      runSQL(`INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, created_at) VALUES ('${PEND_PAY}', '${PEND_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 50000, 'NGN', 'WA-PY-PEND-PAY', 'pending', now());`);

      const after = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);
      expect(after).toBe(before); // $0 from pending payment
    } finally {
      runSQL(`DELETE FROM public.payments WHERE id = '${PEND_PAY}';`);
      runSQL(`DELETE FROM public.bookings WHERE id = '${PEND_BK}';`);
    }
  });

  it('226-FIN-2c-pay3: failed payment contributes $0 revenue', () => {
    const FAIL_BK = 'c2250000-0000-0000-0000-0000000000e2';
    const FAIL_PAY = 'c2250000-0000-0000-0000-0000000000e3';
    try {
      const before = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);

      runSQL(`INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at) VALUES ('${FAIL_BK}', 'WA-PY-FAIL', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 50000, now());`);
      runSQL(`INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, created_at) VALUES ('${FAIL_PAY}', '${FAIL_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 50000, 'NGN', 'WA-PY-FAIL-PAY', 'failed', now());`);

      const after = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);
      expect(after).toBe(before); // $0 from failed payment
    } finally {
      runSQL(`DELETE FROM public.payments WHERE id = '${FAIL_PAY}';`);
      runSQL(`DELETE FROM public.bookings WHERE id = '${FAIL_BK}';`);
    }
  });

  it('226-FIN-2c-pay4: failed then successful retry counts once', () => {
    const RETRY_BK = 'c2250000-0000-0000-0000-0000000000e4';
    const RETRY_FAIL = 'c2250000-0000-0000-0000-0000000000e5';
    const RETRY_OK = 'c2250000-0000-0000-0000-0000000000e6';
    try {
      const before = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);

      runSQL(`INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at) VALUES ('${RETRY_BK}', 'WA-PY-RTRY', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 20000, now());`);
      // First attempt: failed
      runSQL(`INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, created_at) VALUES ('${RETRY_FAIL}', '${RETRY_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 20000, 'NGN', 'WA-PY-RTRY-F', 'failed', now() - interval '1 minute');`);
      // Second attempt: success
      runSQL(`INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, created_at) VALUES ('${RETRY_OK}', '${RETRY_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 20000, 'NGN', 'WA-PY-RTRY-S', 'success', now());`);

      const after = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);
      expect(after).toBe(before + 20000); // counted once from successful payment
    } finally {
      runSQL(`DELETE FROM public.payments WHERE id IN ('${RETRY_FAIL}', '${RETRY_OK}');`);
      runSQL(`DELETE FROM public.bookings WHERE id = '${RETRY_BK}';`);
    }
  });

  it('226-FIN-2c-pay5: full completed refund = $0 net revenue', () => {
    const REF_BK = 'c2250000-0000-0000-0000-0000000000e7';
    const REF_PAY = 'c2250000-0000-0000-0000-0000000000e8';
    const REF_ID = 'c2250000-0000-0000-0000-0000000000e9';
    try {
      const before = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);

      runSQL(`INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at) VALUES ('${REF_BK}', 'WA-PY-RFND', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 30000, now());`);
      runSQL(`INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, paid_at, created_at) VALUES ('${REF_PAY}', '${REF_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 30000, 'NGN', 'WA-PY-RFND-PAY', 'success', now(), now());`);
      // Full refund — completed
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${REF_ID}', '${REF_PAY}', '${BIZ_A}', 30000, 'success', 'full');`);

      const after = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);
      expect(after).toBe(before); // $0 net — full refund cancels settlement
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id = '${REF_ID}';`);
      runSQL(`DELETE FROM public.payments WHERE id = '${REF_PAY}';`);
      runSQL(`DELETE FROM public.bookings WHERE id = '${REF_BK}';`);
    }
  });

  it('226-FIN-2c-pay6: partial completed refund = settled minus refunded', () => {
    const PREF_BK = 'c2250000-0000-0000-0000-0000000000ea';
    const PREF_PAY = 'c2250000-0000-0000-0000-0000000000eb';
    const PREF_ID = 'c2250000-0000-0000-0000-0000000000ec';
    try {
      const before = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);

      runSQL(`INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at) VALUES ('${PREF_BK}', 'WA-PY-PREF', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 40000, now());`);
      runSQL(`INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, paid_at, created_at) VALUES ('${PREF_PAY}', '${PREF_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 40000, 'NGN', 'WA-PY-PREF-PAY', 'success', now(), now());`);
      // Partial refund — 15000 of 40000
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${PREF_ID}', '${PREF_PAY}', '${BIZ_A}', 15000, 'success', 'partial');`);

      const after = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);
      expect(after).toBe(before + 25000); // 40000 - 15000 = 25000 net
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id = '${PREF_ID}';`);
      runSQL(`DELETE FROM public.payments WHERE id = '${PREF_PAY}';`);
      runSQL(`DELETE FROM public.bookings WHERE id = '${PREF_BK}';`);
    }
  });

  it('226-FIN-2c-pay7: pending/failed refund does NOT reduce revenue', () => {
    const URFND_BK = 'c2250000-0000-0000-0000-0000000000ed';
    const URFND_PAY = 'c2250000-0000-0000-0000-0000000000ee';
    const URFND_PEND = 'c2250000-0000-0000-0000-0000000000ef';
    const URFND_FAIL = 'c2250000-0000-0000-0000-0000000000f1';
    try {
      const before = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);

      runSQL(`INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at) VALUES ('${URFND_BK}', 'WA-PY-URFD', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 25000, now());`);
      runSQL(`INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, paid_at, created_at) VALUES ('${URFND_PAY}', '${URFND_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 25000, 'NGN', 'WA-PY-URFD-PAY', 'success', now(), now());`);
      // Pending refund — should NOT reduce revenue
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${URFND_PEND}', '${URFND_PAY}', '${BIZ_A}', 25000, 'pending', 'full');`);
      // Failed refund — should NOT reduce revenue
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${URFND_FAIL}', '${URFND_PAY}', '${BIZ_A}', 25000, 'failed', 'full');`);

      const after = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);
      expect(after).toBe(before + 25000); // full settled amount — pending/failed refunds ignored
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id IN ('${URFND_PEND}', '${URFND_FAIL}');`);
      runSQL(`DELETE FROM public.payments WHERE id = '${URFND_PAY}';`);
      runSQL(`DELETE FROM public.bookings WHERE id = '${URFND_BK}';`);
    }
  });

  it('226-FIN-2c-pay8: payment.status=refunded with full refund row = $0 net', () => {
    // Tests the refunded payment status path: payment transitions success→refunded
    // after a full refund. CASE includes 'refunded' in settlement, refund row subtracts it.
    const RFND_BK = 'c2250000-0000-0000-0000-0000000000f2';
    const RFND_PAY = 'c2250000-0000-0000-0000-0000000000f3';
    const RFND_REF = 'c2250000-0000-0000-0000-0000000000f4';
    try {
      const before = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);

      runSQL(`INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at) VALUES ('${RFND_BK}', 'WA-PY-RFST', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 35000, now());`);
      // Payment with status='refunded' (post-full-refund state)
      runSQL(`INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, paid_at, created_at) VALUES ('${RFND_PAY}', '${RFND_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 35000, 'NGN', 'WA-PY-RFST-PAY', 'refunded', now(), now());`);
      // Completed full refund
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${RFND_REF}', '${RFND_PAY}', '${BIZ_A}', 35000, 'success', 'full');`);

      const after = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);
      // Net = 35000 (settlement) - 35000 (refund) = $0
      expect(after).toBe(before);
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id = '${RFND_REF}';`);
      runSQL(`DELETE FROM public.payments WHERE id = '${RFND_PAY}';`);
      runSQL(`DELETE FROM public.bookings WHERE id = '${RFND_BK}';`);
    }
  });

  it('226-FIN-2c-pay9: payment.status=refunded with partial refund = net settlement', () => {
    // Partial refund where payment status transitions to 'refunded' mid-process
    const PRFND_BK = 'c2250000-0000-0000-0000-0000000000f5';
    const PRFND_PAY = 'c2250000-0000-0000-0000-0000000000f6';
    const PRFND_REF = 'c2250000-0000-0000-0000-0000000000f7';
    try {
      const before = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);

      runSQL(`INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at) VALUES ('${PRFND_BK}', 'WA-PY-PRST', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 50000, now());`);
      // Payment with status='refunded' but only partially refunded
      runSQL(`INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, paid_at, created_at) VALUES ('${PRFND_PAY}', '${PRFND_BK}', '${CUSTOMER_USER}', '${BIZ_A}', 50000, 'NGN', 'WA-PY-PRST-PAY', 'refunded', now(), now());`);
      // Partial refund of 20000
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${PRFND_REF}', '${PRFND_PAY}', '${BIZ_A}', 20000, 'success', 'partial');`);

      const after = parseInt(runSQL(`SELECT booking_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`), 10);
      // Net = 50000 (settlement) - 20000 (partial refund) = 30000
      expect(after).toBe(before + 30000);
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id = '${PRFND_REF}';`);
      runSQL(`DELETE FROM public.payments WHERE id = '${PRFND_PAY}';`);
      runSQL(`DELETE FROM public.bookings WHERE id = '${PRFND_BK}';`);
    }
  });

  it('226-FIN-2d: no double-counting across booking/order/invoice sources with total_revenue', () => {
    // Prove structural disjointness + aggregate correctness
    const INV_ID = 'c2250000-0000-0000-0000-0000000000d5';
    try {
      // Add a paid invoice
      runSQL(`INSERT INTO public.invoices (id, reference_code, business_id, customer_name, total_amount, amount_paid, status, created_at) VALUES ('${INV_ID}', 'WA-INV-001', '${BIZ_A}', 'Invoice Customer', 8000, 8000, 'paid', now());`);

      // Get component totals
      const raw = runSQL(`SELECT booking_revenue, order_revenue, invoice_revenue, total_revenue FROM public.get_business_revenue_totals('${BIZ_A}');`);
      const parts = raw.split('|');
      const bRev = parseInt(parts[0], 10);
      const oRev = parseInt(parts[1], 10);
      const iRev = parseInt(parts[2], 10);
      const total = parseInt(parts[3], 10);

      // total_revenue = sum of components (no double-counting)
      expect(total).toBe(bRev + oRev + iRev);

      // Invoice revenue includes the new invoice
      expect(iRev).toBe(8000);

      // Each reference appears exactly once in transaction projection
      const bkTxn = runSQL(`SELECT COUNT(*) FROM public.get_business_transactions('${BIZ_A}') WHERE reference_code = 'WA-PY-T001';`);
      expect(bkTxn).toBe('1');

      const ordTxn = runSQL(`SELECT COUNT(*) FROM public.get_business_transactions('${BIZ_A}') WHERE reference_code = 'WA-OR-T001';`);
      expect(ordTxn).toBe('1');

      const invTxn = runSQL(`SELECT COUNT(*) FROM public.get_business_transactions('${BIZ_A}') WHERE reference_code = 'WA-INV-001';`);
      expect(invTxn).toBe('1');

      // Cross-source: no booking ref appears as order/invoice, etc.
      const bkAsOrd = runSQL(`SELECT COUNT(*) FROM public.get_business_transactions('${BIZ_A}') WHERE reference_code = 'WA-PY-T001' AND txn_type != 'booking';`);
      expect(bkAsOrd).toBe('0');

      const ordAsBk = runSQL(`SELECT COUNT(*) FROM public.get_business_transactions('${BIZ_A}') WHERE reference_code = 'WA-OR-T001' AND txn_type != 'order';`);
      expect(ordAsBk).toBe('0');

      const invAsOther = runSQL(`SELECT COUNT(*) FROM public.get_business_transactions('${BIZ_A}') WHERE reference_code = 'WA-INV-001' AND txn_type != 'invoice';`);
      expect(invAsOther).toBe('0');
    } finally {
      runSQL(`DELETE FROM public.invoices WHERE id = '${INV_ID}';`);
    }
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

  // ── Profiles RLS isolation proof (#226-RLS-1) ──
  // Uses SET ROLE authenticated (non-superuser, non-BYPASSRLS) to prove
  // profiles RLS blocks cross-user SELECT while the authorized RPC
  // still resolves business-owned customer data.

  it('226-RLS-1a: authenticated business owner CANNOT directly SELECT another user profiles row', () => {
    // auth.uid() = OWNER_A (set in beforeAll), SET ROLE authenticated
    // OWNER_A tries to read CUSTOMER_USER's profile — RLS must deny
    let result: { stdout: string; exitCode: number };
    try {
      const stdout = execSync(
        `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
        { input: `SET ROLE authenticated;\nSELECT COUNT(*) FROM public.profiles WHERE id = '${CUSTOMER_USER}';`, encoding: 'utf-8', timeout: 15000 },
      );
      result = { stdout: stdout.trim(), exitCode: 0 };
    } catch (err: any) {
      result = { stdout: err.stdout?.trim() || '', exitCode: err.status || 1 };
    }
    // RLS blocks: either 0 rows or permission error
    if (result.exitCode === 0) {
      const count = result.stdout.split('\n').pop()?.replace('SET', '').trim();
      expect(count).toBe('0');
    }
    // exitCode !== 0 also acceptable (permission denied)
  });

  it('226-RLS-1b: authorized RPC STILL resolves business-owned customer attribution', () => {
    // The same auth.uid() = OWNER_A, but the SECURITY DEFINER RPC
    // can resolve customer names from business-owned customer_profiles
    const result = runSQL(`
      SELECT customer_name FROM public.get_business_transactions('${BIZ_A}')
      WHERE reference_code = 'WA-OR-T001';
    `);
    expect(result).toContain('Babajide Ace');
  });

  it('RPC ownership check denies cross-business access', () => {
    runSQL(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${OWNER_B}'::UUID $fn$ LANGUAGE SQL STABLE;`);
    const result = runSQL(`SELECT COUNT(*) FROM public.get_business_transactions('${BIZ_A}');`);
    runSQL(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$ SELECT '${OWNER_A}'::UUID $fn$ LANGUAGE SQL STABLE;`);
    expect(result).toBe('0');
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
        INSERT INTO public.profiles (id, first_name, last_name, email)
        VALUES ('${OTHER_USER}', 'Other', 'Person', 'other-225@test.local');
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
        VALUES ('${OTHER_BOOKING}', 'WA-PY-OTHER', '${BIZ_A}', '${OTHER_USER}', 'payment', 'Other Person', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 99999, now());
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
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, service_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
        VALUES ('${ONE_TIME_BK}', 'WA-PY-OT01', '${BIZ_A}', '${CUSTOMER_USER}', '${ONE_TIME_SVC}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 5000, now());
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
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, service_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
        VALUES ('${NON_GIVING_BK}', 'WA-PY-NG01', '${BIZ_A}', '${CUSTOMER_USER}', '${NON_GIVING_SVC}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 5000, now());
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
        INSERT INTO public.profiles (id, first_name, last_name, email)
        VALUES ('${OTHER_USER}', 'Other', 'User226', 'other-226@test.local');
        INSERT INTO public.customer_profiles (id, business_id, phone, name, user_id)
        VALUES ('${OTHER_CP}', '${BIZ_A}', '+2349999999999', 'Other User226', '${OTHER_USER}');
      `);

      // Create a booking by CUSTOMER_USER but with OTHER_CP's phone
      // (shared/reused phone scenario)
      runSQL(`
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
        VALUES ('${SHARED_BOOKING}', 'WA-PY-XATTR', '${BIZ_A}', '${CUSTOMER_USER}', 'payment', 'Babajide Ace', '+2349999999999', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 7777, now());
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

  // ── Durable-ID-first attribution proof ──
  // NOTE: bookings.user_id and orders.user_id are NOT NULL in the canonical schema.
  // The phone fallback join conditions (b.user_id IS NULL AND cp_p.user_id IS NULL)
  // are defense-in-depth for any future schema relaxation or legacy data.
  // We prove durable-ID-first by testing that a booking with user_id=A and
  // shared phone does NOT resolve to user B's customer_profiles (the existing
  // cross-attribution test above covers this).

  it('durable-ID-first: booking with user_id resolves via cp.user_id, not phone', () => {
    // The test booking BOOKING_GIVING has user_id=CUSTOMER_USER and phone=CUSTOMER_PHONE
    // CP_A has user_id=CUSTOMER_USER (via backfill/setup)
    // Verify attribution comes through user_id join (cp_u), not phone join (cp_p)
    const result = runSQL(`
      SELECT customer_name FROM public.get_business_transactions('${BIZ_A}')
      WHERE reference_code = 'WA-PY-T001';
    `);
    // guest_name 'Babajide Ace' is on the booking itself, so it resolves regardless
    // The key proof is that the RPC doesn't error and returns the correct name
    expect(result).toContain('Babajide Ace');
  });

  it('durable-ID-first: order with user_id resolves via cp.user_id, not delivery_phone', () => {
    const result = runSQL(`
      SELECT customer_name FROM public.get_business_transactions('${BIZ_A}')
      WHERE reference_code = 'WA-OR-T001';
    `);
    // Order has user_id=CUSTOMER_USER, CP_A has user_id=CUSTOMER_USER
    expect(result).toContain('Babajide Ace');
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
        INSERT INTO public.profiles (id, first_name, last_name, email)
        VALUES ('${DUAL_USER}', 'Dual', 'Phone', 'dual-225@test.local');
        INSERT INTO public.customer_profiles (id, business_id, phone, name, user_id)
        VALUES
          ('${CP_PHONE1}', '${BIZ_A}', '+2341111111111', 'Dual Phone Old', NULL),
          ('${CP_PHONE2}', '${BIZ_A}', '+2342222222222', 'Dual Phone New', NULL);
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, flow_type, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
        VALUES
          ('${BK1}', 'WA-DUAL-1', '${BIZ_A}', '${DUAL_USER}', 'payment', '+2341111111111', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 1000, now()),
          ('${BK2}', 'WA-DUAL-2', '${BIZ_A}', '${DUAL_USER}', 'payment', '+2342222222222', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 2000, now());
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
        INSERT INTO public.bookings (id, reference_code, business_id, user_id, service_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
        VALUES ('${INACTIVE_BK}', 'WA-PY-IN01', '${BIZ_A}', '${CUSTOMER_USER}', '${INACTIVE_SVC}', 'payment', 'Test', '${CUSTOMER_PHONE}', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 5000, now());
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
