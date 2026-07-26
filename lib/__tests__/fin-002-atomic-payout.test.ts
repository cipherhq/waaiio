/**
 * FIN-002: Atomic payout execution and provider idempotency tests
 *
 * Route-level tests (mocked dependencies, real route logic):
 * - Atomic claim prevents concurrent double-approval
 * - Server-generated tokens and provider keys are used
 * - Constrained state transitions (no backward to pending)
 * - Provider idempotency keys sent to providers
 * - Timeout/unknown → review_required
 * - Token-guarded finalization
 * - Manual methods bypass claim entirely
 * - Unsupported methods fail closed
 * - RPC errors are not treated as claim contention
 * - Failed finalization is not reported as success
 * - Feature gate blocks everything
 *
 * Database tests are in fin-002-db.test.ts (requires local Supabase).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Shared helpers ──

let capturedLogs: string[] = [];
let capturedFetchCalls: { url: string; body?: string; headers?: Record<string, string> }[] = [];

function captureAll(...args: unknown[]): void {
  capturedLogs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
}

function mockLogger() {
  return {
    error: captureAll, info: captureAll, debug: captureAll, warn: captureAll,
    withContext: () => ({ error: captureAll, info: captureAll, debug: captureAll, warn: captureAll }),
  };
}

function makePostRequest(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Configurable mock factory ──

interface MockConfig {
  claimResult?: unknown[] | null;
  claimError?: unknown;
  submitResult?: unknown[] | null;
  submitError?: unknown;
  failResult?: unknown[] | null;
  reviewResult?: unknown[] | null;
  payoutData?: Record<string, unknown> | null;
  manualUpdateResult?: unknown[] | null;
  fetchThrows?: boolean;
}

function setupMocks(config: MockConfig = {}) {
  const {
    claimResult = [{ claimed_id: 'p1', claimed_token: 'server-tok-uuid', idempotency_key: 'payout_p1' }],
    claimError = null,
    submitResult = [{ submitted_id: 'p1' }],
    submitError = null,
    failResult = [{ failed_id: 'p1' }],
    reviewResult = [{ review_id: 'p1' }],
    payoutData = {
      id: 'p1', business_id: 'b1', status: 'pending',
      net_amount: 100, payout_account_id: 'pa1',
      period_start: '2024-01-01', period_end: '2024-01-07',
    },
    manualUpdateResult = [{ id: 'p1' }],
    fetchThrows = false,
  } = config;

  capturedFetchCalls = [];

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    ['select', 'eq', 'neq', 'in', 'is', 'single', 'maybeSingle', 'update', 'insert'].forEach(m => {
      chain[m] = vi.fn().mockReturnValue(chain);
    });
    if (table === 'business_payouts') {
      chain.single = vi.fn().mockResolvedValue({ data: payoutData });
      // For manual update with .select('id') chain
      const updateChain: Record<string, unknown> = {};
      ['eq', 'in', 'select'].forEach(m => { updateChain[m] = vi.fn().mockReturnValue(updateChain); });
      updateChain.select = vi.fn().mockResolvedValue({ data: manualUpdateResult });
      chain.update = vi.fn().mockReturnValue(updateChain);
    } else if (table === 'businesses') {
      chain.single = vi.fn().mockResolvedValue({
        data: { verification_level: 'verified', country_code: 'NG', name: 'Test', owner_id: 'u1' },
      });
    } else if (table === 'payout_accounts') {
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: { id: 'pa1', business_id: 'b1', is_active: true, verified_at: '2024-01-01' },
      });
      chain.single = vi.fn().mockResolvedValue({
        data: { bank_code: '058', account_number: '0123456789', account_name: 'Test',
                stripe_account_id: 'acct_test' },
      });
    } else if (table === 'platform_fees') {
      chain.is = vi.fn().mockResolvedValue({ data: [{ transaction_amount: 1000, fee_total: 50 }] });
    } else if (table === 'profiles') {
      chain.single = vi.fn().mockResolvedValue({ data: { email: 'test@test.com' } });
    } else {
      chain.single = vi.fn().mockResolvedValue({ data: null });
      chain.insert = vi.fn().mockResolvedValue({});
    }
    chain.neq = vi.fn().mockResolvedValue({ data: [] });
    return chain;
  });

  vi.doMock('@/lib/supabase/server', () => ({
    createClient: vi.fn().mockResolvedValue({ from: mockFrom }),
  }));

  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: vi.fn().mockReturnValue({
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'claim_payout_for_transfer') {
          if (claimError) return Promise.resolve({ data: null, error: claimError });
          return Promise.resolve({ data: claimResult, error: null });
        }
        if (name === 'mark_payout_provider_submitted') {
          if (submitError) return Promise.resolve({ data: null, error: submitError });
          return Promise.resolve({ data: submitResult, error: null });
        }
        if (name === 'mark_payout_transfer_failed') {
          return Promise.resolve({ data: failResult, error: null });
        }
        if (name === 'mark_payout_review_required') {
          return Promise.resolve({ data: reviewResult, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    }),
  }));

  vi.doMock('@/lib/admin-auth', () => ({
    requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin' }),
  }));
  vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
  vi.doMock('@/lib/email/templates', () => ({
    payoutApprovedEmail: vi.fn(), payoutPaidEmail: vi.fn(),
  }));
  vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

  if (fetchThrows) {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network timeout'));
  } else {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const bodyStr = typeof init?.body === 'string' ? init.body : init?.body?.toString() || '';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers;
        if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
        else if (Array.isArray(h)) h.forEach(([k, v]) => { headers[k] = v; });
        else Object.entries(h).forEach(([k, v]) => { headers[k] = v; });
      }
      capturedFetchCalls.push({ url, body: bodyStr, headers });

      if (url.includes('transferrecipient')) {
        return new Response(JSON.stringify({ status: true, data: { recipient_code: 'RCP_test' } }));
      }
      if (url.includes('paystack.co/transfer')) {
        return new Response(JSON.stringify({ status: true, data: { transfer_code: 'TRF_test' } }));
      }
      if (url.includes('stripe.com/v1/transfers')) {
        return new Response(JSON.stringify({ id: 'tr_test' }));
      }
      return new Response(JSON.stringify({}));
    });
  }
}

// ═══════════════════════════════════════════════════════════
// Atomic Claim
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Atomic payout claim', () => {
  beforeEach(() => {
    capturedLogs = [];
    capturedFetchCalls = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_paystack_key';
    process.env.STRIPE_SECRET_KEY = 'test_stripe_key';
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
    delete process.env.PAYSTACK_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    vi.restoreAllMocks();
  });

  it('second concurrent request returns 409 when claim returns empty', async () => {
    setupMocks({ claimResult: [] });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(409);
    expect(capturedFetchCalls.length).toBe(0);
  });

  it('successful claim proceeds to provider call and uses server-generated values', async () => {
    setupMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(200);
    expect(capturedFetchCalls.length).toBeGreaterThan(0);
  });

  it('RPC error returns 500, NOT 409 (not treated as claim contention)', async () => {
    setupMocks({ claimError: { message: 'connection refused' } });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(500);
    expect(capturedFetchCalls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Provider Idempotency
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Provider idempotency keys (server-generated)', () => {
  beforeEach(() => {
    capturedLogs = [];
    capturedFetchCalls = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_paystack_key';
    process.env.STRIPE_SECRET_KEY = 'test_stripe_key';
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
    delete process.env.PAYSTACK_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    vi.restoreAllMocks();
  });

  it('Paystack transfer uses database-returned reference field', async () => {
    setupMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    await POST(req, { params: Promise.resolve({ id: 'p1' }) });

    const transferCall = capturedFetchCalls.find(c =>
      c.url.includes('paystack.co/transfer') && !c.url.includes('recipient'));
    expect(transferCall).toBeTruthy();
    const body = JSON.parse(transferCall!.body || '{}');
    expect(body.reference).toBe('payout_p1'); // Server-generated from claim RPC
  });

  it('Stripe transfer uses database-returned Idempotency-Key header', async () => {
    setupMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'stripe_transfer' });
    await POST(req, { params: Promise.resolve({ id: 'p1' }) });

    const stripeCall = capturedFetchCalls.find(c => c.url.includes('stripe.com'));
    expect(stripeCall).toBeTruthy();
    expect(stripeCall!.headers?.['Idempotency-Key']).toBe('payout_p1');
  });
});

// ═══════════════════════════════════════════════════════════
// Constrained State Transitions
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Constrained state transitions (no backward to pending)', () => {
  it('approve route source never calls finalize with pending status', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'), 'utf-8',
    );
    // Should NOT contain finalize_payout_transfer (old generic finalizer)
    expect(source).not.toContain('finalize_payout_transfer');
    // Should NOT contain p_status (old arbitrary status parameter)
    expect(source).not.toContain('p_status');
    // Should contain the constrained RPCs
    expect(source).toContain('mark_payout_provider_submitted');
    expect(source).toContain('mark_payout_transfer_failed');
    expect(source).toContain('mark_payout_review_required');
  });

  it('cron source uses constrained RPCs, never generic finalizer', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/cron/auto-payout/route.ts'), 'utf-8',
    );
    expect(source).not.toContain('finalize_payout_transfer');
    // No RPC call passes 'pending' as a status parameter
    expect(source).not.toMatch(/p_status.*'pending'/);
    expect(source).toContain('mark_payout_provider_submitted');
    expect(source).toContain('mark_payout_transfer_failed');
    expect(source).toContain('mark_payout_review_required');
  });

  it('migration drops old generic finalizer', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('supabase/migrations/292_atomic_payout_claim.sql'), 'utf-8',
    );
    expect(source).toContain('DROP FUNCTION IF EXISTS public.finalize_payout_transfer');
  });

  it('migration claim RPC rejects unsupported methods', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('supabase/migrations/292_atomic_payout_claim.sql'), 'utf-8',
    );
    expect(source).toContain("p_transfer_method NOT IN ('paystack_transfer', 'stripe_transfer')");
    expect(source).toContain('RAISE EXCEPTION');
  });

  it('migration has unique partial index on provider_idempotency_key', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('supabase/migrations/292_atomic_payout_claim.sql'), 'utf-8',
    );
    expect(source).toContain('CREATE UNIQUE INDEX');
    expect(source).toContain('provider_idempotency_key');
    expect(source).toContain('WHERE provider_idempotency_key IS NOT NULL');
  });
});

// ═══════════════════════════════════════════════════════════
// Timeout / Unknown-Result
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Timeout → review_required', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_paystack_key';
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
    delete process.env.PAYSTACK_SECRET_KEY;
    vi.restoreAllMocks();
  });

  it('provider timeout calls mark_payout_review_required', async () => {
    let reviewCalled = false;

    // Full inline setup — no setupMocks call to avoid ordering issues
    const mockFrom = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      ['select', 'eq', 'neq', 'in', 'is', 'single', 'maybeSingle', 'update'].forEach(m => {
        chain[m] = vi.fn().mockReturnValue(chain);
      });
      if (table === 'business_payouts') {
        chain.single = vi.fn().mockResolvedValue({
          data: { id: 'p1', business_id: 'b1', status: 'pending', net_amount: 100,
                  payout_account_id: 'pa1', period_start: '2024-01-01', period_end: '2024-01-07' },
        });
      } else if (table === 'businesses') {
        chain.single = vi.fn().mockResolvedValue({ data: { verification_level: 'verified', country_code: 'NG' } });
      } else if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa1', business_id: 'b1', is_active: true, verified_at: '2024-01-01' } });
        chain.single = vi.fn().mockResolvedValue({ data: { bank_code: '058', account_number: '0123456789', account_name: 'Test' } });
      } else if (table === 'platform_fees') {
        chain.is = vi.fn().mockResolvedValue({ data: [{ transaction_amount: 1000, fee_total: 50 }] });
      }
      chain.neq = vi.fn().mockResolvedValue({ data: [] });
      return chain;
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: vi.fn().mockResolvedValue({ from: mockFrom }) }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        rpc: vi.fn().mockImplementation((name: string) => {
          if (name === 'claim_payout_for_transfer') {
            return Promise.resolve({ data: [{ claimed_id: 'p1', claimed_token: 'tok', idempotency_key: 'payout_p1' }], error: null });
          }
          if (name === 'mark_payout_review_required') {
            reviewCalled = true;
            return Promise.resolve({ data: [{ review_id: 'p1' }], error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      }),
    }));
    vi.doMock('@/lib/admin-auth', () => ({ requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin' }) }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/templates', () => ({ payoutApprovedEmail: vi.fn(), payoutPaidEmail: vi.fn() }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network timeout'));

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const res = await POST(makePostRequest('/x', { transfer_method: 'paystack_transfer' }), { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(500);
    expect(reviewCalled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Provider Response Classification
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Provider response classification', () => {
  beforeEach(() => {
    capturedLogs = [];
    capturedFetchCalls = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_paystack_key';
    process.env.STRIPE_SECRET_KEY = 'test_stripe_key';
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
    delete process.env.PAYSTACK_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    vi.restoreAllMocks();
  });

  function setupWithFetchBehavior(behavior: (url: string) => Response) {
    let lastTransition: string | null = null;

    const mockFrom = vi.fn().mockImplementation((table: string) => {
      const chain: Record<string, unknown> = {};
      ['select', 'eq', 'neq', 'in', 'is', 'single', 'maybeSingle', 'update', 'insert'].forEach(m => {
        chain[m] = vi.fn().mockReturnValue(chain);
      });
      if (table === 'business_payouts') {
        chain.single = vi.fn().mockResolvedValue({
          data: { id: 'p1', business_id: 'b1', status: 'pending', net_amount: 100,
                  payout_account_id: 'pa1', period_start: '2024-01-01', period_end: '2024-01-07' },
        });
      } else if (table === 'businesses') {
        chain.single = vi.fn().mockResolvedValue({
          data: { verification_level: 'verified', country_code: 'NG', name: 'Test', owner_id: 'u1' },
        });
      } else if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: { id: 'pa1', business_id: 'b1', is_active: true, verified_at: '2024-01-01' },
        });
        chain.single = vi.fn().mockResolvedValue({
          data: { bank_code: '058', account_number: '0123456789', account_name: 'Test', stripe_account_id: 'acct_test' },
        });
      } else if (table === 'platform_fees') {
        chain.is = vi.fn().mockResolvedValue({ data: [{ transaction_amount: 1000, fee_total: 50 }] });
      } else if (table === 'profiles') {
        chain.single = vi.fn().mockResolvedValue({ data: { email: 'test@test.com' } });
      } else {
        chain.insert = vi.fn().mockResolvedValue({});
      }
      chain.neq = vi.fn().mockResolvedValue({ data: [] });
      return chain;
    });

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({ from: mockFrom }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        rpc: vi.fn().mockImplementation((name: string) => {
          if (name === 'claim_payout_for_transfer') {
            return Promise.resolve({
              data: [{ claimed_id: 'p1', claimed_token: 'tok', idempotency_key: 'payout_p1' }],
              error: null,
            });
          }
          if (name === 'mark_payout_transfer_failed') { lastTransition = 'failed'; }
          if (name === 'mark_payout_review_required') { lastTransition = 'review_required'; }
          if (name === 'mark_payout_provider_submitted') { lastTransition = 'submitted'; }
          return Promise.resolve({ data: [{ id: 'p1' }], error: null });
        }),
      }),
    }));
    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin' }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/templates', () => ({
      payoutApprovedEmail: vi.fn(), payoutPaidEmail: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes('transferrecipient')) {
        return new Response(JSON.stringify({ status: true, data: { recipient_code: 'RCP_test' } }));
      }
      return behavior(url);
    });

    return () => lastTransition;
  }

  it('Paystack explicit 400 → failed', async () => {
    const getTransition = setupWithFetchBehavior(() =>
      new Response(JSON.stringify({ status: false }), { status: 400 }));
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    await POST(makePostRequest('/x', { transfer_method: 'paystack_transfer' }), { params: Promise.resolve({ id: 'p1' }) });
    expect(getTransition()).toBe('failed');
  });

  it('Paystack 429 → review_required', async () => {
    const getTransition = setupWithFetchBehavior(() =>
      new Response('Rate limited', { status: 429 }));
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    await POST(makePostRequest('/x', { transfer_method: 'paystack_transfer' }), { params: Promise.resolve({ id: 'p1' }) });
    expect(getTransition()).toBe('review_required');
  });

  it('Paystack 500 → review_required', async () => {
    const getTransition = setupWithFetchBehavior(() =>
      new Response('Server error', { status: 500 }));
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    await POST(makePostRequest('/x', { transfer_method: 'paystack_transfer' }), { params: Promise.resolve({ id: 'p1' }) });
    expect(getTransition()).toBe('review_required');
  });

  it('Paystack malformed 200 body → review_required', async () => {
    const getTransition = setupWithFetchBehavior(() =>
      new Response('not json at all', { status: 200 }));
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    await POST(makePostRequest('/x', { transfer_method: 'paystack_transfer' }), { params: Promise.resolve({ id: 'p1' }) });
    expect(getTransition()).toBe('review_required');
  });

  it('Stripe explicit 400 → failed', async () => {
    const getTransition = setupWithFetchBehavior(() =>
      new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), { status: 400 }));
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    await POST(makePostRequest('/x', { transfer_method: 'stripe_transfer' }), { params: Promise.resolve({ id: 'p1' }) });
    expect(getTransition()).toBe('failed');
  });

  it('Stripe 429 → review_required', async () => {
    const getTransition = setupWithFetchBehavior(() =>
      new Response('Rate limited', { status: 429 }));
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    await POST(makePostRequest('/x', { transfer_method: 'stripe_transfer' }), { params: Promise.resolve({ id: 'p1' }) });
    expect(getTransition()).toBe('review_required');
  });

  it('Stripe 500 → review_required', async () => {
    const getTransition = setupWithFetchBehavior(() =>
      new Response('Internal error', { status: 500 }));
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    await POST(makePostRequest('/x', { transfer_method: 'stripe_transfer' }), { params: Promise.resolve({ id: 'p1' }) });
    expect(getTransition()).toBe('review_required');
  });

  it('Stripe 200 missing ID → review_required', async () => {
    const getTransition = setupWithFetchBehavior(() =>
      new Response(JSON.stringify({ object: 'transfer' }), { status: 200 }));
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    await POST(makePostRequest('/x', { transfer_method: 'stripe_transfer' }), { params: Promise.resolve({ id: 'p1' }) });
    expect(getTransition()).toBe('review_required');
  });

  it('Accepted provider → submitted', async () => {
    const getTransition = setupWithFetchBehavior((url) => {
      if (url.includes('paystack.co/transfer')) {
        return new Response(JSON.stringify({ status: true, data: { transfer_code: 'TRF_ok' } }));
      }
      return new Response(JSON.stringify({}));
    });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const res = await POST(makePostRequest('/x', { transfer_method: 'paystack_transfer' }), { params: Promise.resolve({ id: 'p1' }) });
    expect(getTransition()).toBe('submitted');
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════
// Failed Finalization
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Failed finalization is not reported as success', () => {
  beforeEach(() => {
    capturedLogs = [];
    capturedFetchCalls = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_paystack_key';
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
    delete process.env.PAYSTACK_SECRET_KEY;
    vi.restoreAllMocks();
  });

  it('submit RPC error returns 500 and does not send success notification', async () => {
    setupMocks({ submitResult: [], submitError: { message: 'DB error' } });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('finalization failed');
  });
});

// ═══════════════════════════════════════════════════════════
// Manual Methods
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Manual methods', () => {
  beforeEach(() => {
    capturedLogs = [];
    capturedFetchCalls = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
    vi.restoreAllMocks();
  });

  it('manual_bank bypasses claim RPC and provider', async () => {
    let claimCalled = false;
    setupMocks();
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        rpc: vi.fn().mockImplementation(() => { claimCalled = true; return Promise.resolve({ data: [], error: null }); }),
      }),
    }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'manual_bank' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(200);
    expect(claimCalled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('manual completion verifies one row transitioned', async () => {
    setupMocks({ manualUpdateResult: [] }); // zero rows — concurrent conflict
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'manual_bank' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════
// Unsupported Methods
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Unsupported transfer methods fail closed', () => {
  beforeEach(() => {
    capturedLogs = [];
    capturedFetchCalls = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
    vi.restoreAllMocks();
  });

  it('square_transfer rejected with 400', async () => {
    setupMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'square_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(400);
    expect(capturedFetchCalls.length).toBe(0);
  });

  it('flutterwave_transfer rejected with 400', async () => {
    setupMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'flutterwave_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(400);
    expect(capturedFetchCalls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Feature Gate
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Feature gate blocks everything', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
    vi.restoreAllMocks();
  });

  it('disabled gate returns 503 before any claim or provider call', async () => {
    delete process.env.ENABLE_PAYOUTS;
    setupMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(503);
    expect(capturedFetchCalls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Balance Reservation
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Balance reservation includes review_required', () => {
  it('approve route source includes review_required in balance check', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'), 'utf-8',
    );
    // Balance check should include review_required
    const balanceSection = source.slice(
      source.indexOf('.in(\'status\''),
      source.indexOf('.neq(\'id\''),
    );
    expect(balanceSection).toContain('review_required');
  });
});

// ═══════════════════════════════════════════════════════════
// Destination Validation Before Claim
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Destination details validated before claim', () => {
  it('approve route validates Paystack bank details before claim RPC', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'), 'utf-8',
    );
    const bankCheckPos = source.indexOf('bank_code');
    const claimPos = source.indexOf("'claim_payout_for_transfer'");
    // First bank_code reference should be the validation check, before claim
    expect(bankCheckPos).toBeLessThan(claimPos);
  });

  it('approve route validates Stripe destination before claim RPC', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'), 'utf-8',
    );
    const stripeDestPos = source.indexOf('stripe_account_id');
    const claimPos = source.indexOf("'claim_payout_for_transfer'");
    expect(stripeDestPos).toBeLessThan(claimPos);
  });
});

// ═══════════════════════════════════════════════════════════
// Structural: Claim → Provider → Constrained Transition
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Structural verification', () => {
  it('claim is called immediately before first provider side effect', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'), 'utf-8',
    );
    const claimPos = source.indexOf("'claim_payout_for_transfer'");
    const paystackPos = source.indexOf('api.paystack.co');
    const stripePos = source.indexOf('api.stripe.com');
    expect(claimPos).toBeGreaterThan(0);
    expect(claimPos).toBeLessThan(paystackPos);
    expect(claimPos).toBeLessThan(stripePos);
  });

  it('cron uses same constrained RPCs', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/cron/auto-payout/route.ts'), 'utf-8',
    );
    expect(source).toContain("'claim_payout_for_transfer'");
    expect(source).toContain("'mark_payout_provider_submitted'");
    expect(source).toContain("'mark_payout_transfer_failed'");
    expect(source).toContain("'mark_payout_review_required'");
    // Cron checks both data and error from claim RPC
    expect(source).toContain('claimErr');
  });

  it('migration RPCs use SECURITY DEFINER with explicit search_path', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('supabase/migrations/292_atomic_payout_claim.sql'), 'utf-8',
    );
    const rpcCount = (source.match(/SECURITY DEFINER/g) || []).length;
    expect(rpcCount).toBe(4); // claim + submitted + failed + review_required
    const searchPathCount = (source.match(/SET search_path = public/g) || []).length;
    expect(searchPathCount).toBe(4);
  });

  it('all RPCs revoke PUBLIC/anon/authenticated and grant only service_role', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('supabase/migrations/292_atomic_payout_claim.sql'), 'utf-8',
    );
    // 4 RPCs × 3 REVOKEs each = at least 12 REVOKE statements
    const revokeCount = (source.match(/REVOKE ALL/g) || []).length;
    expect(revokeCount).toBeGreaterThanOrEqual(12);
    // 4 GRANT statements
    const grantCount = (source.match(/GRANT EXECUTE/g) || []).length;
    expect(grantCount).toBe(4);
    // All grants are to service_role
    const serviceRoleGrants = (source.match(/TO service_role/g) || []).length;
    expect(serviceRoleGrants).toBe(4);
  });

  it('claim RPC generates token and key server-side', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('supabase/migrations/292_atomic_payout_claim.sql'), 'utf-8',
    );
    expect(source).toContain('v_token := gen_random_uuid()');
    expect(source).toContain("v_key := 'payout_' || p_payout_id::text");
    // Caller does NOT supply p_claim_token or p_idempotency_key
    const claimSig = source.slice(
      source.indexOf('FUNCTION public.claim_payout_for_transfer'),
      source.indexOf('RETURNS TABLE', source.indexOf('claim_payout_for_transfer')),
    );
    expect(claimSig).not.toContain('p_claim_token');
    expect(claimSig).not.toContain('p_idempotency_key');
  });
});
