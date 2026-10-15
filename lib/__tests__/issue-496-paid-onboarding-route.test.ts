import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  userId: '11111111-1111-4111-8111-111111111111',
  businessId: '22222222-2222-4222-8222-222222222222',
  subscriptionId: '33333333-3333-4333-8333-333333333333',
  paymentId: '44444444-4444-4444-8444-444444444444',
  configId: '55555555-5555-4555-8555-555555555555',
  events: [] as string[],
  authFrom: vi.fn(),
  serviceFrom: vi.fn(),
  rpc: vi.fn(),
  finalize: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: state.userId, email: 'owner@example.com' } },
        error: null,
      }),
    },
    from: (...args: unknown[]) => state.authFrom(...args),
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (...args: unknown[]) => state.serviceFrom(...args),
    rpc: (...args: unknown[]) => state.rpc(...args),
  }),
}));

vi.mock('@/lib/onboarding/finalize', () => ({
  finalizeOnboarding: (...args: unknown[]) => state.finalize(...args),
}));

import { POST } from '@/app/api/onboarding/verify/route';

type Result = { data?: unknown; error?: unknown };

function chain(result: Result, onEq?: (column: string, value: unknown) => void) {
  const q = {
    select: () => q,
    eq: (column: string, value: unknown) => {
      onEq?.(column, value);
      return q;
    },
    lte: () => q,
    order: () => q,
    limit: () => q,
    single: async () => result,
    then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

function setupService(activationResult: Record<string, unknown>) {
  state.events = [];
  state.finalize.mockResolvedValue(undefined);

  state.authFrom.mockImplementation((table: string) => {
    expect(table).toBe('businesses');
    return chain({
      data: { owner_id: state.userId, subscription_tier: 'free' },
      error: null,
    });
  });

  state.serviceFrom.mockImplementation((table: string) => {
    if (table === 'business_capabilities') {
      return chain({
        data: [{ capability: 'payment', is_enabled: true }],
        error: null,
      });
    }

    if (table === 'subscriptions') {
      return {
        select: () => chain({
          data: null,
          error: { code: 'PGRST116', message: 'no rows' },
        }),
        upsert: () => chain({
          data: { id: state.subscriptionId },
          error: null,
        }),
      };
    }

    if (table === 'platform_config_versions') {
      return chain({ data: { id: state.configId }, error: null });
    }

    if (table === 'subscription_payments') {
      return {
        insert: () => chain({ data: { id: state.paymentId }, error: null }),
      };
    }

    if (table === 'businesses') {
      return {
        update: (values: Record<string, unknown>) => {
          if (values.status === 'active') {
            state.events.push('business:active');
          }
          return chain({ error: null }, (column, value) => {
            if (column === 'status') expect(value).toBe('pending');
          });
        },
        select: () => chain({
          data: { bot_code: 'TESTBIZ', slug: 'testbiz' },
          error: null,
        }),
      };
    }

    throw new Error(`Unexpected service table: ${table}`);
  });

  state.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    expect(fn).toBe('activate_paid_subscription');
    expect(args).toEqual({ p_payment_id: state.paymentId });
    state.events.push('rpc:activate');
    return { data: activationResult, error: null };
  });
}

function paystackResponse() {
  return {
    data: {
      status: 'success',
      amount: 1_499_900,
      currency: 'NGN',
      paid_at: '2026-10-01T03:00:00.000Z',
      created_at: '2026-10-01T02:59:00.000Z',
      metadata: {
        type: 'whatsapp_subscription',
        business_id: state.businessId,
        plan: 'growth',
        billing_interval: 'month',
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAYSTACK_SECRET_KEY = 'test-paystack-key';
  vi.stubGlobal('fetch', vi.fn(async () => ({
    json: async () => paystackResponse(),
  })));
});

describe('#496 paid onboarding production orchestration', () => {
  it('runs activation authority before transitioning pending business to active', async () => {
    setupService({ activated: true, allowance_granted: false, reason: 'channel_not_ready' });

    const request = new NextRequest('http://localhost/api/onboarding/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: 'paystack-ref-496' }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'success',
      business_id: state.businessId,
      plan: 'growth',
      bot_code: 'TESTBIZ',
    });
    expect(state.events).toEqual(['rpc:activate', 'business:active']);
  });

  it('fails closed and never activates the business when authority rejects payment evidence', async () => {
    setupService({ activated: false, reason: 'amount_mismatch' });

    const request = new NextRequest('http://localhost/api/onboarding/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: 'paystack-ref-496-rejected' }),
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain('amount_mismatch');
    expect(state.events).toEqual(['rpc:activate']);
  });
});
