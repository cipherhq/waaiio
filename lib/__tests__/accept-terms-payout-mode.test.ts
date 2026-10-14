/**
 * accept-terms route: payout_mode write uses service client after ownership check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

function makeReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/payouts/accept-terms', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
  });
}

describe('POST /api/payouts/accept-terms', () => {
  let serviceUpdateCalls: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.resetModules();
    serviceUpdateCalls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setup(opts: { isOwner: boolean }) {
    // Session client (RLS-scoped)
    const sessionFrom = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, any> = {};
      ['select', 'eq', 'single', 'insert'].forEach(m => { chain[m] = vi.fn().mockReturnValue(chain); });
      if (table === 'businesses') {
        chain.single = vi.fn().mockResolvedValue({
          data: opts.isOwner ? { id: 'biz-1' } : null,
          error: null,
        });
      }
      if (table === 'payout_terms_acceptance') {
        chain.insert = vi.fn().mockResolvedValue({ data: {}, error: null });
      }
      return chain;
    });

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
        from: sessionFrom,
      }),
    }));

    // Service client — captures update calls
    const serviceFrom = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, any> = {};
      ['select', 'eq', 'single'].forEach(m => { chain[m] = vi.fn().mockReturnValue(chain); });
      chain.update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        serviceUpdateCalls.push({ table, ...payload });
        return { eq: vi.fn().mockResolvedValue({ data: {}, error: null }) };
      });
      return chain;
    });

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({ from: serviceFrom }),
    }));

    vi.doMock('@/lib/logger', () => ({
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    }));
  }

  it('owner accepting terms with platform_managed → 200 and service client is used', async () => {
    setup({ isOwner: true });
    const { POST } = await import('@/app/api/payouts/accept-terms/route');
    const res = await POST(makeReq({ business_id: 'biz-1', payout_mode: 'platform_managed' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // The service client (not session) was used for the payout_mode update
    expect(serviceUpdateCalls).toHaveLength(1);
    expect(serviceUpdateCalls[0]).toMatchObject({ table: 'businesses', payout_mode: 'platform_managed' });
  });

  it('non-owner → 403', async () => {
    setup({ isOwner: false });
    const { POST } = await import('@/app/api/payouts/accept-terms/route');
    const res = await POST(makeReq({ business_id: 'biz-1', payout_mode: 'platform_managed' }));

    expect(res.status).toBe(403);
    // Service client must NOT be called
    expect(serviceUpdateCalls).toHaveLength(0);
  });
});
