import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const h = vi.hoisted(() => ({
  user: { id: 'synthetic-owner' } as { id: string } | null, owner: 'synthetic-owner', country: 'US', currency: 'USD',
  pricing: {} as Record<string, unknown>, fetch: vi.fn(), writes: vi.fn(), filters: [] as Array<[string, unknown]>,
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: (table: string) => {
      const q = { select: () => q, eq: () => q, single: async () => ({ data: table === 'businesses'
        ? { id: 'synthetic-business', owner_id: h.owner, country_code: h.country }
        : { email: 'synthetic@example.test' }, error: null }), update: h.writes, insert: h.writes, delete: h.writes };
      return q;
    },
  }),
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    rpc: h.writes,
    from: () => {
      const q = { select: () => q, eq: (key: string, value: unknown) => { h.filters.push([key, value]); return q; },
        single: async () => ({ data: { pricing: h.pricing }, error: null }), update: h.writes, insert: h.writes, delete: h.writes };
      return q;
    },
  }),
}));
vi.mock('@/lib/payments/gateway-resolver', () => ({
  resolveBusinessGateway: async () => ({ gateway: 'stripe', currency: h.currency, source: 'country_default' }),
}));
import { POST } from '@/app/api/onboarding/subscribe/route';
const amount = { growth: 29.99, business: 59.99 };
const priceId = (country: string, tier: string) => 'price_synthetic' + country + tier;
function price(id: string, tier: 'growth' | 'business') {
  return { id, object: 'price', active: true, type: 'recurring', billing_scheme: 'per_unit',
    currency: h.currency.toLowerCase(), unit_amount: Math.round(amount[tier] * 100), unit_amount_decimal: String(Math.round(amount[tier] * 100)),
    custom_unit_amount: null, transform_quantity: null, tiers_mode: null, livemode: false,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    product: { id: 'prod_synthetic' + tier, object: 'product', active: true, livemode: false } };
}
function seed() {
  h.pricing = Object.fromEntries(['growth', 'business'].map(tier => [tier, {
    price: amount[tier as 'growth' | 'business'], provider_plan_refs: { stripe: priceId(h.country, tier) },
  }]));
}
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function request(extra = {}) {
  return new NextRequest('http://localhost/api/onboarding/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ business_id: 'synthetic-business', plan: 'growth', ...extra }) });
}
function checkouts() { return h.fetch.mock.calls.filter(([url]) => String(url).endsWith('/checkout/sessions')); }
beforeEach(() => {
  h.user = { id: 'synthetic-owner' }; h.owner = 'synthetic-owner'; h.country = 'US'; h.currency = 'USD';
  h.filters.length = 0; h.fetch.mockReset(); h.writes.mockReset(); seed();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic'); vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://synthetic.example.test');
  h.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/balance')) return json({ available: [], livemode: false });
    if (url.includes('/prices/')) {
      const id = new URL(url).pathname.split('/').pop()!;
      return json(price(id, id.endsWith('business') ? 'business' : 'growth'));
    }
    if (url.endsWith('/checkout/sessions')) return json({ id: 'cs_synthetic', url: 'https://checkout.example.test/synthetic' });
    throw new Error('Unexpected provider path');
  });
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('#762 actual merchant Stripe catalog checkout', () => {
  for (const [country, currency] of [['US', 'USD'], ['GB', 'GBP'], ['CA', 'CAD']]) {
    it.each(['growth', 'business'] as const)(country + ' %s uses validated canonical Price and preserves session fields', async tier => {
      h.country = country; h.currency = currency; seed();
      const res = await POST(request({ plan: tier, country_code: 'NG', amount: 1, price: 'price_client', callback: '/dashboard/subscription' }));
      expect(res.status).toBe(200); expect(checkouts()).toHaveLength(1);
      const body = new URLSearchParams(checkouts()[0][1].body);
      expect(body.get('line_items[0][price]')).toBe(priceId(country, tier));
      expect(body.get('currency')).toBe(currency.toLowerCase());
      expect([...body.keys()].some(k => k.includes('price_data'))).toBe(false);
      expect(body.get('line_items[0][quantity]')).toBe('1'); expect(body.get('mode')).toBe('subscription');
      expect(body.get('success_url')).toBe('https://synthetic.example.test/dashboard/subscription');
      expect(body.get('cancel_url')).toBe('https://synthetic.example.test/get-started');
      expect(body.get('customer_email')).toBe('synthetic@example.test');
      expect(body.get('metadata[business_id]')).toBe('synthetic-business');
      expect(body.get('metadata[plan]')).toBe(tier); expect(body.get('metadata[billing_interval]')).toBe('month');
      expect(body.get('metadata[type]')).toBe('whatsapp_subscription'); expect(body.get('metadata[user_id]')).toBe('synthetic-owner');
      expect(h.filters).toContainEqual(['code', country]); expect(h.filters).toContainEqual(['is_active', true]);
      expect(h.fetch.mock.calls.filter(([url]) => String(url).includes('/prices/'))).toHaveLength(1);
      expect(h.writes).not.toHaveBeenCalled();
      expect(h.fetch.mock.calls.some(([url]) => String(url).includes('/subscriptions/'))).toBe(false);
    });
  }
  it.each(['no refs property', 'empty object', 'other provider'])('retains inline behavior only for genuine absence: %s', async kind => {
    h.pricing.growth = { price: 29.99, ...(kind === 'no refs property' ? {} : { provider_plan_refs: kind === 'empty object' ? {} : { paystack: 'PLN_synthetic' } }) };
    expect((await POST(request())).status).toBe(200);
    const body = new URLSearchParams(checkouts()[0][1].body);
    expect(body.get('line_items[0][price]')).toBeNull();
    expect(body.get('currency')).toBeNull();
    expect(body.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('2999');
    expect(body.get('line_items[0][price_data][product_data][name]')).toBe('Waaiio Pro Plan (Monthly)');
    expect(body.get('line_items[0][price_data][recurring][interval]')).toBe('month');
    expect(h.fetch.mock.calls.some(([url]) => String(url).includes('/prices/'))).toBe(false);
  });
  it.each(['', ' ', null, 12, {}, 'prod_synthetic', 'price_bad/path', undefined])('present-invalid ref %# never falls back or creates checkout', async ref => {
    h.pricing.growth = { price: 29.99, provider_plan_refs: { stripe: ref } };
    expect((await POST(request())).status).toBe(503); expect(checkouts()).toHaveLength(0); expect(h.writes).not.toHaveBeenCalled();
  });
  it.each([null, [], 'broken'])('malformed ref container %# fails closed', async refs => {
    h.pricing.growth = { price: 29.99, provider_plan_refs: refs };
    expect((await POST(request())).status).toBe(503); expect(checkouts()).toHaveLength(0);
  });
  it.each([{ active: false }, { currency: 'eur' }, { unit_amount: 1 }, { product: null }, { id: 'price_wrong' }])('provider-invalid Price %# creates no checkout', async patch => {
    h.fetch.mockImplementation(async (url: string) => url.endsWith('/balance') ? json({ available: [], livemode: false })
      : json({ ...price(priceId('US', 'growth'), 'growth'), ...patch }));
    expect((await POST(request())).status).toBe(503); expect(checkouts()).toHaveLength(0); expect(h.writes).not.toHaveBeenCalled();
  });
  it('provider timeout creates no checkout and never falls back', async () => {
    h.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/balance')) return json({ available: [], livemode: false });
      throw new DOMException('synthetic timeout', 'TimeoutError');
    });
    expect((await POST(request())).status).toBe(503); expect(checkouts()).toHaveLength(0);
  });
  it('retains readiness denial before checkout', async () => {
    h.fetch.mockResolvedValue(json({}, 503));
    expect((await POST(request())).status).toBe(503); expect(checkouts()).toHaveLength(0);
  });
  it('rejects unauthenticated, nonowner and annual requests before provider interactions', async () => {
    h.user = null; expect((await POST(request())).status).toBe(401);
    h.user = { id: 'synthetic-owner' }; h.owner = 'other'; expect((await POST(request())).status).toBe(403);
    h.owner = 'synthetic-owner'; expect((await POST(request({ billing_interval: 'year' }))).status).toBe(400);
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.writes).not.toHaveBeenCalled();
  });
});

it('pins authoritative currency for a multi-currency catalog Price despite conflicting client input', async () => {
  const normal = h.fetch.getMockImplementation()!;
  h.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.includes('/prices/')) return json({ ...price(priceId('US', 'growth'), 'growth'),
      currency_options: { usd: { unit_amount: 2999 }, eur: { unit_amount: 9999 } } });
    return normal(url, init);
  });
  const res = await POST(request({ currency: 'EUR', country_code: 'DE', amount: 9999 }));
  expect(res.status).toBe(200); expect(checkouts()).toHaveLength(1);
  const body = new URLSearchParams(checkouts()[0][1].body);
  expect(body.get('currency')).toBe('usd');
  expect(body.get('line_items[0][price]')).toBe(priceId('US', 'growth'));
  expect([...body.keys()].some(key => key.includes('price_data'))).toBe(false);
  expect(h.filters).toContainEqual(['code', 'US']); expect(h.writes).not.toHaveBeenCalled();
});
