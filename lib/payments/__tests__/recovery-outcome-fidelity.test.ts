/**
 * Payment Recovery Outcome Fidelity — #168
 *
 * Tests verifyAndReconcilePayment preserves provider-verification fidelity
 * and the recovery-gated retry_payment contract across all flows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock reconcilePayment at module boundary ──
const mockReconcile = vi.fn();
vi.mock('@/lib/payments/reconcile', () => ({
  reconcilePayment: (...args: unknown[]) => mockReconcile(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

describe('verifyAndReconcilePayment — outcome fidelity', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  async function callRecovery(providerOutcome: string, lifecycle: unknown = null) {
    const { verifyAndReconcilePayment } = await import('../bot-recovery');
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }),
      }),
    };
    mockReconcile.mockResolvedValue({ providerOutcome, lifecycle, acknowledgeSuccess: true });
    // eslint-disable-next-line
    return verifyAndReconcilePayment(supabase as any, 'ref-123');
  }

  it('not_paid → outcome: not_paid', async () => {
    const r = await callRecovery('not_paid');
    expect(r.outcome).toBe('not_paid');
    expect(r.paymentId).toBe('p1');
  });

  it('retryable_error → outcome: provider_error', async () => {
    const r = await callRecovery('retryable_error');
    expect(r.outcome).toBe('provider_error');
    expect(r.paymentId).toBe('p1');
  });

  it('config_error → outcome: not_verified', async () => {
    const r = await callRecovery('config_error');
    expect(r.outcome).toBe('not_verified');
    expect(r.paymentId).toBe('p1');
  });

  it('completed lifecycle → outcome: completed (unchanged)', async () => {
    const r = await callRecovery('verified', { status: 'completed' });
    expect(r.outcome).toBe('completed');
  });

  it('already_completed lifecycle → outcome: completed (unchanged)', async () => {
    const r = await callRecovery('verified', { status: 'already_completed' });
    expect(r.outcome).toBe('completed');
  });

  it('not_deliverable lifecycle → outcome: not_deliverable (unchanged)', async () => {
    const r = await callRecovery('verified', { status: 'not_deliverable' });
    expect(r.outcome).toBe('not_deliverable');
  });

  it('processing lifecycle → outcome: processing (unchanged)', async () => {
    const r = await callRecovery('verified', { status: 'processing' });
    expect(r.outcome).toBe('processing');
  });

  it('retryable_failed lifecycle → outcome: retryable (unchanged)', async () => {
    const r = await callRecovery('verified', { status: 'retryable_failed' });
    expect(r.outcome).toBe('retryable');
  });

  it('payment row not found → outcome: not_verified (no paymentId)', async () => {
    const { verifyAndReconcilePayment } = await import('../bot-recovery');
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    };
    // eslint-disable-next-line
    const r = await verifyAndReconcilePayment(supabase as any, 'ref-999');
    expect(r.outcome).toBe('not_verified');
    expect(r.paymentId).toBeUndefined();
  });
});
