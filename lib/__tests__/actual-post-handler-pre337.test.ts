/**
 * Issue #191 Correction 6 — Actual Exported POST Handler Reproduction
 *
 * Evidence branch: audit/191-new-app-old-db-reproduction
 *
 * Proves: when the ACTUAL exported POST handler from
 * app/api/payments/webhook/route.ts runs against a pre-migration-337
 * database (paystack_billing_attempts table absent), a provider-managed
 * customer-recurring charge.success event is silently swallowed:
 *
 *   - Missing-table error from paystack_billing_attempts queries is
 *     destructured away (only `data` is read, `error` is ignored).
 *   - No finalization RPC is called.
 *   - No financial authority is executed.
 *   - The outer processed_webhook_events reaches 'completed'.
 *   - HTTP 200 is returned — Paystack will NOT retry.
 *   - The customer's recurring charge is effectively lost.
 *
 * Approach:
 *   1. Imports the real POST export from the webhook route.
 *   2. Constructs a NextRequest with valid Paystack HMAC signature.
 *   3. Module-mocks createServiceClient() with a pre-337 Supabase client.
 *   4. Mocks all provider/network-facing helpers (no external calls).
 *   5. Drives a provider-managed customer-renewal fixture that reaches
 *      the #176 recurring path (Block 4, Path B).
 *   6. Asserts on the actual handler's behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const TEST_HMAC_KEY = 'not-a-real-key-test-only-191-correction6';

const MISSING_TABLE_ERROR = {
  code: '42P01',
  message: 'relation "public.paystack_billing_attempts" does not exist',
  details: null,
  hint: null,
};

// ═══════════════════════════════════════════════════════════════
// Webhook fixture: provider-managed customer-subscription renewal
// Has subscription_code matching customer_subscriptions (not platform).
// No existing payment record. Will enter Block 4 Path B.
// ═══════════════════════════════════════════════════════════════

const FIXTURE_REFERENCE = 'txn-provider-managed-renewal-c6';

const WEBHOOK_BODY = {
  event: 'charge.success',
  data: {
    reference: FIXTURE_REFERENCE,
    amount: 500000, // 5000 NGN in kobo
    currency: 'NGN',
    id: 99001,
    status: 'success',
    subscription: {
      subscription_code: 'SUB_customer_renewal_abc',
    },
    authorization: {
      authorization_code: 'AUTH_test_xxx',
      reusable: true,
      last4: '4081',
      brand: 'visa',
    },
    customer: {
      customer_code: 'CUS_test_xxx',
      email: 'customer@example.com',
      phone: '+2341234567890',
    },
    metadata: {},
  },
};

// ═══════════════════════════════════════════════════════════════
// HMAC helper — generates a valid Paystack signature
// ═══════════════════════════════════════════════════════════════

function computeHmac(body: string, secret: string): string {
  return createHmac('sha512', secret).update(body).digest('hex');
}

// ═══════════════════════════════════════════════════════════════
// Build pre-337 mock Supabase client
//
// Tables that exist: processed_webhook_events, payments,
// customer_subscriptions, subscriptions
// Tables that DO NOT exist: paystack_billing_attempts
// ═══════════════════════════════════════════════════════════════

function buildPre337ServiceMock() {
  // Track all processed_webhook_events status updates
  const eventUpdates: Array<{ status: string; last_error?: string }> = [];
  // Track RPC calls
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];

  function createChain(tableName: string): Record<string, unknown> {
    // Use a Proxy to make every method chainable
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        // Terminal: single
        if (prop === 'single') {
          return vi.fn(() => {
            switch (tableName) {
              case 'processed_webhook_events':
                return Promise.resolve({
                  data: { id: '1', status: 'processing', attempts: 1 },
                  error: null,
                });
              case 'payments':
                // No existing payment — forces Block 4 entry
                return Promise.resolve({ data: null, error: null });
              case 'subscriptions':
                // Not a platform subscription — forces Block 4
                return Promise.resolve({ data: null, error: null });
              case 'paystack_billing_attempts':
                return Promise.resolve({ data: null, error: MISSING_TABLE_ERROR });
              default:
                return Promise.resolve({ data: null, error: null });
            }
          });
        }

        // Terminal: maybeSingle
        if (prop === 'maybeSingle') {
          return vi.fn(() => {
            switch (tableName) {
              case 'paystack_billing_attempts':
                return Promise.resolve({ data: null, error: MISSING_TABLE_ERROR });
              case 'customer_subscriptions':
                // Return a matching customer subscription for the provider-managed path
                return Promise.resolve({
                  data: {
                    id: 'cs-test-001',
                    amount: 5000,
                    currency: 'NGN',
                    frequency: 'monthly',
                  },
                  error: null,
                });
              default:
                return Promise.resolve({ data: null, error: null });
            }
          });
        }

        // Thenable: for `await supabase.from(...).insert(...)` etc.
        if (prop === 'then') {
          return (
            resolve: (v: unknown) => void,
            _reject?: (e: unknown) => void,
          ) => {
            if (tableName === 'paystack_billing_attempts') {
              resolve({ data: null, error: MISSING_TABLE_ERROR });
            } else {
              resolve({ data: null, error: null });
            }
          };
        }

        // All other methods: return a function that returns the proxy
        return vi.fn((...args: unknown[]) => {
          // Track processed_webhook_events updates
          if (
            tableName === 'processed_webhook_events' &&
            prop === 'update' &&
            args[0] &&
            typeof args[0] === 'object'
          ) {
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

  const fromFn = vi.fn((tableName: string) => createChain(tableName));
  const rpcFn = vi.fn((fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    return Promise.resolve({ data: null, error: MISSING_TABLE_ERROR });
  });

  return {
    client: { from: fromFn, rpc: rpcFn },
    eventUpdates,
    rpcCalls,
    fromFn,
  };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('Correction 6: Actual POST handler on pre-337 DB', () => {
  let mockData: ReturnType<typeof buildPre337ServiceMock>;
  const mockProcessChargeSuccess = vi.fn().mockResolvedValue(undefined);
  const mockProcessChargeFailed = vi.fn().mockResolvedValue(undefined);
  const mockSendConfirmation = vi.fn().mockResolvedValue(undefined);
  const mockNotifyChargeFailed = vi.fn().mockResolvedValue(undefined);
  const mockCreateAlert = vi.fn().mockResolvedValue(undefined);
  const mockSendEmail = vi.fn().mockResolvedValue(undefined);
  const mockFetchInvoice = vi.fn().mockResolvedValue({
    invoiceCode: 'INV_test_123',
    invoiceId: 'inv-001',
    paidAt: new Date().toISOString(),
  });
  const mockActivateSubscription = vi.fn().mockResolvedValue({ result: 'skipped' });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockData = buildPre337ServiceMock();
  });

  async function callActualPOST() {
    // Set env var for HMAC
    process.env.PAYSTACK_SECRET_KEY = TEST_HMAC_KEY;

    // Apply all mocks via vi.doMock (after resetModules)
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => mockData.client),
    }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: mockProcessChargeSuccess,
      processPaystackChargeFailed: mockProcessChargeFailed,
    }));
    vi.doMock('@/lib/payments/send-confirmation', () => ({
      sendProactiveConfirmation: mockSendConfirmation,
    }));
    vi.doMock('@/lib/payments/notify-charge-failed', () => ({
      notifyCustomerChargeFailed: mockNotifyChargeFailed,
    }));
    vi.doMock('@/lib/alerts/create-alert', () => ({
      createAlert: mockCreateAlert,
    }));
    vi.doMock('@/lib/email/templates', () => ({
      subscriptionRenewalReceiptEmail: vi.fn().mockReturnValue({
        subject: 'test',
        html: '<p>test</p>',
      }),
    }));
    vi.doMock('@/lib/email/client', () => ({
      sendEmail: mockSendEmail,
    }));
    vi.doMock('@/lib/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withContext: vi.fn().mockReturnThis(),
      },
    }));
    vi.doMock('@/lib/observability', () => ({
      getRequestId: vi.fn().mockReturnValue('test-req-id'),
    }));
    vi.doMock('@/lib/observability/webhooks', () => ({
      createWebhookLogger: vi.fn().mockReturnValue({
        received: vi.fn(),
        verified: vi.fn(),
        rejected: vi.fn(),
        accepted: vi.fn(),
        ignored: vi.fn(),
        duplicate: vi.fn(),
        processed: vi.fn(),
        failed: vi.fn(),
      }),
    }));
    vi.doMock('@sentry/nextjs', () => ({
      captureException: vi.fn(),
    }));
    vi.doMock('@/lib/utils/sanitize', () => ({
      sanitizeFilterValue: vi.fn((v: string) => v),
    }));
    // Dynamic imports mocked: activate-subscription and paystack-recurring
    vi.doMock('@/lib/recurring/activate-subscription', () => ({
      activatePaystackSubscription: mockActivateSubscription,
    }));
    vi.doMock('@/lib/payments/paystack-recurring', () => ({
      fetchSubscriptionInvoice: mockFetchInvoice,
    }));

    // Import the ACTUAL POST handler
    const { POST } = await import(
      '../../app/api/payments/webhook/route'
    );

    // Build request with valid HMAC
    const rawBody = JSON.stringify(WEBHOOK_BODY);
    const signature = computeHmac(rawBody, TEST_HMAC_KEY);

    const request = new NextRequest(
      'http://localhost:3000/api/payments/webhook',
      {
        method: 'POST',
        body: rawBody,
        headers: {
          'Content-Type': 'application/json',
          'x-paystack-signature': signature,
        },
      },
    );

    const response = await POST(request);
    const json = await response.json();

    return { response, json, status: response.status };
  }

  // ── Test 1: Handler returns HTTP 200 (Paystack won't retry) ──
  it('returns HTTP 200 despite paystack_billing_attempts being absent', async () => {
    const { status } = await callActualPOST();
    expect(status).toBe(200);
  });

  // ── Test 2: Outer event reaches 'completed' (not 'failed') ──
  it('marks outer processed_webhook_events as completed — charge is lost', async () => {
    await callActualPOST();

    // The last eventUpdate should be 'completed'
    const completions = mockData.eventUpdates.filter(
      (u) => u.status === 'completed',
    );
    expect(completions.length).toBeGreaterThanOrEqual(1);

    // Crucially: no 'failed' status was set for the main event
    const failures = mockData.eventUpdates.filter(
      (u) => u.status === 'failed',
    );
    expect(failures.length).toBe(0);
  });

  // ── Test 3: No finalization RPC called ──
  it('never calls finalize_paystack_recurring_charge RPC', async () => {
    await callActualPOST();

    const finalizeCalls = mockData.rpcCalls.filter(
      (c) => c.fn === 'finalize_paystack_recurring_charge',
    );
    expect(finalizeCalls.length).toBe(0);
  });

  // ── Test 4: No proactive confirmation sent ──
  it('never sends proactive confirmation — customer is not notified', async () => {
    await callActualPOST();
    expect(mockSendConfirmation).not.toHaveBeenCalled();
  });

  // ── Test 5: paystack_billing_attempts WAS queried (proves we reached Block 4) ──
  it('queries paystack_billing_attempts — proving Block 4 was entered', async () => {
    await callActualPOST();

    const billingAttemptCalls = mockData.fromFn.mock.calls.filter(
      (call: unknown[]) => call[0] === 'paystack_billing_attempts',
    );
    expect(billingAttemptCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── Test 6: customer_subscriptions was queried — fixture reached Path B ──
  it('queries customer_subscriptions for provider-managed renewal path', async () => {
    await callActualPOST();

    const customerSubCalls = mockData.fromFn.mock.calls.filter(
      (call: unknown[]) => call[0] === 'customer_subscriptions',
    );
    // At least 2: one from Block 2 (auth enrichment) + one from Block 4 Path B
    expect(customerSubCalls.length).toBeGreaterThanOrEqual(2);
  });

  // ── Test 7: Invoice fetch was attempted — proves deep Path B entry ──
  it('calls fetchSubscriptionInvoice — entered deep into Path B', async () => {
    await callActualPOST();
    expect(mockFetchInvoice).toHaveBeenCalled();
  });

  // ── Test 8: The insert into paystack_billing_attempts fails silently ──
  it('attempts to insert into paystack_billing_attempts and fails silently', async () => {
    await callActualPOST();

    // paystack_billing_attempts was accessed multiple times:
    // 1. maybeSingle lookup by provider_reference
    // 2. maybeSingle check for existing finalized
    // 3. maybeSingle check for existing unresolved
    // 4. insert attempt
    // 5. maybeSingle race check
    // All fail with 42P01 but errors are destructured away
    const billingAttemptCalls = mockData.fromFn.mock.calls.filter(
      (call: unknown[]) => call[0] === 'paystack_billing_attempts',
    );
    expect(billingAttemptCalls.length).toBeGreaterThanOrEqual(4);
  });

  // ── Test 9: subscriptions table was queried (platform check ran) ──
  it('queries subscriptions table for platform renewal check', async () => {
    await callActualPOST();

    const subCalls = mockData.fromFn.mock.calls.filter(
      (call: unknown[]) => call[0] === 'subscriptions',
    );
    expect(subCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── Test 10: processPaystackChargeSuccess was called (Block 1 ran) ──
  it('runs processPaystackChargeSuccess from Block 1 before Block 4', async () => {
    await callActualPOST();
    expect(mockProcessChargeSuccess).toHaveBeenCalledTimes(1);
  });
});
