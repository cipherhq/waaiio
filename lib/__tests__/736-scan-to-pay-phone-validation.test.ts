/**
 * #736 Lane 2 — Scan-to-pay checkout phone validation.
 *
 * Covers:
 * 1. Missing phone with Paystack gateway → 422 PHONE_REQUIRED, no payment record
 * 2. Invalid phone (non-E.164) with Paystack gateway → 422 PHONE_REQUIRED
 * 3. Valid E.164 phone with Paystack gateway → gateway initializes, returns URL
 * 4. Missing phone with Stripe gateway → allowed (Stripe does not require phone)
 * 5. Gateway init failure → 500 error, no orphaned payment record
 * 6. Empty-string phone (the original bug) → 422 PHONE_REQUIRED
 * 7. Phone with formatting (spaces, dashes) → normalized and accepted
 * 8. Fixed amount link → amount mismatch rejected
 * 9. Variable amount link → custom amount accepted
 * 10. Max uses reached → 410 returned
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest, NextResponse } from 'next/server';

// ─── Shared mock infrastructure ───

let routeModule: any;

const mockSingle = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockRpc = vi.fn();

/** Tracks all insert calls to detect orphaned payment records. */
let insertCalls: Array<{ table: string; data: unknown }> = [];

function buildChainable(overrides?: Record<string, unknown>) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'order', 'limit', 'is']) {
    q[m] = vi.fn().mockReturnValue(q);
  }
  q.single = mockSingle;
  q.maybeSingle = mockSingle;
  if (overrides) Object.assign(q, overrides);
  return q;
}

function makeMockSupabase() {
  const fromFn = vi.fn().mockImplementation((table: string) => {
    const chain = buildChainable();

    // Track inserts
    const wrappedInsert = vi.fn().mockImplementation((data: unknown) => {
      insertCalls.push({ table, data });
      return buildChainable();
    });

    const wrappedUpdate = vi.fn().mockImplementation(() => {
      return buildChainable();
    });

    return {
      select: vi.fn().mockReturnValue(chain),
      insert: wrappedInsert,
      update: wrappedUpdate,
      eq: vi.fn().mockReturnValue(chain),
    };
  });

  return {
    from: fromFn,
    rpc: mockRpc.mockReturnValue(Promise.resolve({ error: null })),
  };
}

// ─── Mock gateway init function for test control ───
const mockInitializePayment = vi.fn();

// Standard payment link data for a Paystack (NG) business
const PAYSTACK_LINK = {
  id: 'link-001',
  title: 'Test Payment',
  amount: null, // variable amount
  currency: 'NGN',
  uses_count: 0,
  expires_at: null,
  max_uses: null,
  business_id: 'biz-001',
  is_active: true,
  businesses: {
    name: 'Test Shop',
    country_code: 'NG',
    payment_gateway: 'paystack',
    status: 'active',
  },
};

// Standard payment link data for a Stripe (US) business
const STRIPE_LINK = {
  ...PAYSTACK_LINK,
  id: 'link-002',
  currency: 'USD',
  business_id: 'biz-002',
  businesses: {
    name: 'US Shop',
    country_code: 'US',
    payment_gateway: 'stripe',
    status: 'active',
  },
};

// Fixed-amount link
const FIXED_AMOUNT_LINK = {
  ...PAYSTACK_LINK,
  id: 'link-003',
  amount: 5000,
};

// Max-uses-reached link
const MAX_USES_LINK = {
  ...PAYSTACK_LINK,
  id: 'link-004',
  max_uses: 1,
  uses_count: 1,
};

