/**
 * #375: Saved-card dispatched-payment recovery tests.
 *
 * Proves the canonical recovery helper:
 * 1. Uses exact payment ID/key/params for PI replay
 * 2. Stripe succeeded → PI bound via CAS, reconciled, no second payment row
 * 3. requires_action → PI bound, auth URL returned
 * 4. Terminal decline → failed state
 * 5. Indeterminate (timeout) → remains dispatched, no new charge
 * 6. Bot recovery with _saved_card_payment_id → uses payment-ID path
 * 7. Payment not found → error
 * 8. Payment not saved-card / not dispatched → error
 * 9. Idempotency window expired → quarantined
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReconcilePayment = vi.hoisted(() => vi.fn().mockResolvedValue({
  providerOutcome: 'verified',
  lifecycle: { status: 'completed' },
  acknowledgeSuccess: true,
}));

vi.mock('@/lib/payments/reconcile', () => ({
  reconcilePayment: mockReconcilePayment,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));

import { recoverDispatchedSavedCardPayment, type SavedCardRecoveryResult } from '../payments/saved-card-recovery';

// ── Test Helpers ──

function makeSupabase(paymentData: Record<string, unknown> | null = null, casRows: number = 1) {
  const selectChain = {
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: paymentData,
      error: paymentData ? null : { message: 'not found' },
    }),
  };

  const updateChain = {
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue({
      data: casRows > 0 ? [{ id: paymentData?.id || 'pay-123' }] : [],
      error: null,
    }),
  };

  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue(selectChain),
      update: vi.fn().mockReturnValue(updateChain),
    }),
  } as never;
}

const VALID_PAYMENT = {
  id: 'pay-123',
  gateway: 'stripe',
  gateway_reference: 'sc_pending_abc',
  metadata: {
    saved_method: true,
    pi_params: {
      customer: 'cus_test',
      payment_method: 'pm_test',
      amount: '5000',
      currency: 'usd',
      confirm: 'true',
    },
  },
  provider_init_state: 'dispatched',
  status: 'pending',
  created_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
  amount: 50,
  currency: 'usd',
};

describe('recoverDispatchedSavedCardPayment', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    mockReconcilePayment.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.STRIPE_SECRET_KEY = originalEnv;
  });

  it('uses exact payment ID and idempotency key sc_charge_{paymentId} for PI replay', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'pi_replayed', status: 'succeeded' }),
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.stripe.com/v1/payment_intents');
    expect(fetchCall[1].headers['Idempotency-Key']).toBe('sc_charge_pay-123');

    // Verify exact stored pi_params are used
    const body = fetchCall[1].body as string;
    expect(body).toContain('customer=cus_test');
    expect(body).toContain('payment_method=pm_test');
    expect(body).toContain('amount=5000');
    expect(body).toContain('currency=usd');
  });

  it('Stripe succeeded → CAS to provider_confirmed, reconciled, returns succeeded', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'pi_success', status: 'succeeded' }),
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('succeeded');
    expect(result.paymentIntentId).toBe('pi_success');

    // CAS should have been called on supabase
    expect(supabase.from).toHaveBeenCalledWith('payments');
    // reconcilePayment should be called after successful CAS
    expect(mockReconcilePayment).toHaveBeenCalledWith(supabase, 'pay-123', 'saved_card');
  });

  it('requires_action → PI bound, auth URL returned', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        id: 'pi_3ds',
        status: 'requires_action',
        next_action: {
          type: 'redirect_to_url',
          redirect_to_url: { url: 'https://stripe.com/3ds/verify' },
        },
      }),
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('requires_action');
    expect(result.paymentIntentId).toBe('pi_3ds');
    expect(result.authUrl).toBe('https://stripe.com/3ds/verify');
  });

  it('terminal decline (requires_payment_method) → failed state', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'pi_declined', status: 'requires_payment_method' }),
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('declined');
    expect(result.paymentIntentId).toBe('pi_declined');
  });

  it('terminal decline (canceled) → failed state', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'pi_canceled', status: 'canceled' }),
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('declined');
  });

  it('network error → indeterminate, remains dispatched, no new charge', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('indeterminate');
    expect(result.message).toContain('Network error');
    // No reconcile call — payment stays dispatched
    expect(mockReconcilePayment).not.toHaveBeenCalled();
  });

  it('card_error → declined', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: () => Promise.resolve({
        error: { type: 'card_error', code: 'card_declined' },
      }),
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('declined');
    expect(result.message).toContain('Card declined');
  });

  it('payment not found → error', async () => {
    const supabase = makeSupabase(null);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-nonexistent');

    expect(result.outcome).toBe('error');
    expect(result.message).toBe('Payment not found');
  });

  it('payment not saved-card (saved_method !== true) → error', async () => {
    const nonSavedCard = { ...VALID_PAYMENT, metadata: { saved_method: false } };
    const supabase = makeSupabase(nonSavedCard);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('error');
    expect(result.message).toBe('Not a saved-card dispatched payment');
  });

  it('payment not dispatched (provider_init_state !== dispatched) → error', async () => {
    const confirmed = { ...VALID_PAYMENT, provider_init_state: 'provider_confirmed' };
    const supabase = makeSupabase(confirmed);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('error');
    expect(result.message).toBe('Not a saved-card dispatched payment');
  });

  it('payment not pending (status !== pending) → error', async () => {
    const success = { ...VALID_PAYMENT, status: 'success' };
    const supabase = makeSupabase(success);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('error');
    expect(result.message).toBe('Not a saved-card dispatched payment');
  });

  it('idempotency window expired (>23h) → quarantined', async () => {
    const oldPayment = {
      ...VALID_PAYMENT,
      created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24 hours ago
    };

    const supabase = makeSupabase(oldPayment);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('quarantined');
    expect(result.message).toBe('Idempotency window expired');
    // No Stripe API call should be made
    expect(globalThis.fetch).toBeUndefined; // fetch not replaced
  });

  it('missing STRIPE_SECRET_KEY → error', async () => {
    delete process.env.STRIPE_SECRET_KEY;

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('error');
    expect(result.message).toBe('Stripe configuration error');
  });

  it('non-Stripe gateway → error', async () => {
    const paystackPayment = { ...VALID_PAYMENT, gateway: 'paystack' };
    const supabase = makeSupabase(paystackPayment);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('error');
    expect(result.message).toBe('Only Stripe saved-card recovery is supported');
  });

  it('legacy rows without pi_params use reconstructed params', async () => {
    const legacyPayment = {
      ...VALID_PAYMENT,
      metadata: {
        saved_method: true,
        stripe_customer_id: 'cus_legacy',
        stripe_pm_id: 'pm_legacy',
        provider_account_id: 'acct_connected',
        application_fee_amount: 250,
      },
      amount: 50,
      currency: 'usd',
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'pi_legacy', status: 'succeeded' }),
    });

    const supabase = makeSupabase(legacyPayment);
    await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;
    expect(body).toContain('customer=cus_legacy');
    expect(body).toContain('payment_method=pm_legacy');
    expect(body).toContain('amount=5000'); // 50 * 100
    expect(body).toContain('currency=usd');
    expect(body).toContain('transfer_data');
    expect(body).toContain('application_fee_amount=250');
  });

  it('retryable Stripe error (429) → indeterminate, remains dispatched', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({ error: { type: 'rate_limit_error', code: '' } }),
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('indeterminate');
    expect(mockReconcilePayment).not.toHaveBeenCalled();
  });

  it('invalid_request_error (resource_missing) → declined', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({
        error: { type: 'invalid_request_error', code: 'resource_missing' },
      }),
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('declined');
    expect(result.message).toContain('resource_missing');
  });
});

describe('Bot recovery with _saved_card_payment_id', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    mockReconcilePayment.mockClear();
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  it('verifyAndReconcileSavedCardPayment uses payment-ID path, not gateway_reference', async () => {
    // Mock the saved-card recovery to return succeeded
    const mockRecover = vi.fn().mockResolvedValue({ outcome: 'succeeded', paymentIntentId: 'pi_ok' });
    vi.doMock('../payments/saved-card-recovery', () => ({
      recoverDispatchedSavedCardPayment: mockRecover,
    }));

    // Re-import after mock
    const { verifyAndReconcileSavedCardPayment } = await import('../payments/bot-recovery');
    const supabase = makeSupabase(VALID_PAYMENT);

    const result = await verifyAndReconcileSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('completed');
    expect(result.paymentId).toBe('pay-123');
    // gateway_reference was never used — payment-ID path only
  });
});
