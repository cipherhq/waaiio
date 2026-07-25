/**
 * FIN-002: Atomic payout execution and provider idempotency tests
 *
 * Tests proving:
 * - Atomic claim prevents concurrent double-approval
 * - Provider idempotency keys are deterministic and sent to providers
 * - Timeout/unknown result → review_required (not pending or failed)
 * - Token-guarded finalization prevents stale writes
 * - Manual methods never enter claim/provider path
 * - Unsupported transfer methods and gateways fail closed
 * - Feature gate still blocks everything when disabled
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
  finalizeResult?: unknown[] | null;
  payoutData?: Record<string, unknown> | null;
  bizData?: Record<string, unknown> | null;
  payoutAcctData?: Record<string, unknown> | null;
  fetchResponses?: Record<string, unknown>[];
}

function setupApproveRouteMocks(config: MockConfig = {}) {
  const {
    claimResult = [{ claimed_id: 'p1', claimed_token: 'tok', idempotency_key: 'payout_p1' }],
    claimError = null,
    finalizeResult = [{ finalized_id: 'p1' }],
    payoutData = {
      id: 'p1', business_id: 'b1', status: 'pending',
      net_amount: 100, payout_account_id: 'pa1',
      period_start: '2024-01-01', period_end: '2024-01-07',
    },
    bizData = { verification_level: 'verified', payout_limit_monthly: 0, country_code: 'NG' },
    payoutAcctData = { id: 'pa1', business_id: 'b1', is_active: true, verified_at: '2024-01-01' },
  } = config;

  capturedFetchCalls = [];

  // Mock supabase (SSR client for reads)
  const mockFrom = vi.fn().mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'eq', 'neq', 'in', 'is', 'single', 'maybeSingle', 'update', 'insert'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    if (table === 'business_payouts') {
      chain.single = vi.fn().mockResolvedValue({ data: payoutData });
    } else if (table === 'businesses') {
      chain.single = vi.fn().mockResolvedValue({ data: bizData });
    } else if (table === 'payout_accounts') {
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: payoutAcctData });
      chain.single = vi.fn().mockResolvedValue({
        data: { bank_code: '058', account_number: '0123456789', account_name: 'Test',
                stripe_account_id: 'acct_test' },
      });
    } else if (table === 'platform_fees') {
      chain.is = vi.fn().mockResolvedValue({ data: [{ transaction_amount: 1000, fee_total: 50 }] });
    } else {
      chain.single = vi.fn().mockResolvedValue({ data: null });
      chain.insert = vi.fn().mockResolvedValue({});
    }
    // For the prior payouts query
    chain.neq = vi.fn().mockResolvedValue({ data: [] });
    return chain;
  });

  vi.doMock('@/lib/supabase/server', () => ({
    createClient: vi.fn().mockResolvedValue({ from: mockFrom }),
  }));

  // Mock service client (for RPC calls)
  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: vi.fn().mockReturnValue({
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'claim_payout_for_transfer') {
          if (claimError) return Promise.resolve({ data: null, error: claimError });
          return Promise.resolve({ data: claimResult, error: null });
        }
        if (name === 'finalize_payout_transfer') {
          return Promise.resolve({ data: finalizeResult, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    }),
  }));

  vi.doMock('@/lib/admin-auth', () => ({
    requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin' }),
  }));
  vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
  vi.doMock('@/lib/email/templates', () => ({
    payoutApprovedEmail: vi.fn(), payoutPaidEmail: vi.fn(),
  }));
  vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

  // Mock fetch for provider calls
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
      return new Response(JSON.stringify({
        status: true,
        data: { recipient_code: 'RCP_test' },
      }));
    }
    if (url.includes('paystack.co/transfer')) {
      return new Response(JSON.stringify({
        status: true,
        data: { transfer_code: 'TRF_test' },
      }));
    }
    if (url.includes('stripe.com/v1/transfers')) {
      return new Response(JSON.stringify({ id: 'tr_test' }));
    }
    return new Response(JSON.stringify({}));
  });
}

// ═══════════════════════════════════════════════════════════
// Atomic Claim Tests
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

  it('second concurrent request returns 409 when claim fails', async () => {
    setupApproveRouteMocks({ claimResult: [] }); // empty = already claimed
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe('already_claimed');
    // No provider call should have been made
    expect(capturedFetchCalls.length).toBe(0);
  });

  it('successful claim proceeds to provider call', async () => {
    setupApproveRouteMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('processing');
    // Provider calls were made
    expect(capturedFetchCalls.length).toBeGreaterThan(0);
  });

  it('claim RPC error returns 500 without provider call', async () => {
    setupApproveRouteMocks({ claimError: { message: 'RPC error' } });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(500);
    expect(capturedFetchCalls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Provider Idempotency Tests
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Provider idempotency keys', () => {
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

  it('Paystack transfer includes deterministic reference field', async () => {
    setupApproveRouteMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    await POST(req, { params: Promise.resolve({ id: 'p1' }) });

    const transferCall = capturedFetchCalls.find(c => c.url.includes('paystack.co/transfer') && !c.url.includes('recipient'));
    expect(transferCall).toBeTruthy();
    const body = JSON.parse(transferCall!.body || '{}');
    expect(body.reference).toBe('payout_p1');
  });

  it('Stripe transfer includes Idempotency-Key header', async () => {
    setupApproveRouteMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'stripe_transfer' });
    await POST(req, { params: Promise.resolve({ id: 'p1' }) });

    const stripeCall = capturedFetchCalls.find(c => c.url.includes('stripe.com'));
    expect(stripeCall).toBeTruthy();
    expect(stripeCall!.headers?.['Idempotency-Key']).toBe('payout_p1');
  });

  it('idempotency key is deterministic: payout_{id}', async () => {
    // Verify source contains the deterministic pattern
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'), 'utf-8',
    );
    expect(source).toContain('`payout_${id}`');
  });
});

// ═══════════════════════════════════════════════════════════
// Timeout / Unknown-Result Tests
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Timeout and unknown-result handling', () => {
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

  it('provider timeout marks payout as review_required, not pending', async () => {
    // Setup mocks where fetch throws (simulating timeout)
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        from: vi.fn().mockImplementation((table: string) => {
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
            chain.single = vi.fn().mockResolvedValue({
              data: { verification_level: 'verified', country_code: 'NG' },
            });
          } else if (table === 'payout_accounts') {
            chain.maybeSingle = vi.fn().mockResolvedValue({
              data: { id: 'pa1', business_id: 'b1', is_active: true, verified_at: '2024-01-01' },
            });
            chain.single = vi.fn().mockResolvedValue({
              data: { bank_code: '058', account_number: '0123456789', account_name: 'Test' },
            });
          } else if (table === 'platform_fees') {
            chain.is = vi.fn().mockResolvedValue({ data: [{ transaction_amount: 1000, fee_total: 50 }] });
          }
          chain.neq = vi.fn().mockResolvedValue({ data: [] });
          return chain;
        }),
      }),
    }));

    let finalizeStatus: string | null = null;
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        rpc: vi.fn().mockImplementation((name: string, params: Record<string, unknown>) => {
          if (name === 'claim_payout_for_transfer') {
            return Promise.resolve({
              data: [{ claimed_id: 'p1', claimed_token: 'tok', idempotency_key: 'payout_p1' }],
              error: null,
            });
          }
          if (name === 'finalize_payout_transfer') {
            finalizeStatus = params.p_status as string;
            return Promise.resolve({ data: [{ finalized_id: 'p1' }], error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      }),
    }));

    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin' }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
    vi.doMock('@/lib/email/templates', () => ({
      payoutApprovedEmail: vi.fn(), payoutPaidEmail: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    // Make fetch throw to simulate timeout
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network timeout'));

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('review');
    expect(finalizeStatus).toBe('review_required');
  });
});

// ═══════════════════════════════════════════════════════════
// Manual Methods Tests
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Manual methods bypass claim and provider', () => {
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

  it('manual_bank does not call claim RPC or provider', async () => {
    let claimCalled = false;
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        from: vi.fn().mockImplementation(() => {
          const chain: Record<string, unknown> = {};
          ['select', 'eq', 'neq', 'in', 'is', 'single', 'maybeSingle', 'update'].forEach(m => {
            chain[m] = vi.fn().mockReturnValue(chain);
          });
          chain.single = vi.fn().mockResolvedValue({
            data: { id: 'p1', business_id: 'b1', status: 'pending', net_amount: 100,
                    payout_account_id: 'pa1', period_start: '2024-01-01', period_end: '2024-01-07' },
          });
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { id: 'pa1', business_id: 'b1', is_active: true, verified_at: '2024-01-01' },
          });
          chain.is = vi.fn().mockResolvedValue({ data: [{ transaction_amount: 1000, fee_total: 50 }] });
          chain.neq = vi.fn().mockResolvedValue({ data: [] });
          chain.insert = vi.fn().mockResolvedValue({});
          return chain;
        }),
      }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        rpc: vi.fn().mockImplementation(() => { claimCalled = true; return Promise.resolve({ data: [], error: null }); }),
      }),
    }));
    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin' }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
    vi.doMock('@/lib/email/templates', () => ({
      payoutApprovedEmail: vi.fn(), payoutPaidEmail: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'manual_bank' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('paid');
    expect(claimCalled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════
// Unsupported Methods / Gateways
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Unsupported transfer methods fail closed', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
    vi.restoreAllMocks();
  });

  it('unknown transfer method is rejected with 400', async () => {
    setupApproveRouteMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'square_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(400);
    expect(capturedFetchCalls.length).toBe(0);
  });

  it('flutterwave_transfer is rejected with 400', async () => {
    setupApproveRouteMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'flutterwave_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(400);
    expect(capturedFetchCalls.length).toBe(0);
  });

  it('unsupported methods cannot reach a paid or processing state', async () => {
    // Verify source: only paystack_transfer and stripe_transfer are in AUTOMATED_TRANSFER_METHODS
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'), 'utf-8',
    );
    expect(source).toContain("new Set(['paystack_transfer', 'stripe_transfer'])");
    // manual_bank and manual_cash are the only non-automated paths, and they use a conditional update
    expect(source).toContain(".in('status', ['pending', 'approved', 'held'])");
  });
});

// ═══════════════════════════════════════════════════════════
// Feature Gate Integration
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Feature gate still blocks everything', () => {
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
    setupApproveRouteMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', { transfer_method: 'paystack_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    expect(res.status).toBe(503);
    expect(capturedFetchCalls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// Source-Level Structural Verification
// ═══════════════════════════════════════════════════════════

describe('FIN-002: Structural verification', () => {
  it('claim RPC is called before any provider fetch in approve route', async () => {
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

  it('finalize RPC is called after provider call with claim token', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'), 'utf-8',
    );
    expect(source).toContain("'finalize_payout_transfer'");
    expect(source).toContain('p_claim_token: claimToken');
  });

  it('cron uses same claim_payout_for_transfer RPC', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/cron/auto-payout/route.ts'), 'utf-8',
    );
    expect(source).toContain("'claim_payout_for_transfer'");
    expect(source).toContain("'finalize_payout_transfer'");
    expect(source).toContain("'review_required'");
  });

  it('migration creates claim_token, provider_idempotency_key, processing_started_at columns', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('supabase/migrations/292_atomic_payout_claim.sql'), 'utf-8',
    );
    expect(source).toContain('claim_token UUID');
    expect(source).toContain('provider_idempotency_key TEXT');
    expect(source).toContain('processing_started_at TIMESTAMPTZ');
    expect(source).toContain('SECURITY DEFINER');
    expect(source).toContain("GRANT EXECUTE ON FUNCTION public.claim_payout_for_transfer");
    expect(source).toContain("GRANT EXECUTE ON FUNCTION public.finalize_payout_transfer");
    expect(source).toContain('REVOKE ALL');
  });
});
