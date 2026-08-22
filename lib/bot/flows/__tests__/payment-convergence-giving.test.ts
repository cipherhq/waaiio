/**
 * Payment / Direct Giving — "I've Paid" convergence + cancel-race tests.
 *
 * EXECUTABLE BEHAVIORAL TESTS: invoke real await_payment validate()/next()
 * with verifyAndReconcilePayment mocked at its module boundary.
 *
 * SOURCE-STRING GUARDS: supplemental structural assertions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { paymentFlow } from '../payment.flow';

// ── Mock verifyAndReconcilePayment at module boundary ──
const mockRecovery = vi.fn();
vi.mock('@/lib/payments/bot-recovery', () => ({
  verifyAndReconcilePayment: (...args: unknown[]) => mockRecovery(...args),
}));

// Mock logger to suppress noise
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

const step = getStep(paymentFlow, 'await_payment');

function buildCtx(sessionOverrides: Record<string, unknown> = {}, supabaseOverrides?: Record<string, unknown>) {
  // eslint-disable-next-line
  const chainable = (): Record<string, any> => {
    // eslint-disable-next-line
    const c: Record<string, any> = {};
    ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'or', 'in', 'is', 'not', 'gte', 'lte', 'order', 'limit'].forEach(
      m => c[m] = vi.fn().mockReturnValue(c),
    );
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  };

  const supabase = {
    from: vi.fn(() => chainable()),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...supabaseOverrides,
  };

  return createMockContext({
    // eslint-disable-next-line
    supabase: supabase as any,
    session: {
      id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'await_payment', version: 0,
      session_data: {
        active_capability: 'payment',
        payment_reference: 'ref-123',
        booking_id: 'bk-1',
        reference_code: 'PAY-001',
        service_name: 'Membership',
        amount: 5000,
        ...sessionOverrides,
      },
    },
    business: {
      id: 'b1', name: 'Test Church', slug: 'test-church',
      // eslint-disable-next-line
      category: 'church' as any, flow_type: 'payment' as any,
      subscription_tier: 'growth',
      trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
      metadata: {},
    },
  });
}

// ═══════════════════════════════════════════════════════════
// A. EXECUTABLE I'VE PAID BOUNDARY TESTS
// ═══════════════════════════════════════════════════════════

describe('await_payment.validate — I\'ve Paid authority convergence', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('completed: brief ack, already_confirmed, no legacy writers', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'completed', paymentId: 'p1' });
    const ctx = buildCtx();

    const result = await step.validate('i_paid', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('already_confirmed');
    expect(mockRecovery).toHaveBeenCalledOnce();
    // Brief ack sent
    expect(ctx.sender.sendText).toHaveBeenCalledOnce();
    const msg = (ctx.sender.sendText as ReturnType<typeof vi.fn>).mock.calls[0][0].text;
    expect(msg).toContain('Payment Confirmed');
    expect(msg).toContain('PAY-001');
    // No legacy writers invoked (supabase.from only called from mock setup, not from validate)
    const fromCalls = (ctx.supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(fromCalls).not.toContain('customer_profiles');
    expect(fromCalls).not.toContain('platform_fees');
  });

  it('completed (Giving): Giving-specific tips', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'completed', paymentId: 'p1' });
    const ctx = buildCtx({ active_capability: 'giving' });

    const result = await step.validate('i_paid', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('already_confirmed');
    const msg = (ctx.sender.sendText as ReturnType<typeof vi.fn>).mock.calls[0][0].text;
    expect(msg).toContain('my giving');
  });

  it('not_deliverable: terminal ack, already_confirmed', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_deliverable', paymentId: 'p1' });
    const ctx = buildCtx();

    const result = await step.validate('i_paid', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('already_confirmed');
    expect(ctx.sender.sendText).toHaveBeenCalledOnce();
  });

  it('processing: recoverable at await_payment, no false "not paid"', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'processing', paymentId: 'p1' });
    const ctx = buildCtx();

    const result = await step.validate('i_paid', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('payment_processing');
    const msg = (ctx.sender.sendText as ReturnType<typeof vi.fn>).mock.calls[0][0].text;
    expect(msg).toContain('Payment received');
    expect(msg).not.toContain('not yet received');
  });

  it('retryable: same recoverable behavior as processing', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'retryable', paymentId: 'p1' });
    const ctx = buildCtx();

    const result = await step.validate('i_paid', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('payment_processing');
  });

  it('not_verified: non-success retry UX', async () => {
    mockRecovery.mockResolvedValue({ outcome: 'not_verified' });
    const ctx = buildCtx();

    const result = await step.validate('i_paid', ctx);

    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('not yet received');
  });
});

// ═══════════════════════════════════════════════════════════
// B. EXECUTABLE CANCEL-VS-PAYMENT BOUNDARY TESTS
// ═══════════════════════════════════════════════════════════

describe('await_payment.validate — cancel CAS boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('pending cancel succeeds + pending_transfer cancelled', async () => {
    const ctx = buildCtx({ bank_transfer_reference: 'TRF-001' });
    // Mock: booking cancel returns one row (success)
    const bookingChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ id: 'bk-1' }], error: null }),
    };
    const transferChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'bookings') return bookingChain;
      if (table === 'pending_transfers') return transferChain;
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const result = await step.validate('cancel', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('cancel');
    // Booking was cancelled with pending guard
    expect(bookingChain.in).toHaveBeenCalledWith('status', ['pending']);
    // Pending transfer was cancelled
    expect(transferChain.update).toHaveBeenCalled();
    // Customer told cancellation succeeded
    const msg = (ctx.sender.sendText as ReturnType<typeof vi.fn>).mock.calls[0][0].text;
    expect(msg).toContain('cancelled');
  });

  it('payment won: zero-row cancel → already_confirmed, NO pending_transfer cancel', async () => {
    const ctx = buildCtx({ bank_transfer_reference: 'TRF-001' });
    // Mock: cancel returns zero rows (booking no longer pending)
    const bookingChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
      // Re-read returns paid/confirmed
      single: vi.fn().mockResolvedValue({
        data: { status: 'confirmed', deposit_status: 'paid' }, error: null,
      }),
    };
    // Re-read chain needs select→eq→single
    const rereadChain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { status: 'confirmed', deposit_status: 'paid' }, error: null,
          }),
        }),
      }),
    };
    let callCount = 0;
    (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'bookings') {
        callCount++;
        if (callCount === 1) return bookingChain; // cancel UPDATE
        return rereadChain; // re-read SELECT
      }
      if (table === 'pending_transfers') {
        throw new Error('pending_transfers should NOT be touched when payment won');
      }
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const result = await step.validate('cancel', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('already_confirmed');
    const msg = (ctx.sender.sendText as ReturnType<typeof vi.fn>).mock.calls[0][0].text;
    expect(msg).toContain('confirmed');
  });

  it('already cancelled: zero-row cancel → cancellation established, pending_transfer cancelled', async () => {
    const ctx = buildCtx({ bank_transfer_reference: 'TRF-001' });
    const bookingChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const rereadChain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { status: 'cancelled', deposit_status: 'unpaid' }, error: null,
          }),
        }),
      }),
    };
    const transferChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    let callCount = 0;
    (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'bookings') {
        callCount++;
        return callCount === 1 ? bookingChain : rereadChain;
      }
      if (table === 'pending_transfers') return transferChain;
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const result = await step.validate('cancel', ctx);

    expect(result.valid).toBe(true);
    expect(result.data?._action).toBe('cancel');
    expect(transferChain.update).toHaveBeenCalled();
  });

  it('unknown non-pending state: fail closed, NO pending_transfer cancel', async () => {
    const ctx = buildCtx({ bank_transfer_reference: 'TRF-001' });
    const bookingChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const rereadChain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { status: 'in_progress', deposit_status: 'unpaid' }, error: null,
          }),
        }),
      }),
    };
    let callCount = 0;
    (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'bookings') {
        callCount++;
        return callCount === 1 ? bookingChain : rereadChain;
      }
      if (table === 'pending_transfers') {
        throw new Error('pending_transfers should NOT be touched for unknown state');
      }
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const result = await step.validate('cancel', ctx);

    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('Something went wrong');
  });

  it('cancel UPDATE DB error: fail closed', async () => {
    const ctx = buildCtx();
    const bookingChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } }),
    };
    (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'bookings') return bookingChain;
      if (table === 'pending_transfers') {
        throw new Error('pending_transfers should NOT be touched on DB error');
      }
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const result = await step.validate('cancel', ctx);

    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('Something went wrong');
  });

  it('zero-row re-read error: fail closed', async () => {
    const ctx = buildCtx();
    const bookingChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const rereadChain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: { message: 'timeout' } }),
        }),
      }),
    };
    let callCount = 0;
    (ctx.supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'bookings') {
        callCount++;
        return callCount === 1 ? bookingChain : rereadChain;
      }
      if (table === 'pending_transfers') {
        throw new Error('pending_transfers should NOT be touched on re-read error');
      }
      return { update: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const result = await step.validate('cancel', ctx);

    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('Something went wrong');
  });
});

// ═══════════════════════════════════════════════════════════
// C. EXECUTABLE next() ROUTING TESTS
// ═══════════════════════════════════════════════════════════

describe('await_payment.next — post-convergence routing', () => {
  it('already_confirmed → null (flow ends)', async () => {
    const ctx = buildCtx({ _action: 'already_confirmed' });
    const next = await step.next(ctx);
    expect(next).toBeNull();
  });

  it('payment_processing → await_payment (stays for retry)', async () => {
    const ctx = buildCtx({ _action: 'payment_processing' });
    const next = await step.next(ctx);
    expect(next).toBe('await_payment');
  });

  it('cancel → null (flow ends)', async () => {
    const ctx = buildCtx({ _action: 'cancel' });
    const next = await step.next(ctx);
    expect(next).toBeNull();
  });

  it('retry_payment → process_payment', async () => {
    const ctx = buildCtx({ _action: 'retry_payment' });
    const next = await step.next(ctx);
    expect(next).toBe('process_payment');
  });
});

// ═══════════════════════════════════════════════════════════
// D. SOURCE-STRING GUARDS (supplemental)
// ═══════════════════════════════════════════════════════════

function readPaymentFlow(): string {
  const fs = require('fs');
  return fs.readFileSync('lib/bot/flows/payment.flow.ts', 'utf-8');
}

describe('Source guards: no legacy writers', () => {
  it('I\'ve Paid section has no legacy financial effects', () => {
    const src = readPaymentFlow();
    const section = src.split("text === 'i_paid'")[1]?.split("Payment not yet received")[0] || '';
    expect(section).toContain('verifyAndReconcilePayment');
    expect(section).not.toContain('total_spent');
    expect(section).not.toContain('recordPlatformFee');
    expect(section).not.toContain('handlePostCompletion');
    expect(section).not.toContain('calculateLtvTier');
  });

  it('imports do not include removed dependencies', () => {
    const src = readPaymentFlow();
    const importSection = src.split('export const')[0];
    expect(importSection).not.toContain('verifyPayment');
    expect(importSection).not.toContain('recordPlatformFee');
    expect(importSection).not.toContain('handlePostCompletion');
    expect(importSection).not.toContain('getPaymentReceiptMessage');
    expect(importSection).not.toContain('calculateLtvTier');
    expect(importSection).not.toContain('createServiceClient');
    expect(importSection).not.toContain('getPlatformFees');
  });

  it('cancel section has CAS guard and fail-closed branches', () => {
    const src = readPaymentFlow();
    const section = src.split("text === 'cancel'")[1]?.split("Bank transfer proof")[0] || '';
    expect(section).toContain(".in('status', ['pending'])");
    expect(section).toContain('cancelResult?.length');
    expect(section).toContain("deposit_status === 'paid'");
    expect(section).toContain("status === 'cancelled'");
  });

  it('dead payment_confirmed→recurring routing is removed', () => {
    const src = readPaymentFlow();
    const nextArea = src.split("'retry_payment'")[1]?.split('Offer Recurring')[0] || '';
    expect(nextArea).not.toContain("'payment_confirmed'");
    expect(nextArea).not.toContain('offer_recurring');
  });

  it('bank transfer proof handling is unchanged', () => {
    const src = readPaymentFlow();
    expect(src).toContain('analyzeReceipt');
    expect(src).toContain('receiptMatchesExpected');
    expect(src).toContain('transfer_proof_sent');
    const btSection = src.split('Bank transfer proof')[1]?.split('I\'ve Sent Transfer')[0] || '';
    expect(btSection).toContain('notifyOwnerNewPayment');
  });
});
