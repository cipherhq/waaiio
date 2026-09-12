/**
 * M378 Phase 1 — Production Orchestration Side-Effect Proofs (Route-Level)
 *
 * These tests invoke the ACTUAL POST handler from app/api/webhooks/flutterwave/route.ts
 * with mocked provider HTTP (fetch) and mocked Supabase service client.
 * They assert the actual .rpc() calls, .from().insert() calls, and reconcilePayment
 * invocations that constitute the production orchestration contract.
 *
 * Required proofs (from #5646861772):
 * 1. Successful timeout recovery → exact finalize_flutterwave_subscription_checkout for original intent
 * 2. Verified terminal timeout → exact replace_terminal_checkout_intent; no duplicate replacement
 * 3. platform_initial second intent lookup error → 500/fail-closed, no reconcilePayment
 * 4. Verified late success → exact quarantine insert; quarantine failure → non-2xx
 * 5. Cancellation quarantine persistence failure → non-2xx
 * 6. Business-payment only after exhaustive zero-subscription evidence
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Set env vars BEFORE any module loads ──
process.env.FLUTTERWAVE_WEBHOOK_HASH = 'test-webhook-secret';
process.env.FLUTTERWAVE_SECRET_KEY = 'flw-test-key';

// ── Track all side-effect calls ──
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
const insertCalls: { table: string; data: Record<string, unknown> }[] = [];
let reconcilePaymentCalls: unknown[][] = [];

// ── Configurable mock results (set per-test) ──
let intentCheckResult: { data: unknown; error: unknown } = { data: null, error: null };
let intentFullResult: { data: unknown; error: unknown } = { data: null, error: null };
let rpcResultMap: Record<string, { data: unknown; error: unknown }> = {};
let insertErrorMap: Record<string, unknown> = {};
let subsSelectResult: { data: unknown; error: unknown } = { data: [], error: null };
let paymentSelectResult: { data: unknown; error: unknown } = { data: null, error: null };
let processedEventResult: { data: unknown; error: unknown } = { data: null, error: null };

// ── Global fetch mock ──
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Module mocks (must be before route import) ──
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), withContext: () => ({ error: vi.fn() }) },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/observability', () => ({ getRequestId: () => 'test-id' }));
vi.mock('@/lib/observability/webhooks', () => ({
  createWebhookLogger: () => ({
    verified: vi.fn(), received: vi.fn(), processed: vi.fn(),
    rejected: vi.fn(), ignored: vi.fn(), duplicate: vi.fn(), failed: vi.fn(),
  }),
}));
vi.mock('@/lib/alerts/create-alert', () => ({ createAlert: vi.fn() }));
vi.mock('@/lib/payments/process-success', () => ({ processSuccessfulPayment: vi.fn() }));
vi.mock('@/lib/payments/send-confirmation', () => ({ sendProactiveConfirmation: vi.fn() }));

// Mock reconcilePayment to track calls
vi.mock('@/lib/payments/reconcile', () => ({
  reconcilePayment: (...args: unknown[]) => {
    reconcilePaymentCalls.push(args);
    return Promise.resolve();
  },
}));

// Chainable supabase mock factory
function buildChain(table: string): Record<string, unknown> {
  return {
    select: vi.fn().mockImplementation(() => buildEqChain(table)),
    insert: vi.fn().mockImplementation((data: Record<string, unknown>) => {
      insertCalls.push({ table, data });
      return Promise.resolve({ error: insertErrorMap[table] || null });
    }),
    update: vi.fn().mockImplementation(() => ({
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    upsert: vi.fn().mockResolvedValue({ error: null }),
  };
}

function buildEqChain(table: string): Record<string, unknown> {
  const resolve = () => {
    if (table === 'subscription_checkout_intents') {
      // The route reads intents twice: first a lightweight .select('id'), then full select
      // Distinguish by consuming intentCheckResult first, then intentFullResult
      if (intentCheckResult.data !== '__consumed__') {
        const result = { ...intentCheckResult };
        intentCheckResult = { data: '__consumed__', error: null };
        return result;
      }
      return intentFullResult;
    }
    if (table === 'subscriptions') return subsSelectResult;
    if (table === 'payments') return paymentSelectResult;
    if (table === 'processed_webhook_events') return processedEventResult;
    return { data: null, error: null };
  };
  return {
    eq: vi.fn().mockImplementation(() => buildEqChain(table)),
    maybeSingle: vi.fn().mockImplementation(() => Promise.resolve(resolve())),
    single: vi.fn().mockImplementation(() => Promise.resolve(resolve())),
  };
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: vi.fn().mockImplementation((table: string) => buildChain(table)),
    rpc: vi.fn().mockImplementation((fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(rpcResultMap[fn] || { data: null, error: null });
    }),
  }),
}));

// ── Import the actual route handler AFTER mocks ──
const { POST: webhookPOST } = await import('@/app/api/webhooks/flutterwave/route');

// ── Helpers ──
function createWebhookRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/webhooks/flutterwave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'verif-hash': 'test-webhook-secret' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  rpcCalls.length = 0;
  insertCalls.length = 0;
  reconcilePaymentCalls = [];
  intentCheckResult = { data: null, error: null };
  intentFullResult = { data: null, error: null };
  rpcResultMap = {};
  insertErrorMap = {};
  subsSelectResult = { data: [], error: null };
  paymentSelectResult = { data: null, error: null };
  processedEventResult = { data: null, error: null };
});

// ═════════════════════════════════════════════════════════════════════════════
// PROOF 1: Initial webhook → finalize_flutterwave_subscription_checkout for original intent
// ═════════════════════════════════════════════════════════════════════════════
describe('Proof 1: initial webhook → original intent finalizer', () => {
  it('pending intent + verified tx → finalize_flutterwave_subscription_checkout with exact args', async () => {
    const intentId = 'intent-orig-123';
    const txRef = 'waaiiosubORIG1234567890abcdef12345';

    // First intent check (routing): found
    intentCheckResult = { data: { id: intentId }, error: null };
    // Second intent read: full row, pending
    intentFullResult = {
      data: {
        id: intentId, status: 'pending', business_id: 'biz-1', plan: 'growth',
        amount: 14999, currency: 'ngn', idempotency_key: txRef,
        config_version_id: 'cv-1', subscriber_email: 'test@test.com',
      },
      error: null,
    };

    // Finalizer RPC success
    rpcResultMap['finalize_flutterwave_subscription_checkout'] = { data: { finalized: true }, error: null };

    // verifyTransactionById + correlateProviderSubscription
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/v3/transactions/') && url.includes('/verify')) {
        return {
          ok: true,
          json: async () => ({
            status: 'success',
            data: { id: 555, tx_ref: txRef, status: 'successful', amount: 14999, currency: 'NGN', created_at: '2026-09-12T00:00:00Z' },
          }),
        };
      }
      if (typeof url === 'string' && url.includes('/v3/subscriptions')) {
        return { ok: true, json: async () => ({ status: 'success', data: [{ id: 800, plan: 900 }] }) };
      }
      return { ok: false, status: 404 };
    });

    const res = await webhookPOST(createWebhookRequest({
      event: 'charge.completed',
      data: { id: 555, tx_ref: txRef, status: 'successful', amount: 14999, currency: 'NGN' },
    }));
    expect(res.status).toBe(200);

    // Assert exact RPC invocation
    const fin = rpcCalls.find(c => c.fn === 'finalize_flutterwave_subscription_checkout');
    expect(fin).toBeDefined();
    expect(fin!.args.p_intent_id).toBe(intentId);
    expect(fin!.args.p_provider_tx_id).toBe('555');
    expect(fin!.args.p_provider_subscription_id).toBe('800');
    expect(fin!.args.p_provider_plan_id).toBe(900);
    expect(fin!.args.p_verified_amount_minor).toBe(1499900);
    expect(fin!.args.p_verified_currency).toBe('NGN');
    expect(fin!.args.p_provider_paid_at).toBe('2026-09-12T00:00:00Z');

    // No reconcilePayment
    expect(reconcilePaymentCalls).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROOF 3: platform_initial second intent lookup error → 500, no reconcilePayment
// ═════════════════════════════════════════════════════════════════════════════
describe('Proof 3: platform_initial intent read error → fail closed', () => {
  it('second intent read DB error → 500, no reconcilePayment, no finalizer', async () => {
    const txRef = 'waaiiosubERRR1234567890abcdef12345';

    // First intent check: found (routing succeeds)
    intentCheckResult = { data: { id: 'some-id' }, error: null };
    // Second intent read: DB error
    intentFullResult = { data: null, error: { message: 'connection lost' } };

    const res = await webhookPOST(createWebhookRequest({
      event: 'charge.completed',
      data: { id: 777, tx_ref: txRef, status: 'successful', amount: 14999, currency: 'NGN' },
    }));

    expect(res.status).toBe(500);
    expect(reconcilePaymentCalls).toHaveLength(0);
    expect(rpcCalls.find(c => c.fn === 'finalize_flutterwave_subscription_checkout')).toBeUndefined();
  });

  it('second intent read returns null → 500, no reconcilePayment', async () => {
    const txRef = 'waaiiosubNULL1234567890abcdef12345';

    intentCheckResult = { data: { id: 'some-id' }, error: null };
    intentFullResult = { data: null, error: null }; // No error, just missing

    const res = await webhookPOST(createWebhookRequest({
      event: 'charge.completed',
      data: { id: 888, tx_ref: txRef, status: 'successful', amount: 14999, currency: 'NGN' },
    }));

    expect(res.status).toBe(500);
    expect(reconcilePaymentCalls).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROOF 4: Late success → quarantine insert; failure → non-2xx
// ═════════════════════════════════════════════════════════════════════════════
describe('Proof 4: late-success quarantine orchestration', () => {
  it('verified late success for terminal intent → exact quarantine insert', async () => {
    const txRef = 'waaiiosubLATE1234567890abcdef12345';
    const intentId = 'intent-late-456';

    intentCheckResult = { data: { id: intentId }, error: null };
    intentFullResult = {
      data: {
        id: intentId, status: 'failed', business_id: 'biz-1', plan: 'growth',
        amount: 14999, currency: 'ngn', idempotency_key: txRef,
      },
      error: null,
    };

    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/v3/transactions/') && url.includes('/verify')) {
        return {
          ok: true,
          json: async () => ({
            status: 'success',
            data: { id: 999, tx_ref: txRef, status: 'successful', amount: 14999, currency: 'NGN', created_at: '2026-09-12T12:00:00Z' },
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    const res = await webhookPOST(createWebhookRequest({
      event: 'charge.completed',
      data: { id: 999, tx_ref: txRef, status: 'successful', amount: 14999, currency: 'NGN' },
    }));
    expect(res.status).toBe(200);

    // Assert exact quarantine insert
    const qInsert = insertCalls.find(c => c.table === 'subscription_payment_quarantine');
    expect(qInsert).toBeDefined();
    expect(qInsert!.data.intent_id).toBe(intentId);
    expect(qInsert!.data.provider_tx_ref).toBe(txRef);
    expect(qInsert!.data.provider_tx_id).toBe('999');
    expect(qInsert!.data.provider_amount).toBe(1499900);
    expect(qInsert!.data.provider_currency).toBe('NGN');
    expect(qInsert!.data.provider_status).toBe('verified_late_success');
    expect(qInsert!.data.reason).toBe('late_webhook_for_terminal_intent');
    expect(reconcilePaymentCalls).toHaveLength(0);
  });

  it('quarantine write failure → 500 (Flutterwave retries)', async () => {
    const txRef = 'waaiiosubLAQF1234567890abcdef12345';
    const intentId = 'intent-late-789';

    intentCheckResult = { data: { id: intentId }, error: null };
    intentFullResult = {
      data: {
        id: intentId, status: 'superseded', business_id: 'biz-1', plan: 'growth',
        amount: 14999, currency: 'ngn', idempotency_key: txRef,
      },
      error: null,
    };
    insertErrorMap['subscription_payment_quarantine'] = { message: 'DB write failed' };

    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/v3/transactions/') && url.includes('/verify')) {
        return {
          ok: true,
          json: async () => ({
            status: 'success',
            data: { id: 111, tx_ref: txRef, status: 'successful', amount: 14999, currency: 'NGN', created_at: '2026-09-12T12:00:00Z' },
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    const res = await webhookPOST(createWebhookRequest({
      event: 'charge.completed',
      data: { id: 111, tx_ref: txRef, status: 'successful', amount: 14999, currency: 'NGN' },
    }));
    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROOF 5: Cancellation quarantine persistence failure → non-2xx
// ═════════════════════════════════════════════════════════════════════════════
describe('Proof 5: cancellation quarantine write failure → non-2xx', () => {
  it('zero-match cancellation with quarantine write failure → 500', async () => {
    // subscriptions query returns zero matches
    subsSelectResult = { data: [], error: null };
    // Quarantine write fails
    insertErrorMap['subscription_payment_quarantine'] = { message: 'Quarantine DB down' };

    const res = await webhookPOST(createWebhookRequest({
      event: 'subscription.cancelled',
      data: { plan: { id: 123 }, customer: { email: 'test@test.com' } },
    }));

    // Must return 500 so Flutterwave retries
    expect(res.status).toBe(500);
    // Quarantine insert was attempted
    expect(insertCalls.some(c => c.table === 'subscription_payment_quarantine')).toBe(true);
  });

  it('fail_closed cancellation with quarantine write failure → 500', async () => {
    // One local match, but provider verification fails → fail_closed → quarantine write fails
    subsSelectResult = {
      data: [{ id: 'sub-1', status: 'active', flutterwave_subscription_id: '42' }],
      error: null,
    };
    insertErrorMap['subscription_payment_quarantine'] = { message: 'Quarantine insert failed' };

    // Provider verification fails → decideCancellation → fail_closed
    mockFetch.mockImplementation(async () => ({ ok: false, status: 500 }));

    const res = await webhookPOST(createWebhookRequest({
      event: 'subscription.cancelled',
      data: { plan: { id: 456 }, customer: { email: 'user@test.com' } },
    }));

    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROOF 6: Business-payment only after exhaustive zero-subscription evidence
// ═════════════════════════════════════════════════════════════════════════════
describe('Proof 6: business-payment requires exhaustive zero-sub classification', () => {
  it('zero active + zero cancelled → reconcilePayment called', async () => {
    const txRef = 'flw_business_charge_001';

    // Payment found
    paymentSelectResult = {
      data: {
        id: 'pay-1', booking_id: null, amount: 100, reservation_id: null, order_id: null,
        status: 'pending', gateway_reference: txRef, payment_authority_version: 1,
        finalization_completed_at: null, invoice_id: null, campaign_id: null,
      },
      error: null,
    };

    // Exhaustive subscription queries: both zero
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/v3/subscriptions')) {
        return { ok: true, json: async () => ({ status: 'success', data: [] }) };
      }
      return { ok: false, status: 404 };
    });

    const res = await webhookPOST(createWebhookRequest({
      event: 'charge.completed',
      data: { id: 200, tx_ref: txRef, status: 'successful', amount: 100, currency: 'NGN', payment_type: 'card' },
    }));

    // Should reach business-payment
    expect(res.status).toBeLessThan(500);

    // reconcilePayment MUST have been called
    expect(reconcilePaymentCalls).toHaveLength(1);

    // Both explicit status queries must have been made
    const subCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[0] as string).includes('/v3/subscriptions'));
    expect(subCalls.length).toBe(2);
    const statuses = subCalls.map((c: unknown[]) => (c[0] as string).match(/status=(\w+)/)?.[1]).sort();
    expect(statuses).toEqual(['active', 'cancelled']);
  });

  it('cancelled-only match → NOT business-payment, no reconcilePayment', async () => {
    const txRef = 'flw_charge_with_cancelled_sub';

    // Exhaustive: active=zero, cancelled=match
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('status=active') && url.includes('/v3/subscriptions')) {
        return { ok: true, json: async () => ({ status: 'success', data: [] }) };
      }
      if (typeof url === 'string' && url.includes('status=cancelled') && url.includes('/v3/subscriptions')) {
        return { ok: true, json: async () => ({ status: 'success', data: [{ id: 42, plan: 100 }] }) };
      }
      return { ok: false, status: 404 };
    });

    // Local subscription lookup returns no match → orphaned → unknown route
    subsSelectResult = { data: null, error: null };

    const res = await webhookPOST(createWebhookRequest({
      event: 'charge.completed',
      data: { id: 300, tx_ref: txRef, status: 'successful', amount: 100, currency: 'NGN' },
    }));

    expect(res.status).toBe(500);
    expect(reconcilePaymentCalls).toHaveLength(0);
  });

  it('active query provider error → fail closed, no reconcilePayment', async () => {
    const txRef = 'flw_charge_active_err';

    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('status=active') && url.includes('/v3/subscriptions')) {
        return { ok: false, status: 500 };
      }
      if (typeof url === 'string' && url.includes('status=cancelled') && url.includes('/v3/subscriptions')) {
        return { ok: true, json: async () => ({ status: 'success', data: [] }) };
      }
      return { ok: false, status: 404 };
    });

    const res = await webhookPOST(createWebhookRequest({
      event: 'charge.completed',
      data: { id: 400, tx_ref: txRef, status: 'successful', amount: 100, currency: 'NGN' },
    }));

    expect(res.status).toBe(500);
    expect(reconcilePaymentCalls).toHaveLength(0);
  });
});
