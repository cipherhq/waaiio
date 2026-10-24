/**
 * Paystack Subscription Lifecycle Webhook Tests
 *
 * P0 fix + CTO R2 corrections:
 * - Uses established claim_webhook_event RPC (M362) for atomic idempotency
 * - subscription.not_renew preserves paid-through access
 * - Authoritative matching by paystack_customer_code only (no email fallback)
 * - invoice.payment_failed requires invoice_code for billing-cycle uniqueness
 * - Fail-safe on DB errors with claim_token verification
 * - Guards against overwriting existing subscription codes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

// ── Mock infrastructure ──

const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; data: Record<string, unknown> }> = [];
let mockSubResult: unknown = null;
let mockClaimResult: { data: unknown; error: unknown } = {
  data: { claimed: true, claim_token: 'tok-1' },
  error: null,
};

function resetMocks() {
  rpcCalls.length = 0;
  updateCalls.length = 0;
  mockSubResult = null;
  mockClaimResult = { data: { claimed: true, claim_token: 'tok-1' }, error: null };
}

const mockSupabase = {
  rpc: vi.fn(async (fn: string, params: Record<string, unknown>) => {
    rpcCalls.push({ fn, params });
    if (fn === 'claim_webhook_event') return mockClaimResult;
    return { data: null, error: null };
  }),
  from: vi.fn((table: string) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.upsert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'evt-1', status: 'processing', attempts: 1 }, error: null }) }) }));
    chain.update = vi.fn((_data: Record<string, unknown>) => {
      updateCalls.push({ table, data: _data });
      const eqChain: Record<string, ReturnType<typeof vi.fn>> = {};
      eqChain.eq = vi.fn(() => eqChain);
      (eqChain as Record<string, unknown>).then = (resolve: (v: unknown) => void) => resolve({ error: null });
      return eqChain;
    });
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.is = vi.fn(() => chain);
    chain.in = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => {
      if (table === 'subscriptions') return { data: mockSubResult, error: null };
      return { data: null, error: null };
    });
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
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), withScope: vi.fn((fn: (s: Record<string, unknown>) => void) => fn({ setTag: vi.fn(), setContext: vi.fn() })) }));
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

function makeReq(event: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ event, data });
  const sig = createHmac('sha512', PAYSTACK_KEY).update(body).digest('hex');
  return new Request('http://localhost/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-paystack-signature': sig },
    body,
  });
}

const { POST } = await import('@/app/api/payments/webhook/route');
beforeEach(() => { resetMocks(); vi.clearAllMocks(); });

// ══════════════════════════════════════════════════════════════
// 1. Atomic idempotency via claim_webhook_event RPC
// ══════════════════════════════════════════════════════════════

describe('atomic idempotency (claim_webhook_event RPC)', () => {
  it('calls claim_webhook_event RPC instead of upsert', async () => {
    mockSubResult = { id: 'sub-1', business_id: 'biz-1', paystack_subscription_code: null };
    await POST(makeReq('subscription.create', {
      subscription_code: 'SUB_claim_test',
      customer: { customer_code: 'CUS_claim', email: 'claim@test.com' },
    }) as never);
    const claimCall = rpcCalls.find(c => c.fn === 'claim_webhook_event');
    expect(claimCall).toBeDefined();
    expect(claimCall!.params.p_event_id).toBe('paystack-subscription.create-SUB_claim_test');
    expect(claimCall!.params.p_gateway).toBe('paystack');
  });

  it('skips already-completed events without reprocessing', async () => {
    mockClaimResult = { data: { claimed: false, reason: 'already_completed' }, error: null };
    await POST(makeReq('subscription.create', {
      subscription_code: 'SUB_done',
      customer: { customer_code: 'CUS_done' },
    }) as never);
    expect(updateCalls.filter(c => c.table === 'subscriptions')).toHaveLength(0);
  });

  it('skips actively-processing events (concurrent delivery)', async () => {
    mockClaimResult = { data: { claimed: false, reason: 'active_processing' }, error: null };
    const res = await POST(makeReq('subscription.create', {
      subscription_code: 'SUB_concurrent',
      customer: { customer_code: 'CUS_race' },
    }) as never);
    expect(res.status).toBe(200);
    expect(updateCalls.filter(c => c.table === 'subscriptions')).toHaveLength(0);
  });

  it('returns 200 on claim RPC failure (fail-safe)', async () => {
    mockClaimResult = { data: null, error: { message: 'connection error' } };
    const res = await POST(makeReq('subscription.create', {
      subscription_code: 'SUB_rpc_fail',
      customer: { customer_code: 'CUS_fail' },
    }) as never);
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════
// 2. subscription.create — authoritative matching
// ══════════════════════════════════════════════════════════════

describe('subscription.create — matching', () => {
  it('matches by paystack_customer_code and populates subscription_code', async () => {
    mockSubResult = { id: 'sub-match', business_id: 'biz-match', paystack_subscription_code: null };
    await POST(makeReq('subscription.create', {
      subscription_code: 'SUB_new',
      customer: { customer_code: 'CUS_match', email: 'match@test.com' },
    }) as never);
    const subUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.paystack_subscription_code);
    expect(subUpdate).toBeDefined();
    expect(subUpdate!.data.paystack_subscription_code).toBe('SUB_new');
  });

  it('does NOT overwrite existing different subscription_code', async () => {
    mockSubResult = { id: 'sub-existing', business_id: 'biz-e', paystack_subscription_code: 'SUB_original' };
    const { logger } = await import('@/lib/logger');
    await POST(makeReq('subscription.create', {
      subscription_code: 'SUB_different',
      customer: { customer_code: 'CUS_e' },
    }) as never);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('existing code differs'),
      expect.objectContaining({ existing: 'SUB_original' }),
    );
    const subUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.paystack_subscription_code);
    expect(subUpdate).toBeUndefined();
  });

  it('does NOT fall back to email-only matching', async () => {
    mockSubResult = null; // No customer_code match
    const { logger } = await import('@/lib/logger');
    await POST(makeReq('subscription.create', {
      subscription_code: 'SUB_no_email_fallback',
      customer: { customer_code: 'CUS_unknown', email: 'unknown@test.com' },
    }) as never);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('no matching DB subscription by customer_code'),
      expect.anything(),
    );
  });

  it('ignores event without subscription_code', async () => {
    const res = await POST(makeReq('subscription.create', {
      customer: { customer_code: 'CUS_no_code' },
    }) as never);
    expect(res.status).toBe(200);
    expect(rpcCalls.filter(c => c.fn === 'claim_webhook_event')).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. subscription.not_renew — paid-through preservation
// ══════════════════════════════════════════════════════════════

describe('subscription.not_renew — paid-through access', () => {
  it('records cancelled_at WITHOUT changing status or suspending business', async () => {
    mockSubResult = { id: 'sub-nr', business_id: 'biz-nr', current_period_end: '2026-11-01T00:00:00Z' };
    await POST(makeReq('subscription.not_renew', {
      subscription_code: 'SUB_not_renew',
      customer: { customer_code: 'CUS_nr' },
    }) as never);
    const subUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.cancelled_at);
    expect(subUpdate).toBeDefined();
    expect(subUpdate!.data.status).toBeUndefined();
    expect(subUpdate!.data.cancellation_reason).toBe('customer_cancelled');
    const bizUpdate = updateCalls.find(c => c.table === 'businesses');
    expect(bizUpdate).toBeUndefined();
  });

  it('distinguishes provider_disabled from customer_cancelled', async () => {
    mockSubResult = { id: 'sub-dis', business_id: 'biz-dis', current_period_end: '2026-11-01T00:00:00Z' };
    await POST(makeReq('subscription.disable', {
      subscription_code: 'SUB_disabled',
      customer: { customer_code: 'CUS_dis' },
    }) as never);
    const subUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.cancelled_at);
    expect(subUpdate!.data.cancellation_reason).toBe('provider_disabled');
  });
});

// ══════════════════════════════════════════════════════════════
// 4. invoice.payment_failed — billing-cycle uniqueness
// ══════════════════════════════════════════════════════════════

describe('invoice.payment_failed', () => {
  it('includes invoice_code in idempotency key', async () => {
    mockSubResult = { id: 'sub-inv', business_id: 'biz-inv' };
    await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_inv',
      invoice_code: 'INV_oct_2026',
      customer: { customer_code: 'CUS_inv' },
    }) as never);
    const claimCall = rpcCalls.find(c => c.fn === 'claim_webhook_event');
    expect(claimCall!.params.p_event_id).toBe('paystack-invoice.payment_failed-SUB_inv-INV_oct_2026');
  });

  it('rejects invoice.payment_failed WITHOUT invoice_code (cannot deduplicate)', async () => {
    const { logger } = await import('@/lib/logger');
    await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_no_inv_code',
      customer: { customer_code: 'CUS_ni' },
    }) as never);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('missing invoice_code'),
      expect.anything(),
    );
    expect(rpcCalls.filter(c => c.fn === 'claim_webhook_event')).toHaveLength(0);
  });

  it('marks subscription as past_due on valid invoice failure', async () => {
    mockSubResult = { id: 'sub-pdue', business_id: 'biz-pdue' };
    await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_pdue',
      invoice_code: 'INV_pdue_1',
    }) as never);
    const subUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.status === 'past_due');
    expect(subUpdate).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 5. charge.success regression
// ══════════════════════════════════════════════════════════════

describe('charge.success regression', () => {
  it('charge.success with reference bypasses subscription handler entirely', async () => {
    await POST(makeReq('charge.success', {
      reference: 'T_charge_reg',
      amount: 5000,
      currency: 'NGN',
      metadata: { type: 'booking', business_id: 'biz-reg' },
      customer: { customer_code: 'CUS_reg' },
    }) as never);
    // Should NOT call claim_webhook_event (that's for subscription events)
    const subClaimCalls = rpcCalls.filter(c => c.fn === 'claim_webhook_event');
    expect(subClaimCalls).toHaveLength(0);
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