beforeEach(async () => {
  vi.resetModules();
  insertCalls = [];
  mockSingle.mockReset();
  mockInitializePayment.mockReset();
  mockRpc.mockReset();
  mockRpc.mockReturnValue(Promise.resolve({ error: null }));

  // Mock rate limiter
  vi.doMock('@/lib/rate-limit', () => ({
    rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
    getRateLimitKey: vi.fn().mockReturnValue('test-key'),
  }));

  // Mock logger
  vi.doMock('@/lib/logger', () => ({
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      withContext: vi.fn().mockReturnValue({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
    },
  }));

  // Mock supabase service client
  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: () => makeMockSupabase(),
  }));

  // Mock gateway resolver
  vi.doMock('@/lib/payments/gateway-resolver', () => ({
    resolveBusinessGateway: vi.fn().mockImplementation((_supabase: unknown, businessId: string) => {
      if (businessId === 'biz-002') {
        return Promise.resolve({ gateway: 'stripe', currency: 'USD', source: 'country_default' });
      }
      return Promise.resolve({ gateway: 'paystack', currency: 'NGN', source: 'country_default' });
    }),
  }));

  // Mock payment factory
  vi.doMock('@/lib/payments/factory', () => ({
    getPaymentGatewayByName: vi.fn().mockReturnValue({
      name: 'paystack',
      initializePayment: mockInitializePayment,
    }),
  }));

  routeModule = await import('@/app/api/pay-link/pay/route');
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makePostRequest(body: Record<string, unknown>): NextRequest {
  const { NextRequest: NR } = require('next/server');
  return new NR(new URL('https://www.waaiio.com/api/pay-link/pay'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Configure the Supabase .single() mock to return a specific payment link. */
function mockPaymentLink(link: any) {
  mockSingle.mockResolvedValueOnce({ data: link, error: link ? null : { code: 'PGRST116' } });
}

// ─── Tests ───

describe('#736 scan-to-pay phone validation — Paystack gateway', () => {
  it('rejects missing phone with 422 PHONE_REQUIRED and creates no payment record', async () => {
    mockPaymentLink(PAYSTACK_LINK);

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 1000,
      customer_name: 'Test User',
      // no customer_phone
    }));

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.code).toBe('PHONE_REQUIRED');
    expect(data.error).toContain('phone number');

    // No payment record should have been created
    const paymentInserts = insertCalls.filter(c => c.table === 'payments');
    expect(paymentInserts).toHaveLength(0);
  });

  it('rejects empty-string phone (original bug) with 422 PHONE_REQUIRED', async () => {
    mockPaymentLink(PAYSTACK_LINK);

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 1000,
      customer_name: 'Test User',
      customer_phone: '',
    }));

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.code).toBe('PHONE_REQUIRED');
  });

  it('rejects invalid phone (no country code) with 422 PHONE_REQUIRED', async () => {
    mockPaymentLink(PAYSTACK_LINK);

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 1000,
      customer_name: 'Test User',
      customer_phone: '08012345678', // Nigerian local format, not E.164
    }));

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.code).toBe('PHONE_REQUIRED');
    expect(data.error).toContain('international format');
  });

  it('rejects whitespace-only phone with 422 PHONE_REQUIRED', async () => {
    mockPaymentLink(PAYSTACK_LINK);

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 1000,
      customer_name: 'Test User',
      customer_phone: '   ',
    }));

    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.code).toBe('PHONE_REQUIRED');
  });

  it('accepts valid E.164 phone and initializes payment', async () => {
    mockPaymentLink(PAYSTACK_LINK);
    mockInitializePayment.mockResolvedValueOnce({
      url: 'https://checkout.paystack.com/test',
      reference: 'PL-TEST123',
    });

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 1000,
      customer_name: 'Test User',
      customer_phone: '+2348012345678',
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toBe('https://checkout.paystack.com/test');

    // Verify phone was passed to gateway
    expect(mockInitializePayment).toHaveBeenCalledTimes(1);
    const initOpts = mockInitializePayment.mock.calls[0][0];
    expect(initOpts.phone).toBe('+2348012345678');
  });

  it('normalizes phone with spaces and dashes before passing to gateway', async () => {
    mockPaymentLink(PAYSTACK_LINK);
    mockInitializePayment.mockResolvedValueOnce({
      url: 'https://checkout.paystack.com/test',
      reference: 'PL-TEST456',
    });

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 1000,
      customer_name: 'Test User',
      customer_phone: '+234 801-234-5678',
    }));

    expect(res.status).toBe(200);
    const initOpts = mockInitializePayment.mock.calls[0][0];
    expect(initOpts.phone).toBe('+2348012345678');
  });

  it('normalizes phone without + prefix', async () => {
    mockPaymentLink(PAYSTACK_LINK);
    mockInitializePayment.mockResolvedValueOnce({
      url: 'https://checkout.paystack.com/test',
      reference: 'PL-TEST789',
    });

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 1000,
      customer_name: 'Test User',
      customer_phone: '2348012345678',
    }));

    expect(res.status).toBe(200);
    const initOpts = mockInitializePayment.mock.calls[0][0];
    expect(initOpts.phone).toBe('+2348012345678');
  });
});

