/**
 * Onboarding /api/onboarding/verify activation-invariant tests.
 *
 * Proves:
 * 1. Zero capability rows → 400 recoverable, no activation
 * 2. finalizeOnboarding failure → 500 recoverable, no activation
 * 3. Valid setup → activation succeeds with trusted DB capabilities
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Track mutations ──
let subscriptionUpserts: unknown[] = [];
let paymentInserts: unknown[] = [];
let businessUpdates: unknown[] = [];
let finalizeArgs: unknown[] = [];

const mockGetUser = vi.fn();
const mockAuthFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
    from: mockAuthFrom,
  }),
}));

const mockServiceFrom = vi.fn();
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
  }),
}));

const mockFinalize = vi.fn();
vi.mock('@/lib/onboarding/finalize', () => ({
  finalizeOnboarding: (...args: unknown[]) => {
    finalizeArgs.push(args);
    return mockFinalize(...args);
  },
}));

vi.mock('@/lib/constants', () => ({
  PRICING_TIERS: { free: { price: 0 }, growth: { price: 9900 }, business: { price: 29900 } },
}));

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/onboarding/verify'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/onboarding/verify — activation invariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptionUpserts = [];
    paymentInserts = [];
    businessUpdates = [];
    finalizeArgs = [];
    mockFinalize.mockResolvedValue(undefined);

    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.com' } } });

    // Default: business owned by user, pending
    mockAuthFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({
                data: { owner_id: 'user-1', subscription_tier: 'free' },
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) };
    });

    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'business_capabilities') {
        return {
          select: () => ({
            eq: () => Promise.resolve({
              data: [{ capability: 'scheduling', is_enabled: true }, { capability: 'payment', is_enabled: true }],
              error: null,
            }),
          }),
        };
      }
      if (table === 'subscriptions') {
        return {
          upsert: (data: unknown) => {
            subscriptionUpserts.push(data);
            return { select: () => ({ single: () => Promise.resolve({ data: { id: 'sub-1' }, error: null }) }) };
          },
        };
      }
      if (table === 'subscription_payments') {
        return {
          insert: (data: unknown) => {
            paymentInserts.push(data);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === 'businesses') {
        return {
          update: (data: unknown) => {
            businessUpdates.push(data);
            return { eq: () => Promise.resolve({ error: null }) };
          },
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { bot_code: 'TEST', slug: 'test' }, error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
        upsert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
        insert: () => Promise.resolve({ error: null }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    });
  });

  it('TEST 1: zero capability rows → 400 recoverable, no activation', async () => {
    // Override: no capability rows
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'business_capabilities') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }
      return {
        upsert: (data: unknown) => { subscriptionUpserts.push(data); return { select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }; },
        insert: (data: unknown) => { paymentInserts.push(data); return Promise.resolve({ error: null }); },
        update: (data: unknown) => { businessUpdates.push(data); return { eq: () => Promise.resolve({ error: null }) }; },
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
      };
    });

    const { POST } = await import('@/app/api/onboarding/verify/route');
    const res = await POST(makeRequest({ business_id: 'biz-1', plan: 'free' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.recoverable).toBe(true);
    expect(body.message).toContain('setup incomplete');

    // No mutations occurred
    expect(finalizeArgs).toHaveLength(0);
    expect(subscriptionUpserts).toHaveLength(0);
    expect(paymentInserts).toHaveLength(0);
    expect(businessUpdates).toHaveLength(0);
  });

  it('TEST 2: finalizeOnboarding throws → 500 recoverable, no activation', async () => {
    mockFinalize.mockRejectedValue(new Error('Profile read failed'));

    const { POST } = await import('@/app/api/onboarding/verify/route');
    const res = await POST(makeRequest({ business_id: 'biz-1', plan: 'free' }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.recoverable).toBe(true);

    // finalizeOnboarding was called (with trusted DB caps)
    expect(finalizeArgs).toHaveLength(1);
    // But no subscription/activation mutations occurred
    expect(subscriptionUpserts).toHaveLength(0);
    expect(paymentInserts).toHaveLength(0);
    expect(businessUpdates).toHaveLength(0);
  });

  it('TEST 3: valid setup → activation succeeds, trusted DB capabilities used', async () => {
    const { POST } = await import('@/app/api/onboarding/verify/route');
    const res = await POST(makeRequest({ business_id: 'biz-1', plan: 'free' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('success');

    // finalizeOnboarding called with trusted caps from DB (not from request)
    expect(finalizeArgs).toHaveLength(1);
    const [_service, params] = finalizeArgs[0] as [unknown, { capabilities: string[] }];
    expect(params.capabilities).toEqual(['scheduling', 'payment']);

    // Business was activated
    expect(businessUpdates.length).toBeGreaterThan(0);
    const activationUpdate = businessUpdates.find((u: any) => u.status === 'active');
    expect(activationUpdate).toBeDefined();
  });
});
