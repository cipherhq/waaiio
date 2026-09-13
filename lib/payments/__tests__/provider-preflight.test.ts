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