describe('#736 scan-to-pay phone validation — Stripe gateway', () => {
  it('allows missing phone for Stripe-routed businesses', async () => {
    mockPaymentLink(STRIPE_LINK);
    mockInitializePayment.mockResolvedValueOnce({
      url: 'https://checkout.stripe.com/test',
      reference: 'PL-STRIPE1',
    });

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 1000,
      customer_name: 'Test User',
      // no customer_phone — should be allowed for Stripe
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.url).toBe('https://checkout.stripe.com/test');
  });
});

describe('#736 scan-to-pay — gateway init failure with no orphaned record', () => {
  it('returns 500 on gateway init failure with no orphaned pending payment', async () => {
    mockPaymentLink(PAYSTACK_LINK);
    // Gateway returns null (init failure)
    mockInitializePayment.mockResolvedValueOnce(null);

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 1000,
      customer_name: 'Test User',
      customer_phone: '+2348012345678',
    }));

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('initialize payment');

    // The route should NOT have created a payment record itself.
    // The gateway may have created one internally, but the route's
    // pre-gateway insert (the source of orphans) is removed.
    const routePaymentInserts = insertCalls.filter(
      c => c.table === 'payments',
    );
    // Zero from the route; gateway internal inserts tracked separately
    expect(routePaymentInserts).toHaveLength(0);
  });

  it('returns 500 on gateway init exception', async () => {
    mockPaymentLink(PAYSTACK_LINK);
    mockInitializePayment.mockRejectedValueOnce(new Error('Network timeout'));

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 1000,
      customer_name: 'Test User',
      customer_phone: '+2348012345678',
    }));

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('unavailable');
  });
});

describe('#736 scan-to-pay — amount and usage validation', () => {
  it('rejects amount mismatch on fixed-amount link', async () => {
    mockPaymentLink(FIXED_AMOUNT_LINK);

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 9999, // link.amount is 5000
      customer_name: 'Test User',
      customer_phone: '+2348012345678',
    }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('mismatch');
  });

  it('accepts matching amount on fixed-amount link', async () => {
    mockPaymentLink(FIXED_AMOUNT_LINK);
    mockInitializePayment.mockResolvedValueOnce({
      url: 'https://checkout.paystack.com/test',
      reference: 'PL-FIXED1',
    });

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 5000,
      customer_name: 'Test User',
      customer_phone: '+2348012345678',
    }));

    expect(res.status).toBe(200);
  });

  it('rejects payment when max uses reached', async () => {
    mockPaymentLink(MAX_USES_LINK);

    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: 1000,
      customer_name: 'Test User',
      customer_phone: '+2348012345678',
    }));

    expect(res.status).toBe(410);
    const data = await res.json();
    expect(data.error).toContain('usage limit');
  });

  it('rejects missing token', async () => {
    const res = await routeModule.POST(makePostRequest({
      amount: 1000,
      customer_name: 'Test User',
    }));

    expect(res.status).toBe(400);
  });

  it('rejects invalid amount', async () => {
    const res = await routeModule.POST(makePostRequest({
      token: 'abc123',
      amount: -100,
      customer_name: 'Test User',
    }));

    expect(res.status).toBe(400);
  });
});
