/**
 * #353 Stripe Saved Card — executable evidence
 *
 * Tests Stripe saved-card evidence extraction, consent detection,
 * redisplay downgrade, charge, and detach.
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

describe('extractStripeSavedCardEvidence', () => {
  it('extracts evidence from Checkout Session with consented PM', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({
        customer: 'cus_test123',
        payment_intent: {
          id: 'pi_test456',
          payment_method: {
            id: 'pm_test789',
            allow_redisplay: 'always',
            card: { last4: '4242', brand: 'visa', exp_month: 12, exp_year: 2027 },
          },
        },
      }),
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
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({
        customer: 'cus_test123',
        payment_intent: {
          id: 'pi_test456',
          payment_method: {
            id: 'pm_test789',
            allow_redisplay: 'limited',
            card: { last4: '4242', brand: 'visa', exp_month: 12, exp_year: 2027 },
          },
        },
      }),
    });

    const { extractStripeSavedCardEvidence } = await import('../stripe-saved-card');
    const evidence = await extractStripeSavedCardEvidence('cs_test_session');

    expect(evidence).not.toBeNull();
    expect(evidence!.consented).toBe(false);
  });

  it('returns null when no customer on session', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ payment_intent: { id: 'pi_1', payment_method: { id: 'pm_1' } } }),
    });

    const { extractStripeSavedCardEvidence } = await import('../stripe-saved-card');
    const evidence = await extractStripeSavedCardEvidence('cs_no_customer');
    expect(evidence).toBeNull();
  });
});

describe('downgradeAllowRedisplay', () => {
  it('returns true when update and verify succeed', async () => {
    mockFetch
      .mockResolvedValueOnce({ json: () => Promise.resolve({ id: 'pm_1' }) }) // update
      .mockResolvedValueOnce({ json: () => Promise.resolve({ allow_redisplay: 'limited' }) }); // verify

    const { downgradeAllowRedisplay } = await import('../stripe-saved-card');
    const result = await downgradeAllowRedisplay('pm_test');
    expect(result).toBe(true);
  });

  it('returns false when verify shows still always', async () => {
    mockFetch
      .mockResolvedValueOnce({ json: () => Promise.resolve({ id: 'pm_1' }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ allow_redisplay: 'always' }) });

    const { downgradeAllowRedisplay } = await import('../stripe-saved-card');
    const result = await downgradeAllowRedisplay('pm_test');
    expect(result).toBe(false);
  });
});

describe('chargeStripeSavedCard', () => {
  it('returns succeeded on successful PI', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ id: 'pi_success', status: 'succeeded' }),
    });

    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 5000, currency: 'usd', idempotencyKey: 'test_key',
    });

    expect(result.status).toBe('succeeded');
    expect(result.paymentIntentId).toBe('pi_success');
  });

  it('returns requires_action for 3DS', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({
        id: 'pi_3ds', status: 'requires_action',
        client_secret: 'pi_3ds_secret_test',
      }),
    });

    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 5000, currency: 'usd', idempotencyKey: 'test_key',
    });

    expect(result.status).toBe('requires_action');
    expect(result.paymentIntentId).toBe('pi_3ds');
  });

  it('returns declined for requires_payment_method', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ id: 'pi_declined', status: 'requires_payment_method' }),
    });

    const { chargeStripeSavedCard } = await import('../stripe-saved-card');
    const result = await chargeStripeSavedCard({
      customerId: 'cus_1', paymentMethodId: 'pm_1',
      amountCents: 5000, currency: 'usd', idempotencyKey: 'test_key',
    });

    expect(result.status).toBe('declined');
  });

  it('includes destination charge params when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ id: 'pi_split', status: 'succeeded' }),
    });

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
});

describe('detachStripePaymentMethod', () => {
  it('returns success on successful detach', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ id: 'pm_detached' }),
    });

    const { detachStripePaymentMethod } = await import('../stripe-saved-card');
    const result = await detachStripePaymentMethod('pm_test');
    expect(result.success).toBe(true);
    expect(result.alreadyDetached).toBe(false);
  });

  it('returns success for already-detached PM', async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ error: { code: 'resource_missing' } }),
    });

    const { detachStripePaymentMethod } = await import('../stripe-saved-card');
    const result = await detachStripePaymentMethod('pm_already_detached');
    expect(result.success).toBe(true);
    expect(result.alreadyDetached).toBe(true);
  });
});

describe('isCompatibleForSavedCard', () => {
  it('Flutterwave → fail closed (not implemented)', async () => {
    const { isCompatibleForSavedCard } = await import('../saved-card-compat');
    const result = await isCompatibleForSavedCard({} as any, 'biz_3', 'flutterwave');
    expect(result.compatible).toBe(false);
    expect(result.reason).toBe('provider_not_implemented');
  });

  it('Square → fail closed (not implemented)', async () => {
    const { isCompatibleForSavedCard } = await import('../saved-card-compat');
    const result = await isCompatibleForSavedCard({} as any, 'biz_4', 'square');
    expect(result.compatible).toBe(false);
  });

  it('PayPal → fail closed (not implemented)', async () => {
    const { isCompatibleForSavedCard } = await import('../saved-card-compat');
    const result = await isCompatibleForSavedCard({} as any, 'biz_5', 'paypal');
    expect(result.compatible).toBe(false);
  });
});
