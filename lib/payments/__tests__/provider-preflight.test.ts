/**
 * M378 Phase 2 — Provider Preflight Validation Tests
 *
 * Tests the actual production preflight functions:
 * - verifyFlutterwavePlan: plan exists, active, currency/amount/cadence match
 * - verifyStripeReadiness: API key valid, API reachable
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { verifyFlutterwavePlan, verifyStripeReadiness } from '../provider-preflight';

beforeEach(() => { mockFetch.mockReset(); });

// ═════ Flutterwave Plan Preflight ═════

describe('verifyFlutterwavePlan', () => {
  const base = {
    planRef: '243206',
    expectedCurrency: 'NGN',
    expectedAmountMajor: 14999,
    expectedInterval: 'monthly' as const,
    flutterwaveKey: 'flw-key',
  };

  it('active plan with matching currency/amount/interval → ok', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { id: 243206, status: 'active', currency: 'NGN', amount: 14999, interval: 'monthly' },
      }),
    });
    expect((await verifyFlutterwavePlan(base)).ok).toBe(true);
    expect((mockFetch.mock.calls[0][0] as string)).toContain('/v3/payment-plans/243206');
  });

  it('plan not found (404) → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const r = await verifyFlutterwavePlan(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('provider_http_404');
  });

  it('plan inactive → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { id: 243206, status: 'cancelled', currency: 'NGN', amount: 14999, interval: 'monthly' },
      }),
    });
    const r = await verifyFlutterwavePlan(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('plan_not_active');
  });

  it('currency mismatch → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { id: 243206, status: 'active', currency: 'USD', amount: 14999, interval: 'monthly' },
      }),
    });
    const r = await verifyFlutterwavePlan(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('currency_mismatch');
  });

  it('amount mismatch → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { id: 243206, status: 'active', currency: 'NGN', amount: 9999, interval: 'monthly' },
      }),
    });
    const r = await verifyFlutterwavePlan(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('amount_mismatch');
  });

  it('interval mismatch → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { id: 243206, status: 'active', currency: 'NGN', amount: 14999, interval: 'yearly' },
      }),
    });
    const r = await verifyFlutterwavePlan(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('interval_mismatch');
  });

  it('provider 5xx → fail closed (unavailable)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const r = await verifyFlutterwavePlan(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('provider_http_500');
  });

  it('network error → fail closed', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await verifyFlutterwavePlan(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('provider_unavailable');
  });

  it('non-success response body → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'error', message: 'Invalid plan' }),
    });
    const r = await verifyFlutterwavePlan(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('provider_non_success');
  });

  it('currency comparison is case-insensitive', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'success',
        data: { id: 243206, status: 'active', currency: 'ngn', amount: 14999, interval: 'monthly' },
      }),
    });
    expect((await verifyFlutterwavePlan(base)).ok).toBe(true);
  });
});

// ═════ Stripe Readiness ═════

describe('verifyStripeReadiness', () => {
  const base = { stripeKey: 'FAKE_STRIPE_KEY_FOR_TESTING' };

  it('valid API key + reachable → ok', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ object: 'balance', available: [] }),
    });
    expect((await verifyStripeReadiness(base)).ok).toBe(true);
    expect((mockFetch.mock.calls[0][0] as string)).toBe('https://api.stripe.com/v1/balance');
  });

  it('invalid API key (401) → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401,
      json: async () => ({ error: { message: 'Invalid API Key' } }),
    });
    const r = await verifyStripeReadiness(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stripe_http_401');
  });

  it('Stripe 5xx → fail closed', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 503,
      json: async () => ({ error: { message: 'Service unavailable' } }),
    });
    const r = await verifyStripeReadiness(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stripe_http_503');
  });

  it('network error → fail closed', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    const r = await verifyStripeReadiness(base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stripe_unavailable');
  });
});
