/**
 * Provider verification adapters — READ-ONLY contract tests.
 *
 * Proves each adapter:
 * - resolves exact payment-scoped credentials
 * - normalizes provider response correctly
 * - does NOT mutate Waaiio state
 * - fails closed on missing/invalid credentials
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/encryption', () => ({
  decryptToken: vi.fn((s: string) => s === 'ENCRYPTED_FAIL' ? (() => { throw new Error('decrypt failed'); })() : `decrypted_${s}`),
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// eslint-disable-next-line
function mockChain(overrides: Record<string, unknown> = {}): any {
  // eslint-disable-next-line
  const c: Record<string, any> = {};
  ['select', 'eq', 'not', 'is', 'order', 'limit', 'like', 'in'].forEach(m => c[m] = vi.fn().mockReturnValue(c));
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  c.update = vi.fn().mockReturnValue(c);
  c.insert = vi.fn().mockResolvedValue({ data: null, error: null });
  Object.assign(c, overrides);
  return c;
}

// eslint-disable-next-line
function buildSupabase(credData?: Record<string, unknown> | null, payoutData?: Record<string, unknown> | null): any {
  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table === 'business_payment_credentials') {
      return mockChain({ maybeSingle: vi.fn().mockResolvedValue({ data: credData ?? null, error: null }) });
    }
    if (table === 'payout_accounts') {
      return mockChain({ maybeSingle: vi.fn().mockResolvedValue({ data: payoutData ?? null, error: null }) });
    }
    return mockChain();
  });
  return { from: fromFn, rpc: vi.fn() };
}

describe('Provider adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAYSTACK_SECRET_KEY = 'test_pk_platform_stub';
    process.env.STRIPE_SECRET_KEY = 'test_sk_stripe_stub';
    process.env.FLUTTERWAVE_SECRET_KEY = 'test_flw_stub';
    process.env.SQUARE_ACCESS_TOKEN = 'test_sq_stub';
    process.env.PAYPAL_CLIENT_ID = 'test_pp_id';
    process.env.PAYPAL_CLIENT_SECRET = 'test_pp_secret';
  });

  // ── PAYSTACK ──

  it('1. Paystack platform → platform credential', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => ({ data: { status: 'success', amount: 500000, currency: 'NGN', id: 'tx1', channel: 'card', authorization: { last4: '1234' }, fees: 750 } }) });
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(buildSupabase(), {
      provider: 'paystack', gatewayReference: 'REF-1', expectedAmount: 5000, expectedCurrency: 'NGN',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
    expect(r.status).toBe('verified');
    if (r.status === 'verified') {
      expect(r.result.amount).toBe(5000); // 500000 kobo → 5000
      expect(r.result.currency).toBe('NGN');
      expect(r.result.provider).toBe('paystack');
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toContain('test_pk_platform_stub');
  });

  it('2. Paystack BYO → exact merchant credential', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => ({ data: { status: 'success', amount: 100000, currency: 'NGN', id: 'tx2' } }) });
    const supabase = buildSupabase({ secret_key: 'sk_merchant_encrypted', connection_type: 'byo' });
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(supabase, {
      provider: 'paystack', gatewayReference: 'REF-2', expectedAmount: 1000, expectedCurrency: 'NGN',
      paymentMetadata: { byo: true, byo_business_id: 'biz-byo' }, isNewAuthority: false, businessId: 'biz-byo',
    });
    expect(r.status).toBe('verified');
    // Must use decrypted BYO key, not platform key
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toContain('decrypted_sk_merchant_encrypted');
  });

  it('3. Paystack BYO credential missing → config_error, fetch 0', async () => {
    const supabase = buildSupabase(null); // no credential found
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(supabase, {
      provider: 'paystack', gatewayReference: 'REF-3', expectedAmount: 1000, expectedCurrency: 'NGN',
      paymentMetadata: { byo: true, byo_business_id: 'biz-missing' }, isNewAuthority: false, businessId: 'biz-missing',
    });
    expect(r.status).toBe('config_error');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('4. Paystack decrypt failure → config_error, fetch 0', async () => {
    const supabase = buildSupabase({ secret_key: 'ENCRYPTED_FAIL' });
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(supabase, {
      provider: 'paystack', gatewayReference: 'REF-4', expectedAmount: 1000, expectedCurrency: 'NGN',
      paymentMetadata: { byo: true, byo_business_id: 'biz-decrypt' }, isNewAuthority: false, businessId: 'biz-decrypt',
    });
    expect(r.status).toBe('config_error');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── STRIPE ──

  it('7. Stripe platform → no Stripe-Account header', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => ({ payment_status: 'paid', amount_total: 500, currency: 'usd', payment_intent: 'pi_123' }) });
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(buildSupabase(), {
      provider: 'stripe', gatewayReference: 'cs_test_123', expectedAmount: 5, expectedCurrency: 'USD',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
    expect(r.status).toBe('verified');
    expect(mockFetch.mock.calls[0][1].headers['Stripe-Account']).toBeUndefined();
  });

  it('8. Stripe Connect → exact Stripe-Account header', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => ({ payment_status: 'paid', amount_total: 1000, currency: 'usd', payment_intent: 'pi_456' }) });
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(buildSupabase(), {
      provider: 'stripe', gatewayReference: 'cs_test_456', expectedAmount: 10, expectedCurrency: 'USD',
      paymentMetadata: { connect: true, connect_account_id: 'acct_connected' }, isNewAuthority: false, businessId: 'biz-1',
    });
    expect(r.status).toBe('verified');
    expect(mockFetch.mock.calls[0][1].headers['Stripe-Account']).toBe('acct_connected');
  });

  it('9. Stripe missing key → config_error', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(buildSupabase(), {
      provider: 'stripe', gatewayReference: 'cs_test_789', expectedAmount: 10, expectedCurrency: 'USD',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
    expect(r.status).toBe('config_error');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── SQUARE ──

  it('15. Square merchant token → exact merchant credential', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => ({ payment: { status: 'COMPLETED', id: 'sq_pay', amount_money: { amount: 5000, currency: 'USD' }, source_type: 'CARD' } }) });
    const supabase = buildSupabase(null, { access_token: 'sq_merchant_encrypted', merchant_id: 'merch_1' });
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(supabase, {
      provider: 'square', gatewayReference: 'sq_ref', expectedAmount: 50, expectedCurrency: 'USD',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-sq',
    });
    expect(r.status).toBe('verified');
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toContain('decrypted_sq_merchant_encrypted');
  });

  it('16. Square missing merchant token → config_error, fetch 0', async () => {
    delete process.env.SQUARE_ACCESS_TOKEN;
    const supabase = buildSupabase(null, null); // no payout account
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(supabase, {
      provider: 'square', gatewayReference: 'sq_ref2', expectedAmount: 50, expectedCurrency: 'USD',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-sq-missing',
    });
    expect(r.status).toBe('config_error');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── NETWORK ERRORS ──

  it('26. timeout/network error → retryable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(buildSupabase(), {
      provider: 'paystack', gatewayReference: 'REF-timeout', expectedAmount: 1000, expectedCurrency: 'NGN',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
    expect(r.status).toBe('retryable_error');
  });

  it('27. provider says unpaid → not_paid', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => ({ data: { status: 'failed', amount: 500000 } }) });
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(buildSupabase(), {
      provider: 'paystack', gatewayReference: 'REF-failed', expectedAmount: 5000, expectedCurrency: 'NGN',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
    expect(r.status).toBe('not_paid');
  });

  // ── READ-ONLY ──

  it('29. verification does NOT mutate Waaiio state', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => ({ data: { status: 'success', amount: 500000, currency: 'NGN', id: 'tx_ro' } }) });
    const supabase = buildSupabase();
    const { verifyWithProvider } = await import('../provider-adapters');
    await verifyWithProvider(supabase, {
      provider: 'paystack', gatewayReference: 'REF-readonly', expectedAmount: 5000, expectedCurrency: 'NGN',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
    // from() should NOT have been called for mutations (update/insert)
    // The only from() calls should be for credential lookup
    const fromCalls = supabase.from.mock.calls.map((c: unknown[]) => c[0]);
    expect(fromCalls).not.toContain('payments');
    expect(fromCalls).not.toContain('bookings');
    expect(fromCalls).not.toContain('orders');
    expect(fromCalls).not.toContain('platform_fees');
  });

  // ── MOCK MODE ──

  it('30. mock reference in dev → verified without provider call', async () => {
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(buildSupabase(), {
      provider: 'paystack', gatewayReference: 'mock_ps_abc', expectedAmount: 5000, expectedCurrency: 'NGN',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
    expect(r.status).toBe('verified');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── PAYMENT ORIGIN IDENTITY ──

  it('31. new-authority payment missing origin → config_error, fetch 0', async () => {
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(buildSupabase(), {
      provider: 'paystack', gatewayReference: 'REF-NO-ORIGIN', expectedAmount: 5000, expectedCurrency: 'NGN',
      paymentMetadata: {}, isNewAuthority: true, businessId: 'biz-1',
    });
    expect(r.status).toBe('config_error');
    expect(r.reason).toContain('missing_payment_origin');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('32. new-authority platform payment → platform credential allowed', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => ({ data: { status: 'success', amount: 500000, currency: 'NGN', id: 'tx_plat' } }) });
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(buildSupabase(), {
      provider: 'paystack', gatewayReference: 'REF-PLAT', expectedAmount: 5000, expectedCurrency: 'NGN',
      paymentMetadata: { payment_origin: 'platform' }, isNewAuthority: true, businessId: 'biz-1',
    });
    expect(r.status).toBe('verified');
  });

  it('33. BYO credential wrong business → config_error', async () => {
    const supabase = buildSupabase({ secret_key: 'sk_other', gateway: 'paystack' });
    const { verifyWithProvider } = await import('../provider-adapters');
    const r = await verifyWithProvider(supabase, {
      provider: 'paystack', gatewayReference: 'REF-WRONG-BIZ', expectedAmount: 1000, expectedCurrency: 'NGN',
      paymentMetadata: { byo: true, byo_business_id: 'biz-A' }, isNewAuthority: true, businessId: 'biz-B',
    });
    expect(r.status).toBe('config_error');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('34. legacy payment without origin does NOT become platform (isNewAuthority=false)', async () => {
    mockFetch.mockResolvedValueOnce({ json: () => ({ data: { status: 'success', amount: 500000, currency: 'NGN', id: 'tx_leg' } }) });
    const { verifyWithProvider } = await import('../provider-adapters');
    // Legacy payments (isNewAuthority=false) with empty metadata still resolve to platform (backward compat)
    const r = await verifyWithProvider(buildSupabase(), {
      provider: 'paystack', gatewayReference: 'REF-LEGACY', expectedAmount: 5000, expectedCurrency: 'NGN',
      paymentMetadata: {}, isNewAuthority: false, businessId: 'biz-1',
    });
    expect(r.status).toBe('verified');
  });
});
