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

  it('explicit transaction mismatch → null (does NOT fall back to most_recent_invoice)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: {
          invoices: [
            { invoice_code: 'INV_other', transaction: 300, amount: 5000, status: 'success' },
          ],
          most_recent_invoice: { invoice_code: 'INV_recent', transaction: 300, amount: 5000, status: 'success' },
        },
      }),
    }));

    // Transaction 999 not found — must return null, NOT INV_recent
    const r = await fetchSubscriptionInvoice('SUB_x', '999');
    expect(r).toBeNull();
  });

  it('discovery mode (no transactionId) → returns most_recent_invoice', async () => {
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

    // No explicit transactionId — discovery mode uses most_recent_invoice
    const r = await fetchSubscriptionInvoice('SUB_x');
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

  // ── Provider invoice endpoint failure modes (#176 R3) ──

  it('invoice endpoint 4xx → null (cycle identity unresolved)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404,
    }));

    const r = await fetchSubscriptionInvoice('SUB_x', '123');
    expect(r).toBeNull();
  });

  it('invoice endpoint malformed JSON → null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => { throw new SyntaxError('Unexpected token'); },
    }));

    const r = await fetchSubscriptionInvoice('SUB_x', '123');
    expect(r).toBeNull();
  });

  it('invoice endpoint timeout → null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new DOMException('signal timed out', 'AbortError'),
    ));

    const r = await fetchSubscriptionInvoice('SUB_x', '123');
    expect(r).toBeNull();
  });
});

describe('correlateInvoiceExact typed boundary (#176 R7)', () => {
  let correlateInvoiceExact: typeof import('@/lib/payments/paystack-recurring').correlateInvoiceExact;

  beforeEach(async () => {
    vi.resetModules();
    process.env.PAYSTACK_SECRET_KEY = MOCK_KEY;
    vi.doMock('@/lib/logger', () => {
      const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
      l.withContext = () => l;
      return { logger: l };
    });
    vi.doMock('@/lib/redact', () => ({ safeProviderError: (d: unknown) => d }));
    const mod = await import('@/lib/payments/paystack-recurring');
    correlateInvoiceExact = mod.correlateInvoiceExact;
  });

  afterEach(() => {
    delete process.env.PAYSTACK_SECRET_KEY;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exact transaction match → exact_match with invoice data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: {
          invoices: [
            { invoice_code: 'INV_exact', transaction: 200, amount: 5000, status: 'success' },
          ],
        },
      }),
    }));

    const r = await correlateInvoiceExact('SUB_x', '200');
    expect(r.status).toBe('exact_match');
    if (r.status === 'exact_match') {
      expect(r.invoiceCode).toBe('INV_exact');
      expect(r.amount).toBe(5000);
      expect(r.invoiceStatus).toBe('success');
    }
  });

  it('no transaction match in well-formed response → definitive_no_match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: true,
        data: { invoices: [{ invoice_code: 'INV_other', transaction: 300, amount: 5000, status: 'success' }] },
      }),
    }));

    const r = await correlateInvoiceExact('SUB_x', '999');
    expect(r.status).toBe('definitive_no_match');
  });

  it('HTTP 500 → indeterminate (NOT no-match)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const r = await correlateInvoiceExact('SUB_x', '123');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') expect(r.reason).toBe('http_500');
  });

  it('network error → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const r = await correlateInvoiceExact('SUB_x', '123');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') expect(r.reason).toBe('network_error');
  });

  it('timeout → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timeout', 'AbortError')));

    const r = await correlateInvoiceExact('SUB_x', '123');
    expect(r.status).toBe('indeterminate');
  });

  it('malformed JSON → indeterminate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => { throw new SyntaxError('Unexpected'); },
    }));

    const r = await correlateInvoiceExact('SUB_x', '123');
    expect(r.status).toBe('indeterminate');
    if (r.status === 'indeterminate') expect(r.reason).toBe('malformed_json');
  });

  it('no credentials → indeterminate', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    vi.resetModules();
    vi.doMock('@/lib/logger', () => {
      const l: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() };
      l.withContext = () => l;
      return { logger: l };
    });
    vi.doMock('@/lib/redact', () => ({ safeProviderError: (d: unknown) => d }));
    const mod = await import('@/lib/payments/paystack-recurring');

    const r = await mod.correlateInvoiceExact('SUB_x', '123');
    expect(r.status).toBe('indeterminate');
  });
});

// ═══════════════════════════════════════════════════════════
// PROVIDER-MANAGED WEBHOOK BOUNDARY TESTS (#176 R3)
// Proves unresolved-invoice behavior at the application layer:
// no accounting finalization, durable reconciliation state,
// later replay convergence.
// ═══════════════════════════════════════════════════════════

