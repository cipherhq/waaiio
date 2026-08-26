/**
 * Stripe Webhook Route — Executable Tests (#177)
 *
 * Tests the invoice.paid customer-recurring path with mocked Supabase.
 * Covers tri-state classification, role resolution, RPC handling, Stage 3, and error paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

const TEST_STRIPE_SECRET = 'whsec_test_stripe_177';

// ═══════════════════════════════════════════════════════════
// Mock helpers
// ═══════════════════════════════════════════════════════════

interface MockConfig {
  platformSub?: Record<string, unknown> | null;
  platformSubError?: Record<string, unknown> | null;
  customerSub?: Record<string, unknown> | null;
  customerSubError?: Record<string, unknown> | null;
  rpcResult?: Record<string, unknown> | null;
  rpcError?: Record<string, unknown> | null;
  confirmResult?: { status: string; retryable?: boolean; reason?: string };
  confirmThrow?: boolean;
  existingEvent?: boolean;
}

function buildServiceMock(config: MockConfig = {}) {
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const upsertCalls: Array<Record<string, unknown>> = [];
  const queriedTables: string[] = [];

  function createChain(tableName: string): Record<string, unknown> {
    queriedTables.push(tableName);
    const resolved = Promise.resolve({ data: null, error: null });
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          // Make the proxy thenable — resolves immediately
          return resolved[prop as keyof typeof resolved].bind(resolved);
        }
        if (prop === 'maybeSingle') {
          return vi.fn(() => {
            switch (tableName) {
              case 'processed_webhook_events':
                return Promise.resolve({ data: config.existingEvent ? { id: 'x' } : null, error: null });
              case 'subscriptions':
                return Promise.resolve({ data: config.platformSub ?? null, error: config.platformSubError ?? null });
              case 'customer_subscriptions':
                return Promise.resolve({ data: config.customerSub ?? null, error: config.customerSubError ?? null });
              default:
                return Promise.resolve({ data: null, error: null });
            }
          });
        }
        if (prop === 'single') {
          return vi.fn(() => Promise.resolve({ data: null, error: null }));
        }
        // Chain methods (select, eq, in, upsert, insert, update, delete, neq) return proxy
        return vi.fn(() => new Proxy({}, handler));
      },
    };
    return new Proxy({}, handler);
  }

  const mockClient = {
    from: vi.fn((table: string) => createChain(table)),
    rpc: vi.fn((fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (config.rpcError) {
        return Promise.resolve({ data: null, error: config.rpcError });
      }
      return Promise.resolve({ data: config.rpcResult ?? null, error: null });
    }),
  };

  return { mockClient, rpcCalls, queriedTables, upsertCalls };
}

function makeStripeSignature(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', TEST_STRIPE_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

function makeInvoicePaidPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'invoice.paid',
    id: 'evt_test_177',
    data: {
      object: {
        id: 'in_test_inv_001',
        subscription: 'sub_test_abc',
        amount_paid: 5000,
        currency: 'usd',
        payment_intent: 'pi_test_001',
        ...overrides,
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════
// Mocking modules
// ═══════════════════════════════════════════════════════════

let currentMock: ReturnType<typeof buildServiceMock>;
let confirmationResult: MockConfig['confirmResult'];
let confirmationThrow: boolean;

// Use vi.hoisted for mock state shared between vi.mock factory and test code
const mockState = vi.hoisted(() => ({
  getMock: (): any => null,
  getConfirmResult: (): any => ({ status: 'completed' }),
  getConfirmThrow: (): boolean => false,
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => mockState.getMock()),
}));

vi.mock('@/lib/payments/send-confirmation', () => ({
  sendProactiveConfirmation: vi.fn(async () => {
    if (mockState.getConfirmThrow()) throw new Error('Stage 3 threw');
    return mockState.getConfirmResult();
  }),
}));

vi.mock('@/lib/alerts/create-alert', () => ({ createAlert: vi.fn() }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email/templates', () => ({
  subscriptionRenewalReceiptEmail: vi.fn(() => ({ subject: 'test', html: '<p>test</p>' })),
}));
vi.mock('@/lib/payments/notify-charge-failed', () => ({ notifyCustomerChargeFailed: vi.fn() }));
vi.mock('@/lib/logger', () => {
  const noop = vi.fn();
  const ctx = { error: noop, warn: noop, info: noop };
  return { logger: { info: noop, warn: noop, error: noop, withContext: vi.fn(() => ctx) } };
});
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

// Set env before importing route
vi.stubEnv('STRIPE_WEBHOOK_SECRET', TEST_STRIPE_SECRET);

// Import after mocks
const { POST } = await import('@/app/api/payments/stripe-webhook/route');

// Wire up mock state getters to test variables
mockState.getMock = () => currentMock.mockClient;
mockState.getConfirmResult = () => confirmationResult ?? { status: 'completed' };
mockState.getConfirmThrow = () => confirmationThrow;

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe('Stripe webhook route — #177 invoice.paid customer recurring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmationThrow = false;
    confirmationResult = { status: 'completed' };
  });

  async function callRoute(payload: unknown) {
    const body = JSON.stringify(payload);
    const sig = makeStripeSignature(body);
    const req = new NextRequest('https://example.com/api/payments/stripe-webhook', {
      method: 'POST',
      body,
      headers: { 'stripe-signature': sig },
    });
    return POST(req);
  }

  // ── not_subscription ──

  it('not_subscription invoice: no platform/customer lookup and no RPC', async () => {
    currentMock = buildServiceMock();
    const payload = makeInvoicePaidPayload({ subscription: null, billing_reason: 'manual' });
    const res = await callRoute(payload);
    expect(res.status).toBe(200);
    // Should NOT have queried subscriptions or customer_subscriptions
    expect(currentMock.queriedTables.filter(t => t === 'subscriptions')).toHaveLength(0);
    expect(currentMock.queriedTables.filter(t => t === 'customer_subscriptions')).toHaveLength(0);
    expect(currentMock.rpcCalls).toHaveLength(0);
  });

  // ── malformed/conflicting classification ──

  it('malformed subscription classification: 5xx, event unprocessed', async () => {
    currentMock = buildServiceMock();
    // subscription_cycle billing reason but no subscription ID
    const payload = makeInvoicePaidPayload({
      subscription: null,
      billing_reason: 'subscription_cycle',
    });
    const res = await callRoute(payload);
    expect(res.status).toBe(500);
  });

  // ── Platform/customer lookup errors ──

  it('platform subscription lookup error: 5xx', async () => {
    currentMock = buildServiceMock({
      platformSubError: { code: '42P01', message: 'relation error' },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Role resolution failed');
  });

  it('customer subscription lookup error: 5xx', async () => {
    currentMock = buildServiceMock({
      customerSubError: { code: 'PGRST', message: 'db error' },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(500);
  });

  // ── Ambiguous dual match ──

  it('platform + customer match same subscription: 5xx ambiguous', async () => {
    currentMock = buildServiceMock({
      platformSub: { id: 'p1', business_id: 'b1', plan: 'growth', status: 'active' },
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active' },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Ambiguous subscription role');
  });

  // ── RPC transport error ──

  it('RPC transport error: 5xx, event unprocessed', async () => {
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
      rpcError: { code: '500', message: 'connection refused' },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Finalization transport error');
  });

  // ── RPC null/malformed result ──

  it('RPC null result: 5xx', async () => {
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
      rpcResult: null,
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Finalization malformed result');
  });

  // ── RPC success:false ──

  it('RPC success:false: 5xx with reason', async () => {
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
      rpcResult: { success: false, reason: 'amount_mismatch' },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('amount_mismatch');
  });

  // ── RPC success but already_finalized not boolean ──

  it('RPC success=true but already_finalized missing: 5xx', async () => {
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
      rpcResult: { success: true },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(500);
  });

  // ── Fresh success runs Stage 3 with canonical IDs ──

  it('fresh finalization success: runs Stage 3, terminal → 200', async () => {
    confirmationResult = { status: 'completed' };
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
      rpcResult: {
        success: true, already_finalized: false,
        payment_id: 'pay-1', booking_id: 'book-1', booking_ref: 'REF-001',
        amount: 50, currency: 'USD', subscription_id: 'c1',
      },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(200);
    // Stage 3 was called
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    expect(sendProactiveConfirmation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'pay-1', amount: 50, booking_id: 'book-1' }),
      '[STRIPE RECURRING]',
    );
  });

  // ── Replay success runs Stage 3 with canonical IDs ──

  it('replay finalization success: runs Stage 3, terminal → 200', async () => {
    confirmationResult = { status: 'already_completed' };
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
      rpcResult: {
        success: true, already_finalized: true,
        payment_id: 'pay-1', booking_id: 'book-1', booking_ref: 'REF-001',
        amount: 50, currency: 'USD', subscription_id: 'c1',
      },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(200);
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    expect(sendProactiveConfirmation).toHaveBeenCalled();
  });

  // ── Stage 3 processing/retryable_failed: retryable, unprocessed ──

  it('Stage 3 processing: 5xx retryable', async () => {
    confirmationResult = { status: 'processing', retryable: true };
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
      rpcResult: {
        success: true, already_finalized: false,
        payment_id: 'pay-1', booking_id: 'book-1', booking_ref: 'REF-001',
        amount: 50, currency: 'USD', subscription_id: 'c1',
      },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Confirmation pending');
  });

  it('Stage 3 retryable_failed: 5xx retryable', async () => {
    confirmationResult = { status: 'retryable_failed', retryable: true, reason: 'claim_rpc_error' };
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
      rpcResult: {
        success: true, already_finalized: false,
        payment_id: 'pay-1', booking_id: 'book-1', booking_ref: 'REF-001',
        amount: 50, currency: 'USD', subscription_id: 'c1',
      },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(500);
  });

  // ── Stage 3 throw: retryable ──

  it('Stage 3 throw: 5xx retryable', async () => {
    confirmationThrow = true;
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
      rpcResult: {
        success: true, already_finalized: false,
        payment_id: 'pay-1', booking_id: 'book-1', booking_ref: 'REF-001',
        amount: 50, currency: 'USD', subscription_id: 'c1',
      },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Confirmation error');
  });

  // ── Terminal outcomes: completed/already_completed/not_deliverable ──

  it('Stage 3 not_deliverable: terminal, event processed → 200', async () => {
    confirmationResult = { status: 'not_deliverable', retryable: false, reason: 'no_phone' };
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
      rpcResult: {
        success: true, already_finalized: false,
        payment_id: 'pay-1', booking_id: 'book-1', booking_ref: 'REF-001',
        amount: 50, currency: 'USD', subscription_id: 'c1',
      },
    });
    const res = await callRoute(makeInvoicePaidPayload());
    expect(res.status).toBe(200);
  });

  // ── Missing/malformed invoice data ──

  it('missing amount_paid: 5xx', async () => {
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
    });
    const payload = makeInvoicePaidPayload({ amount_paid: null });
    const res = await callRoute(payload);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Malformed invoice amount');
  });

  it('non-integer amount_paid: 5xx', async () => {
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
    });
    const payload = makeInvoicePaidPayload({ amount_paid: 50.5 });
    const res = await callRoute(payload);
    expect(res.status).toBe(500);
  });

  it('missing currency: 5xx', async () => {
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
    });
    const payload = makeInvoicePaidPayload({ currency: null });
    const res = await callRoute(payload);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Malformed invoice currency');
  });

  it('malformed invoice ID (not in_): 5xx', async () => {
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
    });
    const payload = makeInvoicePaidPayload({ id: 'not_an_invoice' });
    const res = await callRoute(payload);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Malformed invoice ID');
  });

  it('zero amount_paid: 5xx', async () => {
    currentMock = buildServiceMock({
      customerSub: { id: 'c1', business_id: 'b1', gateway: 'stripe', status: 'active', gateway_subscription_code: 'sub_test_abc' },
    });
    const payload = makeInvoicePaidPayload({ amount_paid: 0 });
    const res = await callRoute(payload);
    expect(res.status).toBe(500);
  });
});
