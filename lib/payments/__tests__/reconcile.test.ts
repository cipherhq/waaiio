/**
 * Shared reconciliation orchestrator tests.
 * Proves provider outcome mapping and authority convergence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

const mockVerify = vi.fn();
const mockAuthorize = vi.fn();
const mockProcess = vi.fn();
const mockConfirm = vi.fn();

vi.mock('../provider-adapters', () => ({
  verifyWithProvider: (...args: unknown[]) => mockVerify(...args),
}));
vi.mock('../authority', () => ({
  authorizeAndFinalize: (...args: unknown[]) => mockAuthorize(...args),
}));
vi.mock('../process-success', () => ({
  processSuccessfulPayment: (...args: unknown[]) => mockProcess(...args),
}));
vi.mock('../send-confirmation', () => ({
  sendProactiveConfirmation: (...args: unknown[]) => mockConfirm(...args),
}));

const PAYMENT = {
  id: 'pay-1', amount: 5000, currency: 'NGN', gateway: 'paystack',
  gateway_reference: 'REF-1', status: 'pending', business_id: 'biz-1',
  booking_id: 'bk-1', invoice_id: null, campaign_id: null,
  reservation_id: null, order_id: null, metadata: { payment_origin: 'platform' },
  gateway_fee: 0, payment_authority_version: 1, finalization_completed_at: null,
};

// eslint-disable-next-line
function buildSupabase(paymentRow = PAYMENT): any {
  // eslint-disable-next-line
  const c: Record<string, any> = {};
  ['select', 'eq', 'neq', 'not', 'is', 'order', 'limit', 'like', 'in', 'update'].forEach(
    m => c[m] = vi.fn().mockReturnValue(c),
  );
  c.single = vi.fn().mockResolvedValue({ data: paymentRow, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: paymentRow, error: null });
  return { from: vi.fn(() => c), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

describe('reconcilePayment', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('1. verified → calls authority once', async () => {
    mockAuthorize.mockResolvedValue({ status: 'completed', retryable: false, stages: { providerPaid: true, businessFinalized: true, customerConfirmed: true } });
    const { reconcilePayment } = await import('../reconcile');
    const r = await reconcilePayment(buildSupabase(), 'pay-1', 'webhook', { status: 'verified', result: { provider: 'paystack', waaiioReference: 'REF-1', amount: 5000, currency: 'NGN', verifiedAt: '', providerStatus: 'success' } });
    expect(r.providerOutcome).toBe('verified');
    expect(r.lifecycle?.status).toBe('completed');
    expect(mockAuthorize).toHaveBeenCalledTimes(1);
  });

  it('2. not_paid → authority NOT called', async () => {
    const { reconcilePayment } = await import('../reconcile');
    const r = await reconcilePayment(buildSupabase(), 'pay-1', 'webhook', { status: 'not_paid', reason: 'provider_failed' });
    expect(r.providerOutcome).toBe('not_paid');
    expect(r.lifecycle).toBeNull();
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('3. retryable_error → authority NOT called', async () => {
    const { reconcilePayment } = await import('../reconcile');
    const r = await reconcilePayment(buildSupabase(), 'pay-1', 'webhook', { status: 'retryable_error', reason: 'timeout' });
    expect(r.providerOutcome).toBe('retryable_error');
    expect(r.lifecycle).toBeNull();
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(r.acknowledgeSuccess).toBe(false); // retryable — do NOT ack
  });

  it('4. config_error → authority NOT called', async () => {
    const { reconcilePayment } = await import('../reconcile');
    const r = await reconcilePayment(buildSupabase(), 'pay-1', 'webhook', { status: 'config_error', reason: 'missing_key' });
    expect(r.providerOutcome).toBe('config_error');
    expect(r.lifecycle).toBeNull();
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('5. payment load error → config_error', async () => {
    const { reconcilePayment } = await import('../reconcile');
    const supabase = buildSupabase();
    supabase.from = vi.fn(() => {
      // eslint-disable-next-line
      const c: Record<string, any> = {};
      ['select', 'eq'].forEach(m => c[m] = vi.fn().mockReturnValue(c));
      c.single = vi.fn().mockResolvedValue({ data: null, error: { message: 'db' } });
      return c;
    });
    const r = await reconcilePayment(supabase, 'pay-missing', 'webhook');
    expect(r.providerOutcome).toBe('config_error');
    expect(r.lifecycle).toBeNull();
  });

  it('6. verified + authority already_completed → lifecycle preserved', async () => {
    mockAuthorize.mockResolvedValue({ status: 'already_completed', retryable: false, stages: { providerPaid: true, businessFinalized: true, customerConfirmed: true } });
    const { reconcilePayment } = await import('../reconcile');
    const r = await reconcilePayment(buildSupabase(), 'pay-1', 'webhook', { status: 'verified', result: { provider: 'paystack', waaiioReference: 'REF-1', amount: 5000, currency: 'NGN', verifiedAt: '', providerStatus: 'success' } });
    expect(r.lifecycle?.status).toBe('already_completed');
  });

  it('7. verified + authority processing → lifecycle preserved, not collapsed', async () => {
    mockAuthorize.mockResolvedValue({ status: 'processing', retryable: true, stages: { providerPaid: true, businessFinalized: false, customerConfirmed: false } });
    const { reconcilePayment } = await import('../reconcile');
    const r = await reconcilePayment(buildSupabase(), 'pay-1', 'webhook', { status: 'verified', result: { provider: 'paystack', waaiioReference: 'REF-1', amount: 5000, currency: 'NGN', verifiedAt: '', providerStatus: 'success' } });
    expect(r.lifecycle?.status).toBe('processing');
    expect(r.lifecycle?.status).not.toBe('completed');
  });
});
