/**
 * Paystack Charge Outcome Boundary Tests (#176)
 *
 * Proves chargeAuthorization and verifyPaystackTransaction preserve
 * #168/#172 HTTP fidelity and fail-closed semantics:
 * - HTTP 400/401/403/429/5xx → indeterminate (never authorize replacement)
 * - Malformed JSON → indeterminate
 * - Network/timeout → indeterminate
 * - Provider success → typed success with transactionId
 * - Provider failure → typed terminal_failure
 * - Provider pending → typed pending (leave dispatched)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const MOCK_KEY = 'test_key_for_unit_test_ps_outcomes';

describe('chargeAuthorization typed outcomes (#176)', () => {
  let chargeAuthorization: typeof import('@/lib/payments/paystack-recurring').chargeAuthorization;

  beforeEach(async () => {
    vi.resetModules();
    process.env.PAYSTACK_SECRET_KEY = MOCK_KEY;
    vi.doMock('@/lib/logger', () => {
      const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
      l.withContext = () => l;
      return { logger: l };
    });
    vi.doMock('@/lib/redact', () => ({
      safeProviderError: (d: unknown) => d,
    }));
    const mod = await import('@/lib/payments/paystack-recurring');
    chargeAuthorization = mod.chargeAuthorization;
  });

  afterEach(() => {
    delete process.env.PAYSTACK_SECRET_KEY;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('success → typed success with transactionId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: { status: 'success', reference: 'ref-1', id: 12345 },
      }),
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-1');
    expect(r.status).toBe('success');
    if (r.status === 'success') {
      expect(r.reference).toBe('ref-1');
      expect(r.transactionId).toBe('12345');
    }
  });

  it('provider failed → terminal_failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: { status: 'failed', reference: 'ref-2' },
      }),
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-2');
    expect(r.status).toBe('terminal_failure');
    if (r.status === 'terminal_failure') {
      expect(r.reason).toContain('paystack_charge_failed');
    }
  });

  it('provider abandoned → terminal_failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: { status: 'abandoned', reference: 'ref-3' },
      }),
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-3');
    expect(r.status).toBe('terminal_failure');
    if (r.status === 'terminal_failure') {
      expect(r.reason).toContain('abandoned');
    }
  });

  it('provider pending → typed pending', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: { status: 'pending', reference: 'ref-4' },
      }),
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-4');
    expect(r.status).toBe('pending');
    if (r.status === 'pending') {
      expect(r.providerStatus).toBe('pending');
    }
  });

  it('API rejected (status false) → terminal_failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: false,
        message: 'Invalid authorization code',
      }),
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-5');
    expect(r.status).toBe('terminal_failure');
    if (r.status === 'terminal_failure') {
      expect(r.reason).toContain('api_rejected');
    }
  });

  // ── HTTP error matrix (#172 pattern) ──

  it('HTTP 400 → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 400,
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-6');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('http_400');
    }
  });

  it('HTTP 401 → indeterminate with config tag', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401,
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-7');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('http_401_config');
    }
  });

  it('HTTP 403 → indeterminate with config tag', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 403,
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-8');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('http_403_config');
    }
  });

  it('HTTP 429 → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429,
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-9');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('http_429');
    }
  });

  it('HTTP 500 → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500,
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-10');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('http_500');
    }
  });

  it('HTTP 502 → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 502,
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-11');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('http_502');
    }
  });

  // ── Malformed/network errors ──

  it('malformed JSON → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => { throw new SyntaxError('Unexpected token'); },
    }));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-12');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('malformed_json');
    }
  });

  it('network error → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-13');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('network_error');
    }
  });

  it('timeout → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('signal timed out', 'AbortError')));

    const r = await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-14');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('network_error');
    }
  });

  // ── Split params forwarded correctly ──

  it('split params included in fetch body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: true, data: { status: 'success', reference: 'ref-split' } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await chargeAuthorization('AUTH_x', 5000, 'a@b.com', 'ref-split', {
      subaccount: 'ACCT_test',
      transaction_charge: 250,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.subaccount).toBe('ACCT_test');
    expect(body.transaction_charge).toBe(250);
  });
});

describe('verifyPaystackTransaction typed outcomes (#176)', () => {
  let verifyPaystackTransaction: typeof import('@/lib/payments/paystack-recurring').verifyPaystackTransaction;

  beforeEach(async () => {
    vi.resetModules();
    process.env.PAYSTACK_SECRET_KEY = MOCK_KEY;
    vi.doMock('@/lib/logger', () => {
      const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
      l.withContext = () => l;
      return { logger: l };
    });
    vi.doMock('@/lib/redact', () => ({
      safeProviderError: (d: unknown) => d,
    }));
    const mod = await import('@/lib/payments/paystack-recurring');
    verifyPaystackTransaction = mod.verifyPaystackTransaction;
  });

  afterEach(() => {
    delete process.env.PAYSTACK_SECRET_KEY;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('success → typed success with amount and transactionId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: { status: 'success', amount: 50000, currency: 'NGN', id: 99 },
      }),
    }));

    const r = await verifyPaystackTransaction('ref-v1');
    expect(r.status).toBe('success');
    if (r.status === 'success') {
      expect(r.amountMinor).toBe(50000);
      expect(r.currency).toBe('NGN');
      expect(r.transactionId).toBe('99');
    }
  });

  it('failed → terminal_failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: { status: 'failed', amount: 50000 },
      }),
    }));

    const r = await verifyPaystackTransaction('ref-v2');
    expect(r.status).toBe('terminal_failure');
  });

  it('reversed → typed reversed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: { status: 'reversed', amount: 50000 },
      }),
    }));

    const r = await verifyPaystackTransaction('ref-v3');
    expect(r.status).toBe('reversed');
  });

  it('pending → typed pending', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: { status: 'processing', amount: 50000 },
      }),
    }));

    const r = await verifyPaystackTransaction('ref-v4');
    expect(r.status).toBe('pending');
  });

  it('not found → typed not_found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: false, message: 'Transaction not found' }),
    }));

    const r = await verifyPaystackTransaction('ref-v5');
    expect(r.status).toBe('not_found');
  });

  it('HTTP 401 → indeterminate (not not_found)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401,
    }));

    const r = await verifyPaystackTransaction('ref-v6');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('http_401_config');
    }
  });

  it('HTTP 500 → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500,
    }));

    const r = await verifyPaystackTransaction('ref-v7');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('http_500');
    }
  });

  it('network error → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));

    const r = await verifyPaystackTransaction('ref-v8');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('network_error');
    }
  });

  it('no credentials → indeterminate', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    vi.resetModules();
    vi.doMock('@/lib/logger', () => {
      const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
      l.withContext = () => l;
      return { logger: l };
    });
    vi.doMock('@/lib/redact', () => ({
      safeProviderError: (d: unknown) => d,
    }));
    const mod = await import('@/lib/payments/paystack-recurring');

    const r = await mod.verifyPaystackTransaction('ref-v9');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') {
      expect(r.reason).toBe('no_credentials');
    }
  });
});

describe('fetchSubscriptionInvoice boundary (#176)', () => {
  let fetchSubscriptionInvoice: typeof import('@/lib/payments/paystack-recurring').fetchSubscriptionInvoice;

  beforeEach(async () => {
    vi.resetModules();
    process.env.PAYSTACK_SECRET_KEY = MOCK_KEY;
    vi.doMock('@/lib/logger', () => {
      const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
      l.withContext = () => l;
      return { logger: l };
    });
    vi.doMock('@/lib/redact', () => ({
      safeProviderError: (d: unknown) => d,
    }));
    const mod = await import('@/lib/payments/paystack-recurring');
    fetchSubscriptionInvoice = mod.fetchSubscriptionInvoice;
  });

  afterEach(() => {
    delete process.env.PAYSTACK_SECRET_KEY;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('matches invoice by transaction ID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: {
          invoices: [
            { invoice_code: 'INV_old', transaction: 100, amount: 5000, status: 'success' },
            { invoice_code: 'INV_match', transaction: 200, amount: 5000, status: 'success' },
          ],
          most_recent_invoice: { invoice_code: 'INV_old', transaction: 100, amount: 5000, status: 'success' },
        },
      }),
    }));

    const r = await fetchSubscriptionInvoice('SUB_x', '200');
    expect(r).not.toBeNull();
    expect(r!.invoiceCode).toBe('INV_match');
  });

  it('falls back to most_recent_invoice when no transaction match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: {
          invoices: [],
          most_recent_invoice: { invoice_code: 'INV_recent', transaction: 300, amount: 5000, status: 'success' },
        },
      }),
    }));

    const r = await fetchSubscriptionInvoice('SUB_x', '999');
    expect(r).not.toBeNull();
    expect(r!.invoiceCode).toBe('INV_recent');
  });

  it('HTTP error → null (fail-closed)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500,
    }));

    const r = await fetchSubscriptionInvoice('SUB_x');
    expect(r).toBeNull();
  });

  it('network error → null (fail-closed)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const r = await fetchSubscriptionInvoice('SUB_x');
    expect(r).toBeNull();
  });

  it('no credentials → null', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    vi.resetModules();
    vi.doMock('@/lib/logger', () => {
      const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
      l.withContext = () => l;
      return { logger: l };
    });
    vi.doMock('@/lib/redact', () => ({
      safeProviderError: (d: unknown) => d,
    }));
    const mod = await import('@/lib/payments/paystack-recurring');

    const r = await mod.fetchSubscriptionInvoice('SUB_x');
    expect(r).toBeNull();
  });
});
