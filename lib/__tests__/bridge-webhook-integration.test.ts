/**
 * Bridge v3.1 — Actual POST handler integration tests (#191)
 *
 * Tests the real exported POST handler from app/api/payments/webhook/route.ts
 * with the bridge resolver wired in. Covers pre-337 and post-337 scenarios,
 * role gating, schema probing, and the critical invariant that multiple
 * pending setup matches never route into D/E/#176.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

const TEST_HMAC_KEY = 'not-a-real-key-bridge-integration-191';

// ═══════════════════════════════════════════════════════════
// PostgREST error shapes
// ═══════════════════════════════════════════════════════════

const MISSING_TABLE_ERROR = {
  code: '42P01',
  message: 'relation "public.paystack_billing_attempts" does not exist',
  details: null,
  hint: null,
};

// ═══════════════════════════════════════════════════════════
// Mock Supabase client factory
// ═══════════════════════════════════════════════════════════

interface MockConfig {
  existingPayment?: Record<string, unknown> | null;
  platformSub?: Record<string, unknown> | null;
  customerSub?: Record<string, unknown> | null;
  pendingSetupSubs?: Array<{ id: string }>;
  schemaReady?: boolean;
}

function buildServiceMock(config: MockConfig = {}) {
  const eventUpdates: Array<{ status: string; last_error?: string }> = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const queriedTables: string[] = [];

  function createChain(tableName: string): Record<string, unknown> {
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        if (prop === 'single') {
          return vi.fn(() => {
            switch (tableName) {
              case 'processed_webhook_events':
                return Promise.resolve({ data: { id: '1', status: 'processing', attempts: 1 }, error: null });
              case 'payments':
                return Promise.resolve({ data: config.existingPayment ?? null, error: null });
              case 'subscriptions':
                return Promise.resolve({ data: config.platformSub ?? null, error: null });
              case 'paystack_billing_attempts':
                return config.schemaReady
                  ? Promise.resolve({ data: null, error: null })
                  : Promise.resolve({ data: null, error: MISSING_TABLE_ERROR });
              default:
                return Promise.resolve({ data: null, error: null });
            }
          });
        }

        if (prop === 'maybeSingle') {
          return vi.fn(() => {
            switch (tableName) {
              case 'payments':
                return Promise.resolve({ data: config.existingPayment ?? null, error: null });
              case 'subscriptions':
                return Promise.resolve({ data: config.platformSub ?? null, error: null });
              case 'customer_subscriptions':
                return Promise.resolve({ data: config.customerSub ?? null, error: null });
              case 'paystack_billing_attempts':
                return config.schemaReady
                  ? Promise.resolve({ data: null, error: null })
                  : Promise.resolve({ data: null, error: MISSING_TABLE_ERROR });
              default:
                return Promise.resolve({ data: null, error: null });
            }
          });
        }

        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            if (tableName === 'customer_subscriptions') {
              // Setup lookup returns array
              resolve({ data: config.pendingSetupSubs ?? [], error: null });
            } else if (tableName === 'paystack_billing_attempts') {
              resolve(config.schemaReady
                ? { data: null, error: null }
                : { data: null, error: MISSING_TABLE_ERROR });
            } else {
              resolve({ data: null, error: null });
            }
          };
        }

        return vi.fn((...args: unknown[]) => {
          if (tableName === 'processed_webhook_events' && prop === 'update' && args[0]) {
            const update = args[0] as Record<string, unknown>;
            if (update.status) {
              eventUpdates.push({
                status: update.status as string,
                last_error: update.last_error as string | undefined,
              });
            }
          }
          return proxy;
        });
      },
    };

    const proxy = new Proxy({} as Record<string, unknown>, handler);
    return proxy;
  }

  const fromFn = vi.fn((tableName: string) => {
    queriedTables.push(tableName);
    return createChain(tableName);
  });

  const rpcFn = vi.fn((fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    if (!config.schemaReady) {
      return Promise.resolve({ data: null, error: MISSING_TABLE_ERROR });
    }
    return Promise.resolve({ data: { success: true, payment_id: 'pay-fin-1' }, error: null });
  });

  return {
    client: { from: fromFn, rpc: rpcFn },
    eventUpdates,
    rpcCalls,
    queriedTables,
    fromFn,
  };
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function computeHmac(body: string): string {
  return createHmac('sha512', TEST_HMAC_KEY).update(body).digest('hex');
}

function makeWebhookBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'charge.success',
    data: {
      reference: 'ref-test-123',
      amount: 500000,
      currency: 'NGN',
      id: 99001,
      status: 'success',
      authorization: { authorization_code: 'AUTH_x', reusable: true, last4: '4081', brand: 'visa' },
      customer: { customer_code: 'CUS_x', email: 'a@b.com', phone: '+234123' },
      metadata: {},
      ...overrides,
    },
  };
}

// ═══════════════════════════════════════════════════════════
// Test runner
// ═══════════════════════════════════════════════════════════

describe('Bridge v3.1: Actual POST handler integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.PAYSTACK_SECRET_KEY = TEST_HMAC_KEY;
  });

  async function callPOST(
    webhookBody: Record<string, unknown>,
    mockConfig: MockConfig,
  ) {
    const mockData = buildServiceMock(mockConfig);

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => mockData.client),
    }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn().mockResolvedValue(undefined),
      processPaystackChargeFailed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/payments/send-confirmation', () => ({
      sendProactiveConfirmation: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/payments/notify-charge-failed', () => ({
      notifyCustomerChargeFailed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/alerts/create-alert', () => ({
      createAlert: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/email/templates', () => ({
      subscriptionRenewalReceiptEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p>t</p>' }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() },
    }));
    vi.doMock('@/lib/observability', () => ({ getRequestId: vi.fn().mockReturnValue('req-1') }));
    vi.doMock('@/lib/observability/webhooks', () => ({
      createWebhookLogger: vi.fn().mockReturnValue({
        received: vi.fn(), verified: vi.fn(), rejected: vi.fn(), accepted: vi.fn(),
        ignored: vi.fn(), duplicate: vi.fn(), processed: vi.fn(), failed: vi.fn(),
      }),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
    vi.doMock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: vi.fn((v: string) => v) }));
    vi.doMock('@/lib/recurring/activate-subscription', () => ({
      activatePaystackSubscription: vi.fn().mockResolvedValue({ result: 'skipped' }),
    }));
    vi.doMock('@/lib/payments/paystack-recurring', () => ({
      fetchSubscriptionInvoice: vi.fn().mockResolvedValue({ invoiceCode: 'INV_test', invoiceId: 'inv-1', paidAt: new Date().toISOString() }),
    }));

    const { POST } = await import('../../app/api/payments/webhook/route');

    const rawBody = JSON.stringify(webhookBody);
    const request = new NextRequest('http://localhost:3000/api/payments/webhook', {
      method: 'POST',
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': computeHmac(rawBody),
      },
    });

    const response = await POST(request);
    const json = await response.json();

    return { status: response.status, json, mockData };
  }

  // ── Role A: One-time payment with existing payment row ──

  it('Role A: returns 200, Block 4 never entered', async () => {
    const body = makeWebhookBody();
    const { status, mockData } = await callPOST(body, {
      existingPayment: { id: 'pay-1', status: 'pending', amount: 5000, booking_id: 'bk-1', gateway: 'paystack' },
    });

    expect(status).toBe(200);
    // paystack_billing_attempts never queried (role A skips Block 4)
    expect(mockData.queriedTables).not.toContain('paystack_billing_attempts');
    // Event reaches completed
    const completions = mockData.eventUpdates.filter(u => u.status === 'completed');
    expect(completions.length).toBeGreaterThanOrEqual(1);
  });

  // ── Role B: Setup with payment row ──

  it('Role B: setup with payment → 200, Block 4 skipped', async () => {
    const body = makeWebhookBody();
    const { status, mockData } = await callPOST(body, {
      existingPayment: { id: 'pay-1', status: 'pending', amount: 5000, booking_id: null, gateway: 'paystack' },
      pendingSetupSubs: [{ id: 'cs-setup-1' }],
    });

    expect(status).toBe(200);
    expect(mockData.queriedTables).not.toContain('paystack_billing_attempts');
  });

  // ── Role B: Setup WITHOUT payment row ──

  it('Role B: setup without payment → 200, Block 4 skipped', async () => {
    const body = makeWebhookBody();
    const { status, mockData } = await callPOST(body, {
      existingPayment: null,
      pendingSetupSubs: [{ id: 'cs-setup-1' }],
    });

    expect(status).toBe(200);
    expect(mockData.queriedTables).not.toContain('paystack_billing_attempts');
  });

  // ── Role B: Multiple pending setup matches → still B, never D/E ──

  it('Role B: multiple pending setups → role B, never enters D/E or probes #176', async () => {
    const body = makeWebhookBody();
    const { status, mockData } = await callPOST(body, {
      existingPayment: null,
      pendingSetupSubs: [{ id: 'cs-1' }, { id: 'cs-2' }],
    });

    expect(status).toBe(200);
    expect(mockData.queriedTables).not.toContain('paystack_billing_attempts');
    // No finalization RPC
    expect(mockData.rpcCalls.length).toBe(0);
  });

  // ── Role C: Platform renewal ──

  it('Role C: platform renewal → 200, Block 4 skipped', async () => {
    const body = makeWebhookBody({
      subscription: { subscription_code: 'SUB_platform_123' },
    });
    const { status, mockData } = await callPOST(body, {
      existingPayment: null,
      platformSub: { id: 'plat-1', business_id: 'biz-1', plan: 'growth', paystack_subscription_code: 'SUB_platform_123' },
    });

    expect(status).toBe(200);
    expect(mockData.queriedTables).not.toContain('paystack_billing_attempts');
  });

  // ── Role D: Cron recurring, pre-337 ──

  it('Role D pre-337: cron charge → schema fails → 503', async () => {
    const body = makeWebhookBody({ reference: 'ps-retry-sub1-1-123' });
    (body.data as Record<string, unknown>).reference = 'ps-retry-sub1-1-123';

    const { status, json, mockData } = await callPOST(body, {
      existingPayment: null,
      schemaReady: false,
    });

    expect(status).toBe(503);
    expect(json.error).toContain('#176 prerequisites');
    // Event marked failed, not completed
    const failures = mockData.eventUpdates.filter(u => u.status === 'failed');
    expect(failures.length).toBeGreaterThanOrEqual(1);
    const completions = mockData.eventUpdates.filter(u => u.status === 'completed');
    expect(completions.length).toBe(0);
  });

  // ── Role D: Cron recurring, post-337 ──

  it('Role D post-337: cron charge → schema ready → enters #176 path → 200', async () => {
    const body = makeWebhookBody({ reference: 'ps-retry-sub1-1-123' });
    (body.data as Record<string, unknown>).reference = 'ps-retry-sub1-1-123';

    const { status, mockData } = await callPOST(body, {
      existingPayment: null,
      schemaReady: true,
    });

    expect(status).toBe(200);
    // paystack_billing_attempts WAS queried (schema probe + existing attempt lookup)
    expect(mockData.queriedTables).toContain('paystack_billing_attempts');
  });

  // ── Role E: Provider-managed recurring, pre-337 ──

  it('Role E pre-337: provider-managed charge → schema fails → 503', async () => {
    const body = makeWebhookBody({
      subscription: { subscription_code: 'SUB_customer_abc' },
    });
    const { status, json, mockData } = await callPOST(body, {
      existingPayment: null,
      customerSub: { id: 'cs-1', amount: 5000, currency: 'NGN', frequency: 'monthly' },
      schemaReady: false,
    });

    expect(status).toBe(503);
    expect(json.error).toContain('#176 prerequisites');
    const failures = mockData.eventUpdates.filter(u => u.status === 'failed');
    expect(failures.length).toBeGreaterThanOrEqual(1);
    const completions = mockData.eventUpdates.filter(u => u.status === 'completed');
    expect(completions.length).toBe(0);
  });

  // ── Role E: Provider-managed recurring, post-337 ──

  it('Role E post-337: provider-managed charge → schema ready → enters #176 path → 200', async () => {
    const body = makeWebhookBody({
      subscription: { subscription_code: 'SUB_customer_abc' },
    });
    const { status, mockData } = await callPOST(body, {
      existingPayment: null,
      customerSub: { id: 'cs-1', amount: 5000, currency: 'NGN', frequency: 'monthly' },
      schemaReady: true,
    });

    expect(status).toBe(200);
    expect(mockData.queriedTables).toContain('paystack_billing_attempts');
  });

  // ── Role F: Unresolved ──

  it('Role F: unresolved charge → 200, parked, no paystack_billing_attempts access', async () => {
    const body = makeWebhookBody();
    const { status, mockData } = await callPOST(body, {
      existingPayment: null,
      schemaReady: false,
    });

    expect(status).toBe(200);
    // paystack_billing_attempts never queried (role F doesn't touch it)
    const billingCalls = mockData.queriedTables.filter(t => t === 'paystack_billing_attempts');
    expect(billingCalls.length).toBe(0);
  });

  // ── CONFLICT: platform + customer sub code ──

  it('CONFLICT: same subscription_code in both tables → 500', async () => {
    const body = makeWebhookBody({
      subscription: { subscription_code: 'SUB_dual' },
    });
    const { status, json, mockData } = await callPOST(body, {
      existingPayment: null,
      platformSub: { id: 'plat-1' },
      customerSub: { id: 'cs-1' },
    });

    expect(status).toBe(500);
    expect(json.error).toContain('BOTH');
    const failures = mockData.eventUpdates.filter(u => u.status === 'failed');
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });

  // ── D/E pre-337: outer event never reaches completed ──

  it('D/E pre-337: outer event status is failed, never completed', async () => {
    const body = makeWebhookBody({
      subscription: { subscription_code: 'SUB_customer_abc' },
    });
    const { mockData } = await callPOST(body, {
      existingPayment: null,
      customerSub: { id: 'cs-1' },
      schemaReady: false,
    });

    // Must have 'failed' and must NOT have 'completed'
    expect(mockData.eventUpdates.some(u => u.status === 'failed')).toBe(true);
    expect(mockData.eventUpdates.some(u => u.status === 'completed')).toBe(false);
  });
});
