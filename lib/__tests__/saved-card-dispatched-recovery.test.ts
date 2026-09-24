/**
 * #375: Saved-card dispatched-payment recovery tests.
 *
 * Proves the canonical recovery helper:
 * 1. Uses exact payment ID/key/params for PI replay
 * 2. Stripe succeeded → PI bound via CAS, reconciled, no second payment row
 * 3. requires_action → PI bound, auth URL returned via createAuthAttempt
 * 4. Terminal decline → failed state
 * 5. Indeterminate (timeout) → remains dispatched, no new charge
 * 6. Bot recovery with _saved_card_payment_id → uses payment-ID path
 * 7. Payment not found → error
 * 8. Payment not saved-card / not dispatched → appropriate outcome
 * 9. Idempotency window expired → quarantined
 * 10. CAS-loss convergence paths
 * 11. Already-resolved payments → converge
 * 12. Centralized flow recovery + mapping
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mockReconcilePayment = vi.hoisted(() => vi.fn().mockResolvedValue({
  providerOutcome: 'verified',
  lifecycle: { status: 'completed' },
  acknowledgeSuccess: true,
}));

const mockCreateAuthAttempt = vi.hoisted(() => vi.fn().mockResolvedValue({
  authUrl: 'https://www.waaiio.com/payment-auth?t=signed_token',
  attemptId: 'attempt-123',
}));

const mockCanonicalSavedCardPhone = vi.hoisted(() => vi.fn().mockReturnValue('+2348001234567'));

vi.mock('@/lib/payments/reconcile', () => ({
  reconcilePayment: mockReconcilePayment,
}));

vi.mock('@/lib/payments/stripe-saved-card', () => ({
  createAuthAttempt: mockCreateAuthAttempt,
}));

vi.mock('@/lib/payments/saved-card-compat', () => ({
  canonicalSavedCardPhone: mockCanonicalSavedCardPhone,
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
import { recoverSavedCardPaymentForFlow, mapSavedCardRecoveryToValidation, type FlowRecoveryResult } from '../payments/bot-recovery';

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

/**
 * Make a supabase mock that returns different data for CAS re-reads.
 * First select (payment lookup) returns paymentData.
 * Subsequent selects (CAS re-read) return reReadData.
 */
