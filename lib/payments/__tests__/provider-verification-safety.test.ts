/**
 * Provider Verification Safety — #172
 *
 * Proves: non-2xx HTTP, non-terminal provider states, and unknown statuses
 * cannot become `not_paid`. Only explicit terminal-safe provider states
 * and HTTP 200 success may authorize replacement checkout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyWithProvider } from '../provider-adapters';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/encryption', () => ({
  decryptToken: vi.fn((s: string) => `decrypted_${s}`),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// eslint-disable-next-line
function mockChain(overrides: Record<string, unknown> = {}): any {
  // eslint-disable-next-line
  const c: Record<string, any> = {};
  ['select', 'eq', 'not', 'is', 'order', 'limit', 'like', 'in'].forEach(m => c[m] = vi.fn().mockReturnValue(c));
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  Object.assign(c, overrides);
  return c;
}

function buildSupabase() {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'business_payment_credentials') {
        return mockChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) });
      }
      if (table === 'payout_accounts') {
        return mockChain({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) });
      }
      return mockChain();
    }),
  };
}

function mockResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const BASE_OPTS = { expectedAmount: 5000, expectedCurrency: 'NGN', paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1' };

// Set env vars for platform credentials
process.env.PAYSTACK_SECRET_KEY = 'test_key_for_unit_test_ps';
process.env.STRIPE_SECRET_KEY = 'test_key_for_unit_test_stripe';
process.env.FLUTTERWAVE_SECRET_KEY = 'test_key_for_unit_test_flw';
process.env.SQUARE_ACCESS_TOKEN = 'test_key_for_unit_test_sq';
process.env.PAYPAL_CLIENT_ID = 'paypal_client';
process.env.PAYPAL_CLIENT_SECRET = 'paypal_secret';

beforeEach(() => {
  mockFetch.mockReset();
  vi.clearAllMocks();
  // Ensure gateway credentials are available for all provider tests
  process.env.PAYSTACK_SECRET_KEY = 'test_key_for_unit_test_ps';
  process.env.STRIPE_SECRET_KEY = 'test_key_for_unit_test_stripe';
  process.env.FLUTTERWAVE_SECRET_KEY = 'test_key_for_unit_test_flw';
  process.env.SQUARE_ACCESS_TOKEN = 'test_key_for_unit_test_sq';
  process.env.PAYPAL_CLIENT_ID = 'paypal_client';
  process.env.PAYPAL_CLIENT_SECRET = 'paypal_secret';
});

// ═══════════════════════════════════════════════════════════
// PAYSTACK
// ═══════════════════════════════════════════════════════════

describe('Paystack verification safety', () => {
  async function verify(fetchResponse: unknown) {
    mockFetch.mockResolvedValueOnce(fetchResponse);
    // eslint-disable-next-line
    return verifyWithProvider(buildSupabase() as any, { provider: 'paystack', gatewayReference: 'REF-1', ...BASE_OPTS });
  }

  it('HTTP 200 + success → verified', async () => {
    const r = await verify(mockResponse(200, { data: { status: 'success', amount: 500000, currency: 'NGN', id: 'tx1' } }));
    expect(r.status).toBe('verified');
  });

  it('HTTP 200 + failed → not_paid', async () => {
    const r = await verify(mockResponse(200, { data: { status: 'failed' } }));
    expect(r.status).toBe('not_paid');
  });

  it('HTTP 200 + abandoned → not_paid', async () => {
    const r = await verify(mockResponse(200, { data: { status: 'abandoned' } }));
    expect(r.status).toBe('not_paid');
  });

  it('HTTP 200 + reversed → retryable_error (NOT not_paid)', async () => {
    const r = await verify(mockResponse(200, { data: { status: 'reversed' } }));
    expect(r.status).toBe('retryable_error');
    expect(r.status).not.toBe('not_paid');
  });

  it('HTTP 200 + pending → retryable_error', async () => {
    const r = await verify(mockResponse(200, { data: { status: 'pending' } }));
    expect(r.status).toBe('retryable_error');
  });

  it('HTTP 200 + processing → retryable_error', async () => {
    const r = await verify(mockResponse(200, { data: { status: 'processing' } }));
    expect(r.status).toBe('retryable_error');
  });

  it('HTTP 200 + ongoing → retryable_error', async () => {
    const r = await verify(mockResponse(200, { data: { status: 'ongoing' } }));
    expect(r.status).toBe('retryable_error');
  });

  it('HTTP 200 + unknown status → retryable_error', async () => {
    const r = await verify(mockResponse(200, { data: { status: 'new_unknown_status' } }));
    expect(r.status).toBe('retryable_error');
  });

  it('HTTP 400 → retryable_error (NOT not_paid)', async () => {
    const r = await verify(mockResponse(400, { status: false, message: 'Bad request' }));
    expect(r.status).toBe('retryable_error');
  });

  it('HTTP 401 → config_error', async () => {
    const r = await verify(mockResponse(401, { status: false }));
    expect(r.status).toBe('config_error');
  });

  it('HTTP 404 → retryable_error', async () => {
    const r = await verify(mockResponse(404, { status: false }));
    expect(r.status).toBe('retryable_error');
  });

  it('HTTP 500 → retryable_error', async () => {
    const r = await verify(mockResponse(500, { status: false }));
    expect(r.status).toBe('retryable_error');
  });

  it('network timeout → retryable_error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    // eslint-disable-next-line
    const r = await verifyWithProvider(buildSupabase() as any, { provider: 'paystack', gatewayReference: 'REF-1', ...BASE_OPTS });
    expect(r.status).toBe('retryable_error');
  });
});

// ═══════════════════════════════════════════════════════════
// STRIPE
// ═══════════════════════════════════════════════════════════

describe('Stripe Checkout verification safety', () => {
  async function verify(fetchResponse: unknown) {
    mockFetch.mockResolvedValueOnce(fetchResponse);
    // eslint-disable-next-line
    return verifyWithProvider(buildSupabase() as any, {
      provider: 'stripe', gatewayReference: 'cs_test_123', expectedAmount: 5000, expectedCurrency: 'USD',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
  }

  it('paid → verified', async () => {
    const r = await verify(mockResponse(200, { payment_status: 'paid', amount_total: 500000, currency: 'usd', payment_intent: 'pi_1' }));
    expect(r.status).toBe('verified');
  });

  it('expired + unpaid → not_paid', async () => {
    const r = await verify(mockResponse(200, { status: 'expired', payment_status: 'unpaid' }));
    expect(r.status).toBe('not_paid');
  });

  it('open + unpaid → retryable_error', async () => {
    const r = await verify(mockResponse(200, { status: 'open', payment_status: 'unpaid' }));
    expect(r.status).toBe('retryable_error');
  });

  it('complete + unpaid → retryable_error', async () => {
    const r = await verify(mockResponse(200, { status: 'complete', payment_status: 'unpaid' }));
    expect(r.status).toBe('retryable_error');
  });

  it('no_payment_required → config_error', async () => {
    const r = await verify(mockResponse(200, { payment_status: 'no_payment_required' }));
    expect(r.status).toBe('config_error');
  });

  it('HTTP 401 → config_error', async () => {
    const r = await verify(mockResponse(401, { error: { type: 'authentication_error' } }));
    expect(r.status).toBe('config_error');
  });

  it('HTTP 500 → retryable_error', async () => {
    const r = await verify(mockResponse(500, {}));
    expect(r.status).toBe('retryable_error');
  });
});

describe('Stripe PaymentIntent verification safety', () => {
  async function verify(fetchResponse: unknown) {
    mockFetch.mockResolvedValueOnce(fetchResponse);
    // eslint-disable-next-line
    return verifyWithProvider(buildSupabase() as any, {
      provider: 'stripe', gatewayReference: 'pi_test_123', expectedAmount: 5000, expectedCurrency: 'USD',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
  }

  it('succeeded → verified', async () => {
    const r = await verify(mockResponse(200, { status: 'succeeded', amount: 500000, currency: 'usd', id: 'pi_1' }));
    expect(r.status).toBe('verified');
  });

  it('canceled → not_paid', async () => {
    const r = await verify(mockResponse(200, { status: 'canceled' }));
    expect(r.status).toBe('not_paid');
  });

  it('processing → retryable_error', async () => {
    const r = await verify(mockResponse(200, { status: 'processing' }));
    expect(r.status).toBe('retryable_error');
  });

  it('requires_action → retryable_error', async () => {
    const r = await verify(mockResponse(200, { status: 'requires_action' }));
    expect(r.status).toBe('retryable_error');
  });

  it('requires_capture → retryable_error', async () => {
    const r = await verify(mockResponse(200, { status: 'requires_capture' }));
    expect(r.status).toBe('retryable_error');
  });

  it('unknown → retryable_error', async () => {
    const r = await verify(mockResponse(200, { status: 'new_unknown' }));
    expect(r.status).toBe('retryable_error');
  });
});

// ═══════════════════════════════════════════════════════════
// FLUTTERWAVE
// ═══════════════════════════════════════════════════════════

describe('Flutterwave verification safety', () => {
  async function verify(fetchResponse: unknown) {
    mockFetch.mockResolvedValueOnce(fetchResponse);
    // eslint-disable-next-line
    return verifyWithProvider(buildSupabase() as any, {
      provider: 'flutterwave', gatewayReference: 'FLW-REF-1', expectedAmount: 5000, expectedCurrency: 'NGN',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
  }

  it('successful → verified', async () => {
    const r = await verify(mockResponse(200, { status: 'success', data: { status: 'successful', amount: 5000, currency: 'NGN', id: 1 } }));
    expect(r.status).toBe('verified');
  });

  it('failed → not_paid', async () => {
    const r = await verify(mockResponse(200, { status: 'success', data: { status: 'failed' } }));
    expect(r.status).toBe('not_paid');
  });

  it('pending → retryable_error', async () => {
    const r = await verify(mockResponse(200, { status: 'success', data: { status: 'pending' } }));
    expect(r.status).toBe('retryable_error');
  });

  it('unknown → retryable_error', async () => {
    const r = await verify(mockResponse(200, { status: 'success', data: { status: 'weird' } }));
    expect(r.status).toBe('retryable_error');
  });

  it('HTTP 401 → config_error', async () => {
    const r = await verify(mockResponse(401, { status: 'error' }));
    expect(r.status).toBe('config_error');
  });

  it('HTTP 500 → retryable_error', async () => {
    const r = await verify(mockResponse(500, {}));
    expect(r.status).toBe('retryable_error');
  });
});

// ═══════════════════════════════════════════════════════════
// SQUARE
// ═══════════════════════════════════════════════════════════

describe('Square verification safety', () => {
  async function verify(fetchResponse: unknown) {
    mockFetch.mockResolvedValueOnce(fetchResponse);
    // eslint-disable-next-line
    return verifyWithProvider(buildSupabase() as any, {
      provider: 'square', gatewayReference: 'SQ-REF-1', expectedAmount: 5000, expectedCurrency: 'USD',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
  }

  it('COMPLETED → verified', async () => {
    const r = await verify(mockResponse(200, { payment: { status: 'COMPLETED', id: 'p1', amount_money: { amount: 500000, currency: 'USD' }, source_type: 'CARD' } }));
    expect(r.status).toBe('verified');
  });

  it('CANCELED → not_paid', async () => {
    const r = await verify(mockResponse(200, { payment: { status: 'CANCELED' } }));
    expect(r.status).toBe('not_paid');
  });

  it('FAILED → not_paid', async () => {
    const r = await verify(mockResponse(200, { payment: { status: 'FAILED' } }));
    expect(r.status).toBe('not_paid');
  });

  it('APPROVED → retryable_error', async () => {
    const r = await verify(mockResponse(200, { payment: { status: 'APPROVED' } }));
    expect(r.status).toBe('retryable_error');
  });

  it('PENDING → retryable_error', async () => {
    const r = await verify(mockResponse(200, { payment: { status: 'PENDING' } }));
    expect(r.status).toBe('retryable_error');
  });

  it('HTTP 401 → config_error', async () => {
    const r = await verify(mockResponse(401, { errors: [{ code: 'UNAUTHORIZED' }] }));
    expect(r.status).toBe('config_error');
  });
});

// ═══════════════════════════════════════════════════════════
// PAYPAL
// ═══════════════════════════════════════════════════════════

describe('PayPal verification safety', () => {
  const oauthOk = mockResponse(200, { access_token: 'tok' });

  async function verify(oauthRes: unknown, orderRes?: unknown) {
    if (orderRes) {
      mockFetch.mockResolvedValueOnce(oauthRes).mockResolvedValueOnce(orderRes);
    } else {
      mockFetch.mockResolvedValueOnce(oauthRes);
    }
    // eslint-disable-next-line
    return verifyWithProvider(buildSupabase() as any, {
      provider: 'paypal', gatewayReference: 'ORDER-1', expectedAmount: 50, expectedCurrency: 'USD',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
  }

  it('OAuth 401 → config_error', async () => {
    const r = await verify(mockResponse(401, { error: 'invalid_client' }), mockResponse(200, {}));
    expect(r.status).toBe('config_error');
    expect(mockFetch).toHaveBeenCalledTimes(1); // no order call
  });

  it('OAuth 500 → retryable_error', async () => {
    const r = await verify(mockResponse(500, {}), mockResponse(200, {}));
    expect(r.status).toBe('retryable_error');
  });

  it('OAuth success but no token → config_error', async () => {
    const r = await verify(mockResponse(200, {}), mockResponse(200, {}));
    expect(r.status).toBe('config_error');
  });

  it('Order VOIDED → not_paid', async () => {
    const r = await verify(oauthOk, mockResponse(200, { status: 'VOIDED' }));
    expect(r.status).toBe('not_paid');
  });

  it('Order CREATED → retryable_error', async () => {
    const r = await verify(oauthOk, mockResponse(200, { status: 'CREATED' }));
    expect(r.status).toBe('retryable_error');
  });

  it('Order APPROVED → retryable_error', async () => {
    const r = await verify(oauthOk, mockResponse(200, { status: 'APPROVED' }));
    expect(r.status).toBe('retryable_error');
  });

  it('Order COMPLETED + capture COMPLETED → verified', async () => {
    const r = await verify(oauthOk, mockResponse(200, {
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ status: 'COMPLETED', id: 'cap1', amount: { value: '50.00', currency_code: 'USD' } }] } }],
    }));
    expect(r.status).toBe('verified');
  });

  it('Order COMPLETED + capture PENDING → retryable_error', async () => {
    const r = await verify(oauthOk, mockResponse(200, {
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ status: 'PENDING', id: 'cap1', amount: { value: '50.00', currency_code: 'USD' } }] } }],
    }));
    expect(r.status).toBe('retryable_error');
  });

  it('Order COMPLETED + capture DECLINED → not_paid', async () => {
    const r = await verify(oauthOk, mockResponse(200, {
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ status: 'DECLINED', id: 'cap1', amount: { value: '50.00', currency_code: 'USD' } }] } }],
    }));
    expect(r.status).toBe('not_paid');
  });

  it('Order COMPLETED + capture FAILED → retryable_error (NOT not_paid)', async () => {
    const r = await verify(oauthOk, mockResponse(200, {
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ status: 'FAILED', id: 'cap1' }] } }],
    }));
    expect(r.status).toBe('retryable_error');
  });

  it('Order COMPLETED + capture REFUNDED → retryable_error', async () => {
    const r = await verify(oauthOk, mockResponse(200, {
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ status: 'REFUNDED', id: 'cap1' }] } }],
    }));
    expect(r.status).toBe('retryable_error');
  });

  it('Order COMPLETED + missing capture → retryable_error', async () => {
    const r = await verify(oauthOk, mockResponse(200, { status: 'COMPLETED', purchase_units: [{ payments: {} }] }));
    expect(r.status).toBe('retryable_error');
  });

  it('Order COMPLETED + unknown capture → retryable_error', async () => {
    const r = await verify(oauthOk, mockResponse(200, {
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ status: 'WEIRD_NEW_STATUS' }] } }],
    }));
    expect(r.status).toBe('retryable_error');
  });

  it('Order HTTP 404 → retryable_error', async () => {
    const r = await verify(oauthOk, mockResponse(404, { name: 'RESOURCE_NOT_FOUND' }));
    expect(r.status).toBe('retryable_error');
  });
});

// ═══════════════════════════════════════════════════════════
// CROSS-CUTTING: no outcome can bypass #168 gate
// ═══════════════════════════════════════════════════════════

describe('Cross-cutting: only not_paid and verified are definitive', () => {
  it('retryable_error cannot authorize replacement checkout', async () => {
    // This is enforced by bot-recovery.ts mapping + recovery-gated retry
    // Verify the adapter produces the right type
    mockFetch.mockResolvedValueOnce(mockResponse(429, { status: false }));
    // eslint-disable-next-line
    const r = await verifyWithProvider(buildSupabase() as any, { provider: 'paystack', gatewayReference: 'REF-1', ...BASE_OPTS });
    expect(r.status).toBe('retryable_error');
    expect(r.status).not.toBe('not_paid');
    expect(r.status).not.toBe('verified');
  });
});
