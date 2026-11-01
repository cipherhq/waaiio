import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ allowed: true, select: vi.fn(), rows: [] as unknown[] }));
vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: async () => m.allowed ? { id: 'fixture-admin' } : null }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: () => {
  const q: any = { select: (...args: unknown[]) => { m.select(...args); return q; }, order: () => q, range: () => q,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: m.rows, count: m.rows.length, error: null }).then(resolve) };
  return q;
} }) }));
import { GET } from '@/app/api/admin/payouts/route';
beforeEach(() => { m.allowed = true; m.select.mockClear(); m.rows = []; });
describe('payout list authoritative currency and safe projection', () => {
  it('returns each stored currency unchanged including null, regardless of business country', async () => {
    m.rows = ['USD', 'NGN', null].map((currency,i) => ({ id:`fixture-${i}`,currency,net_amount:10,businesses:{name:'Fixture',country_code:'NG'},claim_token:'must-not-return',provider_idempotency_key:'must-not-return' }));
    const res = await GET(new NextRequest('https://fixture.invalid/api/admin/payouts'));
    expect(res.status).toBe(200);
    const body = await res.json(); expect(body.payouts.map((p: any) => p.currency)).toEqual(['USD','NGN',null]);
    expect(m.select.mock.calls[0][0].split(', ')).toContain('currency');
    expect(m.select.mock.calls[0][0]).not.toMatch(/claim_token|provider_idempotency_key|\*/);
    expect(JSON.stringify(body)).not.toContain('must-not-return');
  });
  it('denies unauthorized callers before querying payouts', async () => {
    m.allowed = false;
    expect((await GET(new NextRequest('https://fixture.invalid/api/admin/payouts'))).status).toBe(403);
    expect(m.select).not.toHaveBeenCalled();
  });
});
