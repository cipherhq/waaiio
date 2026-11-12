/**
 * Behavioural route tests: /api/onboarding/verify checks a Paystack plan
 * payment against the server-side plan price (countries.pricing[plan].price,
 * country currency) before any subscription row is written or the paid
 * activation RPC runs. Imports the real handler and the real price helper;
 * Supabase and the Paystack verify call are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  userId: '11111111-1111-4111-8111-111111111111',
  businessId: '22222222-2222-4222-8222-222222222222',
  subscriptionId: '33333333-3333-4333-8333-333333333333',
  paymentId: '44444444-4444-4444-8444-444444444444',
  configId: '55555555-5555-4555-8555-555555555555',
  authFrom: vi.fn(),
  serviceFrom: vi.fn(),
  rpc: vi.fn(),
  finalize: vi.fn(),
  // fake DB state
  pricing: { growth: { price: 14999 }, business: { price: 39999 } } as Record<string, unknown> | null,
  countryCurrency: 'NGN',
  countryGateway: 'paystack',
  subscription: null as null | { id: string; status: string; plan: string },
  evidenceRefs: new Set<string>(),
  upserts: [] as Record<string, unknown>[],
  evidenceInserts: [] as Record<string, unknown>[],
  businessUpdates: [] as Record<string, unknown>[],
  countriesQueried: 0,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: state.userId } }, error: null }) },
    from: (...args: unknown[]) => state.authFrom(...args),
  }),
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (...args: unknown[]) => state.serviceFrom(...args),
    rpc: (...args: unknown[]) => state.rpc(...args),
  }),
}));
vi.mock('@/lib/onboarding/finalize', () => ({
  finalizeOnboarding: (...args: unknown[]) => state.finalize(...args),
}));

import { POST } from '@/app/api/onboarding/verify/route';

type Result = { data?: unknown; error?: unknown };

function chain(resolveResult: (cols: string, filters: Record<string, unknown>) => Result) {
  let cols = '';
  const filters: Record<string, unknown> = {};
  const q = {
    select: (c?: string) => { cols = c ?? ''; return q; },
    eq: (column: string, value: unknown) => { filters[column] = value; return q; },
    lte: () => q,
    order: () => q,
    limit: () => q,
    single: async () => resolveResult(cols, filters),
    maybeSingle: async () => resolveResult(cols, filters),
    then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(resolveResult(cols, filters)).then(resolve, reject),
  };
  return q;
}

function setupFakes() {
  state.finalize.mockResolvedValue(undefined);
  state.authFrom.mockImplementation((table: string) => {
    expect(table).toBe('businesses');
    return chain(() => ({
      data: { owner_id: state.userId, subscription_tier: state.subscription?.status === 'active' ? 'growth' : 'free', wa_method: 'shared', assigned_channel_id: 'ch-1' },
      error: null,
    }));
  });

  state.serviceFrom.mockImplementation((table: string) => {
    if (table === 'countries') {
      state.countriesQueried += 1;
      return chain((cols, filters) => {
        expect(filters.code).toBe('NG');
        if (cols.includes('pricing')) {
          return state.pricing ? { data: { pricing: state.pricing }, error: null } : { data: null, error: { message: 'no rows' } };
        }
        return { data: { payment_gateway: state.countryGateway, currency_code: state.countryCurrency }, error: null };
      });
    }
    if (table === 'business_capabilities') {
      return chain(() => ({ data: [{ capability: 'payment', is_enabled: true }], error: null }));
    }
    if (table === 'subscriptions') {
      return {
        select: () => chain(() => state.subscription
          ? { data: state.subscription, error: null }
          : { data: null, error: { code: 'PGRST116', message: 'no rows' } }),
        upsert: (values: Record<string, unknown>) => {
          state.upserts.push(values);
          state.subscription = { id: state.subscriptionId, status: 'pending', plan: values.plan as string };
          return chain(() => ({ data: { id: state.subscriptionId }, error: null }));
        },
      };
    }
    if (table === 'platform_config_versions') {
      return chain(() => ({ data: { id: state.configId }, error: null }));
    }
    if (table === 'subscription_payments') {
      return {
        insert: (values: Record<string, unknown>) => {
          const ref = values.provider_reference as string;
          if (state.evidenceRefs.has(ref)) {
            return chain(() => ({ data: null, error: { code: '23505', message: 'duplicate key' } }));
          }
          state.evidenceRefs.add(ref);
          state.evidenceInserts.push(values);
          return chain(() => ({ data: { id: state.paymentId }, error: null }));
        },
        select: () => chain(() => ({ data: { id: state.paymentId }, error: null })),
      };
    }
    if (table === 'businesses') {
      return {
        select: (c?: string) => chain(() => {
          if (c === 'country_code') return { data: { country_code: 'NG' }, error: null };
          if (c === 'status') return { data: { status: 'active' }, error: null };
          return { data: { bot_code: 'TESTBIZ', slug: 'testbiz' }, error: null };
        }),
        update: (values: Record<string, unknown>) => {
          state.businessUpdates.push(values);
          const q = chain(() => ({ data: [{ id: state.businessId, status: 'active' }], error: null }));
          return q;
        },
      };
    }
    if (table === 'admin_onboarding_invites') {
      return chain(() => ({ data: null, error: null }));
    }
    throw new Error(`Unexpected service table: ${table}`);
  });

  state.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'activate_paid_subscription') {
      expect(args).toEqual({ p_payment_id: state.paymentId });
      const idempotent = state.subscription?.status === 'active';
      if (state.subscription) state.subscription.status = 'active';
      return { data: { activated: true, allowance_granted: true, ...(idempotent ? { idempotent: true } : {}) }, error: null };
    }
    return { data: null, error: null };
  });
}

function stubPaystack(overrides: { amount?: number; currency?: string; billing_interval?: string; plan?: string } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(String(url)).toContain('https://api.paystack.co/transaction/verify/');
    return {
      json: async () => ({
        data: {
          status: 'success',
          amount: overrides.amount ?? 1_499_900,
          currency: overrides.currency ?? 'NGN',
          paid_at: '2026-10-01T03:00:00.000Z',
          created_at: '2026-10-01T02:59:00.000Z',
          metadata: {
            type: 'whatsapp_subscription',
            business_id: state.businessId,
            plan: overrides.plan ?? 'growth',
            billing_interval: overrides.billing_interval ?? 'month',
          },
        },
      }),
    };
  }));
}

function verify(reference: string) {
  return POST(new NextRequest('http://localhost/api/onboarding/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference }),
  }));
}

function expectNoActivation() {
  expect(state.rpc).not.toHaveBeenCalled();
  expect(state.upserts).toEqual([]);
  expect(state.evidenceInserts).toEqual([]);
  expect(state.businessUpdates).toEqual([]);
  expect(state.finalize).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.stubEnv('ENABLE_CHANNEL_ALLOCATION_OPERATIONS', 'true');
  process.env.PAYSTACK_SECRET_KEY = 'test-paystack-key';
  state.pricing = { growth: { price: 14999 }, business: { price: 39999 } };
  state.countryCurrency = 'NGN';
  state.countryGateway = 'paystack';
  state.subscription = null;
  state.evidenceRefs = new Set();
  state.upserts = [];
  state.evidenceInserts = [];
  state.businessUpdates = [];
  state.countriesQueried = 0;
  setupFakes();
});

describe('onboarding verify: Paystack plan payment must match the server plan price', () => {
  it('rejects an underpaid amount and changes nothing (activation RPC not called)', async () => {
    stubPaystack({ amount: 100 }); // 1 NGN for a 14,999 NGN plan
    const res = await verify('ref-underpay');
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.reason).toBe('amount_mismatch');
    expectNoActivation();
  });

  it('rejects an overpaid / off-by-one amount as well (exact match required)', async () => {
    stubPaystack({ amount: 1_499_901 });
    const res = await verify('ref-off-by-one');
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('amount_mismatch');
    expectNoActivation();
  });

  it('rejects a lower-plan price paid for a higher plan', async () => {
    stubPaystack({ amount: 1_499_900, plan: 'business' }); // growth price, business plan
    const res = await verify('ref-plan-swap');
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('amount_mismatch');
    expectNoActivation();
  });

  it('rejects the wrong currency even when the number matches', async () => {
    stubPaystack({ amount: 1_499_900, currency: 'GHS' });
    const res = await verify('ref-wrong-currency');
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.reason).toBe('currency_mismatch');
    expectNoActivation();
  });

  it('fails closed when the plan price cannot be read', async () => {
    state.pricing = null;
    stubPaystack();
    const res = await verify('ref-no-pricing');
    expect(res.status).toBe(503);
    expectNoActivation();
  });

  it('activates when the exact plan price and currency are paid', async () => {
    stubPaystack();
    const res = await verify('ref-exact');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'success', plan: 'growth', messaging_allowance_status: 'granted' });
    expect(state.rpc).toHaveBeenCalledWith('activate_paid_subscription', { p_payment_id: state.paymentId });
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({ plan: 'growth', status: 'pending', amount: 14999, currency: 'NGN', gateway: 'paystack' });
    expect(state.evidenceInserts[0]).toMatchObject({ amount: 1_499_900, currency: 'NGN', plan: 'growth' });
    expect(state.businessUpdates).toContainEqual({ status: 'active' });
  });

  it('activates the higher plan at its exact price (legitimate upgrade price)', async () => {
    stubPaystack({ amount: 3_999_900, plan: 'business' });
    const res = await verify('ref-business');
    expect(res.status).toBe(200);
    expect(state.upserts[0]).toMatchObject({ plan: 'business', amount: 39999, currency: 'NGN' });
  });

  it('is idempotent on a repeat verify of the same reference', async () => {
    stubPaystack();
    const first = await verify('ref-repeat');
    expect(first.status).toBe(200);
    const second = await verify('ref-repeat');
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe('success');
    // One subscription upsert and one evidence row; the replay reuses both.
    expect(state.upserts).toHaveLength(1);
    expect(state.evidenceInserts).toHaveLength(1);
    expect(state.rpc.mock.calls.filter(c => c[0] === 'activate_paid_subscription')).toHaveLength(2);
  });

  it('annual billing is not offered: a yearly payment is rejected before activation', async () => {
    stubPaystack({ amount: 1_499_900 * 12, billing_interval: 'year' });
    const res = await verify('ref-annual');
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('Annual billing is not yet supported');
    expectNoActivation();
  });

  it('Stripe path is unchanged: no regional price lookup for cs_ sessions', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({
        payment_status: 'paid',
        amount_total: 2900,
        currency: 'usd',
        created: 1_759_287_600,
        metadata: { type: 'whatsapp_subscription', business_id: state.businessId, plan: 'growth', billing_interval: 'month' },
      }),
    })));
    const res = await verify('cs_test_fixture');
    expect(res.status).toBe(200);
    expect(state.countriesQueried).toBe(0);
  });
});
