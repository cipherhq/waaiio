import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const m = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn(), permission: vi.fn(), owner: 'owner', member: null as null | { id: string }, scopes: [] as unknown[][] }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: m.auth }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'key' }));
vi.mock('@/lib/merchants/recipient-permission', () => ({ hasRecipientPermission: m.permission }));
import { GET } from '@/app/api/merchant-recipients/route';
const req = () => new NextRequest('https://example.test/api/merchant-recipients?businessId=biz&q=Sam');
beforeEach(() => {
  vi.clearAllMocks(); m.owner = 'owner'; m.member = null; m.scopes = [];
  m.auth.mockResolvedValue({ user: { id: 'owner' }, service: { from: m.from } });
  m.permission.mockImplementation(async (_db, _biz, phone) => phone === '+12025550123');
  m.from.mockImplementation(table => {
    const data = table === 'businesses' ? { owner_id: m.owner } : table === 'business_members' ? m.member : [{ name: 'Sam', phone: '+12025550123' }, { name: 'Sam revoked', phone: '+12025550124' }];
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'or', 'limit']) chain[method] = (...args: unknown[]) => { m.scopes.push([table, method, ...args]); return chain; };
    chain.maybeSingle = async () => ({ data, error: null });
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
    return chain;
  });
});
it('only returns consented contacts from the authenticated business', async () => {
  const response = await GET(req());
  expect((await response.json()).customers).toEqual([{ name: 'Sam', phone: '+12025550123' }]);
  expect(m.scopes).toContainEqual(['customer_profiles', 'eq', 'business_id', 'biz']);
  expect(m.permission).toHaveBeenCalledWith(expect.anything(), 'biz', '+12025550124', 'utility');
});
it('denies unauthenticated users without reads', async () => {
  m.auth.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
  expect((await GET(req())).status).toBe(401); expect(m.from).not.toHaveBeenCalled();
});
it('denies another merchant before reading contacts', async () => {
  m.owner = 'someone-else';
  expect((await GET(req())).status).toBe(403);
  expect(m.from).not.toHaveBeenCalledWith('customer_profiles');
});
it('allows active team members with the same business scope as chat', async () => {
  m.owner = 'someone-else'; m.member = { id: 'member' };
  expect((await GET(req())).status).toBe(200);
  expect(m.scopes).toContainEqual(['business_members', 'eq', 'status', 'active']);
  expect(m.scopes).toContainEqual(['business_members', 'eq', 'business_id', 'biz']);
});
