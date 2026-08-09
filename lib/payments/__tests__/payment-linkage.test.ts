import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InitPaymentOpts, InitPaymentResult } from '../types';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Regression tests for payment order/business linkage.
 *
 * All gateway modules are dynamically imported AFTER environment variables are
 * controlled — eliminating credential capture at module-import time.
 *
 * Mock-mode tests install a fetch guard that throws on any network call.
 * Live-path tests mock the provider HTTP response and verify the INSERT payload.
 */

// ── Credential env vars that must be cleared before dynamic import ──

const CREDENTIAL_VARS = [
  'PAYSTACK_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_LOCATION_ID',
  'SQUARE_ENVIRONMENT',
  'FLUTTERWAVE_SECRET_KEY',
  'FLW_SECRET_KEY',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_ENVIRONMENT',
];

// ── Supabase test double ──

interface InsertCapture {
  table: string;
  row: Record<string, unknown>;
}

function createTestSupabase() {
  const inserts: InsertCapture[] = [];
  const insertFn = vi.fn((row: Record<string, unknown>) => {
    inserts.push({ table: 'payments', row });
    return {
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'pay-1', ...row }, error: null }),
      }),
    };
  });

  const client = {
    from: vi.fn((table: string) => ({
      insert: (r: Record<string, unknown>) => {
        inserts.push({ table, row: r });
        return insertFn(r);
      },
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      like: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    })),
  } as unknown as SupabaseClient;

  return { client, inserts };
}

function baseOpts(supabase: SupabaseClient): InitPaymentOpts {
  return {
    supabase,
    userId: 'user-1',
    amount: 5000,
    currency: 'NGN',
    referenceCode: 'REF-001',
    businessName: 'Test Shop',
    phone: '+2341234567890',
  };
}

// ── Environment helpers ──

let savedEnv: Record<string, string | undefined>;

