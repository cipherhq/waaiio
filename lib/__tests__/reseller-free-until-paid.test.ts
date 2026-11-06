/**
 * Owner decision 2026-11-06 ("free until paid"):
 * - sub-accounts a reseller creates start on the free plan, whatever the request says;
 * - a reseller's own plan and account cap change only after payment is confirmed;
 * - branding is still saved, now through the service client after the owner check (M524).
 *
 * Runs the real route handlers with Supabase and Stripe calls stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const USER_ID = 'user-reseller-1';
const RESELLER = {
  id: 'reseller-1', user_id: USER_ID, status: 'active', max_sub_accounts: 10,
  tier: 'starter', branding: {}, company_name: 'Acme', stripe_customer_id: 'cus_1', stripe_subscription_id: null,
};

type Write = { client: 'user' | 'service'; table: string; op: string; values?: Record<string, unknown>; filters: Array<[string, unknown]> };
const { writes } = vi.hoisted(() => ({ writes: [] as Write[] }));

function makeClient(kind: 'user' | 'service') {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER_ID, email: 'r@example.com' } } }) },
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let op = 'select';
      let values: Record<string, unknown> | undefined;
      const record = () => writes.push({ client: kind, table, op, values, filters });
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) return { eq: () => Promise.resolve({ count: 0, error: null }) };
        return chain;
      };
      chain.eq = (col: string, val: unknown) => { filters.push([col, val]); return chain; };
      chain.order = self; chain.range = self; chain.limit = self;
      chain.insert = (v: Record<string, unknown>) => { op = 'insert'; values = v; record(); return chain; };
      chain.update = (v: Record<string, unknown>) => { op = 'update'; values = v; return chain; };
      chain.maybeSingle = async () => ({ data: table === 'resellers' ? RESELLER : null, error: null });
      chain.single = async () => ({ data: op === 'insert' ? { id: 'biz-new', ...values } : RESELLER, error: null });
      chain.then = (resolve: (v: unknown) => void) => { if (op === 'update') record(); return Promise.resolve({ error: null }).then(resolve); };
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeClient('user') }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => makeClient('service') }));

const fetchMock = vi.fn();

beforeEach(() => {
  writes.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function json(url: string, method: string, body: unknown) {
  return new NextRequest(new URL(`http://localhost${url}`), {
    method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/reseller/accounts — sub-accounts start free', () => {
  it.each(['business', 'growth', undefined])('requested tier %s → created on free', async (tier) => {
    const { POST } = await import('@/app/api/reseller/accounts/route');
    const res = await POST(json('/api/reseller/accounts', 'POST', {
      name: 'Shop', category: 'salon', email: 's@example.com', country_code: 'NG', subscription_tier: tier,
    }));
    expect(res.status).toBe(201);
    const insert = writes.find(w => w.table === 'businesses' && w.op === 'insert');
    expect(insert?.values?.subscription_tier).toBe('free');
    expect(insert?.values?.reseller_id).toBe(RESELLER.id);
  });
});

describe('POST /api/reseller/subscription — plan changes only after payment', () => {
  it('without Stripe billing configured: refused with a clear message, nothing written', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    const { POST } = await import('@/app/api/reseller/subscription/route');
    const res = await POST(json('/api/reseller/subscription', 'POST', { tier: 'enterprise' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/once payment is confirmed/);
    expect(writes.filter(w => w.table === 'resellers')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with Stripe billing: records the subscription only; tier and cap unchanged; response shows current plan', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    vi.stubEnv('RESELLER_STRIPE_PRICE_ENTERPRISE', 'price_ent');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'sub_new', status: 'incomplete', current_period_end: 1 }) });
    const { POST } = await import('@/app/api/reseller/subscription/route');
    const res = await POST(json('/api/reseller/subscription', 'POST', { tier: 'enterprise' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier).toBe('starter');
    expect(body.maxAccounts).toBe(10);
    expect(body.pending_tier).toBe('enterprise');
    const resellerWrites = writes.filter(w => w.table === 'resellers');
    expect(resellerWrites).toHaveLength(1);
    expect(resellerWrites[0].values).toEqual({ stripe_subscription_id: 'sub_new' });
  });

  it('an invalid tier is still rejected', async () => {
    const { POST } = await import('@/app/api/reseller/subscription/route');
    const res = await POST(json('/api/reseller/subscription', 'POST', { tier: 'platinum' }));
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/reseller/branding — saved through the service client, scoped to the owner', () => {
  it('writes only branding fields, with the service client, for this reseller and user', async () => {
    const { PUT } = await import('@/app/api/reseller/branding/route');
    const res = await PUT(json('/api/reseller/branding', 'PUT', { primary_color: '#6C2BD9', company_name: 'Acme Ltd' }));
    expect(res.status).toBe(200);
    const w = writes.filter(x => x.table === 'resellers' && x.op === 'update');
    expect(w).toHaveLength(1);
    expect(w[0].client).toBe('service');
    expect(Object.keys(w[0].values!).sort()).toEqual(['branding', 'company_name']);
    expect(w[0].filters).toEqual([['id', RESELLER.id], ['user_id', USER_ID]]);
  });

  it('ignores non-branding fields in the request', async () => {
    const { PUT } = await import('@/app/api/reseller/branding/route');
    await PUT(json('/api/reseller/branding', 'PUT', { primary_color: '#000000', commission_percentage: 100, tier: 'enterprise' }));
    const w = writes.find(x => x.table === 'resellers' && x.op === 'update');
    expect(Object.keys(w!.values!)).toEqual(['branding']);
  });
});
