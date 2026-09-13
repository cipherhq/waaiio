/**
 * Route-level tests for subscription recovery/reconciliation crons.
 *
 * Covers:
 * - Flutterwave cancelled + bounded tx found → paid_finalized
 * - Flutterwave cancelled + no tx → terminal_no_payment
 * - Flutterwave unavailable → unavailable evidence
 * - Flutterwave pagination cap → unavailable
 * - Stripe canceled + paid invoice found → paid_finalized
 * - Stripe canceled + no invoice → terminal_no_payment
 * - Stripe active → provider_active_or_retrying
 * - Checkout recovery: quarantine result not counted as recovered (Finding 6)
 * - Cancellation: basic flow via claim RPC
 * - Stable source keys (no Date.now())
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/cron-auth', () => ({
  verifyCronAuth: vi.fn(() => null),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/payments/flutterwave-subscription', () => ({
  verifySubscriptionStatus: vi.fn(),
  correlateProviderSubscription: vi.fn(),
}));

vi.mock('@/lib/payments/flutterwave-verify', () => ({
  verifyTransactionById: vi.fn(),
}));

vi.mock('@/lib/payments/stripe-renewal-finalization', () => ({
  finalizeStripeRenewal: vi.fn(),
}));

vi.mock('@/lib/payments/stripe-invoice-extractors', () => ({
  extractSubscriptionLinePeriod: vi.fn((invoiceData: Record<string, unknown>) => {
    const lines = invoiceData.lines as { data?: Array<{ period?: { start?: number; end?: number } }> } | undefined;
    if (!lines?.data?.[0]?.period?.start || !lines?.data?.[0]?.period?.end) {
      return { error: 'no_lines', detail: 'Missing lines data' };
    }
    return { periodStart: lines.data[0].period.start, periodEnd: lines.data[0].period.end };
  }),
  classifyInvoiceSubscription: vi.fn(),
  extractInvoicePaymentIdentity: vi.fn(),
}));

vi.mock('@/lib/payments/flutterwave-decisions', () => ({
  decideSubscriptionCorrelation: vi.fn(),
}));

const { createServiceClient } = await import('@/lib/supabase/service');
const { verifySubscriptionStatus, correlateProviderSubscription } = await import('@/lib/payments/flutterwave-subscription');
const { verifyTransactionById } = await import('@/lib/payments/flutterwave-verify');
const { finalizeStripeRenewal } = await import('@/lib/payments/stripe-renewal-finalization');

// Helper to build a mock supabase service client
function buildMockService(rpcResults: Record<string, { data: unknown; error: unknown }> = {}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const fromCalls: Array<{ table: string; method: string; args: unknown[] }> = [];

  const mockService = {
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (rpcResults[fn]) return Promise.resolve(rpcResults[fn]);
      return Promise.resolve({ data: { recorded: true }, error: null });
    }),
    from: vi.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      const addChain = (method: string) => {
        chain[method] = vi.fn((...cArgs: unknown[]) => {
          fromCalls.push({ table, method, args: cArgs });
          return chain;
        });
      };
      addChain('select');
      addChain('insert');
      addChain('update');
      addChain('eq');
      addChain('lte');
      addChain('in');
      addChain('order');
      addChain('limit');
      addChain('single');
      chain.single = vi.fn(() => {
        fromCalls.push({ table, method: 'single', args: [] });
        if (table === 'platform_config_versions') {
          return Promise.resolve({ data: { id: 'cfg-ver-001' }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      });
      return chain;
    }),
    _rpcCalls: rpcCalls,
    _fromCalls: fromCalls,
  };
  return mockService;
}

// Mock fetch for external API calls
const originalFetch = globalThis.fetch;

describe('Renewal Recovery Cron — Decision Paths', () => {
  let mockService: ReturnType<typeof buildMockService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = buildMockService({
      claim_overdue_subscription_batch: {
        data: [],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses stable source keys (no Date.now()) for Flutterwave', async () => {
    const subId = 'sub-flw-001';
    mockService = buildMockService({
      claim_overdue_subscription_batch: {
        data: [{
          sub_id: subId,
          gateway: 'flutterwave',
          current_period_end: '2026-10-01T00:00:00Z',
          flutterwave_subscription_id: 'flw_123',
          flutterwave_subscriber_email: 'test@test.com',
          flutterwave_plan_id: 12345,
          currency: 'NGN',
          amount: 5000,
          business_id: 'biz-001',
          plan: 'growth',
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
    (verifySubscriptionStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 'active' });

    // Mock fetch for paginated tx search — return empty (exhaustive)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'success', data: [] }),
    });

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const req = new Request('http://localhost/api/cron/subscription-renewal-recovery') as any;
    await GET(req);

    // Find the record_reconciliation_evidence call
    const evidenceCall = mockService._rpcCalls.find(c => c.fn === 'record_reconciliation_evidence');
    expect(evidenceCall).toBeTruthy();
    // Source key must be deterministic (no Date.now())
    const sourceKey = evidenceCall!.args.p_source_key as string;
    expect(sourceKey).toBe(`renewal_recovery_flw_${subId}`);
    expect(sourceKey).not.toMatch(/\d{13}/); // no unix timestamp
  });

  it('uses stable source keys for Stripe', async () => {
    const subId = 'sub-stripe-001';
    mockService = buildMockService({
      claim_overdue_subscription_batch: {
        data: [{
          sub_id: subId,
          gateway: 'stripe',
          current_period_end: '2026-10-01T00:00:00Z',
          stripe_subscription_id: 'sub_stripe_123',
          business_id: 'biz-001',
          plan: 'growth',
          currency: 'USD',
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);

    // Mock Stripe subscription API → active, then invoice search → empty
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/v1/subscriptions/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'active' }),
        });
      }
      if (url.includes('/v1/invoices')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [], has_more: false }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    process.env.STRIPE_SECRET_KEY = 'test_stripe_key_mock';

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const req = new Request('http://localhost/api/cron/subscription-renewal-recovery') as any;
    await GET(req);

    const evidenceCall = mockService._rpcCalls.find(c => c.fn === 'record_reconciliation_evidence');
    expect(evidenceCall).toBeTruthy();
    const sourceKey = evidenceCall!.args.p_source_key as string;
    expect(sourceKey).toBe(`renewal_recovery_stripe_${subId}`);
    expect(sourceKey).not.toMatch(/\d{13}/);

    process.env.STRIPE_SECRET_KEY = '';
  });

  it('Flutterwave cancelled + unavailable tx search → unavailable (not terminal)', async () => {
    const subId = 'sub-flw-002';
    mockService = buildMockService({
      claim_overdue_subscription_batch: {
        data: [{
          sub_id: subId,
          gateway: 'flutterwave',
          current_period_end: '2026-10-01T00:00:00Z',
          flutterwave_subscription_id: 'flw_456',
          flutterwave_subscriber_email: 'test2@test.com',
          flutterwave_plan_id: 12345,
          currency: 'NGN',
          amount: 5000,
          business_id: 'biz-002',
          plan: 'growth',
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
    (verifySubscriptionStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 'cancelled' });

    // Mock fetch to fail for bounded tx search
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const req = new Request('http://localhost/api/cron/subscription-renewal-recovery') as any;
    await GET(req);

    const evidenceCall = mockService._rpcCalls.find(c => c.fn === 'record_reconciliation_evidence');
    expect(evidenceCall).toBeTruthy();
    // When tx search fails, outcome must be 'unavailable' (never terminal)
    expect(evidenceCall!.args.p_outcome).toBe('unavailable');
  });

  it('Flutterwave cancelled + no tx candidates → terminal_no_payment', async () => {
    const subId = 'sub-flw-003';
    mockService = buildMockService({
      claim_overdue_subscription_batch: {
        data: [{
          sub_id: subId,
          gateway: 'flutterwave',
          current_period_end: '2026-10-01T00:00:00Z',
          flutterwave_subscription_id: 'flw_789',
          flutterwave_subscriber_email: 'test3@test.com',
          flutterwave_plan_id: 12345,
          currency: 'NGN',
          amount: 5000,
          business_id: 'biz-003',
          plan: 'growth',
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
    (verifySubscriptionStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 'cancelled' });

    // Mock fetch: bounded tx search returns empty (exhaustive)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'success', data: [] }),
    });

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const req = new Request('http://localhost/api/cron/subscription-renewal-recovery') as any;
    await GET(req);

    const evidenceCall = mockService._rpcCalls.find(c => c.fn === 'record_reconciliation_evidence');
    expect(evidenceCall).toBeTruthy();
    expect(evidenceCall!.args.p_outcome).toBe('terminal_no_payment');
  });

  it('Stripe canceled + no paid invoices → terminal_no_payment', async () => {
    const subId = 'sub-stripe-002';
    mockService = buildMockService({
      claim_overdue_subscription_batch: {
        data: [{
          sub_id: subId,
          gateway: 'stripe',
          current_period_end: '2026-10-01T00:00:00Z',
          stripe_subscription_id: 'sub_stripe_456',
          business_id: 'biz-002',
          plan: 'growth',
          currency: 'USD',
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/v1/subscriptions/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'canceled' }),
        });
      }
      if (url.includes('/v1/invoices')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [], has_more: false }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    process.env.STRIPE_SECRET_KEY = 'test_stripe_key_mock';

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const req = new Request('http://localhost/api/cron/subscription-renewal-recovery') as any;
    await GET(req);

    const evidenceCall = mockService._rpcCalls.find(c => c.fn === 'record_reconciliation_evidence');
    expect(evidenceCall).toBeTruthy();
    expect(evidenceCall!.args.p_outcome).toBe('terminal_no_payment');

    process.env.STRIPE_SECRET_KEY = '';
  });

  it('Stripe active → provider_active_or_retrying', async () => {
    const subId = 'sub-stripe-003';
    mockService = buildMockService({
      claim_overdue_subscription_batch: {
        data: [{
          sub_id: subId,
          gateway: 'stripe',
          current_period_end: '2026-10-01T00:00:00Z',
          stripe_subscription_id: 'sub_stripe_789',
          business_id: 'biz-003',
          plan: 'growth',
          currency: 'USD',
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);

    // Stripe sub API → active, then invoice search → empty
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/v1/subscriptions/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'active' }),
        });
      }
      if (url.includes('/v1/invoices')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [], has_more: false }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    process.env.STRIPE_SECRET_KEY = 'test_stripe_key_mock';

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const req = new Request('http://localhost/api/cron/subscription-renewal-recovery') as any;
    await GET(req);

    const evidenceCall = mockService._rpcCalls.find(c => c.fn === 'record_reconciliation_evidence');
    expect(evidenceCall).toBeTruthy();
    expect(evidenceCall!.args.p_outcome).toBe('provider_active_or_retrying');

    process.env.STRIPE_SECRET_KEY = '';
  });

  it('Flutterwave pagination cap reached → unavailable (not terminal)', async () => {
    const subId = 'sub-flw-pagecap';
    mockService = buildMockService({
      claim_overdue_subscription_batch: {
        data: [{
          sub_id: subId,
          gateway: 'flutterwave',
          current_period_end: '2026-10-01T00:00:00Z',
          flutterwave_subscription_id: 'flw_cap_123',
          flutterwave_subscriber_email: 'cap@test.com',
          flutterwave_plan_id: 12345,
          currency: 'NGN',
          amount: 50,
          business_id: 'biz-cap',
          plan: 'growth',
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
    (verifySubscriptionStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 'cancelled' });

    // Mock fetch: always return data (never empty) → page cap will be hit
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'success', data: [
        { id: 111, tx_ref: 'tx_infinite', amount: 50, currency: 'NGN', created_at: '2026-10-01T01:00:00Z' },
      ]}),
    });

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const req = new Request('http://localhost/api/cron/subscription-renewal-recovery') as any;
    await GET(req);

    const evidenceCall = mockService._rpcCalls.find(c => c.fn === 'record_reconciliation_evidence');
    expect(evidenceCall).toBeTruthy();
    // Page cap → unavailable (never terminal_no_payment)
    expect(evidenceCall!.args.p_outcome).toBe('unavailable');
  });

  it('FLW paid finalization: verified candidate → finalize_flutterwave_subscription_renewal → paid_finalized', async () => {
    const subId = 'sub-flw-paid-001';
    mockService = buildMockService({
      claim_overdue_subscription_batch: {
        data: [{
          sub_id: subId,
          gateway: 'flutterwave',
          current_period_end: '2026-10-01T00:00:00Z',
          flutterwave_subscription_id: 'flw_paid_123',
          flutterwave_subscriber_email: 'paid@test.com',
          flutterwave_plan_id: 99,
          currency: 'NGN',
          amount: 50,
          business_id: 'biz-paid',
          plan: 'growth',
        }],
        error: null,
      },
      finalize_flutterwave_subscription_renewal: {
        data: { finalized: true },
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
    (verifySubscriptionStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 'cancelled' });

    // Mock paginated tx search: return one candidate on page 1, empty on page 2+
    let fetchCallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // Page 1: return one candidate
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'success', data: [
            { id: 999, tx_ref: 'txref_001', amount: 50, currency: 'NGN', created_at: '2026-10-01T01:00:00Z' },
          ]}),
        });
      }
      // Page 2+: empty (exhausted)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'success', data: [] }),
      });
    });

    // verifyTransactionById returns successful — amount=50 (major units, matching sub.amount)
    (verifyTransactionById as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      tx: { id: 999, tx_ref: 'txref_001', status: 'successful', amount: 50, currency: 'NGN', created_at: '2026-10-01T01:00:00Z' },
    });

    // correlateProviderSubscription returns match
    (correlateProviderSubscription as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, sub: { subscriptionId: 'flw_paid_123', planId: 99 },
    });

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const req = new Request('http://localhost/api/cron/subscription-renewal-recovery') as any;
    const res = await GET(req);
    const body = await res.json();

    // Should have called finalize RPC
    const finCall = mockService._rpcCalls.find(c => c.fn === 'finalize_flutterwave_subscription_renewal');
    expect(finCall).toBeTruthy();

    // Should record paid_finalized evidence
    const evidenceCall = mockService._rpcCalls.find(c => c.fn === 'record_reconciliation_evidence');
    expect(evidenceCall).toBeTruthy();
    expect(evidenceCall!.args.p_outcome).toBe('paid_finalized');
  });

  it('Stripe paid finalization: matching invoice → finalizeStripeRenewal → paid_finalized', async () => {
    const subId = 'sub-stripe-paid-001';
    const periodEndUnix = Math.floor(new Date('2026-10-01T00:00:00Z').getTime() / 1000);

    mockService = buildMockService({
      claim_overdue_subscription_batch: {
        data: [{
          sub_id: subId,
          gateway: 'stripe',
          current_period_end: '2026-10-01T00:00:00Z',
          stripe_subscription_id: 'sub_stripe_paid_123',
          business_id: 'biz-stripe-paid',
          plan: 'growth',
          currency: 'USD',
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/v1/subscriptions/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'canceled' }),
        });
      }
      if (url.includes('/v1/invoices')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [{
              id: 'in_paid_001',
              payment_intent: 'pi_paid_001',
              amount_paid: 9900,
              currency: 'usd',
              period_start: periodEndUnix,
              period_end: periodEndUnix + 30 * 86400,
              created: periodEndUnix + 100,
              status_transitions: { paid_at: periodEndUnix + 100 },
              lines: {
                data: [{
                  subscription: 'sub_stripe_paid_123',
                  period: { start: periodEndUnix, end: periodEndUnix + 30 * 86400 },
                }],
              },
            }],
            has_more: false,
          }),
        });
      }
      return Promise.resolve({ ok: false });
    });

    (finalizeStripeRenewal as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ finalized: true, paymentId: 'pay-001' });

    process.env.STRIPE_SECRET_KEY = 'test_stripe_key_mock';

    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    const req = new Request('http://localhost/api/cron/subscription-renewal-recovery') as any;
    await GET(req);

    // Should record paid_finalized evidence
    const evidenceCall = mockService._rpcCalls.find(c => c.fn === 'record_reconciliation_evidence');
    expect(evidenceCall).toBeTruthy();
    expect(evidenceCall!.args.p_outcome).toBe('paid_finalized');

    process.env.STRIPE_SECRET_KEY = '';
  });
});

describe('Checkout Recovery — Structured Result Check (Finding 6)', () => {
  let mockService: ReturnType<typeof buildMockService>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('quarantine result from finalize RPC is NOT counted as recovered', async () => {
    mockService = buildMockService({
      claim_stale_checkout_batch: {
        data: [{
          intent_id: 'intent-001',
          idempotency_key: 'key-001',
          created_at: '2026-09-01T00:00:00Z',
          gateway: 'flutterwave',
        }],
        error: null,
      },
      finalize_flutterwave_subscription_checkout: {
        // Quarantined: finalized is NOT true
        data: { finalized: false, quarantine: true },
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);

    // Mock flutterwave-verify discover
    vi.doMock('@/lib/payments/flutterwave-verify', () => ({
      discoverAndVerifyTransaction: vi.fn().mockResolvedValue({
        ok: true,
        tx: { id: 123, tx_ref: 'key-001', status: 'successful', amount: 50, currency: 'NGN', created_at: '2026-09-01' },
      }),
    }));

    // Mock flutterwave-subscription correlate
    vi.doMock('@/lib/payments/flutterwave-subscription', () => ({
      correlateProviderSubscription: vi.fn().mockResolvedValue({
        ok: true, sub: { subscriptionId: 'flw_sub_1', planId: 99 },
      }),
      verifySubscriptionStatus: vi.fn(),
    }));

    // Mock flutterwave-decisions
    vi.doMock('@/lib/payments/flutterwave-decisions', () => ({
      decideSubscriptionCorrelation: vi.fn().mockReturnValue({
        action: 'proceed', subscriptionId: 'flw_sub_1', planId: 99,
      }),
    }));

    const { GET } = await import('@/app/api/cron/subscription-checkout-recovery/route');
    const req = new Request('http://localhost/api/cron/subscription-checkout-recovery') as any;
    const res = await GET(req);
    const body = await res.json();

    // recovered should be 0 because finalized !== true (quarantined)
    expect(body.recovered).toBe(0);
    // skipped should be 1
    expect(body.skipped).toBe(1);
  });
});

describe('Cancellation Reconciliation — Basic Flow', () => {
  let mockService: ReturnType<typeof buildMockService>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses claim_active_subscriptions_for_cancellation_check RPC and stable event IDs', async () => {
    const subId = 'sub-cancel-001';
    mockService = buildMockService({
      claim_active_subscriptions_for_cancellation_check: {
        data: [{
          sub_id: subId,
          gateway: 'flutterwave',
          flutterwave_subscription_id: 'flw_cancel_123',
          flutterwave_subscriber_email: 'cancel@test.com',
          flutterwave_plan_id: 99,
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
    (verifySubscriptionStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 'cancelled' });

    // Reset modules to get fresh route import
    vi.resetModules();
    // Re-mock after reset
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockService }));
    vi.doMock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
    vi.doMock('@/lib/payments/flutterwave-subscription', () => ({
      verifySubscriptionStatus: vi.fn().mockResolvedValue({ ok: true, status: 'cancelled' }),
      correlateProviderSubscription: vi.fn(),
    }));

    const { GET } = await import('@/app/api/cron/subscription-cancellation-reconciliation/route');
    const req = new Request('http://localhost/api/cron/subscription-cancellation-reconciliation') as any;
    await GET(req);

    // Should have called the claim RPC
    const claimCall = mockService._rpcCalls.find(c => c.fn === 'claim_active_subscriptions_for_cancellation_check');
    expect(claimCall).toBeTruthy();

    // Should have called finalize_subscription_cancellation with stable event ID
    const cancelCall = mockService._rpcCalls.find(c => c.fn === 'finalize_subscription_cancellation');
    expect(cancelCall).toBeTruthy();
    expect(cancelCall!.args.p_provider_event_id).toBe(`reconciliation_cancel_flutterwave_${subId}`);
  });
});