function saveAndClearCredentials() {
  savedEnv = {};
  for (const key of CREDENTIAL_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
}

function restoreCredentials() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// ── Fetch guard: throws if any network call is attempted ──

function installFetchGuard(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('FETCH_GUARD: unexpected network request in test');
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

// ── Dynamic gateway loader ──

type GatewayModule = { initializePayment(opts: InitPaymentOpts): Promise<InitPaymentResult | null> };

async function loadGateway(provider: string): Promise<GatewayModule> {
  const mod = await import(`@/lib/payments/${provider}`);
  const className = Object.keys(mod).find(k => k.endsWith('Gateway'));
  if (!className) throw new Error(`No gateway class found in ${provider}`);
  return new mod[className]() as GatewayModule;
}

// ══════════════════════════════════════════════════════════════
// MOCK-PATH TESTS — no credentials, fetch guard active
// ══════════════════════════════════════════════════════════════

const providers = ['paystack', 'stripe', 'square', 'flutterwave', 'paypal'] as const;

describe.each(providers.map(p => ({ provider: p })))('$provider mock-path linkage', ({ provider }) => {
  let removeFetchGuard: () => void;

  beforeEach(() => {
    vi.resetModules();
    saveAndClearCredentials();
    removeFetchGuard = installFetchGuard();
  });

  afterEach(() => {
    removeFetchGuard();
    restoreCredentials();
  });

  it('stores top-level order_id and business_id', async () => {
    const gw = await loadGateway(provider);
    const { client, inserts } = createTestSupabase();

    await gw.initializePayment({ ...baseOpts(client), orderId: 'order-abc', businessId: 'biz-xyz' });

    const paymentInsert = inserts.find(i => i.table === 'payments');
    expect(paymentInsert).toBeDefined();
    expect(paymentInsert!.row.order_id).toBe('order-abc');
    expect(paymentInsert!.row.business_id).toBe('biz-xyz');
    expect(paymentInsert!.row.gateway).toBe(provider);
  });

  it('preserves metadata.order_id for backward compatibility', async () => {
    const gw = await loadGateway(provider);
    const { client, inserts } = createTestSupabase();

    await gw.initializePayment({ ...baseOpts(client), orderId: 'order-abc', businessId: 'biz-xyz' });

    const row = inserts.find(i => i.table === 'payments')!.row;
    expect((row.metadata as Record<string, unknown>).order_id).toBe('order-abc');
  });

  it('stores null when orderId and businessId are omitted', async () => {
    const gw = await loadGateway(provider);
    const { client, inserts } = createTestSupabase();

    await gw.initializePayment(baseOpts(client));

    const row = inserts.find(i => i.table === 'payments')!.row;
    expect(row.order_id).toBeNull();
    expect(row.business_id).toBeNull();
  });

  it('preserves amount, currency, gateway, and status', async () => {
    const gw = await loadGateway(provider);
    const { client, inserts } = createTestSupabase();

    await gw.initializePayment({ ...baseOpts(client), orderId: 'o-1', businessId: 'b-1' });

    const row = inserts.find(i => i.table === 'payments')!.row;
    expect(row.amount).toBe(5000);
    expect(row.currency).toBe('NGN');
    expect(row.gateway).toBe(provider);
    expect(row.status).toBe('pending');
  });

  it('returns a valid reference and URL', async () => {
    const gw = await loadGateway(provider);
    const { client } = createTestSupabase();

    const result = await gw.initializePayment(baseOpts(client));

    expect(result).not.toBeNull();
    expect(result!.reference).toBeTruthy();
    expect(result!.url).toBeTruthy();
  });

  it('makes no network request (fetch guard active)', async () => {
    const gw = await loadGateway(provider);
    const { client } = createTestSupabase();

    // If any fetch is attempted, the guard will throw and this test fails
    const result = await gw.initializePayment(baseOpts(client));
    expect(result).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// LIVE-PATH TESTS — synthetic credentials, provider calls mocked
// ══════════════════════════════════════════════════════════════

interface LiveCase {
  provider: string;
  envSetup: Record<string, string>;
  providerResponse: Record<string, unknown>;
  expectedGatewayRef: string | RegExp;
}

const liveCases: LiveCase[] = [
  {
    provider: 'paystack',
    envSetup: { PAYSTACK_SECRET_KEY: 'test_not_a_real_key' },
    providerResponse: {
      status: true,
      data: { authorization_url: 'https://checkout.paystack.com/test123', access_code: 'ac_test', reference: 'PS-REF-001' },
    },
    expectedGatewayRef: 'PS-REF-001',
  },
  {
    provider: 'stripe',
    envSetup: { STRIPE_SECRET_KEY: 'test_not_a_real_key' },
    providerResponse: {
      id: 'cs_test_session_001',
      url: 'https://checkout.stripe.com/test',
    },
    expectedGatewayRef: 'cs_test_session_001',
  },
  {
    provider: 'square',
    envSetup: { SQUARE_ACCESS_TOKEN: 'sq_test_fake_token', SQUARE_LOCATION_ID: 'loc_test', SQUARE_ENVIRONMENT: 'sandbox' },
    providerResponse: {
      payment_link: { id: 'sq_link_001', url: 'https://square.link/test', order_id: 'sq_order_001' },
    },
    expectedGatewayRef: 'sq_link_001',
  },
  {
    provider: 'flutterwave',
    envSetup: { FLUTTERWAVE_SECRET_KEY: 'test_flw_not_a_real_key' },
    providerResponse: {
      status: 'success',
      data: { link: 'https://checkout.flutterwave.com/test' },
    },
    expectedGatewayRef: /^flw_[a-f0-9]+$/, // flw_ prefixed hex ref
  },
  {
    provider: 'paypal',
    envSetup: { PAYPAL_CLIENT_ID: 'test_client_id', PAYPAL_CLIENT_SECRET: 'test_client_secret', PAYPAL_ENVIRONMENT: 'sandbox' },
    providerResponse: {
      // PayPal needs two sequential responses: token + order creation
      __paypal_multi: true,
    },
    expectedGatewayRef: 'PAYPAL-ORDER-001',
  },
];

describe.each(liveCases)('$provider live-path linkage', ({ provider, envSetup, providerResponse, expectedGatewayRef }) => {
  let restoreFetch: () => void;

  beforeEach(() => {
    vi.resetModules();
    saveAndClearCredentials();

    // Set synthetic test credentials
    Object.assign(process.env, envSetup);
  });

  afterEach(() => {
    if (restoreFetch) restoreFetch();
    restoreCredentials();
  });

  it('stores top-level order_id and business_id via live insert path', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;

    if (provider === 'paypal') {
      // PayPal makes 2 calls: token + create order
      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'test_token', token_type: 'Bearer' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            id: 'PAYPAL-ORDER-001',
            status: 'CREATED',
            links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/approve/test' }],
          }),
        }) as typeof fetch;
    } else {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(providerResponse),
      }) as typeof fetch;
    }

    restoreFetch = () => { globalThis.fetch = originalFetch; };

    const gw = await loadGateway(provider);
    const { client, inserts } = createTestSupabase();

    const result = await gw.initializePayment({
      ...baseOpts(client),
      orderId: 'order-live-1',
      businessId: 'biz-live-1',
    });

    expect(result).not.toBeNull();

    const paymentInsert = inserts.find(i => i.table === 'payments');
    expect(paymentInsert).toBeDefined();
    const row = paymentInsert!.row;

    // Core assertions: top-level linkage fields
    expect(row.order_id).toBe('order-live-1');
    expect(row.business_id).toBe('biz-live-1');

    // Backward compatibility
    expect((row.metadata as Record<string, unknown>).order_id).toBe('order-live-1');

    // Unchanged behaviour
    expect(row.amount).toBe(5000);
    expect(row.currency).toBe('NGN');
    expect(row.gateway).toBe(provider);
    expect(row.status).toBe('pending');

    // Reference
    if (typeof expectedGatewayRef === 'string') {
      expect(row.gateway_reference).toBe(expectedGatewayRef);
    } else {
      expect(row.gateway_reference).toMatch(expectedGatewayRef);
    }

    // Provider was called (not mock mode)
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// SHARED WRAPPER TESTS
// ══════════════════════════════════════════════════════════════

describe('Shared payment wrapper forwarding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreCredentials();
  });

  it('forwards businessId to gateway.initializePayment', async () => {
    vi.resetModules();
    saveAndClearCredentials();

    const mockGateway = {
      name: 'paystack' as const,
      initializePayment: vi.fn().mockResolvedValue({ url: 'https://pay.test', reference: 'REF-TEST' }),
      verifyPayment: vi.fn(),
      refundPayment: vi.fn(),
    };

    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn().mockReturnValue(mockGateway),
      getPaymentGatewayByName: vi.fn(),
    }));
    vi.doMock('@/lib/countries', () => ({
      getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }),
    }));
    vi.doMock('@/lib/constants', () => ({
      calculatePlatformFee: vi.fn().mockReturnValue({ feePercentage: 2.0, feeFlat: 0, feeTotal: 200 }),
      getPaymentGatewayForCountry: vi.fn().mockReturnValue('paystack'),
    }));
    vi.doMock('@/lib/observability', () => ({
      observe: (_name: string, _meta: unknown, fn: () => unknown) => fn(),
    }));
    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
    }));
    vi.doMock('@/lib/errors', () => ({
      safeLogErrorContext: () => ({}),
    }));
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2.0, feeFlat: 0, feeTotal: 200 }),
    }));

    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');

    // Deep chainable mock that supports all query patterns (.eq, .not, .is, .single, .maybeSingle)
    const chainable = (): Record<string, unknown> => {
      const self: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'is', 'single', 'maybeSingle', 'insert', 'update', 'in', 'order', 'limit', 'like']) {
        self[m] = vi.fn(() => self);
      }
      self.single = vi.fn().mockResolvedValue({ data: null, error: null });
      self.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      self.insert = vi.fn().mockResolvedValue({ data: null, error: null });
      return self;
    };
    const wrapperSupabase = { from: vi.fn(() => chainable()) };

    const result = await initializePayment(wrapperSupabase as unknown as SupabaseClient, {
      orderId: 'order-123',
      userId: 'user-1',
      amount: 5000,
      referenceCode: 'REF-001',
      businessName: 'Test',
      phone: '+2341234567890',
      businessId: 'biz-forwarded',
    });

    expect(result).not.toBeNull();
    expect(mockGateway.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: 'biz-forwarded',
        orderId: 'order-123',
      }),
    );
  });

  it('forwards orderId without businessId', async () => {
    vi.resetModules();
    saveAndClearCredentials();

    const mockGateway = {
      name: 'paystack' as const,
      initializePayment: vi.fn().mockResolvedValue({ url: 'https://pay.test', reference: 'REF-TEST2' }),
      verifyPayment: vi.fn(),
      refundPayment: vi.fn(),
    };

    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn().mockReturnValue(mockGateway),
      getPaymentGatewayByName: vi.fn(),
    }));
    vi.doMock('@/lib/countries', () => ({
      getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }),
    }));
    vi.doMock('@/lib/constants', () => ({
      calculatePlatformFee: vi.fn().mockReturnValue({ feePercentage: 2.0, feeFlat: 0, feeTotal: 200 }),
      getPaymentGatewayForCountry: vi.fn().mockReturnValue('paystack'),
    }));
    vi.doMock('@/lib/observability', () => ({
      observe: (_name: string, _meta: unknown, fn: () => unknown) => fn(),
    }));
    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
    }));
    vi.doMock('@/lib/errors', () => ({
      safeLogErrorContext: () => ({}),
    }));
    vi.doMock('@/lib/getPlatformFees', () => ({
      getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2.0, feeFlat: 0, feeTotal: 200 }),
    }));

    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');

    const chainable = (): Record<string, unknown> => {
      const self: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'is', 'single', 'maybeSingle', 'insert', 'update', 'in', 'order', 'limit', 'like']) {
        self[m] = vi.fn(() => self);
      }
      self.single = vi.fn().mockResolvedValue({ data: null, error: null });
      self.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      self.insert = vi.fn().mockResolvedValue({ data: null, error: null });
      return self;
    };
    const wrapperSupabase = { from: vi.fn(() => chainable()) };

    const result = await initializePayment(wrapperSupabase as unknown as SupabaseClient, {
      userId: 'user-1',
      amount: 3000,
      referenceCode: 'REF-002',
      businessName: 'Test',
      phone: '+2341234567890',
    });

    expect(result).not.toBeNull();
    const callArgs = mockGateway.initializePayment.mock.calls[0][0];
    expect(callArgs.businessId).toBeUndefined();
  });
});
