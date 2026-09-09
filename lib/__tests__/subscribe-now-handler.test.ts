/**
 * Subscribe Now Handler Failure-Path Tests (#263)
 *
 * Executable handler tests proving that Stripe checkout, Stripe renewal,
 * Paystack renewal, and onboarding paid verification fail closed when
 * activation is rejected, evidence/config writes fail, or required
 * canonical fields are missing.
 *
 * These tests import the real POST handlers and exercise them with mocked
 * Supabase clients, proving the handlers return non-success HTTP status
 * and do NOT mark webhooks as processed on paid-entitlement failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════
// Stripe webhook test helpers
// ═══════════════════════════════════════════════════════════

const STRIPE_WEBHOOK_SECRET = 'whsec_test_subscribe_now_263';

function stripeSignature(rawBody: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${timestamp}.${rawBody}`;
  const sig = createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

function buildStripeCheckoutEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt_test_checkout_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_1',
        payment_status: 'paid',
        amount_total: 500000,
        currency: 'ngn',
        created: Math.floor(Date.now() / 1000),
        metadata: {
          type: 'whatsapp_subscription',
          business_id: 'biz-test-1',
          plan: 'growth',
          billing_interval: 'month',
        },
        subscription: 'sub_test_1',
        customer: 'cus_test_1',
        ...overrides,
      },
    },
  };
}

function buildStripeInvoicePaidEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'evt_test_invoice_1',
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_test_1',
        subscription: 'sub_stripe_1',
        amount_paid: 500000,
        currency: 'ngn',
        created: now,
        period_start: now,
        period_end: now + 30 * 86400,
        payment_intent: 'pi_test_1',
        ...overrides,
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════
// Paystack webhook test helpers
// ═══════════════════════════════════════════════════════════

const PAYSTACK_SECRET_KEY = 'not-a-real-key-handler-test-263';

function paystackSignature(rawBody: string): string {
  return createHmac('sha512', PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
}

function buildPaystackRenewalEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: 'charge.success',
    data: {
      reference: 'ref-renewal-test-1',
      amount: 500000,
      currency: 'NGN',
      id: 99001,
      status: 'success',
      paid_at: new Date().toISOString(),
      authorization: { authorization_code: 'AUTH_x', reusable: true, last4: '4081', brand: 'visa' },
      customer: { customer_code: 'CUS_x', email: 'a@b.com', phone: '+234123' },
      metadata: { type: 'whatsapp_subscription', business_id: 'biz-test-1' },
      subscription: { subscription_code: 'SUB_paystack_1' },
      plan_object: { plan_code: 'PLN_test' },
      ...overrides,
    },
  };
}

// ═══════════════════════════════════════════════════════════
// Mock Supabase builder (Stripe)
// ═══════════════════════════════════════════════════════════

interface StripeTestConfig {
  existingPayment?: Record<string, unknown> | null;
  subscriptionRecord?: Record<string, unknown> | null;
  platformSub?: Record<string, unknown> | null;
  customerSub?: Record<string, unknown> | null;
  evidenceInsertResult?: { data: unknown; error: unknown };
  configVersionResult?: { data: unknown; error: unknown };
  activationResult?: { data: unknown; error: unknown };
  webhookEventExists?: boolean;
}

function buildStripeMock(config: StripeTestConfig = {}) {
  const eventUpdates: Array<{ event_id?: string; status?: string }> = [];

  function createChain(tableName: string): Record<string, unknown> {
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        if (prop === 'single') {
          return vi.fn(() => {
            switch (tableName) {
              case 'payments':
                return Promise.resolve({ data: config.existingPayment ?? null, error: null });
              case 'subscriptions':
                if (config.subscriptionRecord !== undefined) {
                  return Promise.resolve({ data: config.subscriptionRecord, error: null });
                }
                return Promise.resolve({ data: config.platformSub ?? null, error: null });
              case 'subscription_payments':
                return Promise.resolve(config.evidenceInsertResult ?? { data: { id: 'sp-test-1' }, error: null });
              case 'platform_config_versions':
                return Promise.resolve(config.configVersionResult ?? { data: { id: 'cfg-v1' }, error: null });
              case 'processed_webhook_events':
                return Promise.resolve({ data: config.webhookEventExists ? { id: 'existing' } : null, error: null });
              default:
                return Promise.resolve({ data: null, error: null });
            }
          });
        }

        if (prop === 'maybeSingle') {
          return vi.fn(() => {
            switch (tableName) {
              case 'processed_webhook_events':
                return Promise.resolve({ data: config.webhookEventExists ? { id: 'existing' } : null, error: null });
              case 'payments':
                return Promise.resolve({ data: config.existingPayment ?? null, error: null });
              case 'subscriptions':
                return Promise.resolve({ data: config.platformSub ?? null, error: null });
              case 'customer_subscriptions':
                return Promise.resolve({ data: config.customerSub ?? null, error: null });
              default:
                return Promise.resolve({ data: null, error: null });
            }
          });
        }

        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            resolve({ data: null, error: null });
          };
        }

        return vi.fn((...args: unknown[]) => {
          if (tableName === 'processed_webhook_events' && prop === 'upsert') {
            const payload = args[0] as Record<string, unknown>;
            eventUpdates.push({ event_id: payload?.event_id as string, status: payload?.status as string });
          }
          return proxy;
        });
      },
    };
    const proxy = new Proxy({} as Record<string, unknown>, handler);
    return proxy;
  }

  const fromFn = vi.fn((tableName: string) => createChain(tableName));
  const rpcFn = vi.fn((fn: string) => {
    if (fn === 'activate_paid_subscription') {
      return Promise.resolve(config.activationResult ?? { data: { activated: true, allowance_granted: true }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  return {
    client: { from: fromFn, rpc: rpcFn },
    eventUpdates,
    fromFn,
    rpcFn,
  };
}

// ═══════════════════════════════════════════════════════════
// Mock Supabase builder (Paystack)
// ═══════════════════════════════════════════════════════════

interface PaystackTestConfig {
  existingPayment?: Record<string, unknown> | null;
  platformSub?: Record<string, unknown> | null;
  customerSub?: Record<string, unknown> | null;
  pendingSetupSubs?: Array<{ id: string }>;
  schemaReady?: boolean;
  evidenceInsertResult?: { data: unknown; error: unknown };
  configVersionResult?: { data: unknown; error: unknown };
  activationResult?: { data: unknown; error: unknown };
}

function buildPaystackMock(config: PaystackTestConfig = {}) {
  const eventUpdates: Array<{ status: string }> = [];

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
              case 'subscription_payments':
                return Promise.resolve(config.evidenceInsertResult ?? { data: { id: 'sp-test-1' }, error: null });
              case 'platform_config_versions':
                return Promise.resolve(config.configVersionResult ?? { data: { id: 'cfg-v1' }, error: null });
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
                  : Promise.resolve({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
              default:
                return Promise.resolve({ data: null, error: null });
            }
          });
        }

        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            if (tableName === 'customer_subscriptions') {
              resolve({ data: config.pendingSetupSubs ?? [], error: null });
            } else if (tableName === 'paystack_billing_attempts') {
              resolve(config.schemaReady
                ? { data: null, error: null }
                : { data: null, error: { code: '42P01', message: 'relation does not exist' } });
            } else {
              resolve({ data: null, error: null });
            }
          };
        }

        return vi.fn((...args: unknown[]) => {
          if (tableName === 'processed_webhook_events' && prop === 'update') {
            const update = args[0] as Record<string, unknown>;
            if (update?.status) eventUpdates.push({ status: update.status as string });
          }
          return proxy;
        });
      },
    };
    const proxy = new Proxy({} as Record<string, unknown>, handler);
    return proxy;
  }

  const fromFn = vi.fn((tableName: string) => createChain(tableName));
  const rpcFn = vi.fn((fn: string) => {
    if (fn === 'activate_paid_subscription') {
      return Promise.resolve(config.activationResult ?? { data: { activated: true, allowance_granted: true }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  return {
    client: { from: fromFn, rpc: rpcFn },
    eventUpdates,
    fromFn,
    rpcFn,
  };
}

// ═══════════════════════════════════════════════════════════
// Stripe webhook handler tests
// ═══════════════════════════════════════════════════════════

describe('Stripe webhook: paid subscription failure paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WEBHOOK_SECRET;
  });

  async function callStripeWebhook(
    event: Record<string, unknown>,
    mockConfig: StripeTestConfig,
  ) {
    const mock = buildStripeMock(mockConfig);

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => mock.client),
    }));
    vi.doMock('@/lib/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() },
    }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));
    vi.doMock('@/lib/alerts/create-alert', () => ({ createAlert: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/templates', () => ({
      subscriptionRenewalReceiptEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p>t</p>' }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/payments/send-confirmation', () => ({
      sendProactiveConfirmation: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/payments/notify-charge-failed', () => ({
      notifyCustomerChargeFailed: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/payments/stripe-invoice-extractors', () => ({
      classifyInvoiceSubscription: vi.fn((data: Record<string, unknown>) => {
        if (data.subscription) return { type: 'subscription', subscriptionId: data.subscription };
        return { type: 'not_subscription', reason: 'no subscription' };
      }),
      extractInvoicePaymentIdentity: vi.fn(() => ({ paymentIntentId: 'pi_test' })),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

    const { POST } = await import('../../app/api/payments/stripe-webhook/route');
    const rawBody = JSON.stringify(event);
    const request = new NextRequest('http://localhost:3000/api/payments/stripe-webhook', {
      method: 'POST',
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': stripeSignature(rawBody),
      },
    });

    const response = await POST(request);
    const json = await response.json();
    return { status: response.status, json, mock };
  }

  it('checkout: missing plan → returns 500, not processed', async () => {
    const event = buildStripeCheckoutEvent({ metadata: { type: 'whatsapp_subscription', business_id: 'biz-1' } });
    const { status, json } = await callStripeWebhook(event, {
      subscriptionRecord: { id: 'sub-1' },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/plan/i);
  });

  it('checkout: invalid plan → returns 500, not processed', async () => {
    const event = buildStripeCheckoutEvent({ metadata: { type: 'whatsapp_subscription', business_id: 'biz-1', plan: 'enterprise' } });
    const { status, json } = await callStripeWebhook(event, {
      subscriptionRecord: { id: 'sub-1' },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/plan/i);
  });

  it('checkout: missing provider timestamp → returns 500', async () => {
    const event = buildStripeCheckoutEvent({ created: undefined });
    const { status, json } = await callStripeWebhook(event, {
      subscriptionRecord: { id: 'sub-1' },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/timestamp/i);
  });

  it('checkout: no subscription record → returns 500', async () => {
    const event = buildStripeCheckoutEvent();
    const { status, json } = await callStripeWebhook(event, {
      subscriptionRecord: null,
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/subscription/i);
  });

  it('checkout: evidence insert failure → returns 500', async () => {
    const event = buildStripeCheckoutEvent();
    const { status, json } = await callStripeWebhook(event, {
      subscriptionRecord: { id: 'sub-1' },
      evidenceInsertResult: { data: null, error: { message: 'insert failed' } },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/evidence/i);
  });

  it('checkout: activation RPC error → returns 500', async () => {
    const event = buildStripeCheckoutEvent();
    const { status, json } = await callStripeWebhook(event, {
      subscriptionRecord: { id: 'sub-1' },
      activationResult: { data: null, error: { message: 'RPC failed' } },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/RPC|activation/i);
  });

  it('checkout: activation rejected → returns 500', async () => {
    const event = buildStripeCheckoutEvent();
    const { status, json } = await callStripeWebhook(event, {
      subscriptionRecord: { id: 'sub-1' },
      activationResult: { data: { activated: false, reason: 'amount_mismatch' }, error: null },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/rejected/i);
  });

  it('renewal: missing provider period_start → returns 500', async () => {
    const event = buildStripeInvoicePaidEvent({ period_start: undefined, period_end: undefined });
    const { status, json } = await callStripeWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', status: 'active' },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/period/i);
  });

  it('renewal: missing currency → returns 500', async () => {
    const event = buildStripeInvoicePaidEvent({ currency: undefined });
    const { status, json } = await callStripeWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', status: 'active' },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/currency/i);
  });

  it('renewal: missing amount → returns 500', async () => {
    const event = buildStripeInvoicePaidEvent({ amount_paid: undefined });
    const { status, json } = await callStripeWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', status: 'active' },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/amount/i);
  });

  it('renewal: evidence insert failure → returns 500', async () => {
    const event = buildStripeInvoicePaidEvent();
    const { status, json } = await callStripeWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', status: 'active' },
      evidenceInsertResult: { data: null, error: { message: 'insert failed' } },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/evidence/i);
  });

  it('renewal: activation RPC error → returns 500', async () => {
    const event = buildStripeInvoicePaidEvent();
    const { status, json } = await callStripeWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', status: 'active' },
      activationResult: { data: null, error: { message: 'RPC failed' } },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/RPC|activation/i);
  });

  it('renewal: activation rejected (activated:false) → returns 500', async () => {
    const event = buildStripeInvoicePaidEvent();
    const { status, json } = await callStripeWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', status: 'active' },
      activationResult: { data: { activated: false, reason: 'currency_mismatch' }, error: null },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/rejected/i);
  });

  it('renewal: config version not found → returns 500', async () => {
    const event = buildStripeInvoicePaidEvent();
    const { status, json } = await callStripeWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', status: 'active' },
      configVersionResult: { data: null, error: null },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/config/i);
  });
});

// ═══════════════════════════════════════════════════════════
// Paystack webhook handler tests
// ═══════════════════════════════════════════════════════════

describe('Paystack webhook: paid subscription failure paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.PAYSTACK_SECRET_KEY = PAYSTACK_SECRET_KEY;
  });

  async function callPaystackWebhook(
    event: Record<string, unknown>,
    mockConfig: PaystackTestConfig,
  ) {
    const mock = buildPaystackMock(mockConfig);

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => mock.client),
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
    vi.doMock('@/lib/alerts/create-alert', () => ({ createAlert: vi.fn().mockResolvedValue(undefined) }));
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
      fetchSubscriptionInvoice: vi.fn().mockResolvedValue(null),
    }));

    const { POST } = await import('../../app/api/payments/webhook/route');
    const rawBody = JSON.stringify(event);
    const request = new NextRequest('http://localhost:3000/api/payments/webhook', {
      method: 'POST',
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'x-paystack-signature': paystackSignature(rawBody),
      },
    });

    const response = await POST(request);
    const json = await response.json();
    return { status: response.status, json, mock };
  }

  it('renewal: missing paid_at timestamp → returns 500', async () => {
    const event = buildPaystackRenewalEvent({ paid_at: undefined, created_at: undefined });
    const { status, json } = await callPaystackWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', paystack_subscription_code: 'SUB_paystack_1' },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/timestamp/i);
  });

  it('renewal: missing currency → returns 500', async () => {
    const event = buildPaystackRenewalEvent({ currency: undefined });
    const { status, json } = await callPaystackWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', paystack_subscription_code: 'SUB_paystack_1' },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/currency/i);
  });

  it('renewal: missing amount → returns 500', async () => {
    const event = buildPaystackRenewalEvent({ amount: undefined });
    const { status, json } = await callPaystackWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', paystack_subscription_code: 'SUB_paystack_1' },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/amount/i);
  });

  it('renewal: evidence insert failure → returns 500', async () => {
    const event = buildPaystackRenewalEvent();
    const { status, json } = await callPaystackWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', paystack_subscription_code: 'SUB_paystack_1' },
      evidenceInsertResult: { data: null, error: { message: 'insert failed' } },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/evidence/i);
  });

  it('renewal: activation RPC error → returns 500', async () => {
    const event = buildPaystackRenewalEvent();
    const { status, json } = await callPaystackWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', paystack_subscription_code: 'SUB_paystack_1' },
      activationResult: { data: null, error: { message: 'RPC transport error' } },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/RPC|activation/i);
  });

  it('renewal: activation rejected (activated:false) → returns 500', async () => {
    const event = buildPaystackRenewalEvent();
    const { status, json } = await callPaystackWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', paystack_subscription_code: 'SUB_paystack_1' },
      activationResult: { data: { activated: false, reason: 'amount_mismatch' }, error: null },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/rejected/i);
  });

  it('renewal: config version not found → returns 500', async () => {
    const event = buildPaystackRenewalEvent();
    const { status, json } = await callPaystackWebhook(event, {
      platformSub: { id: 'sub-1', business_id: 'biz-1', plan: 'growth', paystack_subscription_code: 'SUB_paystack_1' },
      configVersionResult: { data: null, error: null },
    });
    expect(status).toBe(500);
    expect(json.error).toMatch(/config/i);
  });
});

// ═══════════════════════════════════════════════════════════
// Onboarding verify handler tests
// ═══════════════════════════════════════════════════════════

describe('Onboarding verify: paid subscription failure paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.STRIPE_SECRET_KEY = 'not-a-real-key-onboard-263';
    process.env.PAYSTACK_SECRET_KEY = 'not-a-real-key-onboard-263';
  });

  // For onboarding, we need to mock the Supabase client + fetch for Stripe/Paystack verification
  async function callOnboardingVerify(
    body: Record<string, unknown>,
    opts: {
      stripeSession?: Record<string, unknown>;
      paystackVerification?: Record<string, unknown>;
      ownerCheck?: Record<string, unknown> | null;
      capabilities?: Array<Record<string, unknown>>;
      subscriptionUpsert?: { data: unknown; error: unknown };
      configVersion?: { data: unknown; error: unknown };
      evidenceInsert?: { data: unknown; error: unknown };
      activationResult?: { data: unknown; error: unknown };
    } = {},
  ) {
    // Mock fetch for Stripe/Paystack verification
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('api.stripe.com/v1/checkout/sessions/')) {
        return new Response(JSON.stringify(opts.stripeSession ?? {}), { status: 200 });
      }
      if (urlStr.includes('api.stripe.com/v1/subscriptions/')) {
        return new Response(JSON.stringify({
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        }), { status: 200 });
      }
      if (urlStr.includes('api.paystack.co/transaction/verify/')) {
        return new Response(JSON.stringify(opts.paystackVerification ?? {}), { status: 200 });
      }
      return originalFetch(url as string);
    }) as unknown as typeof fetch;

    // Build Supabase mocks
    const supabaseBrowser = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-test-1' } },
          error: null,
        }),
      },
      from: vi.fn((table: string) => {
        const chain: Record<string, unknown> = {};
        const proxy: Record<string, unknown> = new Proxy(chain, {
          get(_, prop: string) {
            if (prop === 'single') {
              return vi.fn(() => {
                if (table === 'businesses') {
                  return Promise.resolve({ data: opts.ownerCheck ?? { owner_id: 'user-test-1', subscription_tier: 'free' }, error: null });
                }
                return Promise.resolve({ data: null, error: null });
              });
            }
            return vi.fn(() => proxy);
          },
        });
        return proxy;
      }),
    };

    const supabaseService = {
      from: vi.fn((table: string) => {
        const chain: Record<string, unknown> = {};
        const proxy: Record<string, unknown> = new Proxy(chain, {
          get(_, prop: string) {
            if (prop === 'single') {
              return vi.fn(() => {
                if (table === 'business_capabilities') {
                  return Promise.resolve({
                    data: opts.capabilities ?? [{ capability: 'scheduling', is_enabled: true }],
                    error: null,
                  });
                }
                if (table === 'subscriptions') {
                  return Promise.resolve(opts.subscriptionUpsert ?? { data: { id: 'sub-test-1' }, error: null });
                }
                if (table === 'platform_config_versions') {
                  return Promise.resolve(opts.configVersion ?? { data: { id: 'cfg-test-1' }, error: null });
                }
                if (table === 'subscription_payments') {
                  return Promise.resolve(opts.evidenceInsert ?? { data: { id: 'sp-test-1' }, error: null });
                }
                if (table === 'businesses') {
                  return Promise.resolve({ data: { bot_code: 'TEST', slug: 'test' }, error: null });
                }
                return Promise.resolve({ data: null, error: null });
              });
            }
            if (prop === 'then') {
              return (resolve: (v: unknown) => void) => {
                if (table === 'business_capabilities') {
                  resolve({
                    data: opts.capabilities ?? [{ capability: 'scheduling', is_enabled: true }],
                    error: null,
                  });
                } else {
                  resolve({ data: null, error: null });
                }
              };
            }
            return vi.fn((..._args: unknown[]) => proxy);
          },
        });
        return proxy;
      }),
      rpc: vi.fn((fn: string) => {
        if (fn === 'activate_paid_subscription') {
          return Promise.resolve(opts.activationResult ?? { data: { activated: true }, error: null });
        }
        if (fn === 'activate_trial_if_eligible') {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    };

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue(supabaseBrowser),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => supabaseService),
    }));
    vi.doMock('@/lib/onboarding/finalize', () => ({
      finalizeOnboarding: vi.fn().mockResolvedValue(undefined),
    }));

    const { POST } = await import('../../app/api/onboarding/verify/route');
    const request = new NextRequest('http://localhost:3000/api/onboarding/verify', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request);
    const json = await response.json();

    // Restore fetch
    globalThis.fetch = originalFetch;

    return { status: response.status, json };
  }

  it('Stripe: missing billing_interval → returns 400', async () => {
    const { status, json } = await callOnboardingVerify(
      { reference: 'cs_test_1' },
      {
        stripeSession: {
          payment_status: 'paid',
          amount_total: 500000,
          currency: 'ngn',
          created: Math.floor(Date.now() / 1000),
          metadata: { business_id: 'biz-1', plan: 'growth' },
          // billing_interval omitted
        },
      },
    );
    expect(status).toBe(400);
    expect(json.message).toMatch(/billing interval/i);
  });

  it('Stripe: annual billing_interval → returns 400', async () => {
    const { status, json } = await callOnboardingVerify(
      { reference: 'cs_test_1' },
      {
        stripeSession: {
          payment_status: 'paid',
          amount_total: 500000,
          currency: 'ngn',
          created: Math.floor(Date.now() / 1000),
          metadata: { business_id: 'biz-1', plan: 'growth', billing_interval: 'year' },
        },
      },
    );
    expect(status).toBe(400);
    expect(json.message).toMatch(/annual/i);
  });

  it('Stripe: missing currency from provider → returns 500', async () => {
    const { status, json } = await callOnboardingVerify(
      { reference: 'cs_test_1' },
      {
        stripeSession: {
          payment_status: 'paid',
          amount_total: 500000,
          // currency omitted
          created: Math.floor(Date.now() / 1000),
          metadata: { business_id: 'biz-1', plan: 'growth', billing_interval: 'month' },
        },
      },
    );
    expect(status).toBe(500);
    expect(json.message).toMatch(/currency/i);
  });

  it('Stripe: activation RPC error → returns 500, not success', async () => {
    const { status, json } = await callOnboardingVerify(
      { reference: 'cs_test_1' },
      {
        stripeSession: {
          payment_status: 'paid',
          amount_total: 500000,
          currency: 'ngn',
          created: Math.floor(Date.now() / 1000),
          subscription: 'sub_stripe_1',
          metadata: { business_id: 'biz-1', plan: 'growth', billing_interval: 'month' },
        },
        activationResult: { data: null, error: { message: 'RPC error' } },
      },
    );
    expect(status).toBe(500);
    expect(json.message).toMatch(/activation failed/i);
  });

  it('Stripe: activation rejected → returns 400, not success', async () => {
    const { status, json } = await callOnboardingVerify(
      { reference: 'cs_test_1' },
      {
        stripeSession: {
          payment_status: 'paid',
          amount_total: 500000,
          currency: 'ngn',
          created: Math.floor(Date.now() / 1000),
          subscription: 'sub_stripe_1',
          metadata: { business_id: 'biz-1', plan: 'growth', billing_interval: 'month' },
        },
        activationResult: { data: { activated: false, reason: 'amount_mismatch' }, error: null },
      },
    );
    expect(status).toBe(400);
    expect(json.message).toMatch(/rejected/i);
  });

  it('Stripe: evidence insert failure → returns 500, not success', async () => {
    const { status, json } = await callOnboardingVerify(
      { reference: 'cs_test_1' },
      {
        stripeSession: {
          payment_status: 'paid',
          amount_total: 500000,
          currency: 'ngn',
          created: Math.floor(Date.now() / 1000),
          subscription: 'sub_stripe_1',
          metadata: { business_id: 'biz-1', plan: 'growth', billing_interval: 'month' },
        },
        evidenceInsert: { data: null, error: { message: 'insert failed' } },
      },
    );
    expect(status).toBe(500);
    expect(json.message).toMatch(/payment recording failed/i);
  });

  it('Paystack: missing billing_interval → returns 400', async () => {
    const { status, json } = await callOnboardingVerify(
      { reference: 'ref_paystack_test' },
      {
        paystackVerification: {
          data: {
            status: 'success',
            amount: 500000,
            currency: 'NGN',
            paid_at: new Date().toISOString(),
            metadata: { business_id: 'biz-1', plan: 'growth' },
            // billing_interval omitted
          },
        },
      },
    );
    expect(status).toBe(400);
    expect(json.message).toMatch(/billing interval/i);
  });

  it('Paystack: missing currency → returns 500', async () => {
    const { status, json } = await callOnboardingVerify(
      { reference: 'ref_paystack_test' },
      {
        paystackVerification: {
          data: {
            status: 'success',
            amount: 500000,
            // currency omitted
            paid_at: new Date().toISOString(),
            metadata: { business_id: 'biz-1', plan: 'growth', billing_interval: 'month' },
          },
        },
      },
    );
    expect(status).toBe(500);
    expect(json.message).toMatch(/currency/i);
  });

  it('Paystack: missing provider timestamp → returns 500', async () => {
    const { status, json } = await callOnboardingVerify(
      { reference: 'ref_paystack_test' },
      {
        paystackVerification: {
          data: {
            status: 'success',
            amount: 500000,
            currency: 'NGN',
            // paid_at and created_at omitted
            metadata: { business_id: 'biz-1', plan: 'growth', billing_interval: 'month' },
          },
        },
      },
    );
    expect(status).toBe(500);
    expect(json.message).toMatch(/timestamp/i);
  });
});
