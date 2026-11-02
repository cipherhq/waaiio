import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/payouts/balance/route';
import { getMerchantAccountingHold } from '@/lib/payouts/accounting-hold';

const f = vi.hoisted(() => ({ user: true, owns: true, active: true as boolean | null, holdError: false, mode: 'platform_managed', currency: 'NGN' as string | null, calls: [] as unknown[][], service: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn() }));
vi.mock('@/lib/constants', () => ({ getCurrencyCode: () => 'NGN' }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ default_platform_fee_percent: 10 }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: (options: unknown) => { f.service(options); return service; } }));
const service = { from(table: string) {
  f.calls.push(['table', table]);
  return { select(columns: string) { f.calls.push(['select', columns]); return { eq(key: string, value: string) {
    f.calls.push(['eq', key, value]); return { maybeSingle: async () => ({ data: f.active === null ? null : { active: f.active }, error: f.holdError ? { message: 'private error' } : null }) };
  } }; } };
} };
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: f.user ? { id: 'owner' } : null } }) },
  from(table: string) {
    let columns = '';
    const q: Record<string, any> = {};
    for (const method of ['eq', 'in', 'is']) q[method] = () => q;
    q.select = (value: string) => { columns = value; return q; };
    const result = () => ({ data: table === 'businesses' ? (f.owns ? { id: 'b1', country_code: 'NG', payout_mode: f.mode } : null)
      : table === 'platform_fees' ? [{ transaction_amount: 1000, fee_total: 100, gateway_fee: 20, waived: false, is_direct_transfer: false, payments: { currency: f.currency } }]
      : table === 'payout_accounts' ? { platform_percentage: 10 }
      : table === 'orders' && columns !== 'id' ? [{ total_amount: 1000 }]
      : [], error: null, count: 0 });
    q.single = async () => result(); q.maybeSingle = async () => result();
    q.then = (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject);
    return q;
  },
}) }));
const request = (query = '?business_id=b1') => new NextRequest('https://example.invalid/api/payouts/balance' + query);
beforeEach(() => { Object.assign(f, { user: true, owns: true, active: true, holdError: false, mode: 'platform_managed', currency: 'NGN', calls: [] }); vi.clearAllMocks(); });
describe('service-only accounting hold read', () => {
  it.each([[true, true], [false, false], [null, false]])('reads active %s as %s with exact business scope', async (active, expected) => {
    f.active = active;
    expect(await getMerchantAccountingHold(service as any, 'b1')).toBe(expected);
    expect(f.calls).toEqual([['table', 'merchant_accounting_holds'], ['select', 'active'], ['eq', 'business_id', 'b1']]);
  });
  it('fails closed on database errors without disclosing their detail', async () => {
    f.holdError = true;
    await expect(getMerchantAccountingHold(service as any, 'b1')).rejects.toThrow('Unable to verify merchant accounting hold');
  });
});
describe('actual balance handler', () => {
  it.each([[false, true, 401], [true, false, 404]])('denies unauthorized ownership before creating service client', async (user, owns, status) => {
    f.user = user; f.owns = owns;
    expect((await GET(request())).status).toBe(status);
    expect(f.service).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });
  it('requires business id before service use', async () => {
    expect((await GET(request(''))).status).toBe(400); expect(f.service).not.toHaveBeenCalled();
  });
  it('returns hold state without zeroing or changing accounting totals', async () => {
    const held = await GET(request()); expect(held.status).toBe(200); const a = await held.json();
    f.active = false; const b = await (await GET(request())).json();
    expect(f.service).toHaveBeenCalledWith({ noStore: true });
    expect(a.settlement_held).toBe(true); expect(b.settlement_held).toBe(false);
    expect(a.net_available).toBe(900); expect(a.gross).toBe(1000);
    expect({ ...a, settlement_held: false }).toEqual(b);
  });
  it('preserves direct split totals while reporting business hold independently', async () => {
    f.mode = 'direct_split'; const a = await (await GET(request())).json();
    f.active = false; const b = await (await GET(request())).json();
    expect(a.net_available).toBe(900); expect({ ...a, settlement_held: false }).toEqual(b);
  });
  it('does not return available amounts when hold lookup fails', async () => {
    f.holdError = true; const res = await GET(request());
    expect(res.status).toBe(500); expect(await res.json()).toEqual({ error: 'Failed to calculate balance' });
  });
});
