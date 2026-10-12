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
        // UPDATE for adjustment link failure — .update({}).eq('id', payoutId).select('id')
        chain.update = vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({ data: [{ id: 'payout-1' }], error: null }),
          }),
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

  it('adjustment link failure: containment update sets status held with adjustment_link_failed flag', async () => {
    // Adjustments exist, adjustment UPDATE errors, containment UPDATE on business_payouts succeeds
    // We need to capture the update payload to verify the containment write
    //
    // The generate route calls .from('business_payouts') 4 times for a single business:
    //   0: dedup check (.select().eq().eq().eq().maybeSingle())
    //   1: monthly limit check (.select().eq().in().gte()) — only if payout_limit_monthly > 0
    //   2: INSERT (.insert({}).select('id').single())
    //   3: containment UPDATE (.update({}).eq('id',...).select('id'))
    let capturedUpdatePayload: Record<string, unknown> | null = null;
    let payoutsCallIdx = 0;

    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });
      if (table === 'businesses') {
        chain.eq = vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: [{ id: 'b1', created_at: '2025-01-01', verification_level: 'basic', payout_limit_monthly: 500000, country_code: 'NG' }],
            error: null,
          }),
        });
      } else if (table === 'business_payouts') {
        const idx = payoutsCallIdx++;
        if (idx === 0) {
          // Dedup check — no existing payout
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        } else if (idx === 1) {
          // Monthly limit check — terminal is .gte()
          chain.gte = vi.fn().mockResolvedValue({ data: [], error: null });
        } else if (idx === 2) {
          // INSERT
          chain.insert = vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'payout-1' }, error: null }),
            }),
          });
        } else if (idx === 3) {
          // Containment UPDATE — capture the payload
          chain.update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
            capturedUpdatePayload = payload;
            return {
              eq: vi.fn().mockReturnValue({
                select: vi.fn().mockResolvedValue({ data: [{ id: 'payout-1' }], error: null }),
              }),
            };
          });
        }
      } else if (table === 'platform_fees') {
        chain.lte = vi.fn().mockResolvedValue({
          data: [{ transaction_amount: 10000, fee_total: 500, gateway_fee: 100, waived: false, is_direct_transfer: false }],
          error: null,
        });
      } else if (table === 'payments') {
        chain.lte = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'payout_adjustments') {
        // SELECT returns adjustments
        chain.is = vi.fn().mockResolvedValue({ data: [{ id: 'adj-1', amount: -500 }], error: null });
        // UPDATE (link to payout) errors
        chain.in = vi.fn().mockResolvedValue({ error: { message: 'FK constraint violated' } });
      } else if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1' }, error: null });
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

    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(
      makeRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }),
    );
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.failed).toBeGreaterThan(0);

    // Verify containment update payload includes status: 'held' and the adjustment_link_failed flag
    expect(capturedUpdatePayload).not.toBeNull();
    expect(capturedUpdatePayload!.status).toBe('held');
    const capturedFlags = capturedUpdatePayload!.flags as Array<{ type: string }>;
    expect(capturedFlags).toBeDefined();
    const adjFlag = capturedFlags.find((f) => f.type === 'adjustment_link_failed');
    expect(adjFlag).toBeDefined();
  });

  it('adjustment link failure: containment update fails → payout_id in needs_attention', async () => {
    // Same call sequence as above but the containment UPDATE also fails
    let payoutsCallIdx2 = 0;

    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });
      if (table === 'businesses') {
        chain.eq = vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: [{ id: 'b1', created_at: '2025-01-01', verification_level: 'basic', payout_limit_monthly: 500000, country_code: 'NG' }],
            error: null,
          }),
        });
      } else if (table === 'business_payouts') {
        const idx = payoutsCallIdx2++;
        if (idx === 0) {
          // Dedup check
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        } else if (idx === 1) {
          // Monthly limit check
          chain.gte = vi.fn().mockResolvedValue({ data: [], error: null });
        } else if (idx === 2) {
          // INSERT
          chain.insert = vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'payout-99' }, error: null }),
            }),
          });
        } else if (idx === 3) {
          // Containment UPDATE — fails
          chain.update = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({ data: null, error: { message: 'containment write failed' } }),
            }),
          });
        }
      } else if (table === 'platform_fees') {
        chain.lte = vi.fn().mockResolvedValue({
          data: [{ transaction_amount: 10000, fee_total: 500, gateway_fee: 100, waived: false, is_direct_transfer: false }],
          error: null,
        });
      } else if (table === 'payments') {
        chain.lte = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'payout_adjustments') {
        chain.is = vi.fn().mockResolvedValue({ data: [{ id: 'adj-2', amount: -300 }], error: null });
        chain.in = vi.fn().mockResolvedValue({ error: { message: 'FK constraint violated' } });
      } else if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1' }, error: null });
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

    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(
      makeRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }),
    );
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.failed).toBeGreaterThan(0);
    expect(body.needs_attention).toBeDefined();
    expect(body.needs_attention).toContain('payout-99');
  });
});

