/**
 * Admin Bearer route handler tests — affected-row checks, failure paths, no false success.
 *
 * Calls actual route handlers with mocked Supabase client.
 * Covers CTO rulings #3 (affected rows), #4 (read errors = failed), #5 (atomicity).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Shared mock infrastructure ──

let mockFromImpl: (table: string) => Record<string, unknown>;
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn().mockResolvedValue({
    id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
    role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
  }),
}));
vi.mock('@/lib/admin-audit', () => ({
  logAdminAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/templates', () => ({
  kycApprovedEmail: vi.fn(() => ({ subject: '', html: '' })),
  kycRejectedEmail: vi.fn(() => ({ subject: '', html: '' })),
  kycRequestedEmail: vi.fn(() => ({ subject: '', html: '' })),
}));
vi.mock('@/lib/constants', () => ({
  getPayoutLimit: vi.fn(() => 500000),
  formatPayoutLimit: vi.fn(() => '₦500,000'),
  formatCurrency: vi.fn(() => '₦100'),
  getDocTypeLabel: vi.fn((cc: string, d: string) => d),
  CountryCode: {},
  VerificationLevel: {},
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: vi.fn(), debug: vi.fn(),
    withContext: vi.fn(() => ({
      error: (...args: unknown[]) => mockLoggerError(...args),
      warn: (...args: unknown[]) => mockLoggerWarn(...args),
      info: vi.fn(), debug: vi.fn(),
    })),
  },
  safeLogErrorContext: vi.fn(() => ({})),
}));
vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: vi.fn(() => ({})),
}));
vi.mock('@/lib/admin-step-up', () => ({
  consumeStepUp: vi.fn().mockResolvedValue(true),
  StepUpError: class extends Error { constructor(m: string) { super(m); this.name = 'StepUpError'; } },
}));
vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({
    payout_cooling_period_days: 7,
    fraud_velocity_threshold: 50,
    minimum_payout: { NG: 1000 },
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: (table: string) => mockFromImpl(table),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  })),
}));

function makeRequest(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
  });
}

/** Build a chainable mock for a Supabase .from(table) call */
function chainMock(terminalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'neq', 'in', 'is', 'gte', 'lte', 'order', 'range', 'insert', 'update'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue(terminalResult);
  chain.maybeSingle = vi.fn().mockResolvedValue(terminalResult);
  return chain;
}

// ═══════════════════════════════════════════════════════════════
// verification/review — document pre-validation, write order, error checks
// ═══════════════════════════════════════════════════════════════

