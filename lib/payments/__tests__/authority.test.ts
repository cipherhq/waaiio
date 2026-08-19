/**
 * Payment Authority — Phase 1 Core Lifecycle Tests
 *
 * Executable behavioral tests for the three-stage payment state machine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedPaymentResult, FinalizationResult, PaymentLifecycleResult } from '../authority';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

function makeVerified(overrides: Partial<VerifiedPaymentResult> = {}): VerifiedPaymentResult {
  return {
    provider: 'paystack', waaiioReference: 'REF-001', amount: 5000,
    currency: 'NGN', verifiedAt: new Date().toISOString(), ...overrides,
  };
}

const PAYMENT_ROW = {
  id: 'pay-1', amount: 5000, currency: 'NGN', gateway: 'paystack', status: 'pending',
  booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null,
  order_id: null, metadata: {}, gateway_fee: 0, finalization_completed_at: null,
  payment_authority_version: 1,
};

// eslint-disable-next-line
function mockChain(overrides: Record<string, unknown> = {}): any {
  // eslint-disable-next-line
  const c: Record<string, any> = {};
  ['select', 'eq', 'neq', 'not', 'is', 'order', 'limit', 'like', 'update', 'in'].forEach(
    m => c[m] = vi.fn().mockReturnValue(c),
  );
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  Object.assign(c, overrides);
  return c;
}

function buildSupabase(opts: {
  paymentRow?: typeof PAYMENT_ROW | null;
  paymentError?: unknown;
  updateError?: unknown;
  claimResult?: unknown;
  claimError?: unknown;
  completeResult?: unknown;
  completeError?: unknown;
} = {}) {
  const rpcFn = vi.fn().mockImplementation((name: string) => {
    if (name === 'claim_payment_finalization') {
      return Promise.resolve({ data: opts.claimResult ?? null, error: opts.claimError ?? null });
    }
    if (name === 'complete_payment_finalization') {
      return Promise.resolve({ data: opts.completeResult ?? null, error: opts.completeError ?? null });
    }
    if (name === 'release_payment_finalization') {
      return Promise.resolve({ data: { released: true }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  const fromFn = vi.fn(() => mockChain({
    maybeSingle: vi.fn().mockResolvedValue({
      data: opts.paymentRow !== undefined ? opts.paymentRow : PAYMENT_ROW,
      error: opts.paymentError ?? null,
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({
            data: opts.updateError ? null : [{ id: 'pay-1' }],
            error: opts.updateError ?? null,
          }),
        }),
      }),
    }),
  }));

  // eslint-disable-next-line
  return { rpc: rpcFn, from: fromFn } as any;
}

const successProcess = vi.fn().mockResolvedValue({ criticalSuccess: true });
const failProcess = vi.fn().mockResolvedValue({ criticalSuccess: false, errors: ['booking_confirm_failed'] });
const completedConfirm = vi.fn().mockResolvedValue({ status: 'completed' });
const processingConfirm = vi.fn().mockResolvedValue({ status: 'processing', retryable: true });
const retryFailedConfirm = vi.fn().mockResolvedValue({ status: 'retryable_failed', retryable: true, reason: 'ticket_state_incomplete' });

describe('Payment Authority — Phase 1 Core', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── Input validation ──

  it('1. provider mismatch → rejected', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({ paymentRow: { ...PAYMENT_ROW, gateway: 'stripe' } });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('rejected');
    expect(r.reason).toContain('provider_mismatch');
    expect(r.stages.providerPaid).toBe(false);
  });

  it('2. amount mismatch → rejected', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({ paymentRow: { ...PAYMENT_ROW, amount: 3000 } });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('rejected');
    expect(r.reason).toContain('amount_mismatch');
  });

  it('3. currency mismatch → rejected', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({ paymentRow: { ...PAYMENT_ROW, currency: 'USD' } });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('rejected');
    expect(r.reason).toContain('currency_mismatch');
  });

  // ── Stage 1 failures ──

  it('4. payment lookup DB error → retryable', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({ paymentError: { message: 'connection refused' } });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('retryable_failed');
    expect(r.stages.providerPaid).toBe(false);
    expect(successProcess).not.toHaveBeenCalled();
  });

  // ── Stage 2: finalization claim ──

  it('5. finalization claim RPC error → retryable', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({ claimError: { message: 'rpc timeout' } });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('retryable_failed');
    expect(r.stages.providerPaid).toBe(true);
    expect(r.stages.businessFinalized).toBe(false);
  });

  it('6. another worker owns Stage 2 → processing', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({ claimResult: { claimed: false, reason: 'processing_in_progress' } });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('processing');
    expect(r.retryable).toBe(true);
    expect(r.stages.businessFinalized).toBe(false);
  });

  it('7. processSuccessfulPayment critical failure → Stage 2 incomplete', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({
      claimResult: { claimed: true, claim_token: 'tok', payment_id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, gateway_fee: 0 },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), failProcess, completedConfirm);
    expect(r.status).toBe('retryable_failed');
    expect(r.stages.businessFinalized).toBe(false);
    expect(completedConfirm).not.toHaveBeenCalled();
  });

  it('8. complete RPC transport error → Stage 2 incomplete', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({
      claimResult: { claimed: true, claim_token: 'tok', payment_id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, gateway_fee: 0 },
      completeError: { message: 'timeout' },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('retryable_failed');
    expect(r.stages.businessFinalized).toBe(false);
    expect(completedConfirm).not.toHaveBeenCalled();
  });

  it('9. complete RPC semantic false → Stage 2 incomplete', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({
      claimResult: { claimed: true, claim_token: 'tok', payment_id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, gateway_fee: 0 },
      completeResult: { completed: false, reason: 'token_mismatch' },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('processing');
    expect(r.stages.businessFinalized).toBe(false);
  });

  it('10. complete RPC success → Stage 2 complete → proceeds to Stage 3', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({
      claimResult: { claimed: true, claim_token: 'tok', payment_id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, gateway_fee: 0 },
      completeResult: { completed: true, already_completed: false },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('completed');
    expect(r.stages.businessFinalized).toBe(true);
    expect(r.stages.customerConfirmed).toBe(true);
    expect(completedConfirm).toHaveBeenCalledTimes(1);
  });

  // ── Stage 3: confirmation ──

  it('11. confirmation processing → lifecycle not complete', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({
      claimResult: { claimed: true, claim_token: 'tok', payment_id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, gateway_fee: 0 },
      completeResult: { completed: true, already_completed: false },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, processingConfirm);
    expect(r.status).toBe('processing');
    expect(r.stages.businessFinalized).toBe(true);
    expect(r.stages.customerConfirmed).toBe(false);
  });

  it('12. confirmation retryable_failed → lifecycle not complete', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({
      claimResult: { claimed: true, claim_token: 'tok', payment_id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, gateway_fee: 0 },
      completeResult: { completed: true, already_completed: false },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, retryFailedConfirm);
    expect(r.status).toBe('retryable_failed');
    expect(r.stages.businessFinalized).toBe(true);
    expect(r.stages.customerConfirmed).toBe(false);
  });

  it('13. confirmation completed → lifecycle complete', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({
      claimResult: { claimed: true, claim_token: 'tok', payment_id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, gateway_fee: 0 },
      completeResult: { completed: true, already_completed: false },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('completed');
    expect(r.stages).toEqual({ providerPaid: true, businessFinalized: true, customerConfirmed: true });
  });

  it('14. fully completed retry → skips to Stage 3 (already_completed finalization)', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({
      paymentRow: { ...PAYMENT_ROW, status: 'success', finalization_completed_at: '2026-08-10T00:00:00Z', payment_authority_version: 1 },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    // processPayment should NOT be called (finalization already done)
    expect(successProcess).not.toHaveBeenCalled();
    // Should still call confirmation (Stage 3)
    expect(completedConfirm).toHaveBeenCalledTimes(1);
    expect(r.stages.businessFinalized).toBe(true);
  });

  it('15. processPayment throws → releases claim, retryable', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const throwProcess = vi.fn().mockRejectedValue(new Error('DB crashed'));
    const supabase = buildSupabase({
      claimResult: { claimed: true, claim_token: 'tok', payment_id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, gateway_fee: 0 },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), throwProcess, completedConfirm);
    expect(r.status).toBe('retryable_failed');
    expect(r.stages.businessFinalized).toBe(false);
    // Should have called release
    expect(supabase.rpc).toHaveBeenCalledWith('release_payment_finalization', expect.any(Object));
  });

  // ── not_deliverable ──

  it('16. confirmation not_deliverable → not_deliverable lifecycle, NOT completed', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const notDeliverableConfirm = vi.fn().mockResolvedValue({ status: 'not_deliverable', retryable: false, reason: 'no_phone_or_email' });
    const supabase = buildSupabase({
      claimResult: { claimed: true, claim_token: 'tok', payment_id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, gateway_fee: 0 },
      completeResult: { completed: true, already_completed: false },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, notDeliverableConfirm);
    expect(r.status).toBe('not_deliverable');
    expect(r.retryable).toBe(false);
    expect(r.stages.providerPaid).toBe(true);
    expect(r.stages.businessFinalized).toBe(true);
    expect(r.stages.customerConfirmed).toBe(false);
    // Must NOT be 'completed'
    expect(r.status).not.toBe('completed');
    expect(r.status).not.toBe('already_completed');
  });

  // ── Legacy fence ──

  it('18. legacy success payment (no authority version) → rejected, NOT replayed', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({
      paymentRow: { ...PAYMENT_ROW, status: 'success', payment_authority_version: null },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('rejected');
    expect(r.reason).toContain('legacy_finalization_unverified');
    expect(successProcess).not.toHaveBeenCalled();
    expect(completedConfirm).not.toHaveBeenCalled();
  });

  it('19. new-authority pending payment → normal Stage 2 proceeds', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const supabase = buildSupabase({
      paymentRow: { ...PAYMENT_ROW, status: 'pending', payment_authority_version: 1 },
      claimResult: { claimed: true, claim_token: 'tok', payment_id: 'pay-1', amount: 5000, booking_id: 'bk-1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, gateway_fee: 0 },
      completeResult: { completed: true, already_completed: false },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, completedConfirm);
    expect(r.status).toBe('completed');
    expect(successProcess).toHaveBeenCalled();
  });

  it('17. not_deliverable on already-finalized retry → same truthful result', async () => {
    const { authorizeAndFinalize } = await import('../authority');
    const notDeliverableConfirm = vi.fn().mockResolvedValue({ status: 'not_deliverable', retryable: false, reason: 'no_phone_or_email' });
    const supabase = buildSupabase({
      paymentRow: { ...PAYMENT_ROW, status: 'success', finalization_completed_at: '2026-08-10T00:00:00Z', payment_authority_version: 1 },
    });
    const r = await authorizeAndFinalize(supabase, makeVerified(), successProcess, notDeliverableConfirm);
    expect(r.status).toBe('not_deliverable');
    expect(r.stages.businessFinalized).toBe(true);
    expect(r.stages.customerConfirmed).toBe(false);
    // processPayment should NOT be called (already finalized)
    expect(successProcess).not.toHaveBeenCalled();
  });
});
