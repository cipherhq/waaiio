/**
 * #601/#664 Defect 1: Balance-check DB errors during payout approval
 * must emit structured logger.error (observability) and return HTTP 500
 * (fail-closed). Previously these paths returned 500 silently.
 *
 * Tests:
 * 1. balanceError  (platform_fees query fails)  → 500 + logger.error
 * 2. priorError    (business_payouts prior query fails) → 500 + logger.error
 * 3. balAdjError   (payout_adjustments query fails) → 500 + logger.error
 * 4. Happy path still succeeds (no false positives from logging additions)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock verification limit — always allow
vi.mock('@/lib/payouts/verification-limit', () => ({
  checkVerificationLimit: vi.fn().mockResolvedValue({ allowed: true, limit: 999_999_999, used: 0, remaining: 999_999_999 }),
}));

// ── Shared state ──

let loggedErrors: { message: string; context: Record<string, unknown> }[] = [];

function mockLogger() {
  return {
    error: (msg: string, ctx?: Record<string, unknown>) => {
      loggedErrors.push({ message: msg, context: ctx || {} });
    },
    info: () => {},
    debug: () => {},
    warn: () => {},
    withContext: () => ({
      error: (msg: string, ctx?: Record<string, unknown>) => {
        loggedErrors.push({ message: msg, context: ctx || {} });
      },
      info: () => {},
      debug: () => {},
      warn: () => {},
    }),
  };
}

function makeRequest() {
  return new NextRequest(new URL('http://localhost:3000/api/admin/payouts/p1/approve'), {
    method: 'POST',
    body: JSON.stringify({ transfer_method: 'paystack_transfer', stepUpId: 'step-1' }),
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Mock setup ──

// Which table query should fail? Set before each test.
let failTable: 'platform_fees' | 'business_payouts_prior' | 'payout_adjustments' | null = null;
const DB_ERROR = { message: 'connection reset', code: 'XX000' };

function setupMocks() {
  const mockFrom = vi.fn().mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    ['select', 'eq', 'neq', 'in', 'is', 'single', 'maybeSingle', 'update', 'insert'].forEach(m => {
      chain[m] = vi.fn().mockReturnValue(chain);
    });

    if (table === 'business_payouts') {
      // .single() is the payout fetch; .neq() is the prior-payouts balance query
      chain.single = vi.fn().mockResolvedValue({
        data: {
          id: 'p1', business_id: 'b1', status: 'pending',
          net_amount: 100, payout_account_id: 'pa1', flags: [],
          transfer_method: 'paystack_transfer',
        },
      });
      if (failTable === 'business_payouts_prior') {
        chain.neq = vi.fn().mockResolvedValue({ data: null, error: DB_ERROR });
      } else {
        chain.neq = vi.fn().mockResolvedValue({ data: [], error: null });
      }
    } else if (table === 'businesses') {
      chain.single = vi.fn().mockResolvedValue({
        data: { verification_level: 'verified', country_code: 'NG', name: 'Test Biz', owner_id: 'u1' },
      });
    } else if (table === 'payout_accounts') {
      chain.maybeSingle = vi.fn().mockResolvedValue({
        data: { id: 'pa1', business_id: 'b1', is_active: true, verified_at: '2024-01-01', gateway: 'paystack' },
      });
      chain.single = vi.fn().mockResolvedValue({
        data: { bank_code: '058', account_number: '0123456789', account_name: 'Test', gateway: 'paystack' },
      });
    } else if (table === 'platform_fees') {
      if (failTable === 'platform_fees') {
        chain.is = vi.fn().mockResolvedValue({ data: null, error: DB_ERROR });
      } else {
        chain.is = vi.fn().mockResolvedValue({
          data: [{ transaction_amount: 1000, fee_total: 50, gateway_fee: 10, waived: false, is_direct_transfer: false }],
          error: null,
        });
      }
    } else if (table === 'payout_adjustments') {
      if (failTable === 'payout_adjustments') {
        chain.eq = vi.fn().mockResolvedValue({ data: null, error: DB_ERROR });
      } else {
        chain.eq = vi.fn().mockResolvedValue({ data: [], error: null });
      }
    } else if (table === 'admin_audit_logs') {
      chain.insert = vi.fn().mockResolvedValue({});
    } else {
      chain.single = vi.fn().mockResolvedValue({ data: null });
    }
    return chain;
  });

  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: vi.fn().mockReturnValue({
      from: mockFrom,
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'claim_payout_for_transfer') {
          return Promise.resolve({
            data: [{ claimed_id: 'p1', claimed_token: 'tok', idempotency_key: 'payout_p1' }],
            error: null,
          });
        }
        if (name === 'mark_payout_provider_submitted') {
          return Promise.resolve({ data: [{ submitted_id: 'p1' }], error: null });
        }
        if (name === 'check_session_exists') {
          return { maybeSingle: vi.fn().mockResolvedValue({ data: { exists: true }, error: null }) };
        }
        return Promise.resolve({ data: null, error: null });
      }),
    }),
  }));

  vi.doMock('@/lib/admin-auth', () => ({
    requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin', aal: 'aal2', bearerToken: 'test-bearer' }),
    getSessionIdFromToken: vi.fn().mockReturnValue('test-session-id'),
  }));
  vi.doMock('@/lib/admin-step-up', () => ({
    consumeStepUp: vi.fn().mockResolvedValue(true),
    StepUpError: class extends Error { constructor(m: string) { super(m); this.name = 'StepUpError'; } },
  }));
  vi.doMock('@/lib/admin-audit', () => ({
    logAdminAudit: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
  vi.doMock('@/lib/email/templates', () => ({
    payoutApprovedEmail: vi.fn(), payoutPaidEmail: vi.fn(),
  }));
  vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
  vi.doMock('@/lib/errors', () => ({
    safeLogErrorContext: (err: unknown) => ({ error_detail: err }),
  }));
}

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe('#601/#664: Balance-check DB errors log and fail closed', () => {
  beforeEach(() => {
    loggedErrors = [];
    failTable = null;
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_key';
  });
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('balanceError (platform_fees) → HTTP 500 + logger.error with payout_id and business_id', async () => {
    failTable = 'platform_fees';
    setupMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to load balance data');

    // Verify structured log was emitted
    const balanceLog = loggedErrors.find(e => e.message.includes('Balance check failed'));
    expect(balanceLog).toBeDefined();
    expect(balanceLog!.context.payout_id).toBe('p1');
    expect(balanceLog!.context.business_id).toBe('b1');
    expect(balanceLog!.context.error_detail).toEqual(DB_ERROR);
  });

  it('priorError (business_payouts) → HTTP 500 + logger.error with payout_id and business_id', async () => {
    failTable = 'business_payouts_prior';
    setupMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to load prior payout data');

    const priorLog = loggedErrors.find(e => e.message.includes('Prior payout check failed'));
    expect(priorLog).toBeDefined();
    expect(priorLog!.context.payout_id).toBe('p1');
    expect(priorLog!.context.business_id).toBe('b1');
    expect(priorLog!.context.error_detail).toEqual(DB_ERROR);
  });

  it('balAdjError (payout_adjustments) → HTTP 500 + logger.error with payout_id and business_id', async () => {
    failTable = 'payout_adjustments';
    setupMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to load adjustment data');

    const adjLog = loggedErrors.find(e => e.message.includes('Adjustment check failed'));
    expect(adjLog).toBeDefined();
    expect(adjLog!.context.payout_id).toBe('p1');
    expect(adjLog!.context.business_id).toBe('b1');
    expect(adjLog!.context.error_detail).toEqual(DB_ERROR);
  });

  it('no DB errors → no balance-check error logs emitted', async () => {
    failTable = null;
    setupMocks();
    // Mock fetch for Paystack transfer recipient + transfer
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ status: true, data: { recipient_code: 'RCP_t', transfer_code: 'TRF_t' } }));
    });
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'p1' }) });

    // Should not be a 500 from balance checks
    expect(res.status).not.toBe(500);

    // No balance-check error logs
    const balanceErrors = loggedErrors.filter(e =>
      e.message.includes('Balance check failed') ||
      e.message.includes('Prior payout check failed') ||
      e.message.includes('Adjustment check failed')
    );
    expect(balanceErrors).toHaveLength(0);
  });
});