function makeSupabaseWithReRead(
  paymentData: Record<string, unknown>,
  reReadData: Record<string, unknown>,
  casRows: number = 0,
) {
  let selectCallCount = 0;

  const makeSelectChain = () => ({
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return Promise.resolve({ data: paymentData, error: null });
      }
      return Promise.resolve({ data: reReadData, error: null });
    }),
  });

  const updateChain = {
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue({
      data: casRows > 0 ? [{ id: paymentData.id || 'pay-123' }] : [],
      error: null,
    }),
  };

  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockImplementation(() => makeSelectChain()),
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
    customer_phone: '2348001234567',
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
    mockCreateAuthAttempt.mockClear();
    mockCanonicalSavedCardPhone.mockClear();
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

  // R1-B3: requires_action creates durable auth attempt + signed URL
  it('requires_action → creates durable auth attempt with signed Waaiio URL', async () => {
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

    mockCreateAuthAttempt.mockResolvedValue({
      authUrl: 'https://www.waaiio.com/payment-auth?t=signed_token_abc',
      attemptId: 'attempt-456',
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('requires_action');
    expect(result.paymentIntentId).toBe('pi_3ds');
    // Should return the signed Waaiio URL, NOT the raw Stripe redirect URL
    expect(result.authUrl).toBe('https://www.waaiio.com/payment-auth?t=signed_token_abc');
    expect(result.authUrl).not.toContain('stripe.com');
    // createAuthAttempt should have been called
    expect(mockCreateAuthAttempt).toHaveBeenCalledWith(supabase, 'pay-123', '+2348001234567');
  });

  // R1-B3: requires_action with auth creation failure → indeterminate
  it('requires_action with auth creation failure → indeterminate (not raw URL)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        id: 'pi_3ds_fail',
        status: 'requires_action',
        next_action: {
          type: 'redirect_to_url',
          redirect_to_url: { url: 'https://stripe.com/3ds/verify' },
        },
      }),
    });

    mockCreateAuthAttempt.mockResolvedValue(null); // Auth creation fails

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('indeterminate');
    expect(result.message).toContain('auth attempt creation failed');
    // Must NOT return the raw Stripe URL
    expect(result.authUrl).toBeUndefined();
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

  // R1-B4: terminal decline allows safe retry
  it('terminal decline allows safe retry (result type = declined)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'pi_declined2', status: 'requires_payment_method' }),
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    // Type is 'declined' which maps to terminal_decline in FlowRecoveryResult
    // which in turn maps to _retry_payment: true in mapSavedCardRecoveryToValidation
    expect(result.outcome).toBe('declined');
    expect(result.message).toContain('declined');
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

  // R1-B5: payment not dispatched (already progressed) → converge
  it('payment provider_confirmed + pending → already_resolved after reconciliation', async () => {
    const confirmed = { ...VALID_PAYMENT, provider_init_state: 'provider_confirmed' };
    const supabase = makeSupabase(confirmed);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('succeeded');
    // Should have reconciled
    expect(mockReconcilePayment).toHaveBeenCalledWith(supabase, 'pay-123', 'saved_card');
  });

  // R1-B5: already-success → completed
  it('payment already success → reconciles to verify lifecycle completion', async () => {
    const success = { ...VALID_PAYMENT, status: 'success', provider_init_state: 'provider_confirmed' };
    const supabase = makeSupabase(success);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    // R2-B1: Must reconcile — status='success' is Stage 1 only
    expect(mockReconcilePayment).toHaveBeenCalledWith(supabase, 'pay-123', 'saved_card');
    expect(result.outcome).toBe('succeeded');
  });

  // R1-B5: already-failed → declined
  it('payment already failed → declined', async () => {
    const failed = { ...VALID_PAYMENT, status: 'failed', provider_init_state: 'provider_confirmed' };
    const supabase = makeSupabase(failed);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('declined');
    expect(result.message).toBe('Payment was declined');
  });

  it('non-Stripe saved-card payment still reconciles by exact payment ID', async () => {
    const paystack = { ...VALID_PAYMENT, gateway: 'paystack', gateway_reference: 'paystack-ref' };
    const supabase = makeSupabase(paystack);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(mockReconcilePayment).toHaveBeenCalledWith(supabase, 'pay-123', 'saved_card');
    expect(result.outcome).toBe('succeeded');
    expect(globalThis.fetch).toBe(originalFetch);
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
  });

  it('missing STRIPE_SECRET_KEY → error', async () => {
    delete process.env.STRIPE_SECRET_KEY;

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('error');
    expect(result.message).toBe('Stripe configuration error');
  });

  it('non-Stripe gateway → reconciles the same payment ID', async () => {
    const paystackPayment = { ...VALID_PAYMENT, gateway: 'paystack' };
    const supabase = makeSupabase(paystackPayment);
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('succeeded');
    expect(mockReconcilePayment).toHaveBeenCalledWith(supabase, 'pay-123', 'saved_card');
  });

  it('legacy rows without pi_params use reconstructed params', async () => {
    const legacyPayment = {
      ...VALID_PAYMENT,
      metadata: {
        saved_method: true,
        customer_phone: '2348001234567',
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

  // ── R1-B2: CAS-loss convergence tests ──

  it('CAS-loss on succeeded: re-reads payment, converges to succeeded', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'pi_cas_lost', status: 'succeeded' }),
    });

    // CAS fails (0 rows), then re-read shows success
    const supabase = makeSupabaseWithReRead(
      VALID_PAYMENT,
      { status: 'success', provider_init_state: 'provider_confirmed', gateway_reference: 'pi_cas_lost' },
      0, // CAS returns 0 rows
    );
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('succeeded');
    expect(result.paymentIntentId).toBe('pi_cas_lost');
  });

  it('CAS-loss on declined: canonical dispatched/pending remains indeterminate (not false-retry)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'pi_cas_lost_decline', status: 'requires_payment_method' }),
    });

    // CAS fails and canonical row remains non-terminal.
    const supabase = makeSupabaseWithReRead(
      VALID_PAYMENT,
      { status: 'pending', provider_init_state: 'dispatched', gateway_reference: 'sc_pending_abc' },
      0,
    );
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    expect(result.outcome).toBe('indeterminate');
    expect(result.outcome).not.toBe('declined');
  });

  it('CAS-loss on quarantine: re-reads, converges based on current state', async () => {
    const oldPayment = {
      ...VALID_PAYMENT,
      created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    };

    // CAS fails on quarantine, re-read shows it's already success
    const supabase = makeSupabaseWithReRead(
      oldPayment,
      { status: 'success', provider_init_state: 'provider_confirmed', gateway_reference: 'pi_already_ok' },
      0,
    );
    const result = await recoverDispatchedSavedCardPayment(supabase, 'pay-123');

    // The provider response lost the CAS; canonical success wins.
    expect(result.outcome).toBe('succeeded');
  });
});

