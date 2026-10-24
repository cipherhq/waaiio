/**
 * Paystack Subscription Lifecycle Webhook Tests
 *
 * Tests for the P0 fix: subscription.create, subscription.not_renew,
 * subscription.disable, and invoice.payment_failed events were silently
 * dropped by the reference guard (webhook/route.ts:55).
 *
 * These events do NOT carry data.reference — they use data.subscription_code.
 * The fix handles them before the reference guard with their own idempotency.
 *
 * Verified against Paystack MCP: subscription events have subscription_code,
 * customer, plan, authorization — but no reference or metadata.type fields.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

// ── Mock infrastructure ──

const upsertCalls: Array<{ table: string; data: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; data: Record<string, unknown>; filters: Record<string, unknown> }> = [];
const selectResults: Record<string, unknown> = {};

function makeChain(resolveData: unknown = null, resolveError: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = ['select', 'eq', 'in', 'maybeSingle', 'single', 'order', 'limit'];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => ({ data: resolveData, error: resolveError }));
  chain.single = vi.fn(async () => ({ data: resolveData, error: resolveError }));
  return chain;
}

const mockSupabase = {
  from: vi.fn((table: string) => {
    const chain = makeChain(selectResults[table] ?? null);
    chain.upsert = vi.fn((data: Record<string, unknown>, opts: Record<string, unknown>) => {
      upsertCalls.push({ table, data });
      return { select: () => ({ single: async () => ({ data: { id: 'evt-1', status: 'processing', attempts: 1 }, error: null }) }) };
    });
    chain.update = vi.fn((data: Record<string, unknown>) => ({
      eq: vi.fn((col: string, val: string) => {
        updateCalls.push({ table, data, filters: { [col]: val } });
        return { eq: vi.fn(() => Promise.resolve({ error: null })) };
      }),
    }));
    return chain;
  }),
};

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => mockSupabase,
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/observability', () => ({
  getRequestId: () => 'test-req-id',
  generateRequestId: () => 'test-req-id',
}));

vi.mock('@/lib/observability/webhooks', () => ({
  createWebhookLogger: () => ({
    rejected: vi.fn(), verified: vi.fn(), received: vi.fn(), ignored: vi.fn(),
    duplicate: vi.fn(), processed: vi.fn(), failed: vi.fn(),
  }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  withScope: vi.fn((fn: (scope: Record<string, unknown>) => void) => fn({ setTag: vi.fn(), setContext: vi.fn() })),
}));

vi.mock('@/lib/payments/webhook-handler', () => ({
  processPaystackChargeSuccess: vi.fn(async () => {}),
  processPaystackChargeFailed: vi.fn(async () => {}),
}));

vi.mock('@/lib/payments/paystack-card-authorization', () => ({
  normalizePaystackCardAuthorization: vi.fn(() => null),
  persistPaystackCardAuthorization: vi.fn(async () => {}),
}));

vi.mock('@/lib/payments/send-confirmation', () => ({
  sendProactiveConfirmation: vi.fn(async () => {}),
}));

vi.mock('@/lib/payments/notify-charge-failed', () => ({
  notifyCustomerChargeFailed: vi.fn(async () => {}),
}));

vi.mock('@/lib/alerts/create-alert', () => ({
  createAlert: vi.fn(async () => {}),
}));

vi.mock('@/lib/email/templates', () => ({
  subscriptionRenewalReceiptEmail: vi.fn(() => ({ subject: '', html: '' })),
}));

vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn(async () => {}),
}));

vi.mock('@/lib/utils/sanitize', () => ({
  sanitizeFilterValue: vi.fn((v: string) => v),
}));

vi.mock('@/lib/payments/charge-role-resolver', () => ({
  resolveChargeRole: vi.fn(async () => ({ ok: true, role: 'A' })),
}));

// Paystack webhook helper
const PAYSTACK_KEY = 'test_hmac_signing_key_not_a_real_secret';
process.env.PAYSTACK_SECRET_KEY = PAYSTACK_KEY;

function makeWebhookRequest(event: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ event, data });
  const signature = createHmac('sha512', PAYSTACK_KEY).update(body).digest('hex');
  return new Request('http://localhost/api/payments/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-paystack-signature': signature,
    },
    body,
  });
}

const { POST } = await import('@/app/api/payments/webhook/route');

beforeEach(() => {
  upsertCalls.length = 0;
  updateCalls.length = 0;
  for (const key of Object.keys(selectResults)) delete selectResults[key];
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════
// subscription.create
// ══════════════════════════════════════════════════════════════

describe('subscription.create webhook', () => {
  it('processes event without data.reference (P0 fix)', async () => {
    selectResults['subscriptions'] = { id: 'sub-1', business_id: 'biz-1' };
    const req = makeWebhookRequest('subscription.create', {
      subscription_code: 'SUB_test_create',
      customer: { customer_code: 'CUS_test', email: 'test@example.com' },
      plan: { plan_code: 'PLN_test' },
      authorization: {},
      // NO reference field — this is the key test
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    // Should have claimed the event
    const claim = upsertCalls.find(c => c.table === 'processed_webhook_events');
    expect(claim).toBeDefined();
    expect(claim!.data.event_id).toBe('paystack-subscription.create-SUB_test_create');
  });

  it('uses subscription_code as idempotency key, not reference', async () => {
    const req = makeWebhookRequest('subscription.create', {
      subscription_code: 'SUB_idem_test',
      customer: { customer_code: 'CUS_idem', email: 'idem@example.com' },
      plan: {},
    });
    await POST(req as never);
    const claim = upsertCalls.find(c => c.table === 'processed_webhook_events');
    expect(claim!.data.event_id).toBe('paystack-subscription.create-SUB_idem_test');
    expect(claim!.data.event_id).not.toContain('undefined');
  });

  it('ignores event without subscription_code', async () => {
    const req = makeWebhookRequest('subscription.create', {
      // no subscription_code
      customer: { customer_code: 'CUS_no_code' },
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    // Should NOT have claimed any event
    expect(upsertCalls.filter(c => c.table === 'processed_webhook_events')).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
// subscription.not_renew
// ══════════════════════════════════════════════════════════════

describe('subscription.not_renew webhook', () => {
  it('processes cancellation event without data.reference', async () => {
    selectResults['subscriptions'] = { id: 'sub-cancel', business_id: 'biz-cancel' };
    const req = makeWebhookRequest('subscription.not_renew', {
      subscription_code: 'SUB_cancel_test',
      customer: { customer_code: 'CUS_cancel' },
      plan: {},
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const claim = upsertCalls.find(c => c.table === 'processed_webhook_events');
    expect(claim!.data.event_id).toBe('paystack-subscription.not_renew-SUB_cancel_test');
  });
});

// ══════════════════════════════════════════════════════════════
// invoice.payment_failed
// ══════════════════════════════════════════════════════════════

describe('invoice.payment_failed webhook', () => {
  it('processes failed payment without data.reference', async () => {
    selectResults['subscriptions'] = { id: 'sub-fail', business_id: 'biz-fail' };
    const req = makeWebhookRequest('invoice.payment_failed', {
      subscription_code: 'SUB_fail_test',
      customer: { customer_code: 'CUS_fail' },
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const claim = upsertCalls.find(c => c.table === 'processed_webhook_events');
    expect(claim!.data.event_id).toBe('paystack-invoice.payment_failed-SUB_fail_test');
  });
});

// ══════════════════════════════════════════════════════════════
// charge.success still works (regression)
// ══════════════════════════════════════════════════════════════

describe('charge.success regression', () => {
  it('charge.success with reference still reaches existing handler', async () => {
    const req = makeWebhookRequest('charge.success', {
      reference: 'T_charge_regression_test',
      amount: 5000,
      currency: 'NGN',
      metadata: { type: 'booking', business_id: 'biz-regression' },
      customer: { customer_code: 'CUS_reg' },
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    // Should use reference-based idempotency, not subscription-based
    const claim = upsertCalls.find(c => c.table === 'processed_webhook_events');
    expect(claim!.data.event_id).toBe('paystack-T_charge_regression_test');
  });
});

// ══════════════════════════════════════════════════════════════
// Duplicate delivery
// ══════════════════════════════════════════════════════════════

describe('duplicate delivery handling', () => {
  it('duplicate subscription.create returns 200 without reprocessing', async () => {
    // First call claims the event
    const req1 = makeWebhookRequest('subscription.create', {
      subscription_code: 'SUB_dup_test',
      customer: { customer_code: 'CUS_dup' },
    });
    await POST(req1 as never);

    // Simulate the claim returning 'completed' on second call
    mockSupabase.from = vi.fn((table: string) => {
      if (table === 'processed_webhook_events') {
        return {
          upsert: vi.fn(() => ({
            select: () => ({ single: async () => ({ data: { id: 'evt-dup', status: 'completed', attempts: 1 }, error: null }) }),
          })),
        };
      }
      return makeChain();
    });

    const req2 = makeWebhookRequest('subscription.create', {
      subscription_code: 'SUB_dup_test',
      customer: { customer_code: 'CUS_dup' },
    });
    const res = await POST(req2 as never);
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════
// HMAC verification
// ══════════════════════════════════════════════════════════════

describe('HMAC verification preserved', () => {
  it('rejects subscription event with invalid signature', async () => {
    const body = JSON.stringify({
      event: 'subscription.create',
      data: { subscription_code: 'SUB_bad_sig' },
    });
    const req = new Request('http://localhost/api/payments/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': 'invalid_signature',
      },
      body,
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });
});
