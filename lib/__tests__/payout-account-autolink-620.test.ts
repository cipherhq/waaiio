/**
 * #620 — Payout account auto-link: executable route-level tests
 *
 * Each test calls the actual POST handler with mocked Supabase responses.
 * a) status advanced to processing/paid between read and link → 409
 * b) different account linked concurrently → 409
 * c) same account linked, status still eligible → proceeds
 * d) link update returns DB error → 500, no claim or transfer
 * e) step-up failure → zero writes
 * f) existing happy path (link succeeds in 1 row)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock verification limit helper — always allow in these auto-link tests
vi.mock('@/lib/payouts/verification-limit', () => ({
  checkVerificationLimit: vi.fn().mockResolvedValue({ allowed: true, limit: 999_999_999, used: 0, remaining: 999_999_999 }),
}));

function makePostRequest(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

interface AutoLinkTestConfig {
  /** What the link UPDATE returns (data array, or null for 0 rows) */
  linkUpdateResult?: unknown[] | null;
  /** Error from the link UPDATE */
  linkUpdateError?: unknown;
  /** What the re-read returns when link update gives 0 rows */
  rereadData?: { payout_account_id: string | null; status: string } | null;
  /** Whether consumeStepUp should throw */
  stepUpFails?: boolean;
  /** Manual approval update result */
  manualUpdateResult?: unknown[] | null;
}

// Track whether any update was called on business_payouts
let updateCalls: Array<{ table: string; data: Record<string, unknown> }>;

function setupMocks(config: AutoLinkTestConfig = {}) {
  const {
    linkUpdateResult = [{ id: 'p1', status: 'held', payout_account_id: 'pa-candidate' }],
    linkUpdateError = null,
    rereadData = null,
    stepUpFails = false,
    manualUpdateResult = [{ id: 'p1' }],
  } = config;

  updateCalls = [];

  // Track single() call count per from('business_payouts') invocation
  let bpFromCallCount = 0;

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    ['select', 'eq', 'neq', 'in', 'is', 'not', 'single', 'maybeSingle', 'update', 'insert'].forEach(m => {
      chain[m] = vi.fn().mockReturnValue(chain);
    });

    if (table === 'business_payouts') {
      bpFromCallCount++;
      const callNum = bpFromCallCount;

      // First from('business_payouts') → payout read (ends with .single())
      // Subsequent from('business_payouts') for SELECT → re-read
      chain.single = vi.fn().mockImplementation(() => {
        if (callNum === 1) {
          // Initial payout read — held, no payout_account_id
          return Promise.resolve({
            data: {
              id: 'p1', business_id: 'b1', status: 'held',
              net_amount: 100, payout_account_id: null,
              period_start: '2024-01-01', period_end: '2024-01-07',
              flags: [],
            },
          });
        }
        // Re-read after failed link
        return Promise.resolve({ data: rereadData });
      });

      // .update() → link or manual approval
      const linkChain: Record<string, unknown> = {};
      ['eq', 'in', 'is', 'select'].forEach(m => {
        linkChain[m] = vi.fn().mockReturnValue(linkChain);
      });

      // The manual approval update chain (different from link chain)
      const manualChain: Record<string, unknown> = {};
      ['eq', 'in', 'select'].forEach(m => {
        manualChain[m] = vi.fn().mockReturnValue(manualChain);
      });
      manualChain.select = vi.fn().mockResolvedValue({ data: manualUpdateResult });

      let updateCallNum = 0;
      chain.update = vi.fn().mockImplementation((data: Record<string, unknown>) => {
        updateCalls.push({ table, data });
        updateCallNum++;
        if (updateCallNum === 1 && data.payout_account_id) {
          // This is the auto-link update
          linkChain.select = vi.fn().mockResolvedValue({
            data: linkUpdateResult,
            error: linkUpdateError,
          });
          return linkChain;
        }
        // Manual approval update
        return manualChain;
      });
    } else if (table === 'businesses') {
      chain.single = vi.fn().mockResolvedValue({
        data: { verification_level: 'verified', country_code: 'NG', name: 'Test', owner_id: 'u1' },
      });
    } else if (table === 'payout_accounts') {
      // .not() is the terminal for candidate query → returns promise
      chain.not = vi.fn().mockResolvedValue({
        data: [{ id: 'pa-candidate' }], error: null,
      });
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: { id: 'pa-candidate', business_id: 'b1', is_active: true, verified_at: '2024-01-01', gateway: 'paystack' },
      });
      chain.single = vi.fn().mockResolvedValue({
        data: { bank_code: '058', account_number: '0123456789', account_name: 'Test', gateway: 'paystack' },
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

  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: vi.fn().mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      from: mockFrom,
    }),
  }));

  vi.doMock('@/lib/supabase/server', () => ({
    createClient: vi.fn().mockResolvedValue({ from: mockFrom }),
  }));

  vi.doMock('@/lib/admin-auth', () => ({
    requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin', aal: 'aal2', bearerToken: 'test-bearer' }),
    getSessionIdFromToken: vi.fn().mockReturnValue('test-session-id'),
  }));

  if (stepUpFails) {
    const StepUpErrorClass = class extends Error { constructor(m: string) { super(m); this.name = 'StepUpError'; } };
    vi.doMock('@/lib/admin-step-up', () => ({
      consumeStepUp: vi.fn().mockRejectedValue(new StepUpErrorClass('Step-up required')),
      StepUpError: StepUpErrorClass,
    }));
  } else {
    vi.doMock('@/lib/admin-step-up', () => ({
      consumeStepUp: vi.fn().mockResolvedValue(true),
      StepUpError: class extends Error { constructor(m: string) { super(m); this.name = 'StepUpError'; } },
    }));
  }

  vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
  vi.doMock('@/lib/email/templates', () => ({ payoutApprovedEmail: vi.fn(), payoutPaidEmail: vi.fn() }));
  vi.doMock('@/lib/logger', () => ({
    logger: {
      error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn(),
      withContext: () => ({ error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
    },
  }));
  vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn().mockReturnValue({}) }));
  vi.doMock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn().mockResolvedValue(undefined) }));
  vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }) }));
  vi.doMock('@/lib/payments/payout-classification', () => ({
    classifyPaystackError: vi.fn(), classifyStripeError: vi.fn(),
  }));

  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({})));
}