describe('recoverSavedCardPaymentForFlow', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    mockReconcilePayment.mockClear();
    mockCreateAuthAttempt.mockClear();
  });

  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = originalEnv;
  });

  // not-applicable → returns not_applicable (ordinary recovery used)
  it('not-applicable → returns not_applicable for non-saved-card payment', async () => {
    const nonSavedCard = { ...VALID_PAYMENT, metadata: { saved_method: false } };
    const supabase = makeSupabase(nonSavedCard);
    const result = await recoverSavedCardPaymentForFlow(supabase, 'pay-123');

    expect(result.type).toBe('not_applicable');
  });

  it('succeeded → returns completed with paymentId', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'pi_ok', status: 'succeeded' }),
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverSavedCardPaymentForFlow(supabase, 'pay-123');

    expect(result.type).toBe('completed');
    expect('paymentId' in result && result.paymentId).toBe('pay-123');
  });

  it('already success + reconciliation completed → returns completed', async () => {
    const success = { ...VALID_PAYMENT, status: 'success', provider_init_state: 'provider_confirmed' };
    const supabase = makeSupabase(success);
    const result = await recoverSavedCardPaymentForFlow(supabase, 'pay-123');

    // R2-B1: succeeds only when lifecycle is terminal-safe
    expect(result.type).toBe('completed');
  });

  it('declined → returns terminal_decline', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'pi_dec', status: 'requires_payment_method' }),
    });

    const supabase = makeSupabase(VALID_PAYMENT);
    const result = await recoverSavedCardPaymentForFlow(supabase, 'pay-123');

    expect(result.type).toBe('terminal_decline');
  });
});

describe('mapSavedCardRecoveryToValidation', () => {
  it('completed → valid with payment_confirmed action', () => {
    const result: FlowRecoveryResult = { type: 'completed', paymentId: 'pay-1' };
    const sessionData: Record<string, unknown> = {};
    const mapped = mapSavedCardRecoveryToValidation(result, sessionData);

    expect(mapped).not.toBeNull();
    expect(mapped!.valid).toBe(true);
    expect(mapped!.data?._action).toBe('payment_confirmed');
  });

  it('already_completed → valid with payment_confirmed action', () => {
    const result: FlowRecoveryResult = { type: 'already_completed', paymentId: 'pay-1' };
    const sessionData: Record<string, unknown> = {};
    const mapped = mapSavedCardRecoveryToValidation(result, sessionData);

    expect(mapped).not.toBeNull();
    expect(mapped!.valid).toBe(true);
    expect(mapped!.data?._action).toBe('payment_confirmed');
  });

  it('requires_auth → blocks retry with auth message', () => {
    const result: FlowRecoveryResult = { type: 'requires_auth', paymentId: 'pay-1', authUrl: 'https://example.com/auth' };
    const sessionData: Record<string, unknown> = {};
    const mapped = mapSavedCardRecoveryToValidation(result, sessionData);

    expect(mapped).not.toBeNull();
    expect(mapped!.valid).toBe(false);
    expect(mapped!.persistSessionDataOnFailure).toBe(true);
    expect(sessionData._payment_retry_blocked).toBe(true);
  });

  it('terminal_decline → allows retry', () => {
    const result: FlowRecoveryResult = { type: 'terminal_decline', paymentId: 'pay-1', message: 'Card declined' };
    const sessionData: Record<string, unknown> = {};
    const mapped = mapSavedCardRecoveryToValidation(result, sessionData);

    expect(mapped).not.toBeNull();
    expect(mapped!.valid).toBe(true);
    expect(mapped!.data?._retry_payment).toBe(true);
    expect(mapped!.data?._payment_retry_blocked).toBe(false);
    expect(mapped!.data?._saved_card_payment_id).toBeNull();
  });

  it('indeterminate → blocks retry', () => {
    const result: FlowRecoveryResult = { type: 'indeterminate', paymentId: 'pay-1' };
    const sessionData: Record<string, unknown> = {};
    const mapped = mapSavedCardRecoveryToValidation(result, sessionData);

    expect(mapped).not.toBeNull();
    expect(mapped!.valid).toBe(false);
    expect(sessionData._payment_retry_blocked).toBe(true);
  });

  it('not_applicable → returns null (fall through to ordinary)', () => {
    const result: FlowRecoveryResult = { type: 'not_applicable' };
    const sessionData: Record<string, unknown> = {};
    const mapped = mapSavedCardRecoveryToValidation(result, sessionData);

    expect(mapped).toBeNull();
  });
});

