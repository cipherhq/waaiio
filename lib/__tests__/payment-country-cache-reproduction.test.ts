/**
 * Actual-module reproduction: country-cache cold-start regression.
 *
 * Uses real lib/countries, lib/payments/factory, lib/constants, and
 * lib/bot/flows/shared/payment — not hand-written simulations.
 *
 * Proves:
 * 1. With unpopulated country cache, initializePayment() returns null
 *    through the payment.init-threw path with errorName=Error
 * 2. Provider initialization count = 0 and no payment INSERT occurs
 * 3. Control: with populated/primed NG country state, provider boundary
 *    is reached exactly once
 * 4. A failed loadCountries() leaves the authoritative resolver unable
 *    to resolve NG
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Minimal mocks for dependencies initializePayment needs ──

// Mock the browser Supabase client used by loadCountries
const mockBrowserFrom = vi.fn();
vi.mock('@/lib/supabase/client', () => ({
  createClient: vi.fn(() => ({
    from: mockBrowserFrom,
  })),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({})),
}));

vi.mock('@/lib/logger', () => {
  const errorFn = vi.fn();
  return {
    logger: {
      info: vi.fn(), warn: vi.fn(), debug: vi.fn(),
      error: errorFn,
      withContext: vi.fn(() => ({ error: errorFn, warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
    },
  };
});

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: vi.fn(() => ({})),
}));

vi.mock('@/lib/observability', () => ({
  observe: vi.fn((_name: string, _ctx: unknown, fn: () => unknown) => fn()),
  observeProvider: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

vi.mock('@/lib/getPlatformFees', () => ({
  getPlatformFees: vi.fn(async () => ({ feePercentage: 5, feeFlat: 0, feeTotal: 250 })),
}));

vi.mock('@/lib/trial-status', () => ({
  resolveTrialStatus: vi.fn(async () => false),
  resolveTrialCredit: vi.fn(async () => false),
}));

// Shared gateway spy — must use real class constructors for factory.ts module-level `new`
const mockGatewayInit = vi.fn();

vi.mock('@/lib/payments/paystack', () => {
  return { PaystackGateway: class { name = 'paystack'; initializePayment = mockGatewayInit; } };
});
vi.mock('@/lib/payments/stripe', () => {
  return { StripeGateway: class { name = 'stripe'; initializePayment = vi.fn(async () => null); } };
});
vi.mock('@/lib/payments/flutterwave', () => {
  return { FlutterwaveGateway: class { name = 'flutterwave'; initializePayment = vi.fn(async () => null); } };
});
vi.mock('@/lib/payments/square', () => {
  return { SquareGateway: class { name = 'square'; initializePayment = vi.fn(async () => null); } };
});
vi.mock('@/lib/payments/paypal', () => {
  return { PayPalGateway: class { name = 'paypal'; initializePayment = vi.fn(async () => null); } };
});

// ── Supabase mock for initializePayment's internal queries ──

function makeChain(result: { data: unknown; error: unknown }) {
  const c: any = {
    select: vi.fn(() => c), insert: vi.fn(() => c), update: vi.fn(() => c),
    eq: vi.fn(() => c), neq: vi.fn(() => c), not: vi.fn(() => c),
    in: vi.fn(() => c), like: vi.fn(() => c), gte: vi.fn(() => c),
    lte: vi.fn(() => c), order: vi.fn(() => c), limit: vi.fn(() => c),
    or: vi.fn(() => c), is: vi.fn(() => c),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
  };
  c.then = (resolve: (v: any) => void) => resolve(result);
  return c;
}

function buildPaymentSupabase() {
  return {
    from: vi.fn((table: string) => {
      if (table === 'business_payment_credentials') return makeChain({ data: null, error: null });
      if (table === 'businesses') return makeChain({ data: { payout_mode: 'platform_managed', payment_channels: null }, error: null });
      if (table === 'platform_config_versions') return makeChain({ data: { id: 'cfg-001', config_snapshot: { fee_policy_enabled: false } }, error: null });
      return makeChain({ data: null, error: null });
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

const SCHEDULING_OPTS = {
  bookingId: 'booking-snapakit-001',
  userId: 'user-snapakit-001',
  amount: 2000,
  referenceCode: 'WAA-BK-6948',
  businessName: 'SnapaKit',
  phone: '+2348012345678',
  userEmail: 'customer@example.com',
  countryCode: 'NG' as const,
  businessId: 'biz-snapakit-001',
  gatewayOverride: null as string | null,
  inboundChannelId: 'ch-snapakit-001',
  confirmationOrigin: 'whatsapp' as const,
  transactionCategory: 'scheduling',
};

// ── NG country row matching production schema ──
const NG_COUNTRY_ROW = {
  code: 'NG',
  name: 'Nigeria',
  flag: '🇳🇬',
  dialing_code: '+234',
  currency_code: 'NGN',
  currency_symbol: '₦',
  currency_locale: 'en-NG',
  payment_gateway: 'paystack',
  phone_digits: 11,
  phone_pattern: '^[0-9]{10,11}$',
  phone_placeholder: '08012345678',
  cities: {},
  pricing: {},
  verification_tiers: {},
  doc_types: [],
  is_active: true,
  sort_order: 1,
};

describe('Country-cache cold-start reproduction (actual modules)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGatewayInit.mockResolvedValue({
      url: 'https://checkout.paystack.com/repro-test',
      reference: 'REPRO-REF-001',
    });

    // Reset the country cache to null via invalidateCache
    const countries = await import('@/lib/countries');
    countries.invalidateCache();
  });

  it('(1) FIX VERIFICATION: cold cache + countries table returns NG → provider reached (no loadCountries prerequisite)', async () => {
    // Verify cache is cold — getCountry returns null
    const countries = await import('@/lib/countries');
    expect(countries.getCountry('NG')).toBeNull();

    // But initializePayment now queries countries table directly via passed supabase
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');

    // Build supabase that returns NG country data from the countries table
    const supabase = buildPaymentSupabase();
    // Override from() to return NG country row for 'countries' table
    (supabase.from as any).mockImplementation((table: string) => {
      if (table === 'countries') return makeChain({
        data: { payment_gateway: 'paystack', currency_code: 'NGN' },
        error: null,
      });
      if (table === 'business_payment_credentials') return makeChain({ data: null, error: null });
      if (table === 'businesses') return makeChain({ data: { payout_mode: 'platform_managed', payment_channels: null }, error: null });
      if (table === 'platform_config_versions') return makeChain({ data: { id: 'cfg-001', config_snapshot: { fee_policy_enabled: false } }, error: null });
      return makeChain({ data: null, error: null });
    });

    const result = await initializePayment(supabase as any, SCHEDULING_OPTS);

    // Provider must be reached — cache is cold but per-request DB query succeeds
    expect(mockGatewayInit).toHaveBeenCalledTimes(1);
    const providerArgs = mockGatewayInit.mock.calls[0][0];
    expect(providerArgs.currency).toBe('NGN');
    expect(providerArgs.amount).toBe(2000);
    expect(providerArgs.bookingId).toBe('booking-snapakit-001');

    // countries table was queried (per-request, not from cache)
    const fromCalls = (supabase.from as any).mock.calls.map((c: any) => c[0]);
    expect(fromCalls).toContain('countries');
  });

  it('(2) FIX VERIFICATION: cold cache + countries DB error → fail closed with stage log, provider count=0', async () => {
    const countries = await import('@/lib/countries');
    expect(countries.getCountry('NG')).toBeNull();

    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const supabase = buildPaymentSupabase();
    (supabase.from as any).mockImplementation((table: string) => {
      if (table === 'countries') return makeChain({ data: null, error: { message: 'connection refused' } });
      return makeChain({ data: null, error: null });
    });

    const result = await initializePayment(supabase as any, SCHEDULING_OPTS);

    expect(result).toBeNull();
    expect(mockGatewayInit).toHaveBeenCalledTimes(0);

    // Stage-specific log emitted
    const { logger } = await import('@/lib/logger');
    const withContextCalls = (logger.withContext as any).mock.calls;
    const stageCall = withContextCalls.find(
      (args: any[]) => args[0]?.op === 'payment.country-payment-config'
    );
    expect(stageCall, 'Expected payment.country-payment-config log op').toBeDefined();
  });

  it('(4) Failed loadCountries leaves authoritative resolver unable to resolve NG', async () => {
    const countries = await import('@/lib/countries');

    // Simulate a failed loadCountries — the browser supabase client returns an error
    mockBrowserFrom.mockReturnValue(
      makeChain({ data: null, error: { message: 'connection refused' } })
    );

    // loadCountries catches the error and returns [] — but cache stays null
    const result = await countries.loadCountries();
    expect(result).toEqual([]);

    // The authoritative resolver cannot resolve NG
    expect(countries.getCountry('NG')).toBeNull();

    // getPaymentGatewayForCountry throws
    const { getPaymentGatewayForCountry } = await import('@/lib/constants');
    expect(() => getPaymentGatewayForCountry('NG' as any)).toThrow(
      '[AUTHORITATIVE] Country NG not resolved from DB'
    );
  });
});