describe('#620 — Auto-link executable route tests', () => {
  beforeEach(() => { vi.resetModules(); process.env.ENABLE_PAYOUTS = 'true'; });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.ENABLE_PAYOUTS; });

  it('(f) happy path: link succeeds, manual approval completes', async () => {
    setupMocks({
      linkUpdateResult: [{ id: 'p1', status: 'held', payout_account_id: 'pa-candidate' }],
    });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', {
      transfer_method: 'manual_bank', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // Verify the link update was called
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateCalls[0].data.payout_account_id).toBe('pa-candidate');
  });

  it('(a) status advanced to processing between read and link → 409', async () => {
    setupMocks({
      linkUpdateResult: [],  // 0 rows — status or account changed
      rereadData: { payout_account_id: null, status: 'processing' },
    });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', {
      transfer_method: 'manual_bank', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('changed by a concurrent request');
    // Only the link update should have been called, not the manual approval
    expect(updateCalls.length).toBe(1);
  });

  it('(b) different account linked concurrently → 409', async () => {
    setupMocks({
      linkUpdateResult: [],  // 0 rows — someone else linked a different account
      rereadData: { payout_account_id: 'pa-other', status: 'held' },
    });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', {
      transfer_method: 'manual_bank', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('changed by a concurrent request');
    expect(updateCalls.length).toBe(1);
  });

  it('(c) same account linked concurrently, status still eligible → proceeds', async () => {
    setupMocks({
      linkUpdateResult: [],  // 0 rows, but same candidate was already linked
      rereadData: { payout_account_id: 'pa-candidate', status: 'held' },
    });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', {
      transfer_method: 'manual_bank', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // Should have called link update + manual approval update
    expect(updateCalls.length).toBe(2);
  });

  it('(d) link update returns DB error → 500, no claim or transfer', async () => {
    setupMocks({
      linkUpdateResult: null,
      linkUpdateError: { message: 'deadlock detected', code: '40P01' },
    });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', {
      transfer_method: 'manual_bank', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain('Failed to link payout account');
    // Only the failed link update, no manual approval
    expect(updateCalls.length).toBe(1);
  });

  it('(e) step-up failure → zero writes on business_payouts', async () => {
    setupMocks({ stepUpFails: true });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makePostRequest('/api/admin/payouts/p1/approve', {
      transfer_method: 'manual_bank', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('step_up_required');
    // No update calls at all — step-up failed before any write
    expect(updateCalls.length).toBe(0);
  });
});