describe('verification/review: document pre-validation and ordered writes', () => {
  let reviewModule: typeof import('@/app/api/verification/review/route');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoggerError.mockClear();
    mockLoggerWarn.mockClear();
    vi.resetModules();

    // Re-register mocks before re-importing the route
    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockResolvedValue({
        id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
        role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
      }),
    }));
    vi.doMock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/templates', () => ({
      kycApprovedEmail: vi.fn(() => ({ subject: '', html: '' })),
      kycRejectedEmail: vi.fn(() => ({ subject: '', html: '' })),
    }));
    vi.doMock('@/lib/constants', () => ({
      getPayoutLimit: vi.fn(() => 500000),
      formatPayoutLimit: vi.fn(() => '₦500,000'),
      CountryCode: {}, VerificationLevel: {},
    }));
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(),
        withContext: vi.fn(() => ({
          error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(),
        })),
      },
    }));
  });

  /**
   * Mock setup for the review route.
   *
   * The route calls tables in this order:
   *   1. businesses SELECT (get biz info)
   *   2. business_documents SELECT (pre-validate IDs) — via .in().eq()
   *   3. business_documents UPDATE (approve/reject docs) — via .update().in().eq().select()
   *   4. verification_requests UPDATE
   *   5. businesses UPDATE (mark verified/rejected) — LAST
   *   6. profiles SELECT (for email)
   *
   * The mock tracks call sequence per table to return different results
   * for SELECT vs UPDATE on the same table.
   */
  function setupMocks(overrides: {
    bizSelectResult?: { data: unknown; error: unknown };
    docPreValidateResult?: { data: unknown; error: unknown };
    docsUpdateResult?: { data: unknown; error: unknown };
    reqUpdateResult?: { data: unknown; error: unknown };
    bizUpdateResult?: { data: unknown; error: unknown };
    profileResult?: { data: unknown; error: unknown };
  } = {}) {
    const defaults = {
      bizSelectResult: { data: { name: 'Test Biz', owner_id: 'u1', country_code: 'NG' }, error: null },
      docPreValidateResult: { data: [{ id: 'd1' }], error: null },
      docsUpdateResult: { data: [{ id: 'd1' }], error: null },
      reqUpdateResult: { data: null, error: null },
      bizUpdateResult: { data: [{ id: 'b1' }], error: null },
      profileResult: { data: { email: 'test@test.com' }, error: null },
    };
    const cfg = { ...defaults, ...overrides };

    // Track per-table call counts to differentiate SELECT vs UPDATE
    let bizCallCount = 0;
    let docsCallCount = 0;

    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });

      if (table === 'businesses') {
        const idx = bizCallCount++;
        if (idx === 0) {
          // First: SELECT to get biz info → .single()
          chain.single = vi.fn().mockResolvedValue(cfg.bizSelectResult);
        } else {
          // Second: UPDATE to mark verified/rejected → .update().eq().select()
          // The route does .update({...}).eq('id', business_id).select('id')
          // .update() returns chain, .eq() returns chain, .select() resolves to the result
          chain.select = vi.fn().mockResolvedValue(cfg.bizUpdateResult);
        }
      } else if (table === 'business_documents') {
        const idx = docsCallCount++;
        if (idx === 0) {
          // First: SELECT for pre-validation → .select('id').in().eq()
          // Terminal is .eq() which resolves
          chain.eq = vi.fn().mockResolvedValue(cfg.docPreValidateResult);
        } else {
          // Second: UPDATE for approve/reject → .update().in().eq().select()
          // Terminal is .select() which resolves
          chain.select = vi.fn().mockResolvedValue(cfg.docsUpdateResult);
        }
      } else if (table === 'verification_requests') {
        // UPDATE → .update().eq().eq() — terminal .eq() resolves
        chain.eq = vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue(cfg.reqUpdateResult),
        });
      } else if (table === 'profiles') {
        chain.single = vi.fn().mockResolvedValue(cfg.profileResult);
      } else if (table === 'admin_audit_logs') {
        chain.insert = vi.fn().mockResolvedValue({ error: null });
      }
      return chain;
    };

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => ({
        from: (table: string) => mockFromImpl(table),
      })),
    }));
  }

  it('approve: foreign document_id returns 400 with no writes', async () => {
    // Pre-validation finds 0 owned docs out of 1 requested
    setupMocks({
      docPreValidateResult: { data: [], error: null },
    });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', {
        business_id: 'b1', action: 'approve', level: 'basic', document_ids: ['foreign-doc'],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('1 of 1');
    expect(body.error).toContain('do not belong');
    expect(body.success).toBeUndefined();
  });

  it('approve: missing document_id returns 400 with no writes', async () => {
    // Pre-validation finds 1 owned doc out of 2 requested
    setupMocks({
      docPreValidateResult: { data: [{ id: 'd1' }], error: null },
    });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', {
        business_id: 'b1', action: 'approve', level: 'basic', document_ids: ['d1', 'nonexistent'],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('1 of 2');
    expect(body.error).toContain('do not belong');
    expect(body.success).toBeUndefined();
  });

  it('approve: business update fails AFTER docs/requests succeed returns 500 with log', async () => {
    // Documents and requests write successfully, then business update errors
    setupMocks({
      docPreValidateResult: { data: [{ id: 'd1' }], error: null },
      docsUpdateResult: { data: [{ id: 'd1' }], error: null },
      reqUpdateResult: { data: null, error: null },
      bizUpdateResult: { data: null, error: { message: 'db error' } },
    });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', {
        business_id: 'b1', action: 'approve', level: 'basic', document_ids: ['d1'],
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    expect(body.error).toContain('documents were already updated');
    // Verify logger.error was called to record the partial write
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it('approve: happy path writes docs, then requests, then business', async () => {
    setupMocks({
      docPreValidateResult: { data: [{ id: 'd1' }], error: null },
      docsUpdateResult: { data: [{ id: 'd1' }], error: null },
      reqUpdateResult: { data: null, error: null },
      bizUpdateResult: { data: [{ id: 'b1' }], error: null },
      profileResult: { data: { email: 'test@test.com' }, error: null },
    });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', {
        business_id: 'b1', action: 'approve', level: 'basic', document_ids: ['d1'],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('reject: business update fails after docs/requests succeed returns 500', async () => {
    setupMocks({
      docPreValidateResult: { data: [{ id: 'd1' }], error: null },
      docsUpdateResult: { data: [{ id: 'd1' }], error: null },
      reqUpdateResult: { data: null, error: null },
      bizUpdateResult: { data: null, error: { message: 'db error' } },
    });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', {
        business_id: 'b1', action: 'reject', reason: 'incomplete docs', document_ids: ['d1'],
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    expect(body.error).toContain('documents were already updated');
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it('reject: documents update affected wrong count returns 500', async () => {
    // Pre-validation says 2 docs exist, but UPDATE only touches 1
    setupMocks({
      docPreValidateResult: { data: [{ id: 'd1' }, { id: 'd2' }], error: null },
      docsUpdateResult: { data: [{ id: 'd1' }], error: null }, // only 1 updated, expected 2
    });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', {
        business_id: 'b1', action: 'reject', reason: 'bad docs', document_ids: ['d1', 'd2'],
      }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    expect(body.error).toContain('affected');
    expect(body.error).toContain('1');
    expect(body.error).toContain('2');
  });
});

// ═══════════════════════════════════════════════════════════════
// verification/request — Option B + revert atomicity
// ═══════════════════════════════════════════════════════════════

describe('verification/request: Option B + revert atomicity', () => {
  let requestModule: typeof import('@/app/api/verification/request/route');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoggerError.mockClear();
    mockLoggerWarn.mockClear();
    vi.resetModules();

    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockResolvedValue({
        id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
        role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
      }),
    }));
    vi.doMock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/templates', () => ({ kycRequestedEmail: vi.fn(() => ({ subject: '', html: '' })) }));
    vi.doMock('@/lib/constants', () => ({ getDocTypeLabel: vi.fn((cc: string, d: string) => d), CountryCode: {} }));
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(),
        withContext: vi.fn(() => ({
          error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(),
        })),
      },
    }));
  });

  function setupMocks(overrides: {
    bizSelectResult?: { data: unknown; error: unknown };
    bizUpdateError?: unknown;
    insertResult?: { data: unknown; error: unknown };
    restoreResult?: { data: unknown; error: unknown };
    reReadResult?: { data: unknown; error: unknown };
    profileResult?: { data: unknown; error: unknown };
  } = {}) {
    const defaults = {
      bizSelectResult: { data: { name: 'Test Biz', owner_id: 'u1', country_code: 'NG', verification_status: 'unverified' }, error: null },
      bizUpdateError: null,
      insertResult: { data: { id: 'req-1' }, error: null },
      restoreResult: { data: [{ id: 'b1' }], error: null },
      reReadResult: { data: { verification_status: 'pending' }, error: null },
      profileResult: { data: { email: 'test@test.com' }, error: null },
    };
    const cfg = { ...defaults, ...overrides };

    let bizCallIndex = 0;
    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });
      if (table === 'businesses') {
        const idx = bizCallIndex++;
        if (idx === 0) {
          // First: SELECT to capture current status
          chain.single = vi.fn().mockResolvedValue(cfg.bizSelectResult);
        } else if (idx === 1) {
          // Second: UPDATE to 'pending'
          chain.eq = vi.fn().mockResolvedValue({ error: cfg.bizUpdateError });
        } else if (idx === 2) {
          // Third: CAS restore on insert failure
          // Route does .update().eq('id',…).eq('verification_status','pending').select('id')
          // The chain: .update() -> chain, .eq() returns inner, inner.eq() returns inner2, inner2.select() resolves
          chain.eq = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue(cfg.restoreResult),
            }),
          });
        } else if (idx === 3) {
          // Fourth: Re-read after CAS restore returns zero rows
          chain.single = vi.fn().mockResolvedValue(cfg.reReadResult);
        }
      } else if (table === 'verification_requests') {
        chain.single = vi.fn().mockResolvedValue(cfg.insertResult);
      } else if (table === 'profiles') {
        chain.single = vi.fn().mockResolvedValue(cfg.profileResult);
      } else if (table === 'admin_audit_logs') {
        chain.insert = vi.fn().mockResolvedValue({ error: null });
      }
      return chain;
    };

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => ({
        from: (table: string) => mockFromImpl(table),
      })),
    }));
  }

  it('happy path: updates to pending, inserts request, returns success', async () => {
    setupMocks();
    requestModule = await import('@/app/api/verification/request/route');
    const res = await requestModule.POST(
      makeRequest('/api/verification/request', { business_id: 'b1', requested_level: 'basic' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.request_id).toBe('req-1');
  });

  it('insert failure restores prior status and returns error', async () => {
    setupMocks({
      insertResult: { data: null, error: { message: 'duplicate key' } },
      restoreResult: { data: [{ id: 'b1' }], error: null },
    });
    requestModule = await import('@/app/api/verification/request/route');
    const res = await requestModule.POST(
      makeRequest('/api/verification/request', { business_id: 'b1', requested_level: 'basic' }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    expect(body.error).toContain('Failed to create verification request');
    // Should NOT contain 'manual intervention' — restore succeeded
    expect(body.error).not.toContain('manual intervention');
  });

  it('insert failure + restore failure logs at error with business_id and returns error', async () => {
    setupMocks({
      insertResult: { data: null, error: { message: 'insert failed' } },
      restoreResult: { data: null, error: { message: 'restore also failed' } },
    });
    requestModule = await import('@/app/api/verification/request/route');
    const res = await requestModule.POST(
      makeRequest('/api/verification/request', { business_id: 'b1', requested_level: 'basic' }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('manual intervention');
    // Verify logger.error was called with business_id
    expect(mockLoggerError).toHaveBeenCalled();
    const logCall = mockLoggerError.mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('VERIFICATION'),
    );
    expect(logCall).toBeDefined();
    const logContext = logCall![1] as Record<string, unknown>;
    expect(logContext.business_id).toBe('b1');
  });

  it('insert failure + CAS restore zero rows + concurrent status change returns 409', async () => {
    // CAS returns zero rows (no rows matched the WHERE), re-read shows 'verified' (concurrent change)
    setupMocks({
      insertResult: { data: null, error: { message: 'duplicate key' } },
      restoreResult: { data: [], error: null }, // zero rows — CAS didn't match
      reReadResult: { data: { verification_status: 'verified' }, error: null }, // concurrent change
    });
    requestModule = await import('@/app/api/verification/request/route');
    const res = await requestModule.POST(
      makeRequest('/api/verification/request', { business_id: 'b1', requested_level: 'basic' }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('concurrently');
    // Should have logged a warn, not error
    expect(mockLoggerWarn).toHaveBeenCalled();
    const warnCall = mockLoggerWarn.mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('concurrent'),
    );
    expect(warnCall).toBeDefined();
  });

  it('insert failure + CAS restore zero rows + still pending returns 500 with error log', async () => {
    // CAS returns zero rows, but re-read shows status is still 'pending' — compensation failure
    setupMocks({
      insertResult: { data: null, error: { message: 'insert failed' } },
      restoreResult: { data: [], error: null }, // zero rows — CAS didn't match
      reReadResult: { data: { verification_status: 'pending' }, error: null }, // still pending — anomaly
    });
    requestModule = await import('@/app/api/verification/request/route');
    const res = await requestModule.POST(
      makeRequest('/api/verification/request', { business_id: 'b1', requested_level: 'basic' }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('manual intervention');
    // Should have logged at error level
    expect(mockLoggerError).toHaveBeenCalled();
    const errorCall = mockLoggerError.mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('Compensation failure'),
    );
    expect(errorCall).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// payouts/generate — read errors, insert errors, no-eligible
// ═══════════════════════════════════════════════════════════════

describe('payouts/generate: failure counting and no-eligible result', () => {
  let generateModule: typeof import('@/app/api/admin/payouts/generate/route');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoggerError.mockClear();
    mockLoggerWarn.mockClear();
    vi.resetModules();

    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockResolvedValue({
        id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
        role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
      }),
    }));
    vi.doMock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/admin-step-up', () => ({
      consumeStepUp: vi.fn().mockResolvedValue(true),
      StepUpError: class extends Error { constructor(m: string) { super(m); this.name = 'StepUpError'; } },
    }));
    vi.doMock('@/lib/platformSettings', () => ({
      loadPlatformSettings: vi.fn().mockResolvedValue({
        payout_cooling_period_days: 7,
        fraud_velocity_threshold: 50,
        minimum_payout: { NG: 100 },
      }),
    }));
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(),
        withContext: vi.fn(() => ({
          error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(),
        })),
      },
      safeLogErrorContext: vi.fn(() => ({})),
    }));
    vi.doMock('@/lib/errors', () => ({
      safeLogErrorContext: vi.fn(() => ({})),
    }));
  });

  function setupGenerateMocks(overrides: {
    businesses?: unknown[] | null;
    businessesError?: unknown;
    existingPayout?: unknown;
    existingError?: unknown;
    feesData?: unknown[] | null;
    feesError?: unknown;
    paymentsError?: unknown;
    adjustmentsData?: unknown[] | null;
    adjustmentsError?: unknown;
    insertResult?: { data: unknown; error: unknown };
    payoutAccountData?: unknown;
    adjLinkError?: unknown;
  } = {}) {
    const defaults = {
      businesses: [{ id: 'b1', created_at: '2025-01-01', verification_level: 'basic', payout_limit_monthly: 500000, country_code: 'NG' }],
      businessesError: null,
      existingPayout: null,
      existingError: null,
      feesData: [{ transaction_amount: 10000, fee_total: 500, gateway_fee: 100, waived: false, is_direct_transfer: false }],
      feesError: null,
      paymentsError: null,
      adjustmentsData: [] as unknown[],
      adjustmentsError: null,
      insertResult: { data: { id: 'payout-1' }, error: null },
      payoutAccountData: { id: 'pa-1' },
      adjLinkError: null,
    };
    const cfg = { ...defaults, ...overrides };

    // Track calls to business_payouts to differentiate dedup check vs insert vs update-after-adj-failure
    let payoutsCallCount = 0;

    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });
      if (table === 'businesses') {
        // The businesses SELECT uses .eq().eq() chain, terminal is the last .eq()
        // which resolves to the data array
        chain.eq = vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: cfg.businesses, error: cfg.businessesError }),
        });
      } else if (table === 'business_payouts') {
        const idx = payoutsCallCount++;
        if (idx === 0) {
          // Dedup check uses .maybeSingle()
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: cfg.existingPayout, error: cfg.existingError });
          // Monthly limit check also uses business_payouts
          chain.gte = vi.fn().mockResolvedValue({ data: [], error: null });
        }
        // INSERT — .insert({}).select('id').single()
        chain.insert = vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(cfg.insertResult),
          }),
        });
        // UPDATE for adjustment link failure — .update({}).eq('id', payoutId)
        chain.update = vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        });
      } else if (table === 'platform_fees') {
        chain.lte = vi.fn().mockResolvedValue({ data: cfg.feesData, error: cfg.feesError });
      } else if (table === 'payments') {
        chain.lte = vi.fn().mockResolvedValue({ data: [], error: cfg.paymentsError });
      } else if (table === 'payout_adjustments') {
        if (cfg.adjustmentsError) {
          chain.is = vi.fn().mockResolvedValue({ data: null, error: cfg.adjustmentsError });
        } else {
          chain.is = vi.fn().mockResolvedValue({ data: cfg.adjustmentsData, error: null });
        }
        // The .in() UPDATE for linking adjustments to the payout
        if (cfg.adjLinkError) {
          chain.in = vi.fn().mockResolvedValue({ error: cfg.adjLinkError });
        } else {
          chain.in = vi.fn().mockResolvedValue({ error: null });
        }
      } else if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: cfg.payoutAccountData, error: null });
      } else if (table === 'admin_audit_logs') {
        chain.insert = vi.fn().mockResolvedValue({ error: null });
      }
      return chain;
    };

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => ({
        from: (table: string) => mockFromImpl(table),
        rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    }));
  }

  it('read error on dedup check counts as failed, returns 207', async () => {
    setupGenerateMocks({ existingError: { message: 'connection refused' } });
    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(
      makeRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }),
    );
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.failed).toBeGreaterThan(0);
    expect(body.success).toBeUndefined();
  });

  it('read error on fees counts as failed, returns 207', async () => {
    setupGenerateMocks({ feesError: { message: 'timeout' } });
    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(
      makeRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }),
    );
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.failed).toBeGreaterThan(0);
  });

  it('insert error counts as failed, returns 207', async () => {
    setupGenerateMocks({ insertResult: { data: null, error: { message: 'constraint violation' } } });
    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(
      makeRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }),
    );
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.failed).toBeGreaterThan(0);
    expect(body.success).toBeUndefined();
  });

  it('zero eligible businesses returns explicit no-eligible result', async () => {
    // All businesses have zero gross fees → no eligible payouts
    setupGenerateMocks({ feesData: [] });
    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(
      makeRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.created).toBe(0);
    expect(body.held).toBe(0);
    expect(body.message).toContain('No eligible');
  });

  it('no platform-managed businesses returns explicit message', async () => {
    setupGenerateMocks({ businesses: [] });
    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(
      makeRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain('No platform-managed');
  });

  it('adjustment link failure sets payout to held with flag, counts as failed', async () => {
    // Business has pending adjustments; payout inserts ok, but linking adjustments fails
    setupGenerateMocks({
      adjustmentsData: [{ id: 'adj-1', amount: -500 }],
      adjLinkError: { message: 'FK constraint violated' },
    });
    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(
      makeRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }),
    );
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.failed).toBeGreaterThan(0);
    // Verify logger.error was called with adjustment_link context
    expect(mockLoggerError).toHaveBeenCalled();
    const logCall = mockLoggerError.mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('Adjustment link failed'),
    );
    expect(logCall).toBeDefined();
  });
});