describe('provider-managed webhook: unresolved invoice identity (#176 R3)', () => {
  it('D. webhook + unresolved invoice → source-string proves no finalization, reconciliation preserved', () => {
    const fs = require('fs') as typeof import('fs');
    const webhookCode = fs.readFileSync('app/api/payments/webhook/route.ts', 'utf-8');

    // The webhook must NOT contain invoiceCode || reference as cycle discriminator
    expect(webhookCode).not.toContain('invoiceCode || reference');

    // When invoiceCode is null, the code must preserve reconciliation evidence
    // Find the provider-managed section
    const providerSection = webhookCode.substring(
      webhookCode.indexOf('Fetch authoritative invoice_code for billing-cycle identity'),
      webhookCode.indexOf('No local subscription for subscription_code'),
    );

    // Must check for null invoiceCode before any finalization
    expect(providerSection).toContain('if (!invoiceCode)');

    // Must preserve reconciliation evidence
    expect(providerSection).toContain('reconciliation_required');
    expect(providerSection).toContain('provider_managed_invoice_unresolved');

    // Must NOT finalize when invoiceCode is null
    const unresolvedBlock = providerSection.substring(
      providerSection.indexOf('if (!invoiceCode)'),
      providerSection.indexOf('} else {'),
    );
    // The unresolved block must NOT contain finalize_paystack_recurring_charge
    expect(unresolvedBlock).not.toContain('finalize_paystack_recurring_charge');
    // Must NOT create billing attempts
    expect(unresolvedBlock).not.toContain("from('paystack_billing_attempts')");
    // Must NOT create payments
    expect(unresolvedBlock).not.toContain("from('payments')");
  });

  it('E. durable reconciliation evidence contains all identity needed for later replay', () => {
    const fs = require('fs') as typeof import('fs');
    const webhookCode = fs.readFileSync('app/api/payments/webhook/route.ts', 'utf-8');

    const unresolvedSection = webhookCode.substring(
      webhookCode.indexOf('provider_managed_invoice_unresolved'),
      webhookCode.indexOf('Invoice unresolved for provider-managed charge'),
    );

    // Must preserve: reference, subscription_code, subscription_id, amount, currency, transaction_id
    expect(unresolvedSection).toContain('reference');
    expect(unresolvedSection).toContain('subscription_code');
    expect(unresolvedSection).toContain('subscription_id');
    expect(unresolvedSection).toContain('amount_kobo');
    expect(unresolvedSection).toContain('currency');
    expect(unresolvedSection).toContain('transaction_id');
  });

  it('F. fetchSubscriptionInvoice explicit-match mode does NOT bind unrelated invoice', () => {
    const fs = require('fs') as typeof import('fs');
    const code = fs.readFileSync('lib/payments/paystack-recurring.ts', 'utf-8');

    // Find the fetchSubscriptionInvoice function
    const fnStart = code.indexOf('export async function fetchSubscriptionInvoice');
    const fnEnd = code.indexOf('export', fnStart + 10);
    const fnCode = code.substring(fnStart, fnEnd > fnStart ? fnEnd : code.length);

    // When transactionId is provided: must return null if no match, NOT most_recent_invoice
    expect(fnCode).toContain('if (transactionId)');

    // After the transaction search loop, there must be an explicit 'return null'
    // BEFORE any most_recent_invoice usage
    const txBlock = fnCode.substring(
      fnCode.indexOf('if (transactionId)'),
      fnCode.indexOf('Discovery mode'),
    );
    expect(txBlock).toContain('return null');
    // The txBlock must NOT use most_recent_invoice as a value (the comment mentioning it is OK)
    // Verify: no `subData.most_recent_invoice` or `mostRecent` variable access in this block
    expect(txBlock).not.toContain('subData.most_recent_invoice');
    expect(txBlock).not.toContain('mostRecent');
  });

  it('G. provider-managed cycle key uses only invoice_code, never reference/transaction', () => {
    const fs = require('fs') as typeof import('fs');
    const webhookCode = fs.readFileSync('app/api/payments/webhook/route.ts', 'utf-8');

    // Find the provider-managed finalization section (after invoiceCode is confirmed non-null)
    const resolvedSection = webhookCode.substring(
      webhookCode.indexOf('Authoritative invoice_code resolved'),
      webhookCode.indexOf('No local subscription for subscription_code'),
    );

    // Cycle key must use invoiceCode directly, not a fallback
    expect(resolvedSection).toContain('ps-auto-${localSub.id}-${invoiceCode}');
    expect(resolvedSection).not.toContain('invoiceCode || reference');
    expect(resolvedSection).not.toContain('cycleDiscriminator');
  });
});
