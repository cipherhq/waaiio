import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), auth: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ rpc: h.rpc, from: h.from }) }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: h.auth }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn(async () => null),
  getRateLimitKey: vi.fn(() => 'test-key'),
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));

function request(points: unknown, idempotency?: string) {
  return new NextRequest('http://localhost/api/loyalty/redeem', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idempotency ? { 'Idempotency-Key': idempotency } : {}),
    },
    body: JSON.stringify({
      businessId: 'biz-1', customerPhone: '+2341234567890', points,
    }),
  });
}
const KEY = '11111111-1111-4111-8111-111111111111';

describe('#598 authenticated owner redemption API using M434 atomic receipt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.auth.mockResolvedValue({ businessId: 'biz-1' });
    h.rpc.mockResolvedValue({ data: { success: true, code: 'RW-ABC234', points_balance: 400, replayed: false }, error: null });
    h.from.mockImplementation(() => {
      const chain: Record<string, any> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.single = vi.fn(async () => ({ data: { id: 'loy-1', points_balance: 600 }, error: null }));
      return chain;
    });
  });
  it('requires stable caller-owned idempotency UUID', async () => {
    const { POST } = await import('@/app/api/loyalty/redeem/route');
    const response = await POST(request(200));
    expect(response.status).toBe(428);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each([0, -4, 1.5, '200', null])('rejects invalid integer points: %j', async points => {
    const { POST } = await import('@/app/api/loyalty/redeem/route');
    expect((await POST(request(points, KEY))).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('returns the persisted code and DB balance, not stale local arithmetic', async () => {
    const { POST } = await import('@/app/api/loyalty/redeem/route');
    const response = await POST(request(200, KEY));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, redemption_code: 'RW-ABC234', new_balance: 400, replayed: false });
    expect(h.rpc).toHaveBeenCalledWith('redeem_loyalty_reward_once', expect.objectContaining({
      p_redemption_key: 'api:' + KEY, p_loyalty_id: 'loy-1', p_points: 200,
    }));
    expect(h.from).toHaveBeenCalledTimes(1);
  });
  it('denies insufficient points without issuing a reward', async () => {
    h.rpc.mockResolvedValue({ data: { success: false, reason: 'insufficient_points' }, error: null });
    const { POST } = await import('@/app/api/loyalty/redeem/route');
    const r = await POST(request(200, KEY));
    expect(r.status).toBe(400);
    expect((await r.json()).success).not.toBe(true);
  });
  it('returns 503 for an atomic transaction failure; cannot report success', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'duplicate receipt' } });
    const { POST } = await import('@/app/api/loyalty/redeem/route');
    expect((await POST(request(200, KEY))).status).toBe(503);
  });
  it.each(['------------------------------------', '11111111-1111-1111-1111-111111111111', 'not-a-uuid'])(
    'rejects malformed Idempotency-Key %s before calling the RPC', async badKey => {
      const { POST } = await import('@/app/api/loyalty/redeem/route');
      expect((await POST(request(200, badKey))).status).toBe(428);
      expect(h.rpc).not.toHaveBeenCalled();
    },
  );
  it.each([
    { success: true, points_balance: 400 },
    { success: true, code: 'RW-INVALID', points_balance: 400 },
    { success: true, code: 'RW-ABC234', points_balance: -1 },
  ])('fails closed if an atomic successful debit has no valid durable receipt (%j)', async receipt => {
    h.rpc.mockResolvedValue({ data: receipt, error: null });
    const { POST } = await import('@/app/api/loyalty/redeem/route');
    const response = await POST(request(200, KEY));
    expect(response.status).toBe(503);
    expect((await response.json()).success).not.toBe(true);
  });

  it('preserves a code on idempotent replay', async () => {
    h.rpc.mockResolvedValue({ data: { success: true, code: 'RW-ABC234', points_balance: 400, replayed: true }, error: null });
    const { POST } = await import('@/app/api/loyalty/redeem/route');
    const r = await POST(request(200, KEY));
    expect((await r.json()).replayed).toBe(true);
  });
});