// ═══════════════════════════════════════════════════════════════
// payouts/approve — flagged held payout rejection
// ═══════════════════════════════════════════════════════════════

describe('payouts/approve: flagged held payout rejection', () => {
  let approveModule: typeof import('@/app/api/admin/payouts/[id]/approve/route');

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
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/templates', () => ({
      payoutApprovedEmail: vi.fn(() => ({ subject: '', html: '' })),
      payoutPaidEmail: vi.fn(() => ({ subject: '', html: '' })),
    }));
    vi.doMock('@/lib/constants', () => ({
      formatCurrency: vi.fn(() => '₦100'),
      CountryCode: {},
    }));
    vi.doMock('@/lib/countries', () => ({
      getCountry: vi.fn(() => ({ currency_code: 'NGN' })),
    }));
    vi.doMock('@/lib/errors', () => ({
      safeLogErrorContext: vi.fn(() => ({})),
    }));
    vi.doMock('@/lib/payments/payout-classification', () => ({
      classifyPaystackError: vi.fn(),
      classifyStripeError: vi.fn(),
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

  it('flagged held payout returns 409, consumeStepUp NOT called, no writes', async () => {
    // The approve route checks ENABLE_PAYOUTS before anything else
    process.env.ENABLE_PAYOUTS = 'true';

    // Mock the service client: payout SELECT returns a held payout with adjustment_link_failed flag
    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });
      if (table === 'business_payouts') {
        chain.single = vi.fn().mockResolvedValue({
          data: {
            id: 'payout-flagged',
            business_id: 'b1',
            net_amount: 5000,
            status: 'held',
            payout_account_id: 'pa-1',
            period_start: '2025-01-01',
            period_end: '2025-01-07',
            flags: [{ type: 'adjustment_link_failed', message: 'test', severity: 'critical' }],
          },
          error: null,
        });
      }
      return chain;
    };

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => ({
        from: (table: string) => mockFromImpl(table),
        rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    }));

    approveModule = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = makeRequest('/api/admin/payouts/payout-flagged/approve', {
      transfer_method: 'manual_bank',
      stepUpId: 'su-1',
    });
    const res = await approveModule.POST(req, { params: Promise.resolve({ id: 'payout-flagged' }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('adjustment_link_failed');

    // Verify consumeStepUp was NOT called (the flag check is before step-up)
    const { consumeStepUp: mockConsumeStepUp } = await import('@/lib/admin-step-up');
    expect((mockConsumeStepUp as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    delete process.env.ENABLE_PAYOUTS;
  });
});

// ═══════════════════════════════════════════════════════════════
let cronPaystackEligible = false;
// cron auto-payout — flagged held payout skip logic
// ═══════════════════════════════════════════════════════════════

describe('cron auto-payout: flagged held payout handling', () => {
  let cronModule: typeof import('@/app/api/cron/auto-payout/route');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoggerError.mockClear();
    mockLoggerWarn.mockClear();
    vi.resetModules();

    // Cron uses verifyCronAuth, not requirePlatformAdmin
    vi.doMock('@/lib/cron-auth', () => ({
      verifyCronAuth: vi.fn().mockReturnValue(null), // null = authorized
    }));
    vi.doMock('@/lib/observability/cron', () => ({
      createCronLogger: vi.fn(() => ({
        started: vi.fn(),
        completed: vi.fn(),
        failed: vi.fn(),
      })),
    }));
    vi.doMock('@/lib/countries', () => ({
      loadCountries: vi.fn().mockResolvedValue(undefined),
      getCountry: vi.fn(() => ({ currency_code: 'NGN' })),
    }));
    vi.doMock('@/lib/constants', () => ({
      getCurrencyCode: vi.fn(() => 'NGN'),
      CountryCode: {},
    }));
    vi.doMock('@/lib/platformSettings', () => ({
      loadPlatformSettings: vi.fn().mockResolvedValue({
        payout_cooling_period_days: 7,
        fraud_velocity_threshold: 50,
        minimum_payout: { NG: 100 },
      }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/templates', () => ({
      payoutFailedEmail: vi.fn(() => ({ subject: '', html: '' })),
    }));
    vi.doMock('@/lib/errors', () => ({
      safeLogErrorContext: vi.fn(() => ({})),
    }));
    cronPaystackEligible = false;
    vi.doMock('@/lib/payments/payout-classification', () => ({
      classifyPaystackError: vi.fn(),
      isEligiblePaystackAccount: vi.fn(() => cronPaystackEligible),
    }));
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(),
        withContext: vi.fn(() => ({
          error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(),
        })),
      },
    }));
    vi.doMock('@sentry/nextjs', () => ({
      captureException: vi.fn(),
    }));
  });

  function makeCronRequest() {
    return new NextRequest(new URL('/api/cron/auto-payout', 'http://localhost:3000'), {
      method: 'GET',
      headers: { 'Authorization': 'Bearer test-cron-secret' },
    });
  }

  it('flagged held payout is NOT released', async () => {
    // Track whether business_payouts UPDATE to 'approved' was called for held payout
    let approvedUpdateCalled = false;
    let bizCallIdx = 0;
    let payoutsCallIdx = 0;
    let payoutAccountsCallIdx = 0;

    // The cron route:
    // 1. Queries businesses (.select().eq().eq()) — must return at least 1 to avoid early return
    // 2. Batch-fetches: business_payouts (dedup), platform_fees, payout_adjustments, payout_accounts
    //    via Promise.all — each uses .select().in()...limit()
    // 3. Loops through businesses, skips those with zero gross fees
    // 4. After generation loop: queries held payouts (.select().eq('status','held'))
    // 5. Batch-fetches businesses and payout_accounts for held payouts
    // 6. Loops through held payouts, potentially updates to 'approved'

    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });

      if (table === 'businesses') {
        const idx = bizCallIdx++;
        if (idx === 0) {
          // Generation phase: .select().eq('payout_mode',...).eq('status',...)
          // Return a business so we don't hit the early return.
          // Zero fees will make it skip (no payout generated).
          chain.eq = vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ id: 'biz-dummy', name: 'Dummy', created_at: '2024-01-01', country_code: 'NG', verification_level: 'basic' }],
              error: null,
            }),
          });
        } else {
          // Held payout release phase: .select().in('id',...).limit(5000)
          chain.in = vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{
                id: 'b1',
                created_at: '2024-01-01', // old enough — cooling done
                verification_level: 'basic', // verified
              }],
              error: null,
            }),
          });
        }
      } else if (table === 'business_payouts') {
        const idx = payoutsCallIdx++;
        if (idx === 0) {
          // Batch-fetch: existing payouts for period — .select().in().eq().eq().limit()
          // Return empty — no existing payouts for this business
          chain.in = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          });
        } else if (idx === 1) {
          // Held payouts query: .select().eq('status', 'held')
          chain.eq = vi.fn().mockResolvedValue({
            data: [{
              id: 'held-payout-1',
              business_id: 'b1',
              flags: [{ type: 'adjustment_link_failed', message: 'test failure', severity: 'critical' }],
            }],
            error: null,
          });
        } else {
          // UPDATE to 'approved' — track if called
          chain.update = vi.fn().mockImplementation(() => {
            approvedUpdateCalled = true;
            return {
              eq: vi.fn().mockResolvedValue({ error: null }),
            };
          });
        }
      } else if (table === 'platform_fees') {
        // Batch-fetch: .select().in().is().gte().lte().limit()
        // Return empty — zero fees means no payout generated, skips to held release
        chain.in = vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            gte: vi.fn().mockReturnValue({
              lte: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        });
      } else if (table === 'payout_adjustments') {
        // Batch-fetch: .select().in().is().limit()
        chain.in = vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        });
      } else if (table === 'payout_accounts') {
        const paIdx = payoutAccountsCallIdx++;
        if (paIdx === 0) {
          // Batch-fetch for generation: .select().in().eq().limit()
          chain.in = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          });
        } else {
          // Held payout release phase: .select().in().eq().limit()
          chain.in = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [{ business_id: 'b1' }],
                error: null,
              }),
            }),
          });
        }
      }
      return chain;
    };

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => ({
        from: (table: string) => mockFromImpl(table),
        rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    }));

    // Enable payouts
    process.env.ENABLE_PAYOUTS = 'true';

    cronModule = await import('@/app/api/cron/auto-payout/route');
    const res = await cronModule.GET(makeCronRequest());
    expect(res.status).toBe(200);

    // The flagged held payout should NOT be released (update to 'approved' should NOT be called)
    expect(approvedUpdateCalled).toBe(false);

    // Verify logger.warn was called for the skipped payout
    expect(mockLoggerWarn).toHaveBeenCalled();
    const warnCall = mockLoggerWarn.mock.calls.find(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('adjustment_link_failed'),
    );
    expect(warnCall).toBeDefined();

    delete process.env.ENABLE_PAYOUTS;
  });

  it('unflagged eligible held payout IS released', async () => {
    // Track whether business_payouts UPDATE to 'approved' was called
    let approvedUpdateCalled = false;
    let approvedPayoutId: string | null = null;
    let bizCallIdx = 0;
    let payoutsCallIdx = 0;
    let payoutAccountsCallIdx = 0;

    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });

      if (table === 'businesses') {
        const idx = bizCallIdx++;
        if (idx === 0) {
          // Generation phase: return a business (avoids early return)
          chain.eq = vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ id: 'biz-dummy', name: 'Dummy', created_at: '2024-01-01', country_code: 'NG', verification_level: 'basic' }],
              error: null,
            }),
          });
        } else {
          // Held payout release phase: .select().in('id',...).limit(5000)
          chain.in = vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{
                id: 'b1',
                created_at: '2024-01-01', // old enough — cooling done
                verification_level: 'basic', // verified
              }],
              error: null,
            }),
          });
        }
      } else if (table === 'business_payouts') {
        const idx = payoutsCallIdx++;
        if (idx === 0) {
          // Batch-fetch: existing payouts for period
          chain.in = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          });
        } else if (idx === 1) {
          // Held payouts query: .select().eq('status', 'held')
          chain.eq = vi.fn().mockResolvedValue({
            data: [{
              id: 'held-payout-2',
              business_id: 'b1',
              flags: [{ type: 'cooling_period', message: 'was new', severity: 'warning' }], // non-critical
            }],
            error: null,
          });
        } else {
          // UPDATE to 'approved' — track if called
          chain.update = vi.fn().mockImplementation(() => {
            approvedUpdateCalled = true;
            return {
              eq: vi.fn().mockImplementation((_col: string, val: string) => {
                approvedPayoutId = val;
                return Promise.resolve({ error: null });
              }),
            };
          });
        }
      } else if (table === 'platform_fees') {
        // Zero fees — no payout generated, proceed to held release
        chain.in = vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            gte: vi.fn().mockReturnValue({
              lte: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        });
      } else if (table === 'payout_adjustments') {
        chain.in = vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          }),
        });
      } else if (table === 'payout_accounts') {
        const paIdx = payoutAccountsCallIdx++;
        if (paIdx === 0) {
          // Batch-fetch for generation: .select().in().eq().limit()
          chain.in = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          });
        } else {
          // Held payout release phase
          chain.in = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [{ business_id: 'b1' }],
                error: null,
              }),
            }),
          });
        }
      }
      return chain;
    };

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => ({
        from: (table: string) => mockFromImpl(table),
        rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    }));

    process.env.ENABLE_PAYOUTS = 'true';

    cronModule = await import('@/app/api/cron/auto-payout/route');
    const res = await cronModule.GET(makeCronRequest());
    expect(res.status).toBe(200);

    // The unflagged eligible held payout SHOULD be released
    expect(approvedUpdateCalled).toBe(true);
    expect(approvedPayoutId).toBe('held-payout-2');

    delete process.env.ENABLE_PAYOUTS;
  });

  // ── Cron adjustment link failure during generation phase ──

  it('cron: adjustment link failure on approved payout sets held + flag, no claim or Paystack call', async () => {
    let containmentPayload: Record<string, unknown> | null = null;
    let claimCalled = false;
    let fetchCalled = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    });

    let bizIdx = 0;
    let payoutsIdx = 0;
    let adjIdx = 0;
    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });

      if (table === 'businesses') {
        if (bizIdx++ === 0) {
          // Generation phase: .select().eq('payout_mode',...).eq('status',...)
          chain.eq = vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ id: 'biz-adj', name: 'Adj Biz', created_at: '2024-01-01', country_code: 'NG', verification_level: 'basic', payout_limit_monthly: 999999 }],
              error: null,
            }),
          });
        } else {
          // Held payout release phase: .select().in().limit()
          chain.in = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) });
        }
      } else if (table === 'business_payouts') {
        const idx = payoutsIdx++;
        if (idx === 0) {
          // Batch dedup: .select().in().eq().eq().limit()
          chain.in = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          });
        } else if (idx === 1) {
          // Insert payout: .insert({}).select().single()
          chain.insert = vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'payout-adj-1', net_amount: 9000 }, error: null }),
            }),
          });
        } else if (idx === 2) {
          // Containment update: .update({}).eq('id',...)
          chain.update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
            containmentPayload = payload;
            return { eq: vi.fn().mockResolvedValue({ error: null }) };
          });
        } else {
          // Held payouts query: .select().eq('status','held')
          chain.eq = vi.fn().mockResolvedValue({ data: [], error: null });
        }
      } else if (table === 'platform_fees') {
        // Batch fees: .select().in().is().gte().lte().limit()
        chain.in = vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            gte: vi.fn().mockReturnValue({
              lte: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{ business_id: 'biz-adj', transaction_amount: 10000, fee_total: 500, gateway_fee: 100, waived: false }],
                  error: null,
                }),
              }),
            }),
          }),
        });
      } else if (table === 'payout_adjustments') {
        const aIdx = adjIdx++;
        if (aIdx === 0) {
          // Batch adjustments: .select().in().is().limit()
          chain.in = vi.fn().mockReturnValue({
            is: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [{ id: 'adj-1', business_id: 'biz-adj', amount: -200 }],
                error: null,
              }),
            }),
          });
        } else {
          // Adjustment link update: .update({}).in('id', adjIds)
          chain.update = vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ error: { message: 'connection timeout' } }),
          });
        }
      } else if (table === 'payout_accounts') {
        // Batch accounts: .select().in().eq().limit()
        chain.in = vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ business_id: 'biz-adj', id: 'pa-1', is_active: true, verified_at: '2024-01-01', gateway: 'paystack', bank_code: '058', account_number: '1234567890', account_name: 'Test' }],
              error: null,
            }),
          }),
        });
      }
      return chain;
    };

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => ({
        from: (table: string) => mockFromImpl(table),
        rpc: vi.fn().mockImplementation((name: string) => {
          if (name === 'claim_payout_for_transfer') claimCalled = true;
          return Promise.resolve({ data: null, error: null });
        }),
      })),
    }));

    process.env.ENABLE_PAYOUTS = 'true';
    cronModule = await import('@/app/api/cron/auto-payout/route');
    const res = await cronModule.GET(makeCronRequest());
    expect(res.status).toBe(200);

    expect(containmentPayload).not.toBeNull();
    expect(containmentPayload!.status).toBe('held');
    const flagArr = containmentPayload!.flags as { type: string }[];
    expect(flagArr.some(f => f.type === 'adjustment_link_failed')).toBe(true);
    expect(claimCalled).toBe(false);
    expect(fetchCalled).toBe(false);

    delete process.env.ENABLE_PAYOUTS;
    vi.restoreAllMocks();
  });

  it('cron: containment update fails after adj link failure, still no claim, error logged', async () => {
    let claimCalled = false;

    let bizIdx = 0;
    let payoutsIdx = 0;
    let adjIdx = 0;
    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });

      if (table === 'businesses') {
        if (bizIdx++ === 0) {
          // Generation phase: .select().eq('payout_mode',...).eq('status',...)
          chain.eq = vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ id: 'biz-cf', name: 'CF Biz', created_at: '2024-01-01', country_code: 'NG', verification_level: 'basic', payout_limit_monthly: 999999 }],
              error: null,
            }),
          });
        } else {
          // Held payout release phase: .select().in().limit()
          chain.in = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) });
        }
      } else if (table === 'business_payouts') {
        const idx = payoutsIdx++;
        if (idx === 0) {
          // Batch dedup: .select().in().eq().eq().limit()
          chain.in = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          });
        } else if (idx === 1) {
          // Insert payout: .insert({}).select().single()
          chain.insert = vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'payout-cf-1', net_amount: 9000 }, error: null }),
            }),
          });
        } else if (idx === 2) {
          // Containment update: .update({}).eq('id',...) — returns error
          chain.update = vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: { message: 'disk full' } }),
          });
        } else {
          // Held payouts query: .select().eq('status','held')
          chain.eq = vi.fn().mockResolvedValue({ data: [], error: null });
        }
      } else if (table === 'platform_fees') {
        // Batch fees: .select().in().is().gte().lte().limit()
        chain.in = vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            gte: vi.fn().mockReturnValue({
              lte: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{ business_id: 'biz-cf', transaction_amount: 10000, fee_total: 500, gateway_fee: 100, waived: false }],
                  error: null,
                }),
              }),
            }),
          }),
        });
      } else if (table === 'payout_adjustments') {
        const aIdx = adjIdx++;
        if (aIdx === 0) {
          // Batch adjustments: .select().in().is().limit()
          chain.in = vi.fn().mockReturnValue({
            is: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [{ id: 'adj-cf', business_id: 'biz-cf', amount: -100 }],
                error: null,
              }),
            }),
          });
        } else {
          // Adjustment link update: .update({}).in('id', adjIds) — returns error
          chain.update = vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ error: { message: 'link fail' } }),
          });
        }
      } else if (table === 'payout_accounts') {
        // Batch accounts: .select().in().eq().limit()
        chain.in = vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ business_id: 'biz-cf', id: 'pa-cf', is_active: true, verified_at: '2024-01-01', gateway: 'paystack', bank_code: '058', account_number: '1234567890', account_name: 'Test' }],
              error: null,
            }),
          }),
        });
      }
      return chain;
    };

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => ({
        from: (table: string) => mockFromImpl(table),
        rpc: vi.fn().mockImplementation((name: string) => {
          if (name === 'claim_payout_for_transfer') claimCalled = true;
          return Promise.resolve({ data: null, error: null });
        }),
      })),
    }));

    process.env.ENABLE_PAYOUTS = 'true';
    cronModule = await import('@/app/api/cron/auto-payout/route');
    const res = await cronModule.GET(makeCronRequest());
    expect(res.status).toBe(200);

    expect(claimCalled).toBe(false);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('Containment update failed'),
    );

    delete process.env.ENABLE_PAYOUTS;
  });

  it('cron: link succeeds, approved payout proceeds to claim', async () => {
    let claimCalled = false;
    let claimPayoutId: string | null = null;

    let bizIdx = 0;
    let payoutsIdx = 0;
    let adjIdx = 0;
    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });

      if (table === 'businesses') {
        if (bizIdx++ === 0) {
          // Generation phase: .select().eq('payout_mode',...).eq('status',...)
          chain.eq = vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ id: 'biz-ok', name: 'OK Biz', created_at: '2024-01-01', country_code: 'NG', verification_level: 'basic', payout_limit_monthly: 999999 }],
              error: null,
            }),
          });
        } else {
          // Held payout release phase: .select().in().limit()
          chain.in = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) });
        }
      } else if (table === 'business_payouts') {
        const idx = payoutsIdx++;
        if (idx === 0) {
          // Batch dedup: .select().in().eq().eq().limit()
          chain.in = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          });
        } else if (idx === 1) {
          // Insert payout: .insert({}).select().single()
          chain.insert = vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'payout-ok-1', net_amount: 9000 }, error: null }),
            }),
          });
        } else {
          // Held payouts query: .select().eq('status','held')
          chain.eq = vi.fn().mockResolvedValue({ data: [], error: null });
        }
      } else if (table === 'platform_fees') {
        // Batch fees: .select().in().is().gte().lte().limit()
        chain.in = vi.fn().mockReturnValue({
          is: vi.fn().mockReturnValue({
            gte: vi.fn().mockReturnValue({
              lte: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{ business_id: 'biz-ok', transaction_amount: 10000, fee_total: 500, gateway_fee: 100, waived: false }],
                  error: null,
                }),
              }),
            }),
          }),
        });
      } else if (table === 'payout_adjustments') {
        const aIdx = adjIdx++;
        if (aIdx === 0) {
          // Batch adjustments: .select().in().is().limit()
          chain.in = vi.fn().mockReturnValue({
            is: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({
                data: [{ id: 'adj-ok', business_id: 'biz-ok', amount: -100 }],
                error: null,
              }),
            }),
          });
        } else {
          // Adjustment link update: .update({}).in('id', adjIds) — succeeds
          chain.update = vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({ error: null }),
          });
        }
      } else if (table === 'payout_accounts') {
        // Batch accounts: .select().in().eq().limit()
        chain.in = vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: [{ business_id: 'biz-ok', id: 'pa-ok', is_active: true, verified_at: '2024-01-01', gateway: 'paystack', bank_code: '058', account_number: '1234567890', account_name: 'Test' }],
              error: null,
            }),
          }),
        });
      }
      return chain;
    };

    cronPaystackEligible = true;

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(() => ({
        from: (table: string) => mockFromImpl(table),
        rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
          if (name === 'claim_payout_for_transfer') {
            claimCalled = true;
            claimPayoutId = args.p_payout_id as string;
            return Promise.resolve({
              data: [{ claimed_token: 'tok', idempotency_key: 'key' }],
              error: null,
            });
          }
          if (name === 'mark_payout_provider_submitted') {
            return Promise.resolve({ data: [{ submitted_id: claimPayoutId }], error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      })),
    }));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: true, data: { recipient_code: 'rc', transfer_code: 'tc' } }), { status: 200 }),
    );

    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test-not-a-real-key';

    cronModule = await import('@/app/api/cron/auto-payout/route');
    const res = await cronModule.GET(makeCronRequest());
    expect(res.status).toBe(200);

    expect(claimCalled).toBe(true);
    expect(claimPayoutId).toBe('payout-ok-1');

    delete process.env.ENABLE_PAYOUTS;
    process.env.PAYSTACK_SECRET_KEY = '';
    vi.restoreAllMocks();
  });
});
