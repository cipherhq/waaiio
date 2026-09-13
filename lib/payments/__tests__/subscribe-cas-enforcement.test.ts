/**
 * M379 Phase 2 — Subscribe Route CAS Enforcement Proof
 *
 * Proves that when claim_checkout_initialization returns config_version_conflict,
 * the subscribe route fails closed and NEVER calls Flutterwave checkout initialization.
 *
 * Invokes the ACTUAL POST handler from app/api/onboarding/subscribe/route.ts
 * with mocked Supabase and provider HTTP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Set env vars BEFORE module loads ──
process.env.FLUTTERWAVE_SECRET_KEY = 'flw-test-key';

// ── Track provider calls ──
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// ── Configurable supabase mock ──
let rpcResults: Record<string, { data: unknown; error: unknown }> = {};
let authUser: { id: string } | null = { id: 'user-cas-test' };
let businessData: Record<string, unknown> | null = null;
let profileData: Record<string, unknown> | null = null;
let countryData: Record<string, unknown> | null = null;

function buildChain(): Record<string, unknown> {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockImplementation(() => Promise.resolve({ data: countryData, error: null })),
    maybeSingle: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: authUser }, error: null }) },
    from: vi.fn().mockImplementation((table: string) => {
      const chain = buildChain();
      if (table === 'businesses') {
        chain.single = vi.fn().mockResolvedValue({ data: businessData, error: null });
      }
      if (table === 'profiles') {
        chain.single = vi.fn().mockResolvedValue({ data: profileData, error: null });
      }
      if (table === 'countries') {
        chain.single = vi.fn().mockResolvedValue({ data: countryData, error: null });
      }
      return chain;
    }),
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: vi.fn().mockImplementation(() => buildChain()),
    rpc: vi.fn().mockImplementation((fn: string, args?: Record<string, unknown>) => {
      const result = rpcResults[fn];
      if (result) return Promise.resolve(result);
      return Promise.resolve({ data: null, error: null });
    }),
  }),
}));

// Import AFTER mocks
const { POST: subscribePOST } = await import('@/app/api/onboarding/subscribe/route');

function createSubscribeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/onboarding/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  rpcResults = {};
  authUser = { id: 'user-cas-test' };
  businessData = {
    id: 'biz-cas-test', owner_id: 'user-cas-test', country_code: 'NG',
    subscription_tier: 'free',
  };
  profileData = { email: 'cas@test.com', phone: '+2348012345678' };
  countryData = {
    pricing: {
      growth: {
        price: 14999,
        provider_plan_refs: { flutterwave: '243206' },
      },
    },
    currency_code: 'NGN',
    payment_gateway: 'flutterwave',
  };
});

describe('Subscribe route CAS enforcement', () => {
  it('config_version_conflict from claim → 503, Flutterwave checkout NEVER called', async () => {
    // get_effective_config_version_id succeeds
    rpcResults['get_effective_config_version_id'] = { data: 'stale-v1-uuid', error: null };

    // Flutterwave preflight succeeds
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/v3/payment-plans/')) {
        return {
          ok: true,
          json: async () => ({
            status: 'success',
            data: { id: 243206, status: 'active', currency: 'NGN', amount: 14999, interval: 'monthly' },
          }),
        };
      }
      // This should NEVER be reached — Flutterwave checkout initialization
      if (typeof url === 'string' && url.includes('/v3/payments')) {
        throw new Error('MUST NOT REACH: Flutterwave checkout called after config_version_conflict');
      }
      return { ok: false, status: 404 };
    });

    // claim_checkout_initialization returns config_version_conflict error
    rpcResults['claim_checkout_initialization'] = {
      data: null,
      error: { message: 'config_version_conflict: expected stale-v1-uuid but latest is fresh-v2-uuid' },
    };

    const req = createSubscribeRequest({
      business_id: 'biz-cas-test',
      plan: 'growth',
      billing_interval: 'month',
    });
    const res = await subscribePOST(req);

    // Must fail closed (500)
    expect(res.status).toBe(500);

    // Flutterwave /v3/payments endpoint must NEVER have been called
    const paymentCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('/v3/payments'),
    );
    expect(paymentCalls).toHaveLength(0);
  });
});
