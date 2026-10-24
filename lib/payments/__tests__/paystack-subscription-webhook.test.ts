/**
 * Paystack Subscription Lifecycle Webhook Tests — CTO R3
 *
 * Uses M362 canonical fencing contract:
 * - claim_webhook_event → atomic INSERT-or-reclaim
 * - complete_webhook_event → claim_token + status='processing' verified
 * - fail_webhook_event → records error, stays retryable
 *
 * CTO R3 corrections:
 * - Unmatched subscription.create stays 'failed' (not completed)
 * - Unmatched cancellation/invoice events stay 'failed' (retryable)
 * - Conditional update prevents competing code assignments
 * - No email-only fallback for subscription ownership
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; data: Record<string, unknown> }> = [];
let mockSubResult: unknown = null;
let mockClaimResult: { data: unknown; error: unknown } = {
  data: { claimed: true, claim_token: 'tok-1' }, error: null,
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
    if (fn === 'complete_webhook_event') return { data: true, error: null };
    if (fn === 'fail_webhook_event') return { data: true, error: null };
    return { data: null, error: null };
  }),
  from: vi.fn((table: string) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.update = vi.fn((_data: Record<string, unknown>) => {
      updateCalls.push({ table, data: _data });
      const eqChain: Record<string, ReturnType<typeof vi.fn>> = {};
      eqChain.eq = vi.fn(() => eqChain);
      eqChain.is = vi.fn(() => eqChain);
      (eqChain as Record<string, unknown>).then = (resolve: (v: unknown) => void) =>
        resolve({ error: null, count: 1 });
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
    chain.upsert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: 'e1', status: 'processing', attempts: 1 }, error: null }) }) }));
    return chain;
  }),
};

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSupabase }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/observability', () => ({ getRequestId: () => 'r', generateRequestId: () => 'r' }));
vi.mock('@/lib/observability/webhooks', () => ({ createWebhookLogger: () => ({ rejected: vi.fn(), verified: vi.fn(), received: vi.fn(), ignored: vi.fn(), duplicate: vi.fn(), processed: vi.fn(), failed: vi.fn() }) }));
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

const KEY = 'test_hmac_signing_key_not_a_real_secret';
process.env.PAYSTACK_SECRET_KEY = KEY;

function makeReq(event: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ event, data });
  return new Request('http://localhost/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-paystack-signature': createHmac('sha512', KEY).update(body).digest('hex') },
    body,
  });
}

const { POST } = await import('@/app/api/payments/webhook/route');
beforeEach(() => { resetMocks(); vi.clearAllMocks(); });

// ── 1. Canonical fencing RPCs ──

describe('M362 fencing contract', () => {
  it('calls claim_webhook_event RPC for subscription events', async () => {
    mockSubResult = { id: 's1', business_id: 'b1', paystack_subscription_code: null };
    await POST(makeReq('subscription.create', { subscription_code: 'SUB_1', customer: { customer_code: 'CUS_1' } }) as never);
    expect(rpcCalls.find(c => c.fn === 'claim_webhook_event')).toBeDefined();
  });

  it('calls complete_webhook_event on successful processing', async () => {
    mockSubResult = { id: 's2', business_id: 'b2', paystack_subscription_code: null };
    await POST(makeReq('subscription.create', { subscription_code: 'SUB_2', customer: { customer_code: 'CUS_2' } }) as never);
    const complete = rpcCalls.find(c => c.fn === 'complete_webhook_event');
    expect(complete).toBeDefined();
    expect(complete!.params.p_claim_token).toBe('tok-1');
  });

  it('calls fail_webhook_event on unmatched subscription.create', async () => {
    mockSubResult = null; // No match
    await POST(makeReq('subscription.create', { subscription_code: 'SUB_unmatched', customer: { customer_code: 'CUS_unknown' } }) as never);
    const fail = rpcCalls.find(c => c.fn === 'fail_webhook_event');
    expect(fail).toBeDefined();
    expect(fail!.params.p_error).toContain('Processing did not confirm success');
    // Must NOT call complete_webhook_event
    expect(rpcCalls.filter(c => c.fn === 'complete_webhook_event')).toHaveLength(0);
  });

  it('skips already-completed events', async () => {
    mockClaimResult = { data: { claimed: false, reason: 'already_completed' }, error: null };
    await POST(makeReq('subscription.create', { subscription_code: 'SUB_done', customer: { customer_code: 'CUS_d' } }) as never);
    expect(rpcCalls.filter(c => c.fn === 'complete_webhook_event')).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it('returns 500 for actively-processing events (R6-2: worker may crash)', async () => {
    mockClaimResult = { data: { claimed: false, reason: 'active_processing' }, error: null };
    const res = await POST(makeReq('subscription.create', { subscription_code: 'SUB_race', customer: { customer_code: 'CUS_r' } }) as never);
    expect(res.status).toBe(500); // Triggers Paystack retry after stale threshold
    expect(updateCalls).toHaveLength(0);
  });

  it('returns 500 on claim RPC failure (triggers Paystack retry)', async () => {
    mockClaimResult = { data: null, error: { message: 'connection reset' } };
    const res = await POST(makeReq('subscription.create', { subscription_code: 'SUB_err', customer: { customer_code: 'CUS_e' } }) as never);
    expect(res.status).toBe(500);
  });
});

// ── 2. Subscription.create matching ──

describe('subscription.create matching', () => {
  it('populates code via customer_code match with conditional update', async () => {
    mockSubResult = { id: 's3', business_id: 'b3', paystack_subscription_code: null };
    await POST(makeReq('subscription.create', { subscription_code: 'SUB_new', customer: { customer_code: 'CUS_3' } }) as never);
    const subUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.paystack_subscription_code);
    expect(subUpdate).toBeDefined();
    expect(subUpdate!.data.paystack_subscription_code).toBe('SUB_new');
  });

  it('does NOT overwrite existing different code', async () => {
    mockSubResult = { id: 's4', business_id: 'b4', paystack_subscription_code: 'SUB_original' };
    const { logger } = await import('@/lib/logger');
    await POST(makeReq('subscription.create', { subscription_code: 'SUB_conflict', customer: { customer_code: 'CUS_4' } }) as never);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('existing code differs'), expect.anything());
    expect(updateCalls.filter(c => c.table === 'subscriptions')).toHaveLength(0);
  });

  it('does NOT use email-only fallback', async () => {
    mockSubResult = null;
    const { logger } = await import('@/lib/logger');
    await POST(makeReq('subscription.create', { subscription_code: 'SUB_noemail', customer: { customer_code: 'CUS_nf', email: 'nf@test.com' } }) as never);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('no matching DB subscription'), expect.anything());
  });

  it('ignores events without subscription_code', async () => {
    const res = await POST(makeReq('subscription.create', { customer: { customer_code: 'CUS_nc' } }) as never);
    expect(res.status).toBe(200);
    expect(rpcCalls.filter(c => c.fn === 'claim_webhook_event')).toHaveLength(0);
  });
});

// ── 3. Paid-through cancellation ──

describe('subscription.not_renew — paid-through', () => {
  it('records cancelled_at without status change or business suspension', async () => {
    mockSubResult = { id: 'snr', business_id: 'bnr', current_period_end: '2026-11-01T00:00:00Z' };
    await POST(makeReq('subscription.not_renew', { subscription_code: 'SUB_nr', customer: { customer_code: 'CUS_nr' } }) as never);
    const subUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.cancelled_at);
    expect(subUpdate).toBeDefined();
    expect(subUpdate!.data.status).toBeUndefined();
    expect(subUpdate!.data.cancellation_reason).toBe('customer_cancelled');
    expect(updateCalls.find(c => c.table === 'businesses')).toBeUndefined();
  });

  it('calls fail_webhook_event for unmatched cancellation (retryable)', async () => {
    mockSubResult = null;
    await POST(makeReq('subscription.not_renew', { subscription_code: 'SUB_unmatched_nr', customer: {} }) as never);
    expect(rpcCalls.find(c => c.fn === 'fail_webhook_event')).toBeDefined();
    expect(rpcCalls.filter(c => c.fn === 'complete_webhook_event')).toHaveLength(0);
  });
});

// ── 4. Invoice uniqueness ──

describe('invoice.payment_failed — R5-1 corrected', () => {
  it('does NOT change status to past_due (keeps active)', async () => {
    mockSubResult = { id: 'si', business_id: 'bi' };
    await POST(makeReq('invoice.payment_failed', { subscription_code: 'SUB_i', invoice_code: 'INV_oct' }) as never);
    // Should NOT update subscription status
    const statusUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.status);
    expect(statusUpdate).toBeUndefined();
    // Should complete successfully (alert created, subscription untouched)
    expect(rpcCalls.find(c => c.fn === 'complete_webhook_event')).toBeDefined();
  });

  it('includes invoice_code in idempotency key', async () => {
    mockSubResult = { id: 'si2', business_id: 'bi2' };
    await POST(makeReq('invoice.payment_failed', { subscription_code: 'SUB_i2', invoice_code: 'INV_oct2' }) as never);
    const claim = rpcCalls.find(c => c.fn === 'claim_webhook_event');
    expect(claim!.params.p_event_id).toBe('paystack-invoice.payment_failed-SUB_i2-INV_oct2');
  });

  it('rejects missing invoice_code', async () => {
    await POST(makeReq('invoice.payment_failed', { subscription_code: 'SUB_noic' }) as never);
    expect(rpcCalls.filter(c => c.fn === 'claim_webhook_event')).toHaveLength(0);
  });

  it('returns 500 for unmatched invoice failure (Paystack retries)', async () => {
    mockSubResult = null;
    const res = await POST(makeReq('invoice.payment_failed', { subscription_code: 'SUB_uf', invoice_code: 'INV_uf' }) as never);
    expect(res.status).toBe(500);
    expect(rpcCalls.find(c => c.fn === 'fail_webhook_event')).toBeDefined();
  });
});

describe('R5-2: subsequent lifecycle events after payment failure', () => {
  it('cancellation matches past_due subscriptions (failure → cancel sequence)', async () => {
    // Simulate a subscription that was manually set to past_due (legacy)
    mockSubResult = { id: 'spd', business_id: 'bpd', current_period_end: '2026-11-01T00:00:00Z' };
    await POST(makeReq('subscription.not_renew', { subscription_code: 'SUB_pd_cancel', customer: { customer_code: 'CUS_pd' } }) as never);
    const subUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.cancelled_at);
    expect(subUpdate).toBeDefined();
    expect(subUpdate!.data.cancellation_reason).toBe('customer_cancelled');
  });

  it('invoice failure matches past_due subscriptions (repeated failure)', async () => {
    mockSubResult = { id: 'spd2', business_id: 'bpd2' };
    const res = await POST(makeReq('invoice.payment_failed', { subscription_code: 'SUB_pd_fail', invoice_code: 'INV_cycle2' }) as never);
    expect(res.status).toBe(200); // Matched and completed
    expect(rpcCalls.find(c => c.fn === 'complete_webhook_event')).toBeDefined();
  });
});

describe('R5-3: failed event recovery path', () => {
  it('unmatched events return 500 (Paystack retries, giving time for subscription.create)', async () => {
    mockSubResult = null; // No matching subscription
    const res = await POST(makeReq('subscription.not_renew', { subscription_code: 'SUB_unmatched_retry', customer: {} }) as never);
    expect(res.status).toBe(500);
  });

  it('successfully processed events return 200', async () => {
    mockSubResult = { id: 'sok', business_id: 'bok', current_period_end: '2026-11-01T00:00:00Z' };
    const res = await POST(makeReq('subscription.not_renew', { subscription_code: 'SUB_ok_cancel', customer: {} }) as never);
    expect(res.status).toBe(200);
  });
});

// ── 5. charge.success regression ──

describe('charge.success regression', () => {
  it('charge.success with reference bypasses subscription handler', async () => {
    await POST(makeReq('charge.success', { reference: 'T_reg', amount: 5000, currency: 'NGN', metadata: { type: 'booking' }, customer: { customer_code: 'CUS_r' } }) as never);
    expect(rpcCalls.filter(c => c.fn === 'claim_webhook_event')).toHaveLength(0);
  });
});

// ── 6. HMAC ──

describe('HMAC preserved', () => {
  it('rejects invalid signature', async () => {
    const req = new Request('http://localhost/api/payments/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': 'bad' },
      body: JSON.stringify({ event: 'subscription.create', data: { subscription_code: 'SUB_b' } }),
    });
    expect((await POST(req as never)).status).toBe(400);
  });
});

// ── 7. R4 corrections ──

describe('R4-1: conditional update count handling', () => {
  it('verifies stored value when count is 0 (concurrent race)', async () => {
    // Initial match query returns sub with null code
    mockSubResult = { id: 'sr4', business_id: 'br4', paystack_subscription_code: null };
    // But the update returns count:0 (another instance set it first)
    // Mock the update to return count:0
    const origFrom = mockSupabase.from;
    let updateCallCount = 0;
    mockSupabase.from = vi.fn((table: string) => {
      const chain = origFrom(table);
      if (table === 'subscriptions') {
        const origUpdate = chain.update;
        chain.update = vi.fn((_data: Record<string, unknown>) => {
          updateCalls.push({ table, data: _data });
          updateCallCount++;
          const eqChain: Record<string, ReturnType<typeof vi.fn>> = {};
          eqChain.eq = vi.fn(() => eqChain);
          eqChain.is = vi.fn(() => eqChain);
          // First update (conditional) returns count:0
          (eqChain as Record<string, unknown>).then = (resolve: (v: unknown) => void) =>
            resolve({ error: null, count: updateCallCount === 1 ? 0 : 1 });
          return eqChain;
        });
        // Verification SELECT after zero-row update
        chain.single = vi.fn(async () => ({
          data: { paystack_subscription_code: 'SUB_r4_verify' },
          error: null,
        }));
      }
      return chain;
    });
    await POST(makeReq('subscription.create', { subscription_code: 'SUB_r4_verify', customer: { customer_code: 'CUS_r4' } }) as never);
    // Should still mark as succeeded because the stored code matches
    expect(rpcCalls.find(c => c.fn === 'complete_webhook_event')).toBeDefined();
    mockSupabase.from = origFrom;
  });
});

describe('R6: durable completion and retry policy', () => {
  it('returns 500 on claim RPC failure (Paystack will retry)', async () => {
    mockClaimResult = { data: null, error: { message: 'connection timeout' } };
    const res = await POST(makeReq('subscription.create', { subscription_code: 'SUB_retry', customer: { customer_code: 'CUS_retry' } }) as never);
    expect(res.status).toBe(500);
  });

  it('returns 200 ONLY for already_completed events', async () => {
    mockClaimResult = { data: { claimed: false, reason: 'already_completed' }, error: null };
    const res = await POST(makeReq('subscription.create', { subscription_code: 'SUB_ok', customer: { customer_code: 'CUS_ok' } }) as never);
    expect(res.status).toBe(200);
  });

  it('R6-2: returns 500 for active_processing (worker may crash)', async () => {
    mockClaimResult = { data: { claimed: false, reason: 'active_processing' }, error: null };
    const res = await POST(makeReq('subscription.create', { subscription_code: 'SUB_inprog', customer: { customer_code: 'CUS_ip' } }) as never);
    expect(res.status).toBe(500);
  });

  it('R6-1: returns 500 if complete_webhook_event RPC fails', async () => {
    mockSubResult = { id: 'sfail', business_id: 'bfail', paystack_subscription_code: null };
    // Override RPC to fail on complete_webhook_event
    const origRpc = mockSupabase.rpc;
    mockSupabase.rpc = vi.fn(async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params });
      if (fn === 'claim_webhook_event') return mockClaimResult;
      if (fn === 'complete_webhook_event') return { data: null, error: { message: 'DB timeout' } };
      if (fn === 'fail_webhook_event') return { data: true, error: null };
      return { data: null, error: null };
    });
    const res = await POST(makeReq('subscription.create', { subscription_code: 'SUB_compfail', customer: { customer_code: 'CUS_cf' } }) as never);
    expect(res.status).toBe(500);
    mockSupabase.rpc = origRpc;
  });

  it('R6-1: returns 500 if complete_webhook_event returns false (claim lost)', async () => {
    mockSubResult = { id: 'slost', business_id: 'blost', paystack_subscription_code: null };
    const origRpc = mockSupabase.rpc;
    mockSupabase.rpc = vi.fn(async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params });
      if (fn === 'claim_webhook_event') return mockClaimResult;
      if (fn === 'complete_webhook_event') return { data: false, error: null }; // claim lost
      if (fn === 'fail_webhook_event') return { data: true, error: null };
      return { data: null, error: null };
    });
    const res = await POST(makeReq('subscription.create', { subscription_code: 'SUB_lost', customer: { customer_code: 'CUS_lost' } }) as never);
    expect(res.status).toBe(500);
    mockSupabase.rpc = origRpc;
  });

  it('R6-3: missing invoice_code is quarantined (not silently dropped)', async () => {
    const res = await POST(makeReq('invoice.payment_failed', { subscription_code: 'SUB_noic_q' }) as never);
    expect(res.status).toBe(200); // Quarantined, stop retries
    // Should have inserted a quarantine record
    const { logger } = await import('@/lib/logger');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('quarantined'),
      expect.objectContaining({ subCode: 'SUB_noic_q' }),
    );
  });
});

describe('R4-3: lifecycle safety', () => {
  it('subscription.create with unexpected reference falls through to charge handler', async () => {
    // Event has BOTH subscription_code AND reference — should NOT enter subscription handler
    await POST(makeReq('subscription.create', {
      subscription_code: 'SUB_hybrid',
      reference: 'T_hybrid_ref',
      customer: { customer_code: 'CUS_hybrid' },
    }) as never);
    // Should NOT call claim_webhook_event (subscription path)
    expect(rpcCalls.filter(c => c.fn === 'claim_webhook_event')).toHaveLength(0);
  });
});
