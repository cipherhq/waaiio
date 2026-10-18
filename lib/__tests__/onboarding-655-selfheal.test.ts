/**
 * PR #655 regression: free-plan self-healing success path.
 *
 * Proves:
 * TEST 5: initial update fails (CHECK constraint) → self-heal allocates → retry succeeds → 200
 * TEST 6: initial update fails → self-heal allocates → retry also fails → 500 recoverable
 * This ensures the selfHealed flag prevents a false 500 after successful retry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let businessUpdateCalls = 0;
let businessUpdateResults: Array<{ error: unknown }> = [];

const mockGetUser = vi.fn();
const mockAuthFrom = vi.fn();
const mockServiceFrom = vi.fn();
const mockServiceRpc = vi.fn();
const mockFinalize = vi.fn();
const mockAllocate = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
    from: mockAuthFrom,
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
    rpc: mockServiceRpc,
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
  }),
}));

vi.mock('@/lib/onboarding/finalize', () => ({
  finalizeOnboarding: (...args: unknown[]) => mockFinalize(...args),
}));

vi.mock('@/lib/constants', () => ({
  PRICING_TIERS: { free: { price: 0 }, growth: { price: 9900 }, business: { price: 29900 } },
}));

vi.mock('@/lib/onboarding/whatsapp-readiness', () => ({
  allocateSharedChannelWithFallback: (...args: unknown[]) => mockAllocate(...args),
}));

vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn().mockResolvedValue({ error: null }) }));

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/onboarding/verify'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PR #655 regression: free-plan self-healing success path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    businessUpdateCalls = 0;
    businessUpdateResults = [];
    mockFinalize.mockResolvedValue(undefined);
    mockServiceRpc.mockResolvedValue({ data: null, error: null });
    mockAllocate.mockResolvedValue({
      data: { allocated: true, channel_id: 'ch-1', channel_country: 'NG', fallback_used: false },
      error: null,
    });

    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.com' } } });
    mockAuthFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { owner_id: 'user-1', subscription_tier: 'free' }, error: null }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) };
    });
  });

  function setupServiceFrom(firstUpdateFails: boolean, secondUpdateFails: boolean) {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'business_capabilities') {
        return {
          select: () => ({
            eq: () => Promise.resolve({
              data: [{ capability: 'scheduling', is_enabled: true }],
              error: null,
            }),
          }),
        };
      }
      if (table === 'subscriptions') {
        return {
          upsert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: 'sub-1' }, error: null }),
            }),
          }),
        };
      }
      if (table === 'businesses') {
        return {
          update: (data: unknown) => {
            const callIdx = businessUpdateCalls++;
            const error = callIdx === 0
              ? (firstUpdateFails ? { code: '23514', message: 'chk_shared_requires_channel' } : null)
              : (secondUpdateFails ? { code: '23514', message: 'chk_shared_requires_channel' } : null);
            businessUpdateResults.push({ error });
            return { eq: () => Promise.resolve({ error }) };
          },
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({
                data: { country_code: 'NG', wa_method: 'shared', assigned_channel_id: null },
                error: null,
              }),
              single: () => Promise.resolve({ data: { bot_code: 'TEST', slug: 'test' }, error: null }),
            }),
          }),
        };
      }
      if (table === 'admin_onboarding_invites') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
        upsert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    });
  }

  it('TEST 5: first update fails → self-heal allocates → retry succeeds → 200 success (not false 500)', async () => {
    setupServiceFrom(/* firstFails */ true, /* secondFails */ false);

    const { POST } = await import('@/app/api/onboarding/verify/route');
    const res = await POST(makeRequest({ business_id: 'biz-1', plan: 'free' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');
    expect(body.bot_code).toBe('TEST');

    // Verify self-healing was invoked
    expect(mockAllocate).toHaveBeenCalledOnce();
    // Verify two business update calls: first failed, second succeeded
    expect(businessUpdateCalls).toBe(2);
    expect(businessUpdateResults[0].error).not.toBeNull();
    expect(businessUpdateResults[1].error).toBeNull();
  });

  it('TEST 6: first update fails → self-heal allocates → retry also fails → 500 recoverable', async () => {
    setupServiceFrom(/* firstFails */ true, /* secondFails */ true);

    const { POST } = await import('@/app/api/onboarding/verify/route');
    const res = await POST(makeRequest({ business_id: 'biz-1', plan: 'free' }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.recoverable).toBe(true);
    expect(body.message).toContain('WhatsApp channel routing');
  });

  it('TEST 7: first update succeeds (no CHECK failure) → 200 immediately, no self-healing', async () => {
    setupServiceFrom(/* firstFails */ false, /* secondFails */ false);

    const { POST } = await import('@/app/api/onboarding/verify/route');
    const res = await POST(makeRequest({ business_id: 'biz-1', plan: 'free' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');

    // Self-healing was NOT invoked — first update worked
    expect(mockAllocate).not.toHaveBeenCalled();
    expect(businessUpdateCalls).toBe(1);
  });
});
