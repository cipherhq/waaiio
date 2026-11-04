import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const state = vi.hoisted(() => ({ user: { id: 'owner-1' } as { id: string } | null, owned: true, resolved: null as unknown, resolveCalls: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => {
      const c: Record<string, any> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.maybeSingle = async () => ({ data: state.owned ? { id: 'biz-1' } : null, error: null });
      return c;
    },
  }),
}));
vi.mock('@/app/m/resolve', () => ({
  resolveBusinessChannel: async (key: string) => { state.resolveCalls.push(key); return state.resolved; },
}));
const { GET } = await import('../route');
const req = (q = '?business_id=biz-1') => new NextRequest('https://www.waaiio.com/api/whatsapp/direct-link' + q);

beforeEach(() => { state.user = { id: 'owner-1' }; state.owned = true; state.resolveCalls = []; state.resolved = { verifiedLink: 'https://wa.me/2349037564008?text=CITADEL' }; });

describe('GET /api/whatsapp/direct-link', () => {
  it('returns the verified wa.me link for the owner, uncached', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ link: 'https://wa.me/2349037564008?text=CITADEL' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(state.resolveCalls).toEqual(['biz-1']);
  });
  it('returns null when the server readiness check fails', async () => {
    state.resolved = NextResponse.json({}, { status: 503 });
    expect(await (await GET(req())).json()).toEqual({ link: null });
  });
  it('requires sign-in', async () => {
    state.user = null;
    expect((await GET(req())).status).toBe(401);
    expect(state.resolveCalls).toEqual([]);
  });
  it('requires a business id', async () => {
    expect((await GET(req(''))).status).toBe(400);
  });
  it('never resolves a business the caller does not own', async () => {
    state.owned = false;
    expect((await GET(req())).status).toBe(404);
    expect(state.resolveCalls).toEqual([]);
  });
});
