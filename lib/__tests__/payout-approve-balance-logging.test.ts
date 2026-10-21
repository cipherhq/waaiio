/**
 * #601/#664 Defect 1: Balance-check DB errors during payout approval
 * must emit structured logger.error (observability) and return HTTP 500
 * (fail-closed). Previously these paths returned 500 silently.
 *
 * Tests use the REAL safeLogErrorContext sanitizer (lib/errors.ts) to
 * verify that sensitive DB error messages are stripped from log output.
 *
 * Tests:
 * 1. balanceError  (platform_fees query fails)  → 500 + logger.error
 * 2. priorError    (business_payouts prior query fails) → 500 + logger.error
 * 3. balAdjError   (payout_adjustments query fails) → 500 + logger.error
 * 4. Sensitive DB error message is stripped by real sanitizer
 * 5. Happy path (manual_bank) → 200 + { success: true, status: 'approved' }
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

// ── Mock setup ──

// Which table query should fail? Set before each test.
let failTable: 'platform_fees' | 'business_payouts_prior' | 'payout_adjustments' | null = null;

// Default DB error — safe code, benign message
const DB_ERROR = { message: 'connection reset', code: 'XX000' };

// Sensitive DB error — contains hostnames, credentials, PII that must NOT appear in logs
const SENSITIVE_DB_ERROR = {
  message: 'password authentication failed for user "service_role" at host db.internal.example.com:5432 (customer email: merchant@example.com)',
  code: 'FATAL',
};

// Choose which error object to inject
let activeError: Record<string, string> = DB_ERROR;

function makeRequest(transferMethod = 'paystack_transfer') {
  return new NextRequest(new URL('http://localhost:3000/api/admin/payouts/p1/approve'), {
    method: 'POST',
    body: JSON.stringify({ transfer_method: transferMethod, stepUpId: 'step-1', reference: 'REF-001' }),
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupMocks() {
  const mockFrom = vi.fn().mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    ['select', 'eq', 'neq', 'in', 'is', 'single', 'maybeSingle', 'update', 'insert'].forEach(m => {
      chain[m] = vi.fn().mockReturnValue(chain);
    });

    if (table === 'business_payouts') {
      chain.single = vi.fn().mockResolvedValue({
        data: {
          id: 'p1', business_id: 'b1', status: 'pending',
          net_amount: 100, payout_account_id: 'pa1', flags: [],
          transfer_method: 'paystack_transfer',
        },
      });
      // For the manual_bank update chain
      const updateChain: Record<string, unknown> = {};
      ['eq', 'in', 'select'].forEach(m => { updateChain[m] = vi.fn().mockReturnValue(updateChain); });
      updateChain.select = vi.fn().mockResolvedValue({ data: [{ id: 'p1' }] });
      chain.update = vi.fn().mockReturnValue(updateChain);

      if (failTable === 'business_payouts_prior') {
        chain.neq = vi.fn().mockResolvedValue({ data: null, error: activeError });
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
        chain.is = vi.fn().mockResolvedValue({ data: null, error: activeError });
      } else {
        chain.is = vi.fn().mockResolvedValue({
          data: [{ transaction_amount: 1000, fee_total: 50, gateway_fee: 10, waived: false, is_direct_transfer: false }],
          error: null,
        });
      }
    } else if (table === 'payout_adjustments') {
      if (failTable === 'payout_adjustments') {
        chain.eq = vi.fn().mockResolvedValue({ data: null, error: activeError });
      } else {
        chain.eq = vi.fn().mockResolvedValue({ data: [], error: null });
      }
    } else if (table === 'admin_audit_logs') {
      chain.insert = vi.fn().mockResolvedValue({});
    } else if (table === 'profiles') {
      chain.single = vi.fn().mockResolvedValue({ data: { email: 'admin@test.com' } });
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
  // Real safeLogErrorContext — NOT mocked. Uses actual sanitizer from lib/errors.ts.
  // lib/errors and lib/redact are NOT in vi.doMock — they load as real modules.
}

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe('#601/#664: Balance-check DB errors log and fail closed', () => {
  beforeEach(() => {
    loggedErrors = [];
    failTable = null;
    activeError = DB_ERROR;
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

    const balanceLog = loggedErrors.find(e => e.message.includes('Balance check failed'));
    expect(balanceLog).toBeDefined();
    expect(balanceLog!.context.payout_id).toBe('p1');
    expect(balanceLog!.context.business_id).toBe('b1');
    // Real sanitizer output: errorCode from DB_ERROR.code
    expect(balanceLog!.context.errorCode).toBe('XX000');
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
    expect(priorLog!.context.errorCode).toBe('XX000');
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
    expect(adjLog!.context.errorCode).toBe('XX000');
  });

  it('sensitive DB error message is stripped — only approved sanitized fields in log context', async () => {
    failTable = 'platform_fees';
    activeError = SENSITIVE_DB_ERROR;
    setupMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(500);

    const balanceLog = loggedErrors.find(e => e.message.includes('Balance check failed'));
    expect(balanceLog).toBeDefined();

    // Real safeLogErrorContext strips message text. Only errorName, errorCode, retryable are allowed.
    const ctx = balanceLog!.context;
    expect(ctx.payout_id).toBe('p1');
    expect(ctx.business_id).toBe('b1');

    // errorCode 'FATAL' passes isSafeIdentifier — should be present
    expect(ctx.errorCode).toBe('FATAL');

    // The sensitive message must NOT appear anywhere in the context
    const contextJson = JSON.stringify(ctx);
    expect(contextJson).not.toContain('password authentication failed');
    expect(contextJson).not.toContain('service_role');
    expect(contextJson).not.toContain('db.internal.example.com');
    expect(contextJson).not.toContain('merchant@example.com');
    expect(contextJson).not.toContain('5432');

    // Only approved keys from safeLogErrorContext: errorName, errorCode, retryable
    // Plus our route-added keys: payout_id, business_id
    const allowedKeys = new Set(['payout_id', 'business_id', 'errorName', 'errorCode', 'retryable']);
    for (const key of Object.keys(ctx)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  it('happy path (manual_bank) → HTTP 200 + { success: true, status: approved }, no balance-check error logs', async () => {
    failTable = null;
    setupMocks();
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    // manual_bank bypasses provider calls — simplest complete success path
    const res = await POST(makeRequest('manual_bank'), { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('approved');

    // No balance-check error logs on the happy path
    const balanceErrors = loggedErrors.filter(e =>
      e.message.includes('Balance check failed') ||
      e.message.includes('Prior payout check failed') ||
      e.message.includes('Adjustment check failed')
    );
    expect(balanceErrors).toHaveLength(0);
  });
});
