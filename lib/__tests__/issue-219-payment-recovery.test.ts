/**
 * Issue #219 — Payment-first stale "I've Paid" recovery.
 *
 * Tests recoverByPaymentReference, recoverGeneric, and recoverByOrderReference
 * from lib/payments/stale-payment-recovery.ts.
 *
 * Validates: payment-specific locators, generic recovery, legacy compat,
 * notification correctness, and safety invariants.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReconciliationResult } from '@/lib/payments/reconcile';

// ── Mock reconcilePayment at module boundary ──
const mockReconcile = vi.fn<(...args: unknown[]) => Promise<ReconciliationResult>>();
vi.mock('@/lib/payments/reconcile', () => ({
  reconcilePayment: (...args: unknown[]) => mockReconcile(...args),
}));

// Suppress logger noise
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

// ── Helpers ──

function chainable(overrides: Record<string, any> = {}): Record<string, any> {
  const c: Record<string, any> = {};
  ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'or', 'in', 'is', 'not', 'gte', 'lte', 'order', 'limit'].forEach(
    m => c[m] = vi.fn().mockReturnValue(c),
  );
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  Object.assign(c, overrides);
  return c;
}

function createMockSupabase(fromHandler?: (table: string) => ReturnType<typeof chainable>) {
  return {
    from: vi.fn((table: string) => fromHandler ? fromHandler(table) : chainable()),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
}

const BASE_CTX = {
  businessId: 'biz-1',
  userId: 'user-1',
  phone: '12345678901',
  countryCode: 'NG' as const,
};

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    status: 'success',
    gateway_reference: 'gw-ref-1',
    user_id: 'user-1',
    amount: 5000,
    business_id: 'biz-1',
    booking_id: 'bk-1',
    order_id: null,
    invoice_id: null,
    campaign_id: null,
    reservation_id: null,
    ...overrides,
  };
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    reference_code: 'BK-001',
    flow_type: 'payment',
    guest_phone: '+12345678901',
    ...overrides,
  };
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    reference_code: 'ORD-001',
    status: 'confirmed',
    user_id: 'user-1',
    delivery_phone: '+12345678901',
    business_id: 'biz-1',
    ...overrides,
  };
}

// ── Dynamic import so mocks are applied ──
async function loadModule() {
  const mod = await import('@/lib/payments/stale-payment-recovery');
  return mod;
}

// ═══════════════════════════════════════════════════════════
// A. PAYMENT-SPECIFIC LOCATOR TESTS (11-18)
// ═══════════════════════════════════════════════════════════

describe('recoverByPaymentReference — payment-specific locator', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // Test 11: status='success' → confirmed, provider NOT called
  it('status=success → returns confirmed, provider NOT called', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({ status: 'success' });
    const booking = makeBooking();

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');

    expect(result.type).toBe('confirmed');
    expect(result.message).toContain('Payment Confirmed');
    // reconcilePayment should NOT be called for success status
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  // Test 12: status='pending' + provider verified → confirmed
  it('status=pending + provider verified → returns confirmed via canonical authority', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({ status: 'pending' });
    const booking = makeBooking();

    mockReconcile.mockResolvedValue({
      providerOutcome: 'verified',
      lifecycle: { status: 'completed' } as ReconciliationResult['lifecycle'],
      acknowledgeSuccess: true,
    });

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');

    expect(result.type).toBe('confirmed');
    expect(mockReconcile).toHaveBeenCalledOnce();
  });

  // Test 13: status='pending' + provider not_paid → not_found
  it('status=pending + provider not_paid → returns not_found, safe unpaid UX', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({ status: 'pending' });
    const booking = makeBooking();

    mockReconcile.mockResolvedValue({
      providerOutcome: 'not_paid',
      lifecycle: null,
      acknowledgeSuccess: false,
    });

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');

    expect(result.type).toBe('not_found');
    expect(result.message).toContain('not been received');
  });

  // Test 14: status='pending' + provider error → error, no fresh-charge
  it('status=pending + provider error → returns error, no fresh-charge', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({ status: 'pending' });
    const booking = makeBooking();

    mockReconcile.mockResolvedValue({
      providerOutcome: 'retryable_error',
      lifecycle: null,
      acknowledgeSuccess: false,
    });

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');

    expect(result.type).toBe('error');
    expect(result.message).toContain('trouble verifying');
    // Should not encourage fresh charge
    expect(result.message).not.toContain('new payment');
    expect(result.message).not.toContain('pay again');
  });

  // Test 15: status='failed' → purpose-appropriate failure, no re-charge
  it('status=failed → purpose-appropriate failure, no re-charge', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({ status: 'failed' });
    const booking = makeBooking();

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');

    expect(result.type).toBe('not_found');
    expect(result.message).toContain('could not be confirmed');
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  // Test 16: status='refunded' → refund acknowledgment
  it('status=refunded → refund acknowledgment', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({ status: 'refunded' });
    const booking = makeBooking();

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');

    expect(result.type).toBe('not_found');
    expect(result.message).toContain('refunded');
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  // Test 17: Cross-user payment reference → not_found (denied)
  it('cross-user payment reference → returns not_found (denied)', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({ status: 'success', user_id: 'other-user' });

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');

    expect(result.type).toBe('not_found');
    // Must not reveal the payment exists
    expect(result.message).toContain('No payment found');
  });

  // Test 18: Cross-business payment reference → not_found (denied)
  it('cross-business payment reference → returns not_found (denied)', async () => {
    const { recoverByPaymentReference } = await loadModule();
    // The query uses .eq('business_id', businessId) so cross-business payments won't be returned
    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-cross-biz');

    expect(result.type).toBe('not_found');
  });
});

// ═══════════════════════════════════════════════════════════
// B. GENERIC RECOVERY TESTS (19-25)
// ═══════════════════════════════════════════════════════════

describe('recoverGeneric — payment-first generic recovery', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // Test 19: Booking with flow_type='payment' + successful payment → confirmed
  it('payment/giving booking with successful payment → finds it, returns confirmed', async () => {
    const { recoverGeneric } = await loadModule();
    const payment = makePayment({ status: 'success', gateway_reference: 'gw-single' });
    const booking = makeBooking({ flow_type: 'payment' });

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        // First call: user-based candidate query (returns list)
        // Second call: recoverByPaymentReference lookup (returns single)
        let callCount = 0;
        const origEq = c.eq;
        c.eq = vi.fn((...args: unknown[]) => {
          origEq(...args);
          return c;
        });
        c.limit = vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // Candidate list query
            return Promise.resolve({ data: [payment], error: null });
          }
          return c;
        });
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverGeneric({ ...BASE_CTX, supabase: mockSupa as any });

    expect(result.type).toBe('confirmed');
    expect(result.message).toContain('Payment Confirmed');
  });

  // Test 20: Mixed Order + Giving → disambiguation with both
  it('mixed Order + Giving: same business has both → disambiguation shows both', async () => {
    const { recoverGeneric } = await loadModule();
    const paymentOrder = makePayment({ id: 'p1', status: 'success', gateway_reference: 'gw-order', order_id: 'ord-1', booking_id: null });
    const paymentGiving = makePayment({ id: 'p2', status: 'success', gateway_reference: 'gw-giving', booking_id: 'bk-giving', order_id: null });

    const orderData = { reference_code: 'ORD-100', delivery_phone: '+12345678901' };
    const bookingData = makeBooking({ reference_code: 'GIV-200', flow_type: 'payment' });

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.limit = vi.fn().mockResolvedValue({ data: [paymentOrder, paymentGiving], error: null });
        return c;
      }
      if (table === 'orders') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: orderData, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: bookingData, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverGeneric({ ...BASE_CTX, supabase: mockSupa as any });

    expect(result.type).toBe('disambiguation');
    if (result.type === 'disambiguation') {
      expect(result.candidates.length).toBe(2);
      const purposes = result.candidates.map(c => c.purpose);
      expect(purposes).toContain('order');
      expect(purposes).toContain('payment');
    }
  });

  // Test 21: Two non-order purposes (Giving + Ticketing) → disambiguation with correct labels
  it('two non-order purposes (Giving + Ticketing) → disambiguation with correct labels', async () => {
    const { recoverGeneric } = await loadModule();
    const payGiving = makePayment({ id: 'p1', gateway_reference: 'gw-giv', booking_id: 'bk-giv', order_id: null });
    const payTicket = makePayment({ id: 'p2', gateway_reference: 'gw-tix', booking_id: 'bk-tix', order_id: null });

    const bookGiving = makeBooking({ reference_code: 'GIV-300', flow_type: 'payment' });
    const bookTicket = makeBooking({ reference_code: 'TIX-400', flow_type: 'ticketing' });

    let bookingCallIdx = 0;
    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.limit = vi.fn().mockResolvedValue({ data: [payGiving, payTicket], error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockImplementation(() => {
          bookingCallIdx++;
          return Promise.resolve({ data: bookingCallIdx <= 1 ? bookGiving : bookTicket, error: null });
        });
        return c;
      }
      return chainable();
    });

    const result = await recoverGeneric({ ...BASE_CTX, supabase: mockSupa as any });

    expect(result.type).toBe('disambiguation');
    if (result.type === 'disambiguation') {
      const purposes = result.candidates.map(c => c.purpose);
      expect(purposes).toContain('payment');
      expect(purposes).toContain('ticket');
    }
  });

  // Test 22: Scheduling, Reservation, Invoice, Donation → purpose-appropriate labels
  it('purpose-appropriate recovery for scheduling, reservation, invoice, donation', async () => {
    const { recoverGeneric } = await loadModule();

    // 4 payments with different entity FKs
    const payments = [
      makePayment({ id: 'p-sched', gateway_reference: 'gw-sched', booking_id: 'bk-sched', order_id: null }),
      makePayment({ id: 'p-res', gateway_reference: 'gw-res', booking_id: null, reservation_id: 'res-1', order_id: null }),
      makePayment({ id: 'p-inv', gateway_reference: 'gw-inv', booking_id: null, invoice_id: 'inv-1', order_id: null }),
      makePayment({ id: 'p-don', gateway_reference: 'gw-don', booking_id: null, campaign_id: 'camp-1', order_id: null }),
    ];

    let bookingCalls = 0;
    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.limit = vi.fn().mockResolvedValue({ data: payments, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockImplementation(() => {
          bookingCalls++;
          return Promise.resolve({ data: { reference_code: 'SCH-500', flow_type: 'scheduling', guest_phone: '+12345678901' }, error: null });
        });
        return c;
      }
      if (table === 'reservations') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: { reference_code: 'RES-600', guest_phone: '+12345678901' }, error: null });
        return c;
      }
      if (table === 'invoices') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: { reference_code: 'INV-700', customer_phone: '+12345678901' }, error: null });
        return c;
      }
      if (table === 'campaign_donations') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: { reference_code: 'DON-800', donor_phone: '+12345678901' }, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverGeneric({ ...BASE_CTX, supabase: mockSupa as any });

    expect(result.type).toBe('disambiguation');
    if (result.type === 'disambiguation') {
      // Should have up to 3 candidates (limit)
      expect(result.candidates.length).toBeGreaterThanOrEqual(3);
      const purposes = result.candidates.map(c => c.purpose);
      expect(purposes).toContain('appointment'); // scheduling maps to appointment
    }
  });

  // Test 23: Purpose-appropriate copy: donation confirmed says correct text
  it('purpose-appropriate copy: donation confirmed message uses correct label', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({ status: 'success', booking_id: null, campaign_id: 'camp-1', order_id: null });

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'campaign_donations') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: { reference_code: 'DON-999', donor_phone: '+12345678901' }, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');

    expect(result.type).toBe('confirmed');
    expect(result.message).toContain('donation');
    // Must NOT say "order"
    expect(result.message).not.toContain('order');
  });

  // Test 24: Already-successful recovery never calls provider
  it('already-successful recovery never calls reconcilePayment', async () => {
    const { recoverGeneric } = await loadModule();
    const payment = makePayment({ status: 'success', gateway_reference: 'gw-done' });
    const booking = makeBooking();

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        // Candidate list
        c.limit = vi.fn().mockResolvedValue({ data: [payment], error: null });
        // Direct lookup in recoverByPaymentReference
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
        return c;
      }
      return chainable();
    });

    await recoverGeneric({ ...BASE_CTX, supabase: mockSupa as any });

    expect(mockReconcile).not.toHaveBeenCalled();
  });

  // Test 25: Provider outcome fidelity: not_paid distinct from provider_error
  it('provider outcome fidelity: not_paid distinct from provider_error', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({ status: 'pending' });
    const booking = makeBooking();

    const makeSupaForPending = () => createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
        return c;
      }
      return chainable();
    });

    // not_paid → not_found
    mockReconcile.mockResolvedValue({
      providerOutcome: 'not_paid',
      lifecycle: null,
      acknowledgeSuccess: false,
    });
    const notPaidResult = await recoverByPaymentReference({ ...BASE_CTX, supabase: makeSupaForPending() as any }, 'gw-ref-1');

    vi.clearAllMocks();

    // config_error → error
    mockReconcile.mockResolvedValue({
      providerOutcome: 'config_error',
      lifecycle: null,
      acknowledgeSuccess: false,
    });
    const errorResult = await recoverByPaymentReference({ ...BASE_CTX, supabase: makeSupaForPending() as any }, 'gw-ref-1');

    // They must produce different outcome types
    expect(notPaidResult.type).toBe('not_found');
    expect(errorResult.type).toBe('error');
    expect(notPaidResult.type).not.toBe(errorResult.type);
  });
});

// ═══════════════════════════════════════════════════════════
// C. LEGACY COMPATIBILITY (26-27)
// ═══════════════════════════════════════════════════════════

describe('recoverByOrderReference — legacy compatibility', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // Test 26: Valid order with successful payment → confirmed
  it('valid order with successful payment → returns confirmed', async () => {
    const { recoverByOrderReference } = await loadModule();
    const order = makeOrder();
    const payment = {
      id: 'pay-ord',
      status: 'success',
      gateway_reference: 'gw-ord',
      user_id: 'user-1',
      finalization_completed_at: new Date().toISOString(),
      confirmation_sent_at: null,
      paid_at: new Date().toISOString(),
      amount: 3000,
      created_at: new Date().toISOString(),
    };

    const mockSupa = createMockSupabase((table) => {
      if (table === 'orders') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: order, error: null });
        return c;
      }
      if (table === 'payments') {
        const c = chainable();
        // inspectOrderPayments queries payments list
        c.order = vi.fn().mockResolvedValue({ data: [payment], error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByOrderReference({ ...BASE_CTX, supabase: mockSupa as any }, 'ORD-001');

    expect(result.type).toBe('confirmed');
    expect(result.message).toContain('ORD-001');
  });

  // Test 27: Generic recoverGeneric with only orders → still works
  it('recoverGeneric with only order-linked payments → still works (backward-compatible)', async () => {
    const { recoverGeneric } = await loadModule();
    const payment = makePayment({ status: 'success', gateway_reference: 'gw-ord-only', order_id: 'ord-1', booking_id: null });
    const orderData = { reference_code: 'ORD-LEGACY', delivery_phone: '+12345678901' };

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        // Candidate list for user-based query
        c.limit = vi.fn().mockResolvedValue({ data: [payment], error: null });
        // Direct lookup in recoverByPaymentReference
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'orders') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: orderData, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverGeneric({ ...BASE_CTX, supabase: mockSupa as any });

    expect(result.type).toBe('confirmed');
    expect(result.message).toContain('Payment Confirmed');
  });
});

// ═══════════════════════════════════════════════════════════
// D. NOTIFICATION FIXES (28-29)
// ═══════════════════════════════════════════════════════════

describe('send-confirmation.ts — notification type correctness', () => {
  function readSendConfirmation(): string {
    const fs = require('fs');
    return fs.readFileSync('lib/payments/send-confirmation.ts', 'utf-8');
  }

  // Test 28: Uses type: 'payment' not 'payment_received'
  it('uses type: "payment" not "payment_received"', () => {
    const src = readSendConfirmation();
    // Must have type: 'payment' somewhere for payment notifications
    expect(src).toContain("type: 'payment'");
    // Must NOT use deprecated 'payment_received'
    expect(src).not.toContain("type: 'payment_received'");
  });

  // Test 29: Does not use type: 'donation' — uses type: 'payment' for all
  it('does not use type: "donation" for notification creation', () => {
    const src = readSendConfirmation();
    // Donation notifications should use type: 'payment', not 'donation'
    expect(src).not.toContain("type: 'donation'");
  });
});

// ═══════════════════════════════════════════════════════════
// E. SAFETY INVARIANTS (30-31)
// ═══════════════════════════════════════════════════════════

describe('Safety invariants — no financial charge on recovery', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // Test 30: Recovery of success status never creates financial charge
  it('recovery of success status never calls reconcilePayment (no provider call)', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({ status: 'success' });
    const booking = makeBooking();

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
        return c;
      }
      return chainable();
    });

    await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');

    // reconcilePayment is the gateway to provider calls — must not be invoked for success
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  // Test 31: Source file does not import charge-creating modules at top level
  it('stale-payment-recovery.ts does not import charge-creating modules', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/stale-payment-recovery.ts', 'utf-8');

    // Extract only actual import/require lines (not comments)
    const importLines = src.split('\n').filter((line: string) =>
      (line.trimStart().startsWith('import ') || line.includes('require('))
      && !line.trimStart().startsWith('//')
      && !line.trimStart().startsWith('*')
    ).join('\n');

    // Must not directly import payment processing or charge modules
    expect(importLines).not.toContain('processSuccessfulPayment');
    expect(importLines).not.toContain('sendProactiveConfirmation');
    expect(importLines).not.toContain('handlePostCompletion');
    expect(importLines).not.toContain('recordPlatformFee');
    expect(importLines).not.toContain('createPaymentIntent');
    expect(importLines).not.toContain('chargeCard');
    // reconcilePayment is only dynamically imported inside pending branches, not top-level
    expect(importLines).not.toContain("from './reconcile'");
  });
});

// ═══════════════════════════════════════════════════════════
// F. CTO REVIEW BLOCKERS — BEHAVIORAL HARDENING (32-35)
// ═══════════════════════════════════════════════════════════

describe('CTO review blockers — behavioral hardening', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // Test 32: Identity fail-closed — null user_id + null entity phone → not_found, reconcile NOT called
  it('identity fail-closed: null user_id + null entity phone → not_found, reconcile NOT called', async () => {
    const { recoverByPaymentReference } = await loadModule();
    // Payment has user_id: null — forces phone-based identity path
    const payment = makePayment({ status: 'success', user_id: null, booking_id: null, order_id: null, campaign_id: null, invoice_id: null, reservation_id: null });

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByPaymentReference({ ...BASE_CTX, userId: null, supabase: mockSupa as any }, 'gw-ref-1');

    // Must fail closed — no user_id and resolvePaymentPurpose returns phone: null for unknown purpose
    expect(result.type).toBe('not_found');
    // reconcilePayment must NOT be called — identity could not be proven
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  // Test 33: Campaign donation uses the payment's own ID (not order_id) for campaign_donations query
  it('campaign donation queries campaign_donations with payment.id, not order_id', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({
      id: 'pay-donation-1',
      status: 'success',
      user_id: 'user-1',
      campaign_id: 'camp-1',
      booking_id: null,
      order_id: null,
      invoice_id: null,
      reservation_id: null,
    });

    // Track what arguments .eq receives on campaign_donations chain
    const eqArgs: Array<[string, string]> = [];
    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'campaign_donations') {
        const c = chainable();
        c.eq = vi.fn((...args: unknown[]) => {
          eqArgs.push([args[0] as string, args[1] as string]);
          return c;
        });
        c.maybeSingle = vi.fn().mockResolvedValue({
          data: { reference_code: 'DON-TEST', donor_phone: '+12345678901' },
          error: null,
        });
        return c;
      }
      return chainable();
    });

    await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');

    // Verify that campaign_donations was queried with payment_id = payment.id ('pay-donation-1')
    const paymentIdEq = eqArgs.find(([col]) => col === 'payment_id');
    expect(paymentIdEq).toBeDefined();
    expect(paymentIdEq![1]).toBe('pay-donation-1');
  });

  // Test 34: Failed payment copy does NOT encourage retry — says "contact" instead
  it('failed payment copy does not encourage retry — says "contact" instead', async () => {
    const { recoverByPaymentReference } = await loadModule();
    const payment = makePayment({ status: 'failed' });
    const booking = makeBooking();

    const mockSupa = createMockSupabase((table) => {
      if (table === 'payments') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
        return c;
      }
      if (table === 'bookings') {
        const c = chainable();
        c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
        return c;
      }
      return chainable();
    });

    const result = await recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');

    expect(result.type).toBe('not_found');
    // Must NOT contain retry/re-charge encouragement
    expect(result.message.toLowerCase()).not.toContain('try again');
    expect(result.message.toLowerCase()).not.toContain('get a new');
    expect(result.message.toLowerCase()).not.toContain('pay again');
    expect(result.message.toLowerCase()).not.toContain('new payment');
    // Must direct to contact/support
    expect(result.message.toLowerCase()).toContain('contact');
  });

  // Test 35: Giving vs generic Payment purpose — purpose-appropriate copy
  it('giving vs generic payment purpose — purpose-appropriate copy', async () => {
    const { recoverByPaymentReference } = await loadModule();

    // Helper to run recovery with a specific booking
    async function recoverWithBooking(booking: Record<string, unknown>) {
      const payment = makePayment({ status: 'success', booking_id: 'bk-test', order_id: null });
      const mockSupa = createMockSupabase((table) => {
        if (table === 'payments') {
          const c = chainable();
          c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
          return c;
        }
        if (table === 'bookings') {
          const c = chainable();
          c.maybeSingle = vi.fn().mockResolvedValue({ data: booking, error: null });
          return c;
        }
        return chainable();
      });
      return recoverByPaymentReference({ ...BASE_CTX, supabase: mockSupa as any }, 'gw-ref-1');
    }

    // Case A: flow_type='payment' + service_type='giving' → copy contains "giving"
    const givingResult = await recoverWithBooking({
      reference_code: 'GIV-TEST',
      flow_type: 'payment',
      guest_phone: '+12345678901',
      services: { service_type: 'giving' },
    });
    expect(givingResult.type).toBe('confirmed');
    expect(givingResult.message.toLowerCase()).toContain('giving');

    // Case B: flow_type='payment' + service_type='booking' → copy says "payment" not "giving"
    const paymentResult = await recoverWithBooking({
      reference_code: 'PAY-TEST',
      flow_type: 'payment',
      guest_phone: '+12345678901',
      services: { service_type: 'booking' },
    });
    expect(paymentResult.type).toBe('confirmed');
    expect(paymentResult.message.toLowerCase()).toContain('payment');
    expect(paymentResult.message.toLowerCase()).not.toContain('giving');
  });
});