describe('All flows wired with centralized helper', () => {
  it.each([
    ['ordering', true], ['reservation', true], ['ticketing', true], ['payment', true], ['scheduling', false],
  ] as const)(
    '%s routes both retry and I-have-paid through the centralized payment-ID authority',
    (flow, usesSharedInput) => {
      const source = readFileSync(resolve(process.cwd(), `lib/bot/flows/${flow}.flow.ts`), 'utf8');
      if (usesSharedInput) expect(source).toContain('handleSavedCardInput');
      expect(source.match(/recoverSavedCardPaymentForFlow/g)?.length).toBeGreaterThanOrEqual(2);
      expect(source.match(/mapSavedCardRecoveryToValidation/g)?.length).toBeGreaterThanOrEqual(2);
    },
  );

  it('stale-button recovery uses the same centralized authority', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/bot/bot.service.ts'), 'utf8');
    expect(source).toContain('recoverSavedCardPaymentForFlow');
    expect(source).not.toContain('recoverDispatchedSavedCardPayment(this.supabase, savedCardPaymentId)');
  });

  it('canonical recovery never creates a second logical payment row', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/payments/saved-card-recovery.ts'), 'utf8');
    expect(source).not.toMatch(/from\(['"]payments['"]\)\s*\.insert\(/);
    expect(source).toContain('sc_charge_${paymentId}');
  });

  it('FlowRecoveryResult preserves all distinctions', () => {
    // Verify all types compile and are distinguishable
    const completed: FlowRecoveryResult = { type: 'completed', paymentId: 'p1' };
    const alreadyCompleted: FlowRecoveryResult = { type: 'already_completed', paymentId: 'p1' };
    const requiresAuth: FlowRecoveryResult = { type: 'requires_auth', paymentId: 'p1', authUrl: 'url' };
    const terminalDecline: FlowRecoveryResult = { type: 'terminal_decline', paymentId: 'p1', message: 'msg' };
    const providerConfirmed: FlowRecoveryResult = { type: 'provider_confirmed', paymentId: 'p1' };
    const indeterminate: FlowRecoveryResult = { type: 'indeterminate', paymentId: 'p1' };
    const quarantined: FlowRecoveryResult = { type: 'quarantined', paymentId: 'p1' };
    const notApplicable: FlowRecoveryResult = { type: 'not_applicable' };
    const error: FlowRecoveryResult = { type: 'error', message: 'msg' };

    // All types are distinct
    const types = [completed, alreadyCompleted, requiresAuth, terminalDecline, providerConfirmed, indeterminate, quarantined, notApplicable, error];
    const typeNames = types.map(t => t.type);
    expect(new Set(typeNames).size).toBe(9);
  });
});

// ═══════════════════════════════════════════════════════════════════
// R2-B1: Lifecycle-aware recovery (status=success ≠ completed)
// ═══════════════════════════════════════════════════════════════════

describe('R2-B1: Lifecycle-aware reconciliation after PI succeeded', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PI succeeded + lifecycle completed → outcome succeeded', async () => {
    mockReconcilePayment.mockResolvedValue({
      providerOutcome: 'verified',
      lifecycle: { status: 'completed', retryable: false, stages: { providerPaid: true, businessFinalized: true, customerConfirmed: true } },
      acknowledgeSuccess: true,
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'pi_test', status: 'succeeded' }) });
    const sb = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(sb, 'pay-123');
    expect(result.outcome).toBe('succeeded');
    expect(mockReconcilePayment).toHaveBeenCalledWith(sb, 'pay-123', 'saved_card');
  });

  it('PI succeeded + lifecycle processing → outcome provider_confirmed, NOT succeeded', async () => {
    mockReconcilePayment.mockResolvedValue({
      providerOutcome: 'verified',
      lifecycle: { status: 'processing', retryable: true, stages: { providerPaid: true, businessFinalized: false, customerConfirmed: false } },
      acknowledgeSuccess: true,
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'pi_test', status: 'succeeded' }) });
    const sb = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(sb, 'pay-123');
    expect(result.outcome).toBe('provider_confirmed');
    expect(result.outcome).not.toBe('succeeded');
  });

  it('PI succeeded + lifecycle retryable_failed → outcome provider_confirmed, NOT succeeded', async () => {
    mockReconcilePayment.mockResolvedValue({
      providerOutcome: 'verified',
      lifecycle: { status: 'retryable_failed', retryable: true, stages: { providerPaid: true, businessFinalized: false, customerConfirmed: false } },
      acknowledgeSuccess: true,
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'pi_test', status: 'succeeded' }) });
    const sb = makeSupabase(VALID_PAYMENT);
    const result = await recoverDispatchedSavedCardPayment(sb, 'pay-123');
    expect(result.outcome).toBe('provider_confirmed');
    expect(result.outcome).not.toBe('succeeded');
  });

  it('existing status=success + incomplete finalization → reconciliation runs, not auto-completed', async () => {
    const successPayment = { ...VALID_PAYMENT, status: 'success', provider_init_state: 'provider_confirmed', gateway_reference: 'pi_already' };
    const sb = makeSupabase(successPayment);
    mockReconcilePayment.mockResolvedValue({
      providerOutcome: 'verified',
      lifecycle: { status: 'processing', retryable: true },
      acknowledgeSuccess: true,
    });
    const result = await recoverDispatchedSavedCardPayment(sb, 'pay-123');
    expect(mockReconcilePayment).toHaveBeenCalledWith(sb, 'pay-123', 'saved_card');
    expect(result.outcome).not.toBe('succeeded');
  });

  it('CAS-loss + status=success + processing → no false completion', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'pi_cas_lost', status: 'succeeded' }) });
    // CAS fails (0 rows updated), re-read sees success
    const sb = makeSupabaseWithReRead(
      VALID_PAYMENT, 0,
      { ...VALID_PAYMENT, status: 'success', provider_init_state: 'provider_confirmed', gateway_reference: 'pi_cas_lost' },
    );
    mockReconcilePayment.mockResolvedValue({
      providerOutcome: 'verified',
      lifecycle: { status: 'processing', retryable: true },
      acknowledgeSuccess: true,
    });
    const result = await recoverDispatchedSavedCardPayment(sb, 'pay-123');
    expect(result.outcome).not.toBe('succeeded');
  });

  it('already-success + lifecycle completed → safe completed', async () => {
    const successPayment = { ...VALID_PAYMENT, status: 'success', provider_init_state: 'provider_confirmed', gateway_reference: 'pi_done' };
    const sb = makeSupabase(successPayment);
    mockReconcilePayment.mockResolvedValue({
      providerOutcome: 'verified',
      lifecycle: { status: 'already_completed', retryable: false },
      acknowledgeSuccess: true,
    });
    const result = await recoverDispatchedSavedCardPayment(sb, 'pay-123');
    expect(result.outcome).toBe('succeeded');
  });
});
