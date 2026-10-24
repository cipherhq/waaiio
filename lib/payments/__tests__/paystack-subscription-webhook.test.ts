/**
 * Paystack Subscription Lifecycle Webhook Tests
 *
 * P0 fix: subscription.create, subscription.not_renew, subscription.disable,
 * and invoice.payment_failed events were silently dropped by the reference
 * guard (webhook/route.ts:55). These events use data.subscription_code.
 *
 * CTO R1 corrections:
 * 1. subscription.not_renew preserves paid-through access (no immediate suspension)
 * 2. Atomic idempotency with retry/completed/failed distinction
 * 3. Authoritative subscription matching (reject ambiguous, guard overwrites)
 * 4. Fail-safe on DB errors (don't mark completed on failure)
 * 5. Invoice events keyed by invoice_code for billing-cycle uniqueness
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

// ── Mock infrastructure ──

const upsertCalls: Array<{ table: string; data: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; data: Record<string, unknown>; filters: Array<{ col: string; val: string }> }> = [];
let mockSubResult: unknown = null;
let mockSubsArrayResult: unknown = null;
let mockProfileResult: unknown = null;
let mockBizResult: unknown = null;
let mockClaimResult: { data: unknown; error: unknown } = {
  data: { id: 'evt-1', status: 'processing', attempts: 1 },
  error: null,
};

function resetMocks() {
  upsertCalls.length = 0;
  updateCalls.length = 0;
  mockSubResult = null;
  mockSubsArrayResult = null;
  mockProfileResult = null;
  mockBizResult = null;
  mockClaimResult = { data: { id: 'evt-1', status: 'processing', attempts: 1 }, error: null };
}

const mockSupabase = {
  from: vi.fn((table: string) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};

    chain.upsert = vi.fn((_data: Record<string, unknown>) => {
      upsertCalls.push({ table, data: _data });
      return {
        select: () => ({
          single: async () => mockClaimResult,
        }),
      };
    });

    chain.update = vi.fn((_data: Record<string, unknown>) => {
      const eqs: Array<{ col: string; val: string }> = [];
      const eqChain: Record<string, ReturnType<typeof vi.fn>> = {};
      eqChain.eq = vi.fn((col: string, val: string) => {
        eqs.push({ col, val });
        updateCalls.push({ table, data: _data, filters: [...eqs] });
        return eqChain;
      });
      // Return a promise-like for await
      (eqChain as Record<string, unknown>).then = (resolve: (v: unknown) => void) => resolve({ error: null });
      return eqChain;
    });

    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.is = vi.fn(() => chain);
    chain.in = vi.fn(() => chain);

    chain.maybeSingle = vi.fn(async () => {
      if (table === 'subscriptions') return { data: mockSubResult, error: null };
      if (table === 'profiles') return { data: mockProfileResult, error: null };
      return { data: null, error: null };
    });

    // For the array query (email fallback multiple subs)
    (chain as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      if (table === 'subscriptions' && mockSubsArrayResult !== undefined) {
        resolve({ data: mockSubsArrayResult, error: null });
      } else if (table === 'businesses' && mockBizResult !== undefined) {
        resolve({ data: mockBizResult, error: null });
      } else {
        resolve({ data: [], error: null });
      }
    };

    return chain;
  }),
};

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSupabase }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/observability', () => ({ getRequestId: () => 'test-req-id', generateRequestId: () => 'test-req-id' }));
vi.mock('@/lib/observability/webhooks', () => ({
  createWebhookLogger: () => ({
    rejected: vi.fn(), verified: vi.fn(), received: vi.fn(), ignored: vi.fn(),
    duplicate: vi.fn(), processed: vi.fn(), failed: vi.fn(),
  }),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  withScope: vi.fn((fn: (s: Record<string, unknown>) => void) => fn({ setTag: vi.fn(), setContext: vi.fn() })),
}));
vi.mock('@/lib/payments/webhook-handler', () => ({ processPaystackChargeSuccess: vi.fn(async () => {}), processPaystackChargeFailed: vi.fn(async () => {}) }));
vi.mock('@/lib/payments/paystack-card-authorization', () => ({ normalizePaystackCardAuthorization: vi.fn(() => null), persistPaystackCardAuthorization: vi.fn(async () => {}) }));
vi.mock('@/lib/payments/send-confirmation', () => ({ sendProactiveConfirmation: vi.fn(async () => {}) }));
vi.mock('@/lib/payments/notify-charge-failed', () => ({ notifyCustomerChargeFailed: vi.fn(async () => {}) }));
vi.mock('@/lib/alerts/create-alert', () => ({ createAlert: vi.fn(async () => {}) }));
vi.mock('@/lib/email/templates', () => ({ subscriptionRenewalReceiptEmail: vi.fn(() => ({ subject: '', html: '' })) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: vi.fn((v: string) => v) }));
vi.mock('@/lib/payments/charge-role-resolver', () => ({ resolveChargeRole: vi.fn(async () => ({ ok: true, role: 'A' })) }));

const PAYSTACK_KEY = 'test_hmac_signing_key_not_a_real_secret';
process.env.PAYSTACK_SECRET_KEY = PAYSTACK_KEY;

function makeWebhookRequest(event: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ event, data });
  const signature = createHmac('sha512', PAYSTACK_KEY).update(body).digest('hex');
  return new Request('http://localhost/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
    body,
  });
}

const { POST } = await import('@/app/api/payments/webhook/route');

beforeEach(() => { resetMocks(); vi.clearAllMocks(); });

// ══════════════════════════════════════════════════════════════
// 1. subscription.create — code population
// ══════════════════════════════════════════════════════════════

describe('subscription.create', () => {
  it('processes event without data.reference (P0 fix)', async () => {
    mockSubResult = { id: 'sub-1', business_id: 'biz-1', paystack_subscription_code: null };
    const res = await POST(makeWebhookRequest('subscription.create', {
      subscription_code: 'SUB_test_create',
      customer: { customer_code: 'CUS_test', email: 'test@example.com' },
      plan: { plan_code: 'PLN_test' },
    }) as never);
    expect(res.status).toBe(200);
    const claim = upsertCalls.find(c => c.table === 'processed_webhook_events');
    expect(claim).toBeDefined();
    expect(claim!.data.event_id).toBe('paystack-subscription.create-SUB_test_create');
  });

  it('does not overwrite existing different subscription_code', async () => {
    mockSubResult = { id: 'sub-2', business_id: 'biz-2', paystack_subscription_code: 'SUB_existing_different' };
    const { logger } = await import('@/lib/logger');
    await POST(makeWebhookRequest('subscription.create', {
      subscription_code: 'SUB_new_code',
      customer: { customer_code: 'CUS_existing', email: 'existing@example.com' },
    }) as never);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('existing code differs'),
      expect.objectContaining({ subCode: 'SUB_new_code', existing: 'SUB_existing_different' }),
    );
  });

  it('rejects ambiguous email matches (multiple active subs)', async () => {
    mockSubResult = null; // No customer_code match
    mockProfileResult = { id: 'profile-1' };
    mockBizResult = [{ id: 'biz-a' }, { id: 'biz-b' }];
    mockSubsArrayResult = [
      { id: 'sub-a', business_id: 'biz-a', paystack_subscription_code: null },
      { id: 'sub-b', business_id: 'biz-b', paystack_subscription_code: null },
    ];
    const { logger } = await import('@/lib/logger');
    await POST(makeWebhookRequest('subscription.create', {
      subscription_code: 'SUB_ambiguous',
      customer: { customer_code: 'CUS_ambig', email: 'ambig@example.com' },
    }) as never);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('ambiguous email match'),
      expect.objectContaining({ matchCount: 2 }),
    );
  });

  it('ignores event without subscription_code', async () => {
    const res = await POST(makeWebhookRequest('subscription.create', {
      customer: { customer_code: 'CUS_no_code' },
    }) as never);
    expect(res.status).toBe(200);
    expect(upsertCalls.filter(c => c.table === 'processed_webhook_events')).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
// 2. subscription.not_renew — preserves paid-through access
// ══════════════════════════════════════════════════════════════

describe('subscription.not_renew — paid-through preservation', () => {
  it('records cancellation_at WITHOUT changing status or suspending business', async () => {
    mockSubResult = { id: 'sub-cancel', business_id: 'biz-cancel', current_period_end: '2026-11-01T00:00:00Z' };
    await POST(makeWebhookRequest('subscription.not_renew', {
      subscription_code: 'SUB_cancel_test',
      customer: { customer_code: 'CUS_cancel' },
    }) as never);

    // Should update subscriptions with cancelled_at but NOT change status
    const subUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.cancelled_at);
    expect(subUpdate).toBeDefined();
    expect(subUpdate!.data.status).toBeUndefined(); // Status NOT changed
    expect(subUpdate!.data.cancellation_reason).toBe('customer_cancelled');

    // Should NOT update businesses (no immediate suspension)
    const bizUpdate = updateCalls.find(c => c.table === 'businesses');
    expect(bizUpdate).toBeUndefined();
  });

  it('uses subscription.disable reason for provider-initiated cancellation', async () => {
    mockSubResult = { id: 'sub-disable', business_id: 'biz-disable', current_period_end: '2026-11-01T00:00:00Z' };
    await POST(makeWebhookRequest('subscription.disable', {
      subscription_code: 'SUB_disable_test',
      customer: { customer_code: 'CUS_disable' },
    }) as never);
    const subUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.cancelled_at);
    expect(subUpdate).toBeDefined();
    expect(subUpdate!.data.cancellation_reason).toBe('provider_disabled');
  });
});

// ══════════════════════════════════════════════════════════════
// 3. invoice.payment_failed
// ══════════════════════════════════════════════════════════════

describe('invoice.payment_failed', () => {
  it('marks subscription as past_due', async () => {
    mockSubResult = { id: 'sub-fail', business_id: 'biz-fail' };
    await POST(makeWebhookRequest('invoice.payment_failed', {
      subscription_code: 'SUB_fail_test',
      invoice_code: 'INV_oct_2026',
      customer: { customer_code: 'CUS_fail' },
    }) as never);
    const subUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.status === 'past_due');
    expect(subUpdate).toBeDefined();
  });

  it('includes invoice_code in idempotency key for billing-cycle uniqueness', async () => {
    mockSubResult = { id: 'sub-inv', business_id: 'biz-inv' };
    await POST(makeWebhookRequest('invoice.payment_failed', {
      subscription_code: 'SUB_inv_test',
      invoice_code: 'INV_cycle_1',
    }) as never);
    const claim = upsertCalls.find(c => c.table === 'processed_webhook_events');
    expect(claim!.data.event_id).toBe('paystack-invoice.payment_failed-SUB_inv_test-INV_cycle_1');
  });
});

// ══════════════════════════════════════════════════════════════
// 4. Idempotency
// ══════════════════════════════════════════════════════════════

describe('idempotency', () => {
  it('skips already-completed events', async () => {
    mockClaimResult = { data: { id: 'evt-dup', status: 'completed', attempts: 1 }, error: null };
    const res = await POST(makeWebhookRequest('subscription.create', {
      subscription_code: 'SUB_completed',
      customer: { customer_code: 'CUS_done' },
    }) as never);
    expect(res.status).toBe(200);
    // Should NOT have updated any subscriptions
    expect(updateCalls.filter(c => c.table === 'subscriptions')).toHaveLength(0);
  });

  it('returns 200 on claim error (concurrent delivery)', async () => {
    mockClaimResult = { data: null, error: { message: 'unique_violation' } };
    const res = await POST(makeWebhookRequest('subscription.create', {
      subscription_code: 'SUB_concurrent',
      customer: { customer_code: 'CUS_race' },
    }) as never);
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════
// 5. charge.success regression
// ══════════════════════════════════════════════════════════════

describe('charge.success regression', () => {
  it('charge.success with reference bypasses subscription handler', async () => {
    const res = await POST(makeWebhookRequest('charge.success', {
      reference: 'T_charge_regression',
      amount: 5000,
      currency: 'NGN',
      metadata: { type: 'booking', business_id: 'biz-reg' },
      customer: { customer_code: 'CUS_reg' },
    }) as never);
    expect(res.status).toBe(200);
    const claim = upsertCalls.find(c => c.table === 'processed_webhook_events');
    expect(claim!.data.event_id).toBe('paystack-T_charge_regression');
  });
});

// ══════════════════════════════════════════════════════════════
// 6. HMAC verification preserved
// ══════════════════════════════════════════════════════════════

describe('HMAC', () => {
  it('rejects subscription event with invalid signature', async () => {
    const body = JSON.stringify({ event: 'subscription.create', data: { subscription_code: 'SUB_bad' } });
    const req = new Request('http://localhost/api/payments/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': 'invalid' },
      body,
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });
});
