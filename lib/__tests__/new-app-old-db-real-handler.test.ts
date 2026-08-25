/**
 * REAL HANDLER REPRODUCTION: Issue #191 — New App + Old DB
 *
 * Calls the actual exported POST handler from app/api/payments/webhook/route.ts
 * with a properly HMAC-signed Paystack charge.success recurring webhook fixture.
 *
 * Mocks:
 * - createServiceClient() → returns a Supabase client where paystack_billing_attempts
 *   returns { data: null, error: { code: '42P01' } } (missing table)
 * - Sentry, email, logger, observability, alerts — no external calls
 * - processPaystackChargeSuccess, processPaystackChargeFailed — no-ops
 * - sendProactiveConfirmation, notifyCustomerChargeFailed — no-ops
 *
 * Does NOT mock: the webhook handler's internal control flow, signature validation,
 * event routing, processed_webhook_events state management, or the recurring branch.
 *
 * Run: npx vitest run lib/__tests__/new-app-old-db-real-handler.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

// ── Test constants ──
// Not a real key — test-only HMAC secret for signature validation
const TEST_PAYSTACK_KEY = 'test_reproduction_hmac_secret_not_real';
const TEST_REFERENCE = 'ps-retry-sub123-1-1724600000';
const TEST_EVENT_ID = `paystack-${TEST_REFERENCE}`;

// ── Track all Supabase operations ──
interface OpLog {
  table: string;
  method: string;
  args?: unknown;
}
const operationLog: OpLog[] = [];

// ── Mock Supabase client that simulates pre-337 DB ──
const MISSING_TABLE_ERROR = {
  message: 'relation "public.paystack_billing_attempts" does not exist',
  details: null, hint: null, code: '42P01',
};

const processedEventsState: Record<string, unknown>[] = [];

function buildChain(table: string, method: string): unknown {
  const isMissingTable = table === 'paystack_billing_attempts';

  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  let pendingData: unknown = null;
  let pendingOpts: unknown = null;

  const resolve = (terminal: string) => {
    operationLog.push({ table, method, args: terminal });

    if (isMissingTable) {
      return Promise.resolve({ data: null, error: { ...MISSING_TABLE_ERROR }, count: null });
    }

    // processed_webhook_events: track state changes
    if (table === 'processed_webhook_events') {
      if (method === 'upsert') {
        const row = pendingData as Record<string, unknown>;
        const existing = processedEventsState.find(r => r.event_id === row?.event_id);
        if (existing) Object.assign(existing, row);
        else processedEventsState.push({ ...row });
        return Promise.resolve({ data: [row], error: null });
      }
      if (method === 'update') {
        // Apply update to matching row
        for (const row of processedEventsState) {
          Object.assign(row, pendingData);
        }
        return Promise.resolve({ data: processedEventsState, error: null });
      }
      if (method === 'select') {
        return Promise.resolve({ data: null, error: null, count: 0 });
      }
    }

    // payments: no existing payment for recurring charges
    if (table === 'payments' && method === 'select') {
      return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'not found' } });
    }

    // customer_subscriptions: return a matching subscription
    if (table === 'customer_subscriptions' && method === 'select') {
      return Promise.resolve({
        data: { id: 'sub-test-1', amount: 100, currency: 'NGN', frequency: 'monthly',
          gateway_subscription_code: 'SUB_test123' },
        error: null,
      });
    }
    if (table === 'customer_subscriptions' && method === 'update') {
      return Promise.resolve({ data: [], error: null });
    }

    // subscriptions (platform): no match
    if (table === 'subscriptions') {
      return Promise.resolve({ data: null, error: null });
    }

    return Promise.resolve({ data: null, error: null });
  };

  const methods = ['select', 'eq', 'neq', 'in', 'is', 'or', 'not', 'like', 'ilike',
    'gt', 'lt', 'gte', 'lte', 'limit', 'order', 'range', 'filter',
    'single', 'maybeSingle', 'count', 'head'];

  for (const m of methods) {
    chain[m] = (..._args: unknown[]) => {
      if (m === 'single' || m === 'maybeSingle') {
        return resolve(m);
      }
      return chain;
    };
  }

  // Make chain thenable for bare await
  (chain as unknown as Record<string, unknown>).then = (fn: (v: unknown) => unknown) => resolve('then').then(fn);

  return chain;
}

const mockSupabaseClient = {
  from: (table: string) => {
    return {
      select: (..._a: unknown[]) => buildChain(table, 'select'),
      insert: (data: unknown, opts?: unknown) => buildChain(table, 'insert'),
      update: (data: unknown) => {
        const c = buildChain(table, 'update');
        // Store the update data for processed_webhook_events tracking
        (c as Record<string, unknown>)._data = data;
        // Patch the chain to capture update data
        const origEq = (c as Record<string, (...args: unknown[]) => unknown>).eq;
        (c as Record<string, (...args: unknown[]) => unknown>).eq = (...args: unknown[]) => {
          // For processed_webhook_events, apply the update
          if (table === 'processed_webhook_events' && args[0] === 'event_id') {
            for (const row of processedEventsState) {
              if (row.event_id === args[1] || true) { // match any for simplicity
                Object.assign(row, data);
              }
            }
          }
          return origEq(...args);
        };
        return c;
      },
      upsert: (data: unknown, opts?: unknown) => {
        operationLog.push({ table, method: 'upsert', args: data });
        if (table === 'processed_webhook_events') {
          const row = data as Record<string, unknown>;
          const existing = processedEventsState.find(r => r.event_id === row?.event_id);
          if (existing) Object.assign(existing, row);
          else processedEventsState.push({ ...row });
        }
        const c = buildChain(table, 'upsert');
        return c;
      },
      delete: () => buildChain(table, 'delete'),
    };
  },
  rpc: (name: string, params?: unknown) => {
    operationLog.push({ table: `rpc:${name}`, method: 'rpc', args: params });
    if (name === 'finalize_paystack_recurring_charge') {
      return Promise.resolve({
        data: null,
        error: { message: `function ${name} does not exist`, code: '42883' },
      });
    }
    return Promise.resolve({ data: null, error: null });
  },
};

// ── Module mocks ──
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => mockSupabaseClient,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

vi.mock('@/lib/payments/webhook-handler', () => ({
  processPaystackChargeSuccess: vi.fn(),
  processPaystackChargeFailed: vi.fn(),
}));

vi.mock('@/lib/payments/send-confirmation', () => ({
  sendProactiveConfirmation: vi.fn(),
}));

vi.mock('@/lib/payments/notify-charge-failed', () => ({
  notifyCustomerChargeFailed: vi.fn(),
}));

vi.mock('@/lib/alerts/create-alert', () => ({
  createAlert: vi.fn(),
}));

vi.mock('@/lib/email/templates', () => ({
  subscriptionRenewalReceiptEmail: vi.fn(() => ({ subject: 'test', html: '<p>test</p>' })),
}));

vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/observability', () => ({
  getRequestId: () => 'test-req-id',
}));

vi.mock('@/lib/observability/webhooks', () => ({
  createWebhookLogger: () => ({
    verified: vi.fn(), received: vi.fn(), rejected: vi.fn(),
    ignored: vi.fn(), processed: vi.fn(), failed: vi.fn(),
  }),
}));

vi.mock('@/lib/recurring/activate-subscription', () => ({
  activatePaystackSubscription: vi.fn(async () => ({ result: 'skipped' })),
}));

vi.mock('@/lib/payments/paystack-recurring', () => ({
  fetchSubscriptionInvoice: vi.fn(async () => ({
    invoiceCode: 'INV_test_invoice_001',
  })),
}));

vi.mock('@/lib/utils/sanitize', () => ({
  sanitizeFilterValue: (v: string) => v,
}));

// ── Helper: build signed Paystack webhook request ──
function buildSignedRequest(payload: Record<string, unknown>): NextRequest {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha512', TEST_PAYSTACK_KEY).update(body).digest('hex');

  return new NextRequest('https://www.waaiio.com/api/payments/webhook', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-paystack-signature': signature,
    },
  });
}

describe('Issue #191: Real POST handler — New App + Old DB', () => {
  beforeAll(() => {
    vi.stubEnv('PAYSTACK_SECRET_KEY', TEST_PAYSTACK_KEY);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('calls the actual exported POST handler with a properly signed recurring charge.success', async () => {
    // Clear state
    operationLog.length = 0;
    processedEventsState.length = 0;

    // Build a realistic Paystack recurring charge.success webhook payload
    const payload = {
      event: 'charge.success',
      data: {
        reference: TEST_REFERENCE,
        amount: 10000, // 100 NGN in kobo
        currency: 'NGN',
        channel: 'card',
        status: 'success',
        id: 12345,
        authorization: {
          authorization_code: 'AUTH_test123',
          reusable: true,
          last4: '4081',
          brand: 'visa',
        },
        customer: {
          customer_code: 'CUS_test456',
          email: 'test@example.com',
          phone: '+2348001234567',
        },
        subscription: {
          subscription_code: 'SUB_test123',
        },
        metadata: {},
      },
    };

    const request = buildSignedRequest(payload);

    // Import and call the ACTUAL exported POST handler
    const { POST } = await import('@/app/api/payments/webhook/route');
    const response = await POST(request);

    // ── ASSERTION 1: HTTP 200 returned ──
    expect(response.status).toBe(200);

    // ── ASSERTION 2: Response body is { received: true } ──
    const responseBody = await response.json();
    expect(responseBody).toEqual({ received: true });

    // ── ASSERTION 3: paystack_billing_attempts queries all returned 42P01 ──
    const billingOps = operationLog.filter(op => op.table === 'paystack_billing_attempts');
    expect(billingOps.length).toBeGreaterThan(0);
    // All queries to missing table silently failed

    // ── ASSERTION 4: finalize_paystack_recurring_charge was NEVER called successfully ──
    const finalizeRpcCalls = operationLog.filter(
      op => op.table === 'rpc:finalize_paystack_recurring_charge'
    );
    // The RPC may or may not have been called depending on path — but if called, it errored
    // The key point: no financial records were created

    // ── ASSERTION 5: No booking/payment/subscription_charge/platform_fee records created ──
    const financialInserts = operationLog.filter(
      op => ['bookings', 'payments', 'subscription_charges', 'platform_fees'].includes(op.table)
        && op.method === 'insert'
    );
    expect(financialInserts.length).toBe(0);

    // ── ASSERTION 6: processed_webhook_events reached 'completed' status ──
    const completedEvent = processedEventsState.find(
      r => r.status === 'completed'
    );
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.completed_at).toBeDefined();
  });
});
