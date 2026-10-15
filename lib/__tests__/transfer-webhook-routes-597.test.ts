/**
 * #597: Real signed Paystack/Stripe webhook POST tests.
 * Imports production Next.js handlers with a coherent Supabase/RPC mock.
 * No provider API requests or database writes are made by these tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'crypto';

type Options = {
  status?: string;
  claimReason?: string;
  completeOk?: boolean;
  noPayout?: boolean;
  lookupError?: boolean;
  updateError?: boolean;
};

function configureDatabase(options: Options = {}) {
  const state = {
    status: options.status ?? 'processing',
    updates: [] as Array<Record<string, unknown>>,
    rpcCalls: [] as string[],
  };

  const rpc = vi.fn(async (name: string) => {
    state.rpcCalls.push(name);
    if (name === 'claim_webhook_event') {
      if (options.claimReason) return { data: { claimed: false, reason: options.claimReason }, error: null };
      return { data: { claimed: true, claim_token: 'fencing-token' }, error: null };
    }
    if (name === 'complete_webhook_event') return { data: options.completeOk !== false, error: null };
    if (name === 'fail_webhook_event') return { data: true, error: null };
    throw new Error('Unexpected RPC: ' + name);
  });

  const from = vi.fn((table: string) => {
    if (table === 'business_payouts') {
      let patch: Record<string, unknown> | null = null;
      let allowedStatuses: string[] = [];
      let transferRef: string | null = null;
      const chain = {
        select: vi.fn(() => {
          if (patch) {
            if (options.updateError) return Promise.resolve({ data: null, error: { message: 'DB update unavailable' } });
            if (allowedStatuses.includes(state.status)) {
              state.status = String(patch.status);
              state.updates.push(patch);
              return Promise.resolve({ data: [{ id: 'payout-1' }], error: null });
            }
            return Promise.resolve({ data: [], error: null });
          }
          return chain;
        }),
        eq: vi.fn((field: string, value: string) => {
          if (field === 'gateway_transfer_code') transferRef = value;
          return chain;
        }),
        in: vi.fn((_field: string, statuses: string[]) => {
          allowedStatuses = statuses;
          return chain;
        }),
        update: vi.fn((next: Record<string, unknown>) => {
          patch = next;
          return chain;
        }),
        maybeSingle: vi.fn(async () => {
          if (options.lookupError) return { data: null, error: { code: '42703', message: 'DB lookup failure' } };
          if (options.noPayout || !['tr_test123', 'TRF_test123'].includes(transferRef || '')) {
            return { data: null, error: null };
          }
          return { data: {
            id: 'payout-1', business_id: 'business-1', net_amount: 100,
            status: state.status,
          }, error: null };
        }),
      };
      return chain;
    }

    return {
      select: () => ({ eq: () => ({
        single: async () => ({ data: null, error: null }),
      }) }),
    };
  });

  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: () => ({ from, rpc }),
  }));
  vi.doMock('@/lib/logger', () => ({
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  }));
  vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

  return { state, rpc, from };
}

function stripeBody(type: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'evt_webhook_test',
    type,
    data: { object: {
      id: 'tr_test123', object: 'transfer', amount: 10000,
      amount_reversed: 0, reversed: false, currency: 'usd',
      destination: 'acct_test',
      ...overrides,
    } },
  });
}

async function stripePost(body: string, validSignature = true) {
  const t = Math.floor(Date.now() / 1000).toString();
  const hash = createHmac('sha256', process.env.STRIPE_PAYOUT_WEBHOOK_SECRET!)
    .update(t + '.' + body).digest('hex');
  const signature = validSignature ? 't=' + t + ',v1=' + hash : 't=' + t + ',v1=invalid';
  const { POST } = await import('@/app/api/webhooks/stripe-transfer/route');
  return POST(new NextRequest('http://localhost:3000/api/webhooks/stripe-transfer', {
    method: 'POST', body, headers: { 'stripe-signature': signature },
  }));
}

async function paystackPost(event: string, validSignature = true) {
  const body = JSON.stringify({ event, data: { transfer_code: 'TRF_test123' } });
  const signature = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!)
    .update(body).digest('hex');
  const { POST } = await import('@/app/api/webhooks/paystack-transfer/route');
  return POST(new NextRequest('http://localhost:3000/api/webhooks/paystack-transfer', {
    method: 'POST', body,
    headers: { 'x-paystack-signature': validSignature ? signature : 'not-valid' },
  }));
}

describe('#597: signed production transfer webhook route processing', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.STRIPE_PAYOUT_WEBHOOK_SECRET = 'whsec_route_test_only';
    process.env.PAYSTACK_SECRET_KEY = 'paystack_route_test_only';
  });
  afterEach(() => {
    delete process.env.STRIPE_PAYOUT_WEBHOOK_SECRET;
    delete process.env.PAYSTACK_SECRET_KEY;
    vi.doUnmock('@/lib/supabase/service');
    vi.doUnmock('@/lib/logger');
    vi.doUnmock('@sentry/nextjs');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('Stripe transfer.created is acknowledged without a false paid transition', async () => {
    const db = configureDatabase();
    const res = await stripePost(stripeBody('transfer.created'));
    expect(res.status).toBe(200);
    expect(db.state.status).toBe('processing');
    expect(db.state.updates).toHaveLength(0);
    expect(db.state.rpcCalls).toContain('complete_webhook_event');
  });

  it('Stripe transfer.updated with fabricated paid status never certifies bank payout', async () => {
    const db = configureDatabase();
    const res = await stripePost(stripeBody('transfer.updated', { status: 'paid' }));
    expect(res.status).toBe(200);
    expect(db.state.status).toBe('processing');
    expect(db.state.updates).toHaveLength(0);
  });

  it('Stripe full reversal transitions prior paid payout to failed', async () => {
    const db = configureDatabase({ status: 'paid' });
    const res = await stripePost(stripeBody('transfer.reversed', {
      amount_reversed: 10000, reversed: true,
    }));
    expect(res.status).toBe(200);
    expect(db.state.status).toBe('failed');
    expect(db.state.updates[0].flags).toEqual(expect.arrayContaining([
      expect.stringContaining('fully reversed'),
    ]));
  });

  it('Stripe partial reversal quarantines paid payout, never marks entire amount failed', async () => {
    const db = configureDatabase({ status: 'paid' });
    const res = await stripePost(stripeBody('transfer.reversed', {
      amount_reversed: 2000, reversed: false,
    }));
    expect(res.status).toBe(200);
    expect(db.state.status).toBe('review_required');
    expect(db.state.updates[0].flags).toEqual(expect.arrayContaining([
      expect.stringContaining('partially reversed'),
    ]));
  });

  it('Stripe incomplete reversal amount holds for review instead of full failure', async () => {
    const db = configureDatabase({ status: 'paid' });
    const res = await stripePost(stripeBody('transfer.reversed', {
      amount_reversed: undefined, reversed: false,
    }));
    expect(res.status).toBe(200);
    expect(db.state.status).toBe('review_required');
  });

  it('Stripe invalid HMAC signature returns 401 before claim', async () => {
    const db = configureDatabase();
    const res = await stripePost(stripeBody('transfer.reversed'), false);
    expect(res.status).toBe(401);
    expect(db.state.rpcCalls).toHaveLength(0);
  });

  it('Stripe rejects non-Transfer objects without claim', async () => {
    const db = configureDatabase();
    const res = await stripePost(stripeBody('transfer.created', { object: 'payout' }));
    expect(res.status).toBe(400);
    expect(db.state.rpcCalls).toHaveLength(0);
  });

  it('Stripe ignores unrelated payout.paid object, not a connected Transfer', async () => {
    const db = configureDatabase();
    const res = await stripePost(stripeBody('payout.paid', { object: 'payout', id: 'po_wrong' }));
    expect(res.status).toBe(200);
    expect(db.state.rpcCalls).toHaveLength(0);
    expect(db.state.updates).toHaveLength(0);
  });

  it('Stripe missing payout is retryable and marks claim failed', async () => {
    const db = configureDatabase({ noPayout: true });
    const res = await stripePost(stripeBody('transfer.reversed'));
    expect(res.status).toBe(500);
    expect(db.state.rpcCalls).toContain('fail_webhook_event');
    expect(db.state.rpcCalls).not.toContain('complete_webhook_event');
  });

  it('Stripe lookup SQL error is retryable, never ACKs completion', async () => {
    const db = configureDatabase({ lookupError: true });
    const res = await stripePost(stripeBody('transfer.reversed'));
    expect(res.status).toBe(500);
    expect(db.state.rpcCalls).toContain('fail_webhook_event');
    expect(db.state.rpcCalls).not.toContain('complete_webhook_event');
  });

  it('Stripe active claim returns 503 instead of suppressing retry', async () => {
    const db = configureDatabase({ claimReason: 'active_processing' });
    const res = await stripePost(stripeBody('transfer.reversed'));
    expect(res.status).toBe(503);
    expect(db.state.updates).toHaveLength(0);
  });

  it('Stripe already-completed claim returns 200 without double processing', async () => {
    const db = configureDatabase({ claimReason: 'already_completed' });
    const res = await stripePost(stripeBody('transfer.reversed'));
    expect(res.status).toBe(200);
    expect(db.state.updates).toHaveLength(0);
  });

  it('Stripe complete RPC false does not return 200', async () => {
    const db = configureDatabase({ completeOk: false });
    const res = await stripePost(stripeBody('transfer.created'));
    expect(res.status).toBe(500);
    expect(db.state.status).toBe('processing');
  });

  it('Paystack signed transfer.success updates real handler payout to paid', async () => {
    const db = configureDatabase();
    const res = await paystackPost('transfer.success');
    expect(res.status).toBe(200);
    expect(db.state.status).toBe('paid');
    expect(db.state.rpcCalls).toContain('complete_webhook_event');
  });

  it('Paystack signed reversal after paid transitions to failed', async () => {
    const db = configureDatabase({ status: 'paid' });
    const res = await paystackPost('transfer.reversed');
    expect(res.status).toBe(200);
    expect(db.state.status).toBe('failed');
  });

  it('Paystack rejects forged signature before money state change', async () => {
    const db = configureDatabase();
    const res = await paystackPost('transfer.success', false);
    expect(res.status).toBe(401);
    expect(db.state.rpcCalls).toHaveLength(0);
  });
});
