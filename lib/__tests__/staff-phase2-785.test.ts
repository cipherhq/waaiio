import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ writes: [] as Array<{ operation: string; value: unknown }>, allowed: true }));
function client() {
  return { auth: { getUser: async () => ({ data: { user: { id: 'owner' } } }) }, from: (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq']) chain[method] = () => chain;
    for (const method of ['insert', 'update', 'delete']) chain[method] = (value: unknown) => { state.writes.push({ operation: method, value }); return chain; };
    const result = { data: table === 'businesses' ? (state.allowed ? { id: 'biz' } : null) : { id: 'staff' }, error: null };
    chain.single = chain.maybeSingle = async () => result;
    chain.then = (resolve: (x: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  } };
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }));
import { POST, PUT, DELETE } from '@/app/api/staff/route';
const request = (body: unknown) => new NextRequest('https://example.test/api/staff', { method: 'POST', body: JSON.stringify(body) });
beforeEach(() => { state.writes = []; state.allowed = true; });
it('creates staff without activating commission', async () => {
  expect((await POST(request({ businessId: 'biz', name: 'Sam' }))).status).toBe(200);
  expect(state.writes[0].value).toMatchObject({ commission_rate: null });
});
it('preserves saved commission when editing other staff details', async () => {
  expect((await PUT(request({ businessId: 'biz', staffId: 'staff', name: 'Sam' }))).status).toBe(200);
  expect(state.writes[0].value).not.toHaveProperty('commission_rate');
});
it.each([POST, PUT])('rejects commission mutation while disabled', async handler => {
  expect((await handler(request({ businessId: 'biz', staffId: 'staff', name: 'Sam', commission_rate: 10 }))).status).toBe(400);
  expect(state.writes).toHaveLength(0);
});
it('staff deletion still works and retains ownership guard', async () => {
  expect((await DELETE(request({ businessId: 'biz', staffId: 'staff' }))).status).toBe(200);
  state.allowed = false; state.writes = [];
  expect((await DELETE(request({ businessId: 'biz', staffId: 'staff' }))).status).toBe(403);
  expect(state.writes).toHaveLength(0);
});
