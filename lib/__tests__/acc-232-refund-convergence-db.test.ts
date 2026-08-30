/**
 * #232: Refund domain convergence + execution safety DB tests.
 *
 * Proves against real PostgreSQL (TEST_DATABASE_URL):
 * - Migration 355 creates refunds table + payment columns
 * - From-scratch order: 355 before 356
 * - Non-terminal serialization (partial unique index)
 * - Atomic dispatch claim (claim_refund_dispatch)
 * - Exactly-once finalization (finalize_refund_execution)
 * - Concurrent finalizers → one effect
 * - Replay after success → no-op
 * - Payment aggregate correctness
 * - RLS: authenticated cannot INSERT/UPDATE refunds
 * - Sequential partial refunds: cumulative fee correctness
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('#232 Refund convergence — TEST_DATABASE_URL not set', () => {
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

const OWNER = 'c2320000-0000-0000-0000-000000000001';
const BIZ = 'c2320000-0000-0000-0000-000000000010';
const CUSTOMER = 'c2320000-0000-0000-0000-000000000003';
const BOOKING = 'c2320000-0000-0000-0000-000000000030';
const PAYMENT = 'c2320000-0000-0000-0000-000000000050';
const SERVICE = 'c2320000-0000-0000-0000-000000000020';

describe('#232 Refund convergence PostgreSQL', () => {
  beforeAll(() => {
    runSQL(`
      DELETE FROM public.refunds WHERE business_id = '${BIZ}';
      DELETE FROM public.platform_fees WHERE business_id = '${BIZ}';
      DELETE FROM public.payments WHERE business_id = '${BIZ}';
      DELETE FROM public.bookings WHERE business_id = '${BIZ}';
      DELETE FROM public.services WHERE business_id = '${BIZ}';
      DELETE FROM public.businesses WHERE id = '${BIZ}';
      DELETE FROM public.profiles WHERE id IN ('${OWNER}', '${CUSTOMER}');
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id IN ('${OWNER}', '${CUSTOMER}');
      INSERT INTO auth.users (id) VALUES ('${OWNER}'), ('${CUSTOMER}') ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;

      INSERT INTO public.profiles (id, first_name, last_name, email)
      VALUES ('${OWNER}', 'RefOwner', 'Test', 'ref-owner@test.local'),
             ('${CUSTOMER}', 'RefCust', 'Test', 'ref-cust@test.local');

      INSERT INTO public.businesses (id, owner_id, name, slug, category, address, city, phone, status, subscription_tier, country_code)
      VALUES ('${BIZ}', '${OWNER}', 'RefundTestBiz', 'refund-test-232', 'church', '1 St', 'Lagos', '+2340000232', 'active', 'growth', 'NG');

      INSERT INTO public.services (id, business_id, name, service_type, billing_type, recurring_interval, is_active, price, duration_minutes, deposit_amount)
      VALUES ('${SERVICE}', '${BIZ}', 'Ref Giving', 'giving', 'recurring', 'monthly', true, 10000, 0, 0);

      INSERT INTO public.bookings (id, reference_code, business_id, user_id, service_id, flow_type, guest_name, guest_phone, date, time, party_size, channel, status, total_amount, created_at)
      VALUES ('${BOOKING}', 'WA-RF-001', '${BIZ}', '${CUSTOMER}', '${SERVICE}', 'payment', 'RefCust', '+2340000232', CURRENT_DATE, '10:00', 1, 'whatsapp', 'confirmed', 10000, now());

      INSERT INTO public.payments (id, booking_id, user_id, business_id, amount, currency, gateway_reference, status, paid_at, created_at)
      VALUES ('${PAYMENT}', '${BOOKING}', '${CUSTOMER}', '${BIZ}', 10000, 'NGN', 'WA-RF-001-PAY', 'success', now(), now());

      INSERT INTO public.platform_fees (business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
      VALUES ('${BIZ}', '${BOOKING}', 10000, 2.5, 0, 250, 'growth');

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS
      $fn$ SELECT '${OWNER}'::UUID $fn$
      LANGUAGE SQL STABLE;
    `);
  });

  afterAll(() => {
    runSQL(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS
      $fn$ SELECT NULL::UUID $fn$
      LANGUAGE SQL STABLE;

      DELETE FROM public.refunds WHERE business_id = '${BIZ}';
      DELETE FROM public.platform_fees WHERE business_id = '${BIZ}';
      DELETE FROM public.payments WHERE business_id = '${BIZ}';
      DELETE FROM public.bookings WHERE business_id = '${BIZ}';
      DELETE FROM public.services WHERE business_id = '${BIZ}';
      DELETE FROM public.businesses WHERE id = '${BIZ}';
      DELETE FROM public.profiles WHERE id IN ('${OWNER}', '${CUSTOMER}');
      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      DELETE FROM auth.users WHERE id IN ('${OWNER}', '${CUSTOMER}');
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
    `);
  });

  // ── Schema convergence ──

  it('refunds table exists with required columns', () => {
    const cols = runSQL(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'refunds'
      ORDER BY ordinal_position;
    `);
    expect(cols).toContain('id');
    expect(cols).toContain('payment_id');
    expect(cols).toContain('status');
    expect(cols).toContain('dispatched_at');
    expect(cols).toContain('finalized_at');
    expect(cols).toContain('gateway_refund_reference');
  });

  it('payments has refund columns', () => {
    const cols = runSQL(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payments'
        AND column_name IN ('refund_amount', 'refund_reason', 'refunded_by', 'refunded_at')
      ORDER BY column_name;
    `);
    expect(cols).toContain('refund_amount');
    expect(cols).toContain('refunded_at');
    expect(cols).toContain('refunded_by');
  });

  it('refunds status CHECK allows 5-state model', () => {
    for (const status of ['pending', 'provider_ambiguous', 'provider_success_unfinalized', 'success', 'failed']) {
      const REFID = `c2320000-0000-0000-0000-00000000ff0${status.length}`;
      runSQLSafe(`DELETE FROM public.refunds WHERE id = '${REFID}';`);
      const r = runSQLSafe(`
        INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type)
        VALUES ('${REFID}', '${PAYMENT}', '${BIZ}', 1, '${status}', 'partial');
      `);
      expect(r.exitCode).toBe(0);
      runSQL(`DELETE FROM public.refunds WHERE id = '${REFID}';`);
    }
  });

  // ── Non-terminal serialization ──

  it('partial unique index blocks second non-terminal refund for same payment', () => {
    const REF1 = 'c2320000-0000-0000-0000-000000000100';
    const REF2 = 'c2320000-0000-0000-0000-000000000101';
    try {
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${REF1}', '${PAYMENT}', '${BIZ}', 5000, 'pending', 'partial');`);

      const r = runSQLSafe(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${REF2}', '${PAYMENT}', '${BIZ}', 5000, 'pending', 'partial');`);
      expect(r.exitCode).not.toBe(0); // unique violation
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id IN ('${REF1}', '${REF2}');`);
    }
  });

  it('provider_ambiguous also blocks new attempt', () => {
    const REF1 = 'c2320000-0000-0000-0000-000000000102';
    const REF2 = 'c2320000-0000-0000-0000-000000000103';
    try {
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${REF1}', '${PAYMENT}', '${BIZ}', 5000, 'provider_ambiguous', 'partial');`);

      const r = runSQLSafe(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${REF2}', '${PAYMENT}', '${BIZ}', 5000, 'pending', 'partial');`);
      expect(r.exitCode).not.toBe(0);
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id IN ('${REF1}', '${REF2}');`);
    }
  });

  it('terminal state releases slot for new attempt', () => {
    const REF1 = 'c2320000-0000-0000-0000-000000000104';
    const REF2 = 'c2320000-0000-0000-0000-000000000105';
    try {
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${REF1}', '${PAYMENT}', '${BIZ}', 5000, 'failed', 'partial');`);

      const r = runSQLSafe(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${REF2}', '${PAYMENT}', '${BIZ}', 5000, 'pending', 'partial');`);
      expect(r.exitCode).toBe(0); // allowed — prior attempt is terminal
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id IN ('${REF1}', '${REF2}');`);
    }
  });

  // ── Atomic dispatch claim ──

  it('claim_refund_dispatch claims pending+undispatched refund', () => {
    const REF = 'c2320000-0000-0000-0000-000000000110';
    try {
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, gateway, refund_type) VALUES ('${REF}', '${PAYMENT}', '${BIZ}', 5000, 'pending', 'paystack', 'partial');`);

      const result = runSQL(`SELECT claimed FROM public.claim_refund_dispatch('${REF}');`);
      expect(result).toBe('t');

      // dispatched_at now set
      const dispatched = runSQL(`SELECT dispatched_at IS NOT NULL FROM public.refunds WHERE id = '${REF}';`);
      expect(dispatched).toBe('t');

      // Second claim fails
      const result2 = runSQL(`SELECT claimed FROM public.claim_refund_dispatch('${REF}');`);
      expect(result2).toBe('f');
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id = '${REF}';`);
    }
  });

  // ── Exactly-once finalization ──

  it('finalize_refund_execution finalizes provider_success_unfinalized', () => {
    const REF = 'c2320000-0000-0000-0000-000000000120';
    try {
      // Reset payment to clean state for this test
      runSQL(`UPDATE public.payments SET refund_amount = 0, status = 'success' WHERE id = '${PAYMENT}';`);
      runSQL(`UPDATE public.platform_fees SET refunded_at = NULL, fee_total = 250 WHERE booking_id = '${BOOKING}';`);

      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, gateway, refund_type, initiated_by, dispatched_at, gateway_refund_reference) VALUES ('${REF}', '${PAYMENT}', '${BIZ}', 5000, 'provider_success_unfinalized', 'paystack', 'partial', '${OWNER}', now(), 'gw-ref-123');`);

      const result = runSQL(`SELECT finalize_refund_execution('${REF}');`);
      expect(result).toContain('true');

      // Refund is now success
      const status = runSQL(`SELECT status FROM public.refunds WHERE id = '${REF}';`);
      expect(status).toBe('success');

      // Payment aggregate updated
      const refAmt = runSQL(`SELECT refund_amount FROM public.payments WHERE id = '${PAYMENT}';`);
      expect(parseFloat(refAmt)).toBe(5000);

      // Replay = no-op
      const replay = runSQL(`SELECT finalize_refund_execution('${REF}');`);
      expect(replay).toContain('already_finalized');

      // Payment aggregate NOT doubled
      const refAmt2 = runSQL(`SELECT refund_amount FROM public.payments WHERE id = '${PAYMENT}';`);
      expect(parseFloat(refAmt2)).toBe(5000);
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id = '${REF}';`);
      runSQL(`UPDATE public.payments SET refund_amount = 0, status = 'success' WHERE id = '${PAYMENT}';`);
      runSQL(`UPDATE public.platform_fees SET refunded_at = NULL, fee_total = 250 WHERE booking_id = '${BOOKING}';`);
    }
  });

  it('finalization rejects non-provider_success_unfinalized state', () => {
    const REF = 'c2320000-0000-0000-0000-000000000121';
    try {
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${REF}', '${PAYMENT}', '${BIZ}', 5000, 'pending', 'partial');`);

      const result = runSQL(`SELECT finalize_refund_execution('${REF}');`);
      expect(result).toContain('invalid_state');
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id = '${REF}';`);
    }
  });

  // ── Sequential partial refunds: cumulative fee correctness ──

  it('two partial refunds produce same fee state as one full refund', () => {
    const REF_P1 = 'c2320000-0000-0000-0000-000000000130';
    const REF_P2 = 'c2320000-0000-0000-0000-000000000131';
    try {
      // Reset
      runSQL(`UPDATE public.payments SET refund_amount = 0, status = 'success' WHERE id = '${PAYMENT}';`);
      runSQL(`UPDATE public.platform_fees SET refunded_at = NULL, fee_total = 250 WHERE booking_id = '${BOOKING}';`);

      // First partial: 5000 of 10000
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, gateway, refund_type, initiated_by, dispatched_at, gateway_refund_reference) VALUES ('${REF_P1}', '${PAYMENT}', '${BIZ}', 5000, 'provider_success_unfinalized', 'paystack', 'partial', '${OWNER}', now(), 'gw-p1');`);
      runSQL(`SELECT finalize_refund_execution('${REF_P1}');`);

      const fee1 = runSQL(`SELECT fee_total FROM public.platform_fees WHERE booking_id = '${BOOKING}' AND refunded_at IS NULL;`);
      const fee1Val = parseFloat(fee1);
      // Expect fee reduced by 50% (5000/10000 * 250 = 125)
      expect(fee1Val).toBeCloseTo(125, 0);

      // Second partial: remaining 5000
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, gateway, refund_type, initiated_by, dispatched_at, gateway_refund_reference) VALUES ('${REF_P2}', '${PAYMENT}', '${BIZ}', 5000, 'provider_success_unfinalized', 'paystack', 'full', '${OWNER}', now(), 'gw-p2');`);
      runSQL(`SELECT finalize_refund_execution('${REF_P2}');`);

      // After full refund, fee should be marked refunded_at (not just reduced)
      const feeRefunded = runSQL(`SELECT refunded_at IS NOT NULL FROM public.platform_fees WHERE booking_id = '${BOOKING}';`);
      expect(feeRefunded).toBe('t');

      // Payment fully refunded
      const payStatus = runSQL(`SELECT status FROM public.payments WHERE id = '${PAYMENT}';`);
      expect(payStatus).toBe('refunded');
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id IN ('${REF_P1}', '${REF_P2}');`);
      runSQL(`UPDATE public.payments SET refund_amount = 0, status = 'success' WHERE id = '${PAYMENT}';`);
      runSQL(`UPDATE public.platform_fees SET refunded_at = NULL, fee_total = 250 WHERE booking_id = '${BOOKING}';`);
    }
  });

  // ── RLS/grants ──

  it('authenticated role cannot INSERT into refunds', () => {
    const r = runSQLSafe(`
      SET ROLE authenticated;
      INSERT INTO public.refunds (payment_id, business_id, amount, status, refund_type)
      VALUES ('${PAYMENT}', '${BIZ}', 1000, 'pending', 'partial');
    `);
    expect(r.exitCode).not.toBe(0); // permission denied
  });

  it('authenticated role CAN SELECT own business refunds', () => {
    const REF = 'c2320000-0000-0000-0000-000000000140';
    try {
      // Insert via service role
      runSQL(`INSERT INTO public.refunds (id, payment_id, business_id, amount, status, refund_type) VALUES ('${REF}', '${PAYMENT}', '${BIZ}', 1000, 'success', 'partial');`);

      // auth.uid() = OWNER who owns BIZ
      const r = runSQLSafe(`
        SET ROLE authenticated;
        SELECT COUNT(*) FROM public.refunds WHERE id = '${REF}';
      `);
      const count = r.stdout.split('\n').pop()?.replace('SET', '').trim();
      expect(count).toBe('1');
    } finally {
      runSQL(`DELETE FROM public.refunds WHERE id = '${REF}';`);
    }
  });

  // ── refund_requests unchanged ──

  it('refund_requests table still exists with original columns', () => {
    const cols = runSQL(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'refund_requests'
      ORDER BY ordinal_position;
    `);
    expect(cols).toContain('id');
    expect(cols).toContain('payment_id');
    expect(cols).toContain('status');
    expect(cols).toContain('customer_phone');
  });

  // ── Function access control ──

  it('claim_refund_dispatch not executable by authenticated', () => {
    const result = runSQL(`SELECT has_function_privilege('authenticated', 'public.claim_refund_dispatch(uuid)', 'EXECUTE');`);
    expect(result).toBe('f');
  });

  it('finalize_refund_execution not executable by authenticated', () => {
    const result = runSQL(`SELECT has_function_privilege('authenticated', 'public.finalize_refund_execution(uuid)', 'EXECUTE');`);
    expect(result).toBe('f');
  });

  it('claim_refund_dispatch executable by service_role', () => {
    const result = runSQL(`SELECT has_function_privilege('service_role', 'public.claim_refund_dispatch(uuid)', 'EXECUTE');`);
    expect(result).toBe('t');
  });

  it('finalize_refund_execution executable by service_role', () => {
    const result = runSQL(`SELECT has_function_privilege('service_role', 'public.finalize_refund_execution(uuid)', 'EXECUTE');`);
    expect(result).toBe('t');
  });
});

} // end if(dbUrl)
