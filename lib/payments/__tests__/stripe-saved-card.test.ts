/**
 * #353 Stripe Saved Card — executable evidence
 *
 * Tests Stripe saved-card evidence extraction, consent detection,
 * redisplay downgrade, charge (with HTTP status classification),
 * detach, and provider compatibility.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.STRIPE_SECRET_KEY = 'test_key';
  mockFetch.mockReset();
});

// Helper to mock a Stripe GET response
function mockGet(data: Record<string, unknown>) {
  mockFetch.mockResolvedValueOnce({
    json: () => Promise.resolve(data),
  });
}

// Helper to mock a Stripe POST response
function mockPost(data: Record<string, unknown>, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

describe('extractStripeSavedCardEvidence', () => {
  it('extracts evidence from Checkout Session with consented PM', async () => {
    mockGet({
      customer: 'cus_test123',
      payment_intent: {
        id: 'pi_test456',
        payment_method: {
          id: 'pm_test789',
          allow_redisplay: 'always',
          card: { last4: '4242', brand: 'visa', exp_month: 12, exp_year: 2027 },
        },
      },
    });

    const { extractStripeSavedCardEvidence } = await import('../stripe-saved-card');
    const evidence = await extractStripeSavedCardEvidence('cs_test_session');

    expect(evidence).not.toBeNull();
    expect(evidence!.customerId).toBe('cus_test123');
    expect(evidence!.paymentMethodId).toBe('pm_test789');
    expect(evidence!.consented).toBe(true);
    expect(evidence!.cardLast4).toBe('4242');
    expect(evidence!.cardBrand).toBe('visa');
  });

  it('detects non-consent when allow_redisplay is not always', async () => {
    mockGet({
      customer: 'cus_test123',
      payment_intent: {
        id: 'pi_test456',
        payment_method: {
          id: 'pm_test789', allow_redisplay: 'limited',
          card: { last4: '4242', brand: 'visa', exp_month: 12, exp_year: 2027 },
        },
      },
    });

    const { extractStripeSavedCardEvidence } = await import('../stripe-saved-card');
    const evidence = await extractStripeSavedCardEvidence('cs_test_session');
    expect(evidence).not.toBeNull();
    expect(evidence!.consented).toBe(false);
  });

  it('returns null when no customer on session', async () => {
    mockGet({ payment_intent: { id: 'pi_1', payment_method: { id: 'pm_1' } } });

    const { extractStripeSavedCardEvidence } = await import('../stripe-saved-card');
    const evidence = await extractStripeSavedCardEvidence('cs_no_customer');
    expect(evidence).toBeNull();
  });
});

describe('downgradeAllowRedisplay', () => {
  it('returns true when update and verify succeed', async () => {
    mockPost({ id: 'pm_1' }, 200); // update
    mockGet({ allow_redisplay: 'limited' }); // verify

    const { downgradeAllowRedisplay } = await import('../stripe-saved-card');
    const result = await downgradeAllowRedisplay('pm_test');
    expect(result).toBe(true);
  });

  it('returns false when verify shows still always', async () => {
    mockPost({ id: 'pm_1' }, 200);
    mockGet({ allow_redisplay: 'always' });

    const { downgradeAllowRedisplay } = await import('../stripe-saved-card');
    const result = await downgradeAllowRedisplay('pm_test');
    expect(result).toBe(false);
  });

  it('returns false when update POST fails', async () => {
    mockPost({ error: { type: 'api_error' } }, 500);

    const { downgradeAllowRedisplay } = await import('../stripe-saved-card');
    const result = await downgradeAllowRedisplay('pm_fail');
    expect(result).toBe(false);
  });
});

describe('chargeStripeSavedCard', () => {
  it('returns succeeded on successful PI', async () => {
    mockPost({ id: 'pi_success', status: 'succeeded' }, 200);

    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 5000, currency: 'usd', idempotencyKey: 'test_key',
    });
    expect(result.status).toBe('succeeded');
    expect(result.paymentIntentId).toBe('pi_success');
  });

  it('returns requires_action for 3DS', async () => {
    mockPost({
      id: 'pi_3ds', status: 'requires_action',
      client_secret: 'pi_3ds_secret_test',
    }, 200);

    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 5000, currency: 'usd', idempotencyKey: 'test_key',
    });
    expect(result.status).toBe('requires_action');
    expect(result.paymentIntentId).toBe('pi_3ds');
  });

  it('returns declined for card_error', async () => {
    mockPost({ error: { type: 'card_error', code: 'card_declined', message: 'Insufficient funds' } }, 402);

    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 5000, currency: 'usd', idempotencyKey: 'test_key',
    });
    expect(result.status).toBe('declined');
    expect(result.errorMessage).toContain('Insufficient funds');
  });

  it('returns indeterminate for auth error (401) — NOT declined', async () => {
    mockPost({ error: { type: 'authentication_error', message: 'Invalid API key' } }, 401);

    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 5000, currency: 'usd', idempotencyKey: 'test_key',
    });
    expect(result.status).toBe('indeterminate'); // NOT declined
  });

  it('returns indeterminate for rate limit (429) — NOT declined', async () => {
    mockPost({ error: { type: 'rate_limit_error' } }, 429);

    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 5000, currency: 'usd', idempotencyKey: 'test_key',
    });
    expect(result.status).toBe('indeterminate');
  });

  it('returns indeterminate for idempotency conflict — NOT declined', async () => {
    mockPost({ error: { type: 'idempotent_request_mismatch', code: 'idempotency_key_in_use' } }, 400);

    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 5000, currency: 'usd', idempotencyKey: 'test_key',
    });
    expect(result.status).toBe('indeterminate');
  });

  it('includes destination charge params when provided', async () => {
    mockPost({ id: 'pi_split', status: 'succeeded' }, 200);

    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 10000, currency: 'usd', idempotencyKey: 'test_split',
      stripeAccountId: 'acct_business_b',
      applicationFeeAmount: 500,
    });

    const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(body.get('transfer_data[destination]')).toBe('acct_business_b');
    expect(body.get('application_fee_amount')).toBe('500');
  });

  it('returns declined for requires_payment_method PI status', async () => {
    mockPost({ id: 'pi_declined', status: 'requires_payment_method' }, 200);

    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 5000, currency: 'usd', idempotencyKey: 'test_key',
    });
    expect(result.status).toBe('declined');
  });
});

describe('detachStripePaymentMethod', () => {
  it('returns success on successful detach', async () => {
    mockPost({ id: 'pm_detached' }, 200);

    const { detachStripePaymentMethod } = await import('../stripe-saved-card');
    const result = await detachStripePaymentMethod('pm_test');
    expect(result.success).toBe(true);
    expect(result.alreadyDetached).toBe(false);
  });

  it('returns success for already-detached PM', async () => {
    mockPost({ error: { code: 'resource_missing' } }, 404);

    const { detachStripePaymentMethod } = await import('../stripe-saved-card');
    const result = await detachStripePaymentMethod('pm_already_detached');
    expect(result.success).toBe(true);
    expect(result.alreadyDetached).toBe(true);
  });

  it('returns retryable for auth error', async () => {
    mockPost({ error: { type: 'authentication_error' } }, 401);

    const { detachStripePaymentMethod } = await import('../stripe-saved-card');
    const result = await detachStripePaymentMethod('pm_auth_fail');
    expect(result.success).toBe(false);
    expect(result.terminal).toBe(false); // retryable, not terminal
  });
});

describe('buildSavedCardPIParams', () => {
  it('builds exact params for replay', async () => {
    const { buildSavedCardPIParams } = await import('../stripe-saved-card');
    const params = buildSavedCardPIParams({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 5000, currency: 'usd',
      stripeAccountId: 'acct_dest', applicationFeeAmount: 250,
    });
    expect(params.customer).toBe('cus_1');
    expect(params.payment_method).toBe('pm_1');
    expect(params.amount).toBe('5000');
    expect(params.currency).toBe('usd');
    expect(params.confirm).toBe('true');
    expect(params['transfer_data[destination]']).toBe('acct_dest');
    expect(params['application_fee_amount']).toBe('250');
  });

  it('omits optional params when not provided', async () => {
    const { buildSavedCardPIParams } = await import('../stripe-saved-card');
    const params = buildSavedCardPIParams({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 3000, currency: 'gbp',
    });
    expect(params['transfer_data[destination]']).toBeUndefined();
    expect(params['application_fee_amount']).toBeUndefined();
  });
});

describe('isCompatibleForSavedCard', () => {
  it('Flutterwave → fail closed (not implemented)', async () => {
    const { isCompatibleForSavedCard } = await import('../saved-card-compat');
    const result = await isCompatibleForSavedCard({} as any, 'biz_3', 'flutterwave');
    expect(result.compatible).toBe(false);
    expect(result.reason).toBe('provider_not_implemented');
  });

  it('Square → fail closed', async () => {
    const { isCompatibleForSavedCard } = await import('../saved-card-compat');
    const result = await isCompatibleForSavedCard({} as any, 'biz_4', 'square');
    expect(result.compatible).toBe(false);
  });

  it('PayPal → fail closed', async () => {
    const { isCompatibleForSavedCard } = await import('../saved-card-compat');
    const result = await isCompatibleForSavedCard({} as any, 'biz_5', 'paypal');
    expect(result.compatible).toBe(false);
  });
});
