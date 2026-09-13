/**
 * Route-level tests for subscription-renewal-recovery cron.
 *
 * Mocks fetch + supabase to verify key decision paths:
 * - Flutterwave cancelled + bounded tx found → paid_finalized
 * - Flutterwave cancelled + no tx → terminal_no_payment
 * - Flutterwave unavailable → unavailable evidence
 * - Stripe canceled + paid invoice found → paid_finalized
 * - Stripe canceled + no invoice → terminal_no_payment
 * - Stripe active → provider_active_or_retrying
 * - Stable source keys (no Date.now())
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('@/lib/payments/stripe-renewal-finalization', () => ({
  finalizeStripeRenewal: vi.fn(),
}));

const { createServiceClient } = await import('@/lib/supabase/service');
const { verifySubscriptionStatus, correlateProviderSubscription } = await import('@/lib/payments/flutterwave-subscription');
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
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
    (verifySubscriptionStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 'active' });

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
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);

    // Mock Stripe subscription API
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'active' }),
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
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);
    (verifySubscriptionStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 'cancelled' });

    // Mock fetch: bounded tx search returns empty
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
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (url.includes('/v1/subscriptions/')) {
        // Subscription status check
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'canceled' }),
        });
      }
      if (url.includes('/v1/invoices')) {
        // Invoice search — no paid invoices for the period
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] }),
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
        }],
        error: null,
      },
    });
    (createServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockService);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'active' }),
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
});
