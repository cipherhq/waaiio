/**
 * Paystack Subscription Lifecycle Routing Tests
 *
 * Verifies that the lifecycle handler at webhook/route.ts correctly routes
 * subscription events to platform (subscriptions) vs customer (customer_subscriptions)
 * based on subscription_code lookup, with:
 * - Dual-table parallel lookup (no platform-first preference)
 * - Ambiguous match detection (fail-closed)
 * - DB error vs unmatched distinction
 * - Idempotent handling of terminal-state subscriptions
 * - Platform paid-through semantics (R5-1: no past_due on invoice.payment_failed)
 * - Customer failure escalation (failure_count → past_due at threshold)
 * - Customer notification and alert side effects
 * - subscription.create platform linking by customer_code
 *
 * Fix for PR #700 regression where lifecycle handler intercepted ALL subscription
 * events but only queried platform subscriptions table.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

// ── Mock state ──
type MockRow = Record<string, unknown> | null;
let platformResult: { data: MockRow; error: { message: string } | null } = { data: null, error: null };
let customerResult: { data: MockRow; error: { message: string } | null } = { data: null, error: null };
let claimResult: { data: unknown; error: unknown } = { data: { claimed: true, claim_token: 'tok-1' }, error: null };

const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; data: Record<string, unknown>; filters: string[] }> = [];
const insertCalls: Array<{ table: string; data: Record<string, unknown> }> = [];
const alertCalls: Array<Record<string, unknown>> = [];
const notifyCalls: Array<Record<string, unknown>> = [];

function reset() {
  platformResult = { data: null, error: null };
  customerResult = { data: null, error: null };
  claimResult = { data: { claimed: true, claim_token: 'tok-1' }, error: null };
  rpcCalls.length = 0;
  updateCalls.length = 0;
  insertCalls.length = 0;
  alertCalls.length = 0;
  notifyCalls.length = 0;
}

// Track eq/in filter chains for verification
const mockSupabase = {
  rpc: vi.fn(async (fn: string, params: Record<string, unknown>) => {
    rpcCalls.push({ fn, params });
    if (fn === 'claim_webhook_event') return claimResult;
    if (fn === 'complete_webhook_event') return { data: true, error: null };
    if (fn === 'fail_webhook_event') return { data: true, error: null };
    return { data: null, error: null };
  }),
  from: vi.fn((table: string) => {
    const filters: string[] = [];
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};

    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: unknown) => { filters.push(`${col}=${val}`); return chain; });
    chain.in = vi.fn((col: string, vals: unknown[]) => { filters.push(`${col} IN ${JSON.stringify(vals)}`); return chain; });
    chain.is = vi.fn((col: string, val: unknown) => { filters.push(`${col} IS ${val}`); return chain; });
    chain.single = vi.fn(async () => {
      if (table === 'subscriptions') return platformResult;
      return { data: null, error: null };
    });
    chain.maybeSingle = vi.fn(async () => {
      if (table === 'subscriptions') return platformResult;
      if (table === 'customer_subscriptions') return customerResult;
      return { data: null, error: null };
    });
    chain.update = vi.fn((data: Record<string, unknown>, opts?: Record<string, unknown>) => {
      updateCalls.push({ table, data, filters: [...filters] });
      const updateChain: Record<string, ReturnType<typeof vi.fn>> = {};
      updateChain.eq = vi.fn((col: string, val: unknown) => { filters.push(`${col}=${val}`); return updateChain; });
      updateChain.is = vi.fn((col: string, val: unknown) => { filters.push(`${col} IS ${val}`); return updateChain; });
      // For subscription.create conditional update with count:'exact'
      (updateChain as Record<string, unknown>).then = (resolve: (v: unknown) => void) =>
        resolve({ error: null, count: opts?.count === 'exact' ? 1 : undefined });
      return updateChain;
    });
    chain.insert = vi.fn((data: Record<string, unknown>) => {
      insertCalls.push({ table, data });
      return { error: null };
    });
    chain.upsert = vi.fn(() => ({
      select: () => ({ single: async () => ({ data: { id: 'e1' }, error: null }) }),
    }));

    return chain;
  }),
};

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSupabase }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/observability', () => ({ getRequestId: () => 'r', generateRequestId: () => 'r' }));
vi.mock('@/lib/observability/webhooks', () => ({
  createWebhookLogger: () => ({
    rejected: vi.fn(), verified: vi.fn(), received: vi.fn(),
    ignored: vi.fn(), duplicate: vi.fn(), processed: vi.fn(), failed: vi.fn(),
  }),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  withScope: vi.fn((fn: (s: Record<string, unknown>) => void) => fn({ setTag: vi.fn(), setContext: vi.fn() })),
}));
vi.mock('@/lib/payments/webhook-handler', () => ({
  processPaystackChargeSuccess: vi.fn(async () => {}),
  processPaystackChargeFailed: vi.fn(async () => {}),
}));
vi.mock('@/lib/payments/paystack-card-authorization', () => ({
  normalizePaystackCardAuthorization: vi.fn(() => null),
  persistPaystackCardAuthorization: vi.fn(async () => {}),
}));
vi.mock('@/lib/payments/send-confirmation', () => ({ sendProactiveConfirmation: vi.fn(async () => {}) }));
vi.mock('@/lib/payments/notify-charge-failed', () => ({
  notifyCustomerChargeFailed: vi.fn(async (...args: unknown[]) => { notifyCalls.push(args[1] as Record<string, unknown>); }),
}));
vi.mock('@/lib/alerts/create-alert', () => ({
  createAlert: vi.fn(async (_s: unknown, opts: Record<string, unknown>) => { alertCalls.push(opts); }),
}));
vi.mock('@/lib/email/templates', () => ({ subscriptionRenewalReceiptEmail: vi.fn(() => ({ subject: '', html: '' })) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: vi.fn((v: string) => v) }));
vi.mock('@/lib/payments/charge-role-resolver', () => ({ resolveChargeRole: vi.fn(async () => ({ ok: true, role: 'A' })) }));

const KEY = 'test_routing_key_not_real';
process.env.PAYSTACK_SECRET_KEY = KEY;

function makeReq(event: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ event, data });
  return new Request('http://localhost/api/payments/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-paystack-signature': createHmac('sha512', KEY).update(body).digest('hex'),
    },
    body,
  });
}

const { POST } = await import('@/app/api/payments/webhook/route');
beforeEach(() => { reset(); vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════
// 1–4. Platform subscription events (preserve existing PR #700 behavior)
// ═══════════════════════════════════════════════════════════

describe('Platform subscription routing', () => {
  it('1. subscription.create links by customer_code', async () => {
    platformResult = { data: { id: 'ps1', business_id: 'b1', paystack_subscription_code: null, status: 'active' }, error: null };
    const res = await POST(makeReq('subscription.create', {
      subscription_code: 'SUB_P1',
      customer: { customer_code: 'CUS_P1' },
    }) as never);
    expect(res.status).toBe(200);
    const update = updateCalls.find(c => c.table === 'subscriptions');
    expect(update).toBeTruthy();
    expect(update!.data.paystack_subscription_code).toBe('SUB_P1');
  });

  it('2. subscription.not_renew sets cancelled_at, keeps status active', async () => {
    platformResult = { data: { id: 'ps2', business_id: 'b2', current_period_end: '2026-11-15', status: 'active' }, error: null };
    const res = await POST(makeReq('subscription.not_renew', {
      subscription_code: 'SUB_P2',
    }) as never);
    expect(res.status).toBe(200);
    const update = updateCalls.find(c => c.table === 'subscriptions');
    expect(update).toBeTruthy();
    expect(update!.data.cancelled_at).toBeTruthy();
    expect(update!.data.cancellation_reason).toBe('customer_cancelled');
    // Must NOT change status
    expect(update!.data).not.toHaveProperty('status');
  });

  it('3. subscription.disable sets cancelled_at with provider_disabled reason', async () => {
    platformResult = { data: { id: 'ps3', business_id: 'b3', current_period_end: '2026-11-15', status: 'active' }, error: null };
    const res = await POST(makeReq('subscription.disable', {
      subscription_code: 'SUB_P3',
    }) as never);
    expect(res.status).toBe(200);
    const update = updateCalls.find(c => c.table === 'subscriptions');
    expect(update!.data.cancellation_reason).toBe('provider_disabled');
    expect(update!.data).not.toHaveProperty('status');
  });

  it('4. invoice.payment_failed keeps platform active, creates alert (R5-1)', async () => {
    platformResult = { data: { id: 'ps4', business_id: 'b4', status: 'active' }, error: null };
    const res = await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_P4',
      invoice_code: 'INV_1',
    }) as never);
    expect(res.status).toBe(200);
    // No status change on platform subscriptions
    const statusUpdate = updateCalls.find(c => c.table === 'subscriptions' && c.data.status);
    expect(statusUpdate).toBeUndefined();
    // Alert created
    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0].type).toBe('payment_failed');
  });
});

// ═══════════════════════════════════════════════════════════
// 5–9. Customer subscription events (restored from legacy handlers)
// ═══════════════════════════════════════════════════════════

describe('Customer subscription routing', () => {
  const customerSub = {
    id: 'cs1', business_id: 'cb1', user_id: 'cu1', service_id: 'sv1',
    amount: '5000', currency: 'NGN', customer_phone: '+2341234567890',
    customer_name: 'Test Customer', failure_count: 0,
    gateway_subscription_code: 'SUB_C1', next_charge_at: '2026-11-15',
    status: 'active',
  };

  it('5. invoice.payment_failed increments failure_count', async () => {
    customerResult = { data: { ...customerSub }, error: null };
    const res = await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_C1',
      invoice_code: 'INV_C1',
      gateway_response: 'Insufficient Funds',
      currency: 'NGN',
    }) as never);
    expect(res.status).toBe(200);
    const update = updateCalls.find(c => c.table === 'customer_subscriptions');
    expect(update).toBeTruthy();
    expect(update!.data.failure_count).toBe(1);
    // Not past_due yet (< 3 failures)
    expect(update!.data.status).toBe('active');
  });

  it('6. invoice.payment_failed logs to subscription_charges', async () => {
    customerResult = { data: { ...customerSub }, error: null };
    await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_C1',
      invoice_code: 'INV_C2',
      gateway_response: 'Card declined',
      currency: 'NGN',
    }) as never);
    const chargeInsert = insertCalls.find(c => c.table === 'subscription_charges');
    expect(chargeInsert).toBeTruthy();
    expect(chargeInsert!.data.status).toBe('failed');
    expect(chargeInsert!.data.failure_reason).toBe('Card declined');
    expect(chargeInsert!.data.gateway).toBe('paystack');
  });

  it('7. invoice.payment_failed creates business alert', async () => {
    customerResult = { data: { ...customerSub }, error: null };
    await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_C1',
      invoice_code: 'INV_C3',
    }) as never);
    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0].type).toBe('subscription_payment_failed');
    expect(alertCalls[0].severity).toBe('warning');
  });

  it('8. invoice.payment_failed at 3 failures → past_due', async () => {
    customerResult = { data: { ...customerSub, failure_count: 2 }, error: null };
    await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_C1',
      invoice_code: 'INV_C4',
    }) as never);
    const update = updateCalls.find(c => c.table === 'customer_subscriptions');
    expect(update!.data.failure_count).toBe(3);
    expect(update!.data.status).toBe('past_due');
    // Alert severity escalated
    expect(alertCalls[0].severity).toBe('critical');
  });

  it('9. invoice.payment_failed sends WhatsApp notification', async () => {
    customerResult = { data: { ...customerSub }, error: null };
    await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_C1',
      invoice_code: 'INV_C5',
    }) as never);
    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0].subscriptionId).toBe('cs1');
    expect(notifyCalls[0].customerPhone).toBe('+2341234567890');
    expect(notifyCalls[0].gateway).toBe('paystack');
  });

  it('10. subscription.disable → customer status cancelled', async () => {
    customerResult = { data: { ...customerSub }, error: null };
    const res = await POST(makeReq('subscription.disable', {
      subscription_code: 'SUB_C1',
    }) as never);
    expect(res.status).toBe(200);
    const update = updateCalls.find(c => c.table === 'customer_subscriptions');
    expect(update!.data.status).toBe('cancelled');
    expect(update!.data.cancelled_at).toBeTruthy();
  });

  it('11. subscription.not_renew → customer cancelled_at set, status preserved', async () => {
    customerResult = { data: { ...customerSub }, error: null };
    const res = await POST(makeReq('subscription.not_renew', {
      subscription_code: 'SUB_C1',
    }) as never);
    expect(res.status).toBe(200);
    const update = updateCalls.find(c => c.table === 'customer_subscriptions');
    expect(update!.data.cancelled_at).toBeTruthy();
    // Graceful cancellation: status NOT changed (paid through next_charge_at)
    expect(update!.data).not.toHaveProperty('status');
  });

  it('12. subscription.create with no platform match → no customer handler, fails for reconciliation', async () => {
    // subscription.create uses customer_code matching (platform only).
    // If no platform match, event stays failed — no customer subscription.create handler needed.
    const res = await POST(makeReq('subscription.create', {
      subscription_code: 'SUB_ORPHAN',
      customer: { customer_code: 'CUS_UNKNOWN' },
    }) as never);
    expect(res.status).toBe(500);
    // No customer_subscriptions update
    const csUpdate = updateCalls.find(c => c.table === 'customer_subscriptions');
    expect(csUpdate).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 13. Terminal state idempotency
// ═══════════════════════════════════════════════════════════

describe('Terminal state handling', () => {
  it('13. Already-cancelled customer subscription → idempotent accept', async () => {
    customerResult = {
      data: { id: 'cs_done', business_id: 'b_done', status: 'cancelled', failure_count: 3 },
      error: null,
    };
    const res = await POST(makeReq('subscription.disable', {
      subscription_code: 'SUB_DONE',
    }) as never);
    expect(res.status).toBe(200);
    // No update needed — already terminal
    const csUpdate = updateCalls.find(c => c.table === 'customer_subscriptions');
    expect(csUpdate).toBeUndefined();
  });

  it('13b. Already-cancelled platform subscription → idempotent accept', async () => {
    platformResult = {
      data: { id: 'ps_done', business_id: 'b_done', status: 'cancelled', current_period_end: '2026-10-01' },
      error: null,
    };
    const res = await POST(makeReq('subscription.not_renew', {
      subscription_code: 'SUB_P_DONE',
    }) as never);
    expect(res.status).toBe(200);
    const psUpdate = updateCalls.find(c => c.table === 'subscriptions');
    expect(psUpdate).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 14–16. Routing safety: ambiguous, unmatched, DB errors
// ═══════════════════════════════════════════════════════════

describe('Routing safety', () => {
  it('14. SubCode matches BOTH tables → fail-closed, no processing', async () => {
    platformResult = { data: { id: 'ps_dup', business_id: 'b_dup', status: 'active' }, error: null };
    customerResult = { data: { id: 'cs_dup', business_id: 'b_dup', status: 'active', failure_count: 0 }, error: null };
    const res = await POST(makeReq('subscription.not_renew', {
      subscription_code: 'SUB_AMBIGUOUS',
    }) as never);
    expect(res.status).toBe(500);
    // Neither table should be updated
    expect(updateCalls.filter(c => c.table === 'subscriptions')).toHaveLength(0);
    expect(updateCalls.filter(c => c.table === 'customer_subscriptions')).toHaveLength(0);
    // fail_webhook_event should be called
    expect(rpcCalls.some(c => c.fn === 'fail_webhook_event')).toBe(true);
  });

  it('15. SubCode matches NEITHER table → 500, event marked failed', async () => {
    // Both results already null by default
    const res = await POST(makeReq('subscription.not_renew', {
      subscription_code: 'SUB_NOWHERE',
    }) as never);
    expect(res.status).toBe(500);
    expect(rpcCalls.some(c => c.fn === 'fail_webhook_event')).toBe(true);
  });

  it('16. DB error on platform lookup → 500, claim NOT marked failed', async () => {
    platformResult = { data: null, error: { message: 'connection timeout' } };
    const res = await POST(makeReq('subscription.not_renew', {
      subscription_code: 'SUB_DBERR',
    }) as never);
    expect(res.status).toBe(500);
    // fail_webhook_event should NOT be called — claim stays active for retry
    expect(rpcCalls.some(c => c.fn === 'fail_webhook_event')).toBe(false);
  });

  it('16b. DB error on customer lookup → 500, claim NOT marked failed', async () => {
    customerResult = { data: null, error: { message: 'connection timeout' } };
    const res = await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_DBERR2',
      invoice_code: 'INV_ERR',
    }) as never);
    expect(res.status).toBe(500);
    expect(rpcCalls.some(c => c.fn === 'fail_webhook_event')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 17–20. Existing contract preservation
// ═══════════════════════════════════════════════════════════

describe('Existing contract preservation', () => {
  it('17. Missing subscription_code → 200, accepted', async () => {
    const res = await POST(makeReq('subscription.not_renew', {
      // No subscription_code
      customer: {},
    }) as never);
    expect(res.status).toBe(200);
  });

  it('18. invoice.payment_failed without invoice_code → quarantined', async () => {
    const res = await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_Q1',
      id: 'paystack_event_42',
      // No invoice_code
    }) as never);
    expect(res.status).toBe(200); // Quarantine acknowledged
    // Should NOT reach the routing logic (quarantine returns early)
    expect(updateCalls).toHaveLength(0);
  });

  it('19. Duplicate event (already completed) → 200', async () => {
    claimResult = { data: { claimed: false, reason: 'already_completed' }, error: null };
    const res = await POST(makeReq('subscription.not_renew', {
      subscription_code: 'SUB_DUP',
    }) as never);
    expect(res.status).toBe(200);
  });

  it('20. charge.success NOT intercepted by lifecycle handler', async () => {
    // charge.success should fall through to the reference-based path
    platformResult = { data: { id: 'ps_charge', business_id: 'b_charge', status: 'active' }, error: null };
    const res = await POST(makeReq('charge.success', {
      reference: 'ref_12345',
      subscription_code: 'SUB_CHARGE',
    }) as never);
    // Should NOT have called claim_webhook_event (lifecycle handler skips charge.success)
    const lifecycleClaim = rpcCalls.find(c =>
      c.fn === 'claim_webhook_event' &&
      (c.params.p_event_id as string)?.startsWith('paystack-charge.success-'),
    );
    expect(lifecycleClaim).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 21–24. Additional CTO-required coverage
// ═══════════════════════════════════════════════════════════

describe('CTO-required additional coverage', () => {
  it('21. Customer invoice.payment_failed DB update error → processingSucceeded stays false', async () => {
    // Override from() to return error on customer_subscriptions update
    const originalFrom = mockSupabase.from;
    mockSupabase.from = vi.fn((table: string) => {
      const result = originalFrom(table);
      if (table === 'customer_subscriptions') {
        result.update = vi.fn(() => {
          const chain: Record<string, ReturnType<typeof vi.fn>> = {};
          chain.eq = vi.fn(() => chain);
          (chain as Record<string, unknown>).then = (resolve: (v: unknown) => void) =>
            resolve({ error: { message: 'write_conflict' }, count: 0 });
          return chain;
        });
      }
      return result;
    });
    customerResult = {
      data: {
        id: 'cs_fail', business_id: 'cb_fail', user_id: 'cu_fail', service_id: 'sv_fail',
        amount: '1000', currency: 'NGN', customer_phone: '+234', customer_name: 'Fail',
        failure_count: 0, status: 'active',
      },
      error: null,
    };
    const res = await POST(makeReq('invoice.payment_failed', {
      subscription_code: 'SUB_WRITE_FAIL',
      invoice_code: 'INV_WF',
    }) as never);
    // Should return 500 because durable update failed
    expect(res.status).toBe(500);
    // fail_webhook_event called
    expect(rpcCalls.some(c => c.fn === 'fail_webhook_event')).toBe(true);
    mockSupabase.from = originalFrom;
  });

  it('22. Platform subscription.create without existing code (initial linking)', async () => {
    platformResult = {
      data: { id: 'ps_new', business_id: 'b_new', paystack_subscription_code: null, status: 'active' },
      error: null,
    };
    const res = await POST(makeReq('subscription.create', {
      subscription_code: 'SUB_FRESH',
      customer: { customer_code: 'CUS_NEW' },
    }) as never);
    expect(res.status).toBe(200);
    const update = updateCalls.find(c => c.table === 'subscriptions' && c.data.paystack_subscription_code === 'SUB_FRESH');
    expect(update).toBeTruthy();
  });

  it('23. Customer subscription.disable on past_due sub → cancelled', async () => {
    customerResult = {
      data: {
        id: 'cs_pd', business_id: 'cb_pd', status: 'past_due', failure_count: 2,
        gateway_subscription_code: 'SUB_PD',
      },
      error: null,
    };
    const res = await POST(makeReq('subscription.disable', {
      subscription_code: 'SUB_PD',
    }) as never);
    expect(res.status).toBe(200);
    const update = updateCalls.find(c => c.table === 'customer_subscriptions');
    expect(update!.data.status).toBe('cancelled');
  });

  it('24. Customer subscription.not_renew on paused sub → cancelled_at set', async () => {
    customerResult = {
      data: {
        id: 'cs_paused', business_id: 'cb_paused', status: 'paused',
        next_charge_at: '2026-12-01', gateway_subscription_code: 'SUB_PAUSED',
      },
      error: null,
    };
    const res = await POST(makeReq('subscription.not_renew', {
      subscription_code: 'SUB_PAUSED',
    }) as never);
    expect(res.status).toBe(200);
    const update = updateCalls.find(c => c.table === 'customer_subscriptions');
    expect(update!.data.cancelled_at).toBeTruthy();
    expect(update!.data).not.toHaveProperty('status');
  });
});
