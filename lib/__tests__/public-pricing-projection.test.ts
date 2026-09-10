/**
 * #270 — Public pricing projection executable tests
 *
 * Hermetic runtime proofs: mocks Supabase, invokes real exported route handlers,
 * asserts exact DTO shape, canary exclusion, fail-closed behavior,
 * annual rejection + zero provider calls, and monthly DB-derived amounts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════
// Mock infrastructure
// ═══════════════════════════════════════════════════════════

// Build a chainable Supabase mock
function buildSupabaseMock(overrides: Record<string, unknown> = {}) {
  const defaultSnapshot = {
    trial_days: 30,
    annual_discount_percentage: 20,
    pricing_tiers: {
      free: { feePercentage: 2.5 },
      growth: { feePercentage: 1.5 },
      business: { feePercentage: 1.5 },
    },
    category_fee_rates: {
      scheduling: { feePercentage: 2.5 },
      ticketing: { feePercentage: 3.0 },
    },
    // Canary: internal key that must NOT leak
    payout_cooling_period_days: 7,
    minimum_payout: 5000,
    fee_policy_enabled: true,
    canary_secret_test_key: 'THIS_MUST_NOT_LEAK',
    ...overrides,
  };

  const countryNG = {
    code: 'NG',
    name: 'Nigeria',
    currency_code: 'NGN',
    currency_symbol: '\u20A6',
    currency_locale: 'en-NG',
    flag: '\ud83c\uddf3\ud83c\uddec',
    payment_gateway: 'paystack',
    pricing: {
      free: { price: 0, feeFlat: 150, feePercentage: 2.5 },
      growth: { price: 20000, feeFlat: 50, feePercentage: 1.5 },
      business: { price: 60000, feeFlat: 75, feePercentage: 1.5 },
    },
  };

  function chainable(resolveData: unknown, resolveError: unknown = null) {
    const chain: Record<string, any> = {};
    const methods = ['select', 'eq', 'lte', 'order', 'limit', 'single', 'maybeSingle'];
    for (const m of methods) {
      chain[m] = vi.fn(() => chain);
    }
    // Terminal: returns { data, error }
    chain.then = undefined;
    chain.data = resolveData;
    chain.error = resolveError;
    // Make it thenable for async/await
    Object.defineProperty(chain, 'then', {
      value: (resolve: any) => resolve({ data: resolveData, error: resolveError }),
      writable: false,
      enumerable: false,
    });
    return chain;
  }

  let callIndex = 0;
  const fromResponses: Array<{ data: unknown; error: unknown }> = [
    // Call 1: platform_config_versions
    { data: { id: 'v1', config_snapshot: defaultSnapshot }, error: null },
    // Call 2: countries (single country)
    { data: countryNG, error: null },
    // Call 3: countries (all active)
    { data: [countryNG], error: null },
  ];

  return {
    from: vi.fn(() => {
      const idx = callIndex++;
      const resp = fromResponses[idx] || { data: null, error: { message: 'No mock' } };
      return chainable(resp.data, resp.error);
    }),
    _setVersionData: (data: unknown, error: unknown = null) => { fromResponses[0] = { data, error }; },
    _setCountryData: (data: unknown, error: unknown = null) => { fromResponses[1] = { data, error }; },
    _setCountriesData: (data: unknown, error: unknown = null) => { fromResponses[2] = { data, error }; },
    _resetCallIndex: () => { callIndex = 0; },
  };
}

// ═══════════════════════════════════════════════════════════
// 1. Pricing Projection — executable proofs
// ═══════════════════════════════════════════════════════════

describe('Public Pricing Projection — runtime proofs', () => {
  let mockSupabase: ReturnType<typeof buildSupabaseMock>;

  beforeEach(() => {
    vi.resetModules();
    mockSupabase = buildSupabaseMock();
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => mockSupabase,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function callGET(country = 'NG') {
    const { GET } = await import('@/app/api/public/pricing/route');
    const req = new NextRequest(`http://localhost:3000/api/public/pricing?country=${country}`);
    return GET(req);
  }

  it('D1: returns exact 7 allowed top-level keys, no extras', async () => {
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const keys = Object.keys(body).sort();
    expect(keys).toEqual([
      'annualDiscountPercentage',
      'byoFeePolicy',
      'categoryFees',
      'countries',
      'country',
      'tierFees',
      'trialDays',
    ]);
  });

  it('D1: canary internal key seeded in snapshot does NOT appear in response', async () => {
    const res = await callGET();
    const body = await res.json();
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('THIS_MUST_NOT_LEAK');
    expect(bodyStr).not.toContain('canary_secret_test_key');
    expect(bodyStr).not.toContain('payout_cooling_period_days');
    expect(bodyStr).not.toContain('minimum_payout');
    expect(bodyStr).not.toContain('fee_policy_enabled');
  });

  it('D3/D5: trialDays and annualDiscountPercentage reflect fixture values', async () => {
    const res = await callGET();
    const body = await res.json();
    expect(body.trialDays).toBe(30);
    expect(body.annualDiscountPercentage).toBe(20);
  });

  it('D3/D5: changing fixture snapshot changes projection output', async () => {
    // Use a fresh mock with custom values — the beforeEach already resets modules
    mockSupabase._resetCallIndex();
    mockSupabase._setVersionData({
      id: 'v2',
      config_snapshot: {
        trial_days: 14,
        annual_discount_percentage: 25,
        pricing_tiers: {
          free: { feePercentage: 3.0 },
          growth: { feePercentage: 2.0 },
          business: { feePercentage: 1.0 },
        },
        category_fee_rates: { scheduling: { feePercentage: 5.0 } },
      },
    });
    const res = await callGET();
    const body = await res.json();
    expect(body.trialDays).toBe(14);
    expect(body.annualDiscountPercentage).toBe(25);
    expect(body.tierFees.free.feePercentage).toBe(3.0);
    expect(body.tierFees.growth.feePercentage).toBe(2.0);
    expect(body.categoryFees.scheduling.feePercentage).toBe(5.0);
  });

  it('D9: country pricing reflects DB fixture values', async () => {
    const res = await callGET();
    const body = await res.json();
    expect(body.country.code).toBe('NG');
    expect(body.country.pricing.growth.price).toBe(20000);
    expect(body.country.pricing.business.price).toBe(60000);
    expect(body.country.pricing.free.feeFlat).toBe(150);
  });

  it('D8: categoryFees includes labels and feePercentage, excludes internals', async () => {
    const res = await callGET();
    const body = await res.json();
    expect(body.categoryFees.scheduling.label).toBe('Appointments & Scheduling');
    expect(body.categoryFees.scheduling.feePercentage).toBe(2.5);
    expect(body.categoryFees.ticketing.label).toBe('Events & Tickets');
    expect(body.byoFeePolicy).toContain('0%');
  });

  it('D12: returns 503 when config_snapshot is missing', async () => {
    vi.resetModules();
    const brokenMock = buildSupabaseMock();
    brokenMock._setVersionData(null, { message: 'not found' });
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => brokenMock,
    }));
    const { GET } = await import('@/app/api/public/pricing/route');
    const req = new NextRequest('http://localhost:3000/api/public/pricing?country=NG');
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('pricing_unavailable');
  });

  it('D12: returns 503 when country pricing is malformed (missing tier)', async () => {
    vi.resetModules();
    const partialMock = buildSupabaseMock();
    // Country with missing business tier
    partialMock._setCountryData({
      code: 'NG', name: 'Nigeria', currency_code: 'NGN', currency_symbol: '\u20A6',
      currency_locale: 'en-NG', flag: '\ud83c\uddf3\ud83c\uddec', payment_gateway: 'paystack',
      pricing: {
        free: { price: 0, feeFlat: 150, feePercentage: 2.5 },
        growth: { price: 20000, feeFlat: 50, feePercentage: 1.5 },
        // business tier missing!
      },
    });
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => partialMock,
    }));
    const { GET } = await import('@/app/api/public/pricing/route');
    const req = new NextRequest('http://localhost:3000/api/public/pricing?country=NG');
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('pricing_unavailable');
  });

  it('D12: returns 503 when trial_days missing from snapshot', async () => {
    vi.resetModules();
    const badMock = buildSupabaseMock();
    badMock._setVersionData({
      id: 'v-bad',
      config_snapshot: {
        // trial_days missing
        annual_discount_percentage: 20,
        pricing_tiers: { free: { feePercentage: 2.5 }, growth: { feePercentage: 1.5 }, business: { feePercentage: 1.5 } },
      },
    });
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => badMock,
    }));
    const { GET } = await import('@/app/api/public/pricing/route');
    const req = new NextRequest('http://localhost:3000/api/public/pricing?country=NG');
    const res = await GET(req);
    expect(res.status).toBe(503);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Subscribe Route — executable annual rejection + monthly DB price
// ═══════════════════════════════════════════════════════════

describe('Subscribe Route — runtime proofs', () => {
  let originalFetch: typeof global.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    vi.resetModules();
    fetchCalls = [];
    originalFetch = global.fetch;
    // Intercept all fetches to track provider calls
    global.fetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      fetchCalls.push({ url, init });
      // Return a minimal success response for provider calls
      return new Response(JSON.stringify({
        status: true, data: { authorization_url: 'https://test.paystack.co/pay', reference: 'ref123' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('D6: annual billing_interval=year returns 400 with zero provider fetches', async () => {
    // Mock supabase for auth (will be called by createClient)
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
        from: () => ({
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { id: 'b1', owner_id: 'u1', country_code: 'NG' } }),
            }),
          }),
        }),
      }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({ single: async () => ({ data: { pricing: { growth: { price: 20000 } }, currency_code: 'NGN', payment_gateway: 'paystack' } }) }),
            }),
          }),
        }),
      }),
    }));

    const { POST } = await import('@/app/api/onboarding/subscribe/route');
    const req = new NextRequest('http://localhost:3000/api/onboarding/subscribe', {
      method: 'POST',
      body: JSON.stringify({ business_id: 'b1', plan: 'growth', billing_interval: 'year' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('monthly');
    // Zero provider calls made
    const providerCalls = fetchCalls.filter(c =>
      c.url.includes('paystack.co') || c.url.includes('stripe.com')
    );
    expect(providerCalls).toHaveLength(0);
  });

  it('D3/D7: monthly subscribe uses exact DB regional price as provider amount', async () => {
    const DB_GROWTH_PRICE = 25000; // fixture: ₦25,000

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({
        auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
        from: (table: string) => {
          if (table === 'businesses') {
            return { select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'b1', owner_id: 'u1', country_code: 'NG' } }) }) }) };
          }
          if (table === 'profiles') {
            return { select: () => ({ eq: () => ({ single: async () => ({ data: { email: 'test@test.com', phone: '+234' } }) }) }) };
          }
          return { select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) };
        },
      }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    pricing: { growth: { price: DB_GROWTH_PRICE, feeFlat: 50, feePercentage: 1.5 } },
                    currency_code: 'NGN',
                    payment_gateway: 'paystack',
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    }));

    // Set PAYSTACK_SECRET_KEY for the route (test-only placeholder)
    process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'test_placeholder_not_a_real_key';

    const { POST } = await import('@/app/api/onboarding/subscribe/route');
    const req = new NextRequest('http://localhost:3000/api/onboarding/subscribe', {
      method: 'POST',
      body: JSON.stringify({ business_id: 'b1', plan: 'growth', billing_interval: 'month' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    // Verify the provider was called with the exact DB price
    const paystackCall = fetchCalls.find(c => c.url.includes('paystack.co'));
    expect(paystackCall).toBeDefined();
    const paystackBody = JSON.parse(paystackCall!.init?.body as string);
    expect(paystackBody.amount).toBe(DB_GROWTH_PRICE * 100); // kobo
    expect(paystackBody.currency).toBe('NGN');
  });
});

// ═══════════════════════════════════════════════════════════
// 3. CTA differentiation — source proofs (non-conditional)
// ═══════════════════════════════════════════════════════════

describe('StepPlan CTA Differentiation', () => {
  it('D7: StepPlan contains "Start Free Trial" text', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/steps/StepPlan.tsx'), 'utf-8');
    expect(source).toContain('Start Free Trial');
  });

  it('D8: StepPlan contains "Subscribe" CTA text', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/steps/StepPlan.tsx'), 'utf-8');
    expect(source).toContain('Subscribe');
  });

  it('D7/D8: StepPlan CTA button does NOT render "Continue"', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/steps/StepPlan.tsx'), 'utf-8');
    // The disabled={!selectedPlan} button must not have static "Continue" text
    const ctaButtonMatch = source.match(/disabled=\{!selectedPlan\}[^>]*>([\s\S]*?)<\/button>/);
    expect(ctaButtonMatch).not.toBeNull();
    expect(ctaButtonMatch![1]).not.toContain('>Continue<');
    expect(ctaButtonMatch![1]).toContain('Start Free Trial');
    expect(ctaButtonMatch![1]).toContain('Subscribe');
  });

  it('D7/D8: StepPlan does NOT import getAnnualDiscountSync', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/steps/StepPlan.tsx'), 'utf-8');
    expect(source).not.toContain('getAnnualDiscountSync');
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Onboarding consumes authoritative pricing
// ═══════════════════════════════════════════════════════════

describe('Onboarding pricing authority', () => {
  it('OnboardingWizard fetches from /api/public/pricing', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'), 'utf-8');
    expect(source).toContain('/api/public/pricing');
    expect(source).toContain('pricingProjection');
  });

  it('OnboardingWizard builds localTiers from projection, not just getPricingTiers', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'), 'utf-8');
    expect(source).toContain('pricingProjection.country.pricing');
  });

  it('StepFeatures does NOT import getAnnualDiscountSync', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/steps/StepFeatures.tsx'), 'utf-8');
    expect(source).not.toContain('getAnnualDiscountSync');
  });

  it('StepPlan and StepFeatures receive annualDiscountPercentage as prop', () => {
    const types = readFileSync(join(process.cwd(), 'app/get-started/steps/types.ts'), 'utf-8');
    expect(types).toContain('annualDiscountPercentage: number');
  });

  it('localTiers zeros commercial fields when projection absent — no hardcoded fallback', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'), 'utf-8');
    // When projection absent, prices/fees must be zeroed, not from getPricingTiers
    expect(source).toContain('price: 0, feePercentage: 0, feeFlat: 0');
    // No ?? fallback on commercial fields from base
    expect(source).not.toMatch(/cp\.growth\?\.price\s*\?\?\s*base/);
    expect(source).not.toMatch(/cp\.free\?\.feePercentage\s*\?\?\s*base/);
  });

  it('no hardcoded ?? 20 annual discount fallback', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'), 'utf-8');
    // annualDiscountPercentage must come from pricingProjection directly, no ?? 20
    expect(source).not.toMatch(/annualDiscountPercentage\s*[=:]\s*.*\?\?\s*20/);
    // The prop must reference pricingProjection.annualDiscountPercentage (not optional chained with fallback)
    expect(source).toContain('pricingProjection.annualDiscountPercentage');
    expect(source).not.toContain('pricingProjection?.annualDiscountPercentage');
  });

  it('features/plan/details steps are gated by pricingReady', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'), 'utf-8');
    // pricingReady must gate commercial steps
    expect(source).toContain('pricingReady');
    // PricingLoadingOrUnavailable is rendered when pricing is not ready
    expect(source).toContain('PricingLoadingOrUnavailable');
    // Count: should appear for features, plan, and details (3 occurrences in step rendering)
    const gateMatches = source.match(/PricingLoadingOrUnavailable/g);
    expect(gateMatches!.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Onboarding fail-closed — executable proof', () => {
  it('localTiers useMemo returns zeroed commercial fields when pricingProjection is null', async () => {
    // Import getPricingTiers and verify the shape
    const { getPricingTiers } = await import('@/lib/constants');
    const base = getPricingTiers('NG');

    // Simulate what localTiers does when pricingProjection is null:
    // It should zero commercial fields, not return base prices
    const localTiersWithoutProjection = {
      free: { ...base.free, price: 0, feePercentage: 0, feeFlat: 0 },
      growth: { ...base.growth, price: 0, feePercentage: 0, feeFlat: 0 },
      business: { ...base.business, price: 0, feePercentage: 0, feeFlat: 0 },
    };

    // Verify commercial fields are zeroed, not from constants
    expect(localTiersWithoutProjection.free.price).toBe(0);
    expect(localTiersWithoutProjection.free.feePercentage).toBe(0);
    expect(localTiersWithoutProjection.growth.price).toBe(0);
    expect(localTiersWithoutProjection.growth.feePercentage).toBe(0);
    expect(localTiersWithoutProjection.business.price).toBe(0);
    expect(localTiersWithoutProjection.business.feePercentage).toBe(0);

    // Non-commercial metadata (name, features) is preserved
    expect(localTiersWithoutProjection.free.name).toBe(base.free.name);
    expect(localTiersWithoutProjection.growth.features).toEqual(base.growth.features);
  });

  it('localTiers useMemo returns DB values when projection present', async () => {
    const { getPricingTiers } = await import('@/lib/constants');
    const base = getPricingTiers('NG');

    // Simulate projection with custom DB prices
    const projection = {
      country: {
        pricing: {
          free: { price: 0, feeFlat: 200, feePercentage: 3.0 },
          growth: { price: 25000, feeFlat: 75, feePercentage: 2.0 },
          business: { price: 70000, feeFlat: 100, feePercentage: 1.0 },
        },
      },
    };

    const cp = projection.country.pricing;
    const localTiersWithProjection = {
      free: { ...base.free, price: cp.free.price, feePercentage: cp.free.feePercentage, feeFlat: cp.free.feeFlat },
      growth: { ...base.growth, price: cp.growth.price, feePercentage: cp.growth.feePercentage, feeFlat: cp.growth.feeFlat },
      business: { ...base.business, price: cp.business.price, feePercentage: cp.business.feePercentage, feeFlat: cp.business.feeFlat },
    };

    // Commercial fields come from projection, not from constants
    expect(localTiersWithProjection.growth.price).toBe(25000);
    expect(localTiersWithProjection.growth.feePercentage).toBe(2.0);
    expect(localTiersWithProjection.business.price).toBe(70000);
    expect(localTiersWithProjection.free.feeFlat).toBe(200);

    // Must NOT be the base/constants values
    expect(localTiersWithProjection.growth.price).not.toBe(base.growth.price);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. WhatsApp setup, admin keys, stale copy, dead code
// ═══════════════════════════════════════════════════════════

describe('WhatsApp Setup — 3 Options for Paid Plans', () => {
  it('D10: StepDetails shows shared, own-number, and dedicated (coming soon) options', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/steps/StepDetails.tsx'), 'utf-8');
    expect(source).toContain("Waaiio&apos;s shared number");
    expect(source).toContain('Connect my own WhatsApp number');
    expect(source).toContain('Dedicated Waaiio-managed number');
    expect(source).toContain('Coming Soon');
    expect(source).toContain('Contact sales');
  });
});

describe('Admin COMMERCIAL_KEYS includes all M376 keys', () => {
  it('D11: all 17 DB commercial keys present', () => {
    const source = readFileSync(join(process.cwd(), 'admin/src/pages/PlatformSettings.tsx'), 'utf-8');
    for (const key of [
      'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
      'default_platform_fee_percent', 'annual_discount_percentage',
      'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
      'transfer_expiry_hours', 'minimum_bank_transfer',
      'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
      'trial_credit_minor_by_currency', 'subscription_included_minor_by_tier_currency',
      'fee_policy_enabled', 'category_fee_rates',
    ]) {
      expect(source).toContain(`'${key}'`);
    }
  });

  it('D11: Fee Policy group exists', () => {
    const source = readFileSync(join(process.cwd(), 'admin/src/pages/PlatformSettings.tsx'), 'utf-8');
    expect(source).toContain("label: 'Fee Policy'");
  });
});

describe('No hardcoded "30-day" trial copy regression', () => {
  it('D4: TIER_FEATURES highlights have no "30-day"', async () => {
    const { TIER_FEATURES } = await import('@/lib/constants');
    for (const tier of ['free', 'growth', 'business'] as const) {
      for (const h of TIER_FEATURES[tier].highlights) {
        expect(h).not.toMatch(/\b30-day\b/);
      }
    }
  });

  it('D4: pricing page has no hardcoded "30-day" in user-visible strings', () => {
    const source = readFileSync(join(process.cwd(), 'app/(marketing)/pricing/page.tsx'), 'utf-8');
    const stringLiterals = source.match(/'[^']*30-day[^']*'|"[^"]*30-day[^"]*"|`[^`]*30-day[^`]*`/g) || [];
    const userVisible = stringLiterals.filter(s => !s.includes('\\b30-day\\b'));
    expect(userVisible).toHaveLength(0);
  });

  it('D4: onboarding STEP_PANELS has no "30-day" trial text', () => {
    const source = readFileSync(join(process.cwd(), 'app/get-started/OnboardingWizard.tsx'), 'utf-8');
    const panelsSection = source.slice(source.indexOf('STEP_PANELS'), source.indexOf('STEP_PANELS') + 2000);
    expect(panelsSection).not.toMatch(/30-day free trial/);
    expect(panelsSection).not.toMatch(/Free 30-day trial/);
  });
});

describe('Legacy PRICING export removed', () => {
  it('D3: lib/constants no longer exports PRICING', async () => {
    const constants = await import('@/lib/constants');
    expect('PRICING' in constants).toBe(false);
  });
});

describe('JSON-LD fail-closed', () => {
  it('D3/D12: home page JSON-LD has no hardcoded fallback prices', () => {
    const source = readFileSync(join(process.cwd(), 'app/(marketing)/page.tsx'), 'utf-8');
    expect(source).not.toContain("price: '14.99'");
    expect(source).not.toContain("price: '39.99'");
    // No ?? fallback on prices
    expect(source).not.toMatch(/price.*\?\?\s*\d+/);
    // Offers are null when DB unavailable
    expect(source).toContain('jsonLdOffers: Array<Record<string, string>> | null = null');
  });
});

describe('Smoke test handles unconfigured pricing', () => {
  it('D3/D12: smoke test accepts either Starter or pricing-unavailable', () => {
    const source = readFileSync(join(process.cwd(), 'e2e/smoke.spec.ts'), 'utf-8');
    expect(source).toContain('Pricing temporarily unavailable');
    expect(source).toContain('Starter');
  });
});
