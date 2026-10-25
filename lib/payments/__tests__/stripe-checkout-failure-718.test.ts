/**
 * #718 — Stripe Checkout invalid_request_error diagnostic and narrowly-scoped
 * recovery evidence. No live Stripe calls; uses executable response mocks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mayFallbackFromSaveCardOptions, stripeCheckoutErrorEvidence } from '../stripe-checkout-failure';
import { StripeGateway } from '../stripe';
import { provisionStripeCustomer } from '../provision-stripe-customer';

vi.mock('../provision-stripe-customer', () => ({
  provisionStripeCustomer: vi.fn().mockResolvedValue({ customerId: 'cus_test_bala' }),
}));
vi.mock('../saved-card-compat', async () => {
  const actual = await vi.importActual('../saved-card-compat');
  return { ...actual, isCompatibleForSavedCard: vi.fn().mockResolvedValue({ compatible: true }) };
});

const mockFetch = vi.fn();
const mockSupabase = {
  from: vi.fn().mockReturnValue({
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'pay_existing' }, error: null }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  }),
} as unknown as import('@supabase/supabase-js').SupabaseClient;

const checkoutInput = {
  supabase: mockSupabase,
  bookingId: 'bk_bala',
  userId: 'user_bala',
  amount: 50,
  currency: 'USD',
  referenceCode: 'WA-TK-1940',
  businessName: 'BalaShop',
  phone: '+12025550100',
  businessId: 'biz_bala',
};

const providerError = (param: string) => ({
  ok: false,
  status: 400,
  headers: { get: (key: string) => key === 'request-id' ? 'req_ABC12345678' : null },
  json: async () => ({
    error: {
      type: 'invalid_request_error',
      code: 'parameter_unknown',
      param,
      message: 'private@example.com sk_test_private Stripe details SHOULD NEVER BE LOGGED',
    },
  }),
});
const providerSuccess = {
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({
    id: 'cs_test_bala_ok',
    url: 'https://checkout.stripe.com/c/pay/cs_test_bala_ok',
  }),
};

beforeEach(() => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_mock_not_a_real_key');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://staging.waaiio.com');
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  vi.mocked(provisionStripeCustomer).mockResolvedValue({ customerId: 'cus_test_bala' });
});

describe('Stripe Checkout failure evidence — strict redaction', () => {
  it('retains safe code, type, parameter, HTTP status and Stripe request ID but not error.message', () => {
    const evidence = stripeCheckoutErrorEvidence({
      error: { type: 'invalid_request_error', code: 'parameter_unknown',
        param: 'saved_payment_method_options[payment_method_save]',
        message: 'secret=sk_test_hunter2 email=someone@example.com' },
      __waaiio_http_status: 400, __waaiio_request_id: 'req_ABC12345678',
    });
    expect(evidence).toEqual({
      type: 'invalid_request_error', code: 'parameter_unknown',
      param: 'saved_payment_method_options[payment_method_save]',
      httpStatus: 400, requestId: 'req_ABC12345678',
    });
    expect(JSON.stringify(evidence)).not.toMatch(/hunter2|someone|secret=/);
  });
  it('drops malicious / oversized identifiers instead of allowing log injection', () => {
    const evidence = stripeCheckoutErrorEvidence({
      error: { type: 'invalid_request_error\nleak', code: 'x'.repeat(300),
        param: 'customer_email\nCustomer 123', message: 'sensitive' },
      __waaiio_http_status: 200,
      __waaiio_request_id: 'req_abc\nleak',
    });
    expect(evidence).toEqual({});
  });
  it('only permits fallback for explicitly rejected optional save-card fields', () => {
    const rejected = (param: string, type='invalid_request_error') => ({ error: { type, param }, __waaiio_http_status: 400 });
    for (const p of [
      'saved_payment_method_options',
      'saved_payment_method_options[payment_method_save]',
      'saved_payment_method_options[allow_redisplay_filters]',
      'saved_payment_method_options[allow_redisplay_filters][0]',
    ]) expect(mayFallbackFromSaveCardOptions(rejected(p), true)).toBe(true);
    expect(mayFallbackFromSaveCardOptions(rejected('customer'), true)).toBe(false);
    expect(mayFallbackFromSaveCardOptions(rejected('payment_intent_data[application_fee_amount]'), true)).toBe(false);
    expect(mayFallbackFromSaveCardOptions(rejected('saved_payment_method_options[payment_method_save]', 'authentication_error'), true)).toBe(false);
    expect(mayFallbackFromSaveCardOptions(rejected('saved_payment_method_options[payment_method_save]'), false)).toBe(false);
    expect(mayFallbackFromSaveCardOptions({ error: { type: 'invalid_request_error', message: 'saved_payment_method_options private@example.com' }, __waaiio_http_status: 400 }, true)).toBe(false);
    expect(mayFallbackFromSaveCardOptions({ error: { type: 'invalid_request_error', param: 'saved_payment_method_options' }, __waaiio_http_status: 500 }, true)).toBe(false);
  });
});

describe('#718 BalaShop — Stripe optional save validation fallback', () => {
  it('recovers an explicit save-option rejection, preserving $50, customer, reference, destination and fees', async () => {
    mockFetch.mockResolvedValueOnce(providerError('saved_payment_method_options[payment_method_save]'))
      .mockResolvedValueOnce(providerSuccess);

    const out = await new StripeGateway().initializePayment({
      ...checkoutInput, stripeAccountId: 'acct_test_destination', platformFeeAmount: 2,
    });

    expect(out).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_bala_ok', reference: 'cs_test_bala_ok' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const first = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    const second = new URLSearchParams(mockFetch.mock.calls[1][1].body);

    expect(first.get('saved_payment_method_options[payment_method_save]')).toBe('enabled');
    expect(second.get('saved_payment_method_options[payment_method_save]')).toBeNull();
    expect(second.get('saved_payment_method_options[allow_redisplay_filters][0]')).toBeNull();
    for (const field of [
      'line_items[0][price_data][currency]', 'line_items[0][price_data][unit_amount]',
      'customer', 'client_reference_id', 'payment_intent_data[application_fee_amount]',
      'payment_intent_data[transfer_data][destination]', 'metadata[booking_id]',
    ]) expect(second.get(field)).toBe(first.get(field));

    expect(second.get('line_items[0][price_data][unit_amount]')).toBe('5000');
    expect(second.get('customer')).toBe('cus_test_bala');
    const key1 = mockFetch.mock.calls[0][1].headers['Idempotency-Key'];
    const key2 = mockFetch.mock.calls[1][1].headers['Idempotency-Key'];
    expect(key1).not.toBe(key2);
    expect(key2).toBe(key1 + '_without_save_options');
  });

  it('never retries other invalid_request_error fields or security/routing failures', async () => {
    mockFetch.mockResolvedValueOnce(providerError('customer'));
    const out = await new StripeGateway().initializePayment(checkoutInput);
    expect(out).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed if the fallback is also rejected', async () => {
    mockFetch.mockResolvedValueOnce(providerError('saved_payment_method_options'))
      .mockResolvedValueOnce(providerError('customer'));
    const out = await new StripeGateway().initializePayment(checkoutInput);
    expect(out).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
