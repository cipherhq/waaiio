/**
 * Provider preflight verification tests.
 *
 * Proves: plan validation against provider API, fail-closed on all error paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
  vi.clearAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ═══════════════════════════════════════════════════════════
// verifyPaystackPlan
// ═══════════════════════════════════════════════════════════

describe('verifyPaystackPlan', () => {
  const BASE_INPUT = {
    planCode: 'PLN_test123',
    expectedCurrency: 'NGN',
    expectedAmountMajor: 5000,
    paystackKey: 'test_placeholder_not_real_ps',
  };

  async function verify(input = BASE_INPUT) {
    const { verifyPaystackPlan } = await import('../provider-preflight');
    return verifyPaystackPlan(input);
  }

  it('active plan with matching currency/amount/interval -> ok', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      status: true,
      data: {
        plan_code: 'PLN_test123',
        name: 'Growth Monthly NGN',
        currency: 'NGN',
        amount: 500000, // 5000 * 100
        interval: 'monthly',
        is_archived: false,
      },
    }));

    const result = await verify();
    expect(result.ok).toBe(true);
    expect(result.details?.currency).toBe('NGN');
    expect(result.details?.amount).toBe(500000);
  });

  it('plan not found (404) -> fail closed', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: false, message: 'Plan not found' }, 404));

    const result = await verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('HTTP 404');
  });

  it('plan archived -> fail closed', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      status: true,
      data: {
        plan_code: 'PLN_test123',
        currency: 'NGN',
        amount: 500000,
        interval: 'monthly',
        is_archived: true,
      },
    }));

    const result = await verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('archived');
  });

  it('currency mismatch -> fail closed', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      status: true,
      data: {
        plan_code: 'PLN_test123',
        currency: 'GHS',
        amount: 500000,
        interval: 'monthly',
        is_archived: false,
      },
    }));

    const result = await verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('currency');
    expect(result.reason).toContain('GHS');
  });

  it('amount mismatch (minor units) -> fail closed', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      status: true,
      data: {
        plan_code: 'PLN_test123',
        currency: 'NGN',
        amount: 300000, // 3000 * 100, but expected 5000 * 100 = 500000
        interval: 'monthly',
        is_archived: false,
      },
    }));

    const result = await verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('amount');
    expect(result.reason).toContain('300000');
  });

  it('interval mismatch -> fail closed', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      status: true,
      data: {
        plan_code: 'PLN_test123',
        currency: 'NGN',
        amount: 500000,
        interval: 'annually',
        is_archived: false,
      },
    }));

    const result = await verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('interval');
    expect(result.reason).toContain('annually');
  });

  it('provider 5xx -> fail closed', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ message: 'Internal error' }, 500));

    const result = await verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('HTTP 500');
  });

  it('network error -> fail closed', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ECONNREFUSED');
  });
});

// ═══════════════════════════════════════════════════════════
// verifyFlutterwavePlan
// ═══════════════════════════════════════════════════════════

describe('verifyFlutterwavePlan', () => {
  const BASE_INPUT = {
    planId: '12345',
    expectedCurrency: 'NGN',
    expectedAmountMajor: 5000,
    flutterwaveKey: 'FAKE_FLW_KEY_TEST',
  };

  async function verify(input = BASE_INPUT) {
    const { verifyFlutterwavePlan } = await import('../provider-preflight');
    return verifyFlutterwavePlan(input);
  }

  it('active plan with matching values -> ok', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      status: 'success',
      data: {
        id: 12345,
        name: 'Growth Monthly NGN',
        currency: 'NGN',
        amount: 5000,
        interval: 'monthly',
        status: 'active',
      },
    }));

    const result = await verify();
    expect(result.ok).toBe(true);
  });

  it('inactive plan -> fail closed', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      status: 'success',
      data: {
        currency: 'NGN',
        amount: 5000,
        interval: 'monthly',
        status: 'cancelled',
      },
    }));

    const result = await verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('status');
  });

  it('network error -> fail closed', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    const result = await verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('timeout');
  });
});

// ═══════════════════════════════════════════════════════════
// verifyStripeReadiness
// ═══════════════════════════════════════════════════════════

describe('verifyStripeReadiness', () => {
  it('valid key -> ok', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      available: [{ amount: 1000, currency: 'usd' }],
      livemode: false,
    }));

    const { verifyStripeReadiness } = await import('../provider-preflight');
    const result = await verifyStripeReadiness({ stripeKey: 'test_placeholder_not_real_stripe' });
    expect(result.ok).toBe(true);
  });

  it('invalid key (401) -> fail closed', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid API Key' } }, 401));

    const { verifyStripeReadiness } = await import('../provider-preflight');
    const result = await verifyStripeReadiness({ stripeKey: 'test_placeholder_invalid' });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('HTTP 401');
  });
});

describe('verifyStripePrice — fixed monthly catalog contract', () => {
  const input = { priceId: 'price_syntheticPro', expectedCurrency: 'USD', expectedAmountMajor: 29.99, stripeKey: 'sk_test_synthetic' };
  const valid = () => ({ id: input.priceId, object: 'price', active: true, type: 'recurring', billing_scheme: 'per_unit',
    currency: 'usd', unit_amount: 2999, unit_amount_decimal: '2999', custom_unit_amount: null, transform_quantity: null, tiers_mode: null,
    livemode: false, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    product: { id: 'prod_syntheticPro', object: 'product', active: true, livemode: false } });
  async function verify(overrides = {}) { return (await import('../provider-preflight')).verifyStripePrice({ ...input, ...overrides }); }
  it('retrieves exact ID with expanded product, platform key and timeout, without writes', async () => {
    mockFetch.mockResolvedValue(jsonResponse(valid()));
    expect((await verify()).ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/prices/price_syntheticPro?expand%5B%5D=product');
    expect(opts.method).toBe('GET'); expect(opts.headers).toEqual({ Authorization: 'Bearer sk_test_synthetic' });
    expect(opts.signal).toBeInstanceOf(AbortSignal); expect(opts.body).toBeUndefined();
  });
  it.each([
    ['wrong ID', { id: 'price_other' }], ['wrong object', { object: 'plan' }], ['inactive', { active: false }],
    ['one time', { type: 'one_time' }], ['tiered', { billing_scheme: 'tiered' }], ['currency', { currency: 'cad' }],
    ['amount', { unit_amount: 3000 }], ['fractional minor', { unit_amount: 2999.5 }], ['string amount', { unit_amount: '2999' }],
    ['decimal mismatch', { unit_amount_decimal: '2999.5' }], ['custom amount', { custom_unit_amount: { enabled: true } }],
    ['transformed quantity', { transform_quantity: { divide_by: 2 } }], ['tier mode', { tiers_mode: 'volume' }],
    ['missing recurring', { recurring: null }], ['annual', { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } }],
    ['multi month', { recurring: { interval: 'month', interval_count: 2, usage_type: 'licensed' } }],
    ['metered', { recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } }],
    ['unexpanded product', { product: 'prod_syntheticPro' }], ['missing product', { product: null }],
    ['inactive product', { product: { id: 'prod_syntheticPro', object: 'product', active: false, livemode: false } }],
    ['deleted product', { product: { id: 'prod_syntheticPro', object: 'product', active: true, deleted: true, livemode: false } }],
    ['mode mismatch', { livemode: true }],
  ])('rejects %s without any provider write', async (_name, patch) => {
    mockFetch.mockResolvedValue(jsonResponse({ ...valid(), ...patch }));
    expect((await verify()).ok).toBe(false);
    expect(mockFetch.mock.calls.every(([, opts]) => opts.method === 'GET')).toBe(true);
  });
  it.each(['', 'price_bad/path', ' price_syntheticPro', 'prod_syntheticPro'])('rejects malformed requested ID %s before fetch', async priceId => {
    expect((await verify({ priceId })).ok).toBe(false); expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.001, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid authoritative amount %s before fetch', async expectedAmountMajor => {
    expect((await verify({ expectedAmountMajor })).ok).toBe(false); expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { id: input.priceId }])('rejects malformed provider body %#', async value => {
    mockFetch.mockResolvedValue(jsonResponse(value)); expect((await verify()).ok).toBe(false);
  });
  it.each([401, 404, 429, 500])('fails closed on HTTP %s', async status => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'synthetic' }, status)); expect((await verify()).ok).toBe(false);
  });
  it.each(['network', 'timeout', 'json'])('fails closed on %s without exposing raw errors', async mode => {
    if (mode === 'json') mockFetch.mockResolvedValue({ ok: true, json: async () => { throw new Error('private provider payload'); } });
    else mockFetch.mockRejectedValue(new Error('private provider payload'));
    const result = await verify(); expect(result.ok).toBe(false); expect(result.reason).not.toContain('private provider payload');
  });
});
