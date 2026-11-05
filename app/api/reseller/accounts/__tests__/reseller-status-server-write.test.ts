/**
 * M508 makes businesses.status server-managed. Reseller routes must write
 * status through the service client, scoped to their own sub-account, and
 * keep every other field on the caller's own client (so existing guards such
 * as the subscription_tier guard still apply).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Call = { client: 'user' | 'service'; table: string; op: string; payload?: unknown; eqs: Array<[string, unknown]> };
const state = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  reseller: { id: 'res-1', status: 'active', max_sub_accounts: 5 } as Record<string, unknown> | null,
  ownedBusiness: { id: 'biz-1', reseller_id: 'res-1' } as Record<string, unknown> | null,
  calls: [] as Call[],
}));

function client(kind: 'user' | 'service') {
  return {
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from(table: string) {
      const call: Call = { client: kind, table, op: 'select', eqs: [] };
      state.calls.push(call);
      const c: Record<string, any> = {};
      c.select = () => c;
      c.eq = (col: string, val: unknown) => { call.eqs.push([col, val]); return c; };
      c.update = (payload: unknown) => { call.op = 'update'; call.payload = payload; return c; };
      c.insert = (payload: unknown) => { call.op = 'insert'; call.payload = payload; return c; };
      const result = () => {
        if (table === 'resellers') return { data: state.reseller, error: null };
        if (table === 'businesses' && call.op === 'select') return { data: state.ownedBusiness, error: null, count: 0 };
        return { data: { id: 'biz-1', ...(call.payload as object) }, error: null };
      };
      c.maybeSingle = async () => result();
      c.single = async () => result();
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
      return c;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client('user') }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client('service') }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const one = await import('@/app/api/reseller/accounts/[id]/route');
const list = await import('@/app/api/reseller/accounts/route');
const params = { params: Promise.resolve({ id: 'biz-1' }) };
const json = (body: unknown, method = 'PATCH') => new NextRequest('https://www.waaiio.com/api/reseller/accounts/biz-1', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const writes = (k: 'user' | 'service') => state.calls.filter(c => c.client === k && c.op !== 'select');

beforeEach(() => {
  state.user = { id: 'user-1' };
  state.reseller = { id: 'res-1', status: 'active', max_sub_accounts: 5 };
  state.ownedBusiness = { id: 'biz-1', reseller_id: 'res-1' };
  state.calls = [];
});

describe('reseller sub-account status goes through the server, scoped to the reseller', () => {
  it('PATCH: status via service client scoped to id + reseller; other fields via the caller client', async () => {
    const res = await one.PATCH(json({ status: 'suspended', name: 'New name' }), params);
    expect(res.status).toBe(200);
    const svc = writes('service');
    expect(svc).toHaveLength(1);
    expect(svc[0]).toMatchObject({ table: 'businesses', op: 'update', payload: { status: 'suspended' } });
    expect(svc[0].eqs).toEqual([['id', 'biz-1'], ['reseller_id', 'res-1']]);
    const own = writes('user');
    expect(own).toHaveLength(1);
    expect(own[0].payload).toEqual({ name: 'New name' });
  });

  it('PATCH: subscription_tier never goes through the service client', async () => {
    await one.PATCH(json({ subscription_tier: 'business' }), params);
    expect(writes('service')).toEqual([]);
    expect(writes('user')[0].payload).toEqual({ subscription_tier: 'business' });
  });

  it('PATCH: a sub-account not owned by the reseller never reaches a service write', async () => {
    state.ownedBusiness = null;
    const res = await one.PATCH(json({ status: 'active' }), params);
    expect(res.status).toBe(404);
    expect(writes('service')).toEqual([]);
  });

  it('PATCH: unauthenticated never reaches a service write', async () => {
    state.user = null;
    const res = await one.PATCH(json({ status: 'active' }), params);
    expect(res.status).toBe(401);
    expect(writes('service')).toEqual([]);
  });

  it('DELETE: soft-suspend via service client scoped to id + reseller', async () => {
    const res = await one.DELETE(json({}, 'DELETE'), params);
    expect(res.status).toBe(200);
    const svc = writes('service');
    expect(svc).toHaveLength(1);
    expect(svc[0]).toMatchObject({ op: 'update', payload: { status: 'suspended' } });
    expect(svc[0].eqs).toEqual([['id', 'biz-1'], ['reseller_id', 'res-1']]);
  });

  it('POST: create via service client with owner and reseller set server-side', async () => {
    const res = await list.POST(new NextRequest('https://www.waaiio.com/api/reseller/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sub', category: 'shop', email: 'a@b.co', country_code: 'NG', owner_id: 'attacker', reseller_id: 'other' }),
    }));
    expect(res.status).toBe(201);
    const svc = writes('service');
    expect(svc).toHaveLength(1);
    expect(svc[0].op).toBe('insert');
    expect(svc[0].payload).toMatchObject({ owner_id: 'user-1', reseller_id: 'res-1', status: 'active', country_code: 'NG' });
  });

  it('POST: a suspended reseller never reaches a service write', async () => {
    state.reseller = { id: 'res-1', status: 'suspended', max_sub_accounts: 5 };
    const res = await list.POST(new NextRequest('https://www.waaiio.com/api/reseller/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sub', category: 'shop', email: 'a@b.co', country_code: 'NG' }),
    }));
    expect(res.status).toBe(403);
    expect(writes('service')).toEqual([]);
  });
});
