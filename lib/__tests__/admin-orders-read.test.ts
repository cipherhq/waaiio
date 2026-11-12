import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const f = vi.hoisted(() => ({ role: 'admin', aal: 'aal2', valid: true, orders: [] as any[], items: [] as any[], fail: '', selects: [] as any[], authClient: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: f.authClient }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }) }));
import { GET, OPTIONS } from '@/app/api/admin/orders/route';
const id = '11111111-1111-4111-8111-111111111111';
const row = () => ({ id, reference_code: 'ORD1', business_id: 'biz', user_id: 'user', status: 'confirmed', total_amount: 125, shipping_cost: 25, business: { name: 'Store', country_code: 'US' }, customer: { first_name: 'Test', last_name: 'Customer', email: 'test@example.invalid' }, order_items: [{ count: 2 }] });
function request(query = '', auth = true) { return new NextRequest(`https://staging.waaiio.com/api/admin/orders${query}`, { headers: { Origin: 'https://admin-staging.waaiio.com', ...(auth ? { Authorization: 'Bearer test' } : {}) } }); }
beforeEach(() => {
 f.role = 'admin'; f.aal = 'aal2'; f.valid = true; f.fail = ''; f.selects = []; f.orders = [row()]; f.items = [{ id: 'line', order_id: id, product_id: 'prod', quantity: 2, unit_price: 50, product: { name: 'Widget' }, variant_label: 'Blue', addons: null }];
 f.from.mockReset().mockImplementation((table: string) => {
  const q: any = { filters: [] as any[], offset: 0, end: Infinity, max: Infinity };
  q.select = (columns: string) => { f.selects.push({ table, columns }); return q; };
  q.eq = (key: string, value: unknown) => { q.filters.push([key, value]); return q; };
  q.in = () => q; q.order = () => q; q.limit = (n: number) => { q.max = n; return q; };
  q.range = (start: number, end: number) => { q.offset = start; q.end = end; return q; };
  q.insert = async () => ({ error: null });
  q.then = (resolve: any) => {
   let data = table === 'orders' ? f.orders : table === 'countries' ? [{ code: 'US', currency_code: 'USD' }] : f.items;
   for (const [key, value] of q.filters) data = data.filter((r: any) => r[key] === value);
   return Promise.resolve({ data: data.slice(q.offset, Math.min(q.end + 1, q.max)), error: f.fail === table ? { message: 'internal secret' } : null }).then(resolve);
  }; return q;
 });
 f.authClient.mockReset().mockReturnValue({ from: f.from, auth: {
  getClaims: async () => ({ data: f.valid ? { claims: { sub: 'actor', session_id: 'session', aal: f.aal } } : null }),
  getUser: async () => ({ data: { user: { id: 'actor', email: 'admin@example.invalid', app_metadata: { role: f.role } } } }),
 }, rpc: () => ({ maybeSingle: async () => ({ data: { session_exists: true }, error: null }) }) });
});
describe('Orders HTTP read contract with actual platform authorization', () => {
 for (const role of ['admin', 'support', 'operations']) it(`allows ${role} with MFA and canonical scoped data`, async () => {
  f.role = role; const res = await GET(request()); expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('access-control-allow-origin')).toBe('https://admin-staging.waaiio.com');
  expect((await res.json()).data[0]).toMatchObject({ user_id: 'user', customer_name: 'Test Customer', customer_email: 'test@example.invalid', currency: 'USD', total_amount: 125, shipping_cost: 25, items_count: 2 });
 });
 for (const role of ['finance', 'customer']) it(`denies ${role} before reading orders`, async () => {
  f.role = role; expect((await GET(request())).status).toBe(403); expect(f.selects).toHaveLength(0);
 });
 it('denies AAL1 and invalid or absent sessions before reading orders', async () => {
  f.aal = 'aal1'; expect((await GET(request())).status).toBe(403);
  f.aal = 'aal2'; f.valid = false; expect((await GET(request())).status).toBe(403);
  expect((await GET(request('', false))).status).toBe(403); expect(f.selects).toHaveLength(0);
 });
 it('validates IDs and distinguishes absent records from failures', async () => {
  expect((await GET(request('?orderId=bad'))).status).toBe(400);
  expect((await GET(request('?orderId=22222222-2222-4222-8222-222222222222'))).status).toBe(404);
  f.fail = 'orders'; const res = await GET(request()); expect(res.status).toBe(503); expect(JSON.stringify(await res.json())).not.toContain('internal secret');
 });
 it('binds item reads to the chosen order and maps product names', async () => {
  f.items.push({ ...f.items[0], id: 'other', order_id: 'other-order' });
  const res = await GET(request(`?orderId=${id}`)); const body = await res.json();
  expect(body.data.items).toHaveLength(1); expect(body.data.items[0]).toMatchObject({ product_name: 'Widget', quantity: 2, unit_price: 50 });
  expect(f.selects.every(s => !s.columns.includes('*'))).toBe(true);
 });
 it('reads item pages beyond the default batch instead of dropping lines', async () => {
  f.items = Array.from({ length: 501 }, (_, i) => ({ ...f.items[0], id: `line-${i}` }));
  const res = await GET(request(`?orderId=${id}`)); expect((await res.json()).data.items).toHaveLength(501);
 });
 for (const table of ['countries', 'order_items']) it(`reports ${table} failure explicitly`, async () => {
  f.fail = table; expect((await GET(request(`?orderId=${id}`))).status).toBe(503);
 });
 it('discloses capped list and preserves zero values', async () => {
  f.orders = Array.from({ length: 501 }, () => ({ ...row(), total_amount: 0 })); const res = await GET(request()); const body = await res.json();
  expect(body.data).toHaveLength(500); expect(body.truncated).toBe(true); expect(body.data[0].total_amount).toBe(0);
 });
 it('uses the same CORS policy for preflight and excludes mutation methods', async () => {
  const res = await OPTIONS(request()); expect(res.status).toBe(204); expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
 });
});
