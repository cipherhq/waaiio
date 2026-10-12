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
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(),
    withContext: vi.fn(() => ({
      error: (...args: unknown[]) => mockLoggerError(...args),
      info: vi.fn(), debug: vi.fn(), warn: vi.fn(),
    })),
  },
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
// verification/review — affected rows and error checks
// ═══════════════════════════════════════════════════════════════

describe('verification/review: affected-row and error checks', () => {
  let reviewModule: typeof import('@/app/api/verification/review/route');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoggerError.mockClear();
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
      logger: { error: mockLoggerError, info: vi.fn(), debug: vi.fn(), warn: vi.fn(), withContext: vi.fn(() => ({ error: mockLoggerError, info: vi.fn(), debug: vi.fn(), warn: vi.fn() })) },
    }));
  });

  function setupMocks(overrides: {
    bizSelectResult?: { data: unknown; error: unknown };
    bizUpdateResult?: { data: unknown; error: unknown };
    docsUpdateResult?: { data: unknown; error: unknown };
    reqUpdateResult?: { data: unknown; error: unknown };
    profileResult?: { data: unknown; error: unknown };
  } = {}) {
    const defaults = {
      bizSelectResult: { data: { name: 'Test Biz', owner_id: 'u1', country_code: 'NG' }, error: null },
      bizUpdateResult: { data: [{ id: 'b1' }], error: null },
      docsUpdateResult: { data: [{ id: 'd1' }], error: null },
      reqUpdateResult: { data: [{ id: 'r1' }], error: null },
      profileResult: { data: { email: 'test@test.com' }, error: null },
    };
    const cfg = { ...defaults, ...overrides };

    let bizSelectCount = 0;
    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });
      if (table === 'businesses') {
        // First .from('businesses') is the SELECT; subsequent are UPDATEs
        if (bizSelectCount === 0) {
          bizSelectCount++;
          chain.single = vi.fn().mockResolvedValue(cfg.bizSelectResult);
        } else {
          chain.select = vi.fn().mockResolvedValue(cfg.bizUpdateResult);
        }
      } else if (table === 'business_documents') {
        chain.select = vi.fn().mockResolvedValue(cfg.docsUpdateResult);
      } else if (table === 'verification_requests') {
        chain.select = vi.fn().mockResolvedValue(cfg.reqUpdateResult);
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

  it('approve: business update error returns 500, not success', async () => {
    setupMocks({ bizUpdateResult: { data: null, error: { message: 'db error' } } });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', { business_id: 'b1', action: 'approve', level: 'basic' }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    expect(body.error).toContain('Failed to update business verification');
  });

  it('approve: business update zero rows returns 500, not success', async () => {
    setupMocks({ bizUpdateResult: { data: [], error: null } });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', { business_id: 'b1', action: 'approve', level: 'basic' }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    expect(body.error).toContain('no rows');
  });

  it('approve: documents update error returns 500, not success', async () => {
    setupMocks({ docsUpdateResult: { data: null, error: { message: 'docs error' } } });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', { business_id: 'b1', action: 'approve', level: 'basic', document_ids: ['d1'] }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    expect(body.error).toContain('document');
  });

  it('approve: documents update zero rows returns 500, not success', async () => {
    setupMocks({ docsUpdateResult: { data: [], error: null } });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', { business_id: 'b1', action: 'approve', level: 'basic', document_ids: ['d1'] }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    expect(body.error).toContain('document');
  });

  it('reject: business update error returns 500, not success', async () => {
    setupMocks({ bizUpdateResult: { data: null, error: { message: 'db error' } } });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', { business_id: 'b1', action: 'reject', reason: 'incomplete docs' }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
  });

  it('reject: business update zero rows returns 500, not success', async () => {
    setupMocks({ bizUpdateResult: { data: [], error: null } });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', { business_id: 'b1', action: 'reject', reason: 'incomplete docs' }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
  });

  it('reject: documents update zero rows returns 500, not success', async () => {
    setupMocks({ docsUpdateResult: { data: [], error: null } });
    reviewModule = await import('@/app/api/verification/review/route');
    const res = await reviewModule.POST(
      makeRequest('/api/verification/review', { business_id: 'b1', action: 'reject', reason: 'bad docs', document_ids: ['d1'] }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
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
        error: mockLoggerError, info: vi.fn(), debug: vi.fn(), warn: vi.fn(),
        withContext: vi.fn(() => ({ error: mockLoggerError, info: vi.fn(), debug: vi.fn(), warn: vi.fn() })),
      },
    }));
  });

  function setupMocks(overrides: {
    bizSelectResult?: { data: unknown; error: unknown };
    bizUpdateError?: unknown;
    insertResult?: { data: unknown; error: unknown };
    restoreError?: unknown;
    profileResult?: { data: unknown; error: unknown };
  } = {}) {
    const defaults = {
      bizSelectResult: { data: { name: 'Test Biz', owner_id: 'u1', country_code: 'NG', verification_status: 'unverified' }, error: null },
      bizUpdateError: null,
      insertResult: { data: { id: 'req-1' }, error: null },
      restoreError: null,
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
        } else {
          // Third: CAS restore on insert failure
          chain.eq = vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: cfg.restoreError }),
          });
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
      restoreError: { message: 'restore also failed' },
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
});

// ═══════════════════════════════════════════════════════════════
// payouts/generate — read errors, insert errors, no-eligible
// ═══════════════════════════════════════════════════════════════

describe('payouts/generate: failure counting and no-eligible result', () => {
  let generateModule: typeof import('@/app/api/admin/payouts/generate/route');

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoggerError.mockClear();
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
        error: mockLoggerError, info: vi.fn(), debug: vi.fn(), warn: vi.fn(),
        withContext: vi.fn(() => ({ error: mockLoggerError, info: vi.fn(), debug: vi.fn(), warn: vi.fn() })),
      },
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
    adjustmentsError?: unknown;
    insertResult?: { data: unknown; error: unknown };
    payoutAccountData?: unknown;
  } = {}) {
    const defaults = {
      businesses: [{ id: 'b1', created_at: '2025-01-01', verification_level: 'basic', payout_limit_monthly: 500000, country_code: 'NG' }],
      businessesError: null,
      existingPayout: null,
      existingError: null,
      feesData: [{ transaction_amount: 10000, fee_total: 500, gateway_fee: 100, waived: false, is_direct_transfer: false }],
      feesError: null,
      paymentsError: null,
      adjustmentsError: null,
      insertResult: { data: { id: 'payout-1' }, error: null },
      payoutAccountData: { id: 'pa-1' },
    };
    const cfg = { ...defaults, ...overrides };

    mockFromImpl = (table: string) => {
      const chain = chainMock({ data: null, error: null });
      if (table === 'businesses') {
        // The businesses SELECT uses .eq().eq() chain, terminal is the last .eq()
        // which resolves to the data array
        chain.eq = vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: cfg.businesses, error: cfg.businessesError }),
        });
      } else if (table === 'business_payouts') {
        // Dedup check uses .maybeSingle()
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: cfg.existingPayout, error: cfg.existingError });
        // Monthly limit check also uses business_payouts
        chain.gte = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'platform_fees') {
        chain.lte = vi.fn().mockResolvedValue({ data: cfg.feesData, error: cfg.feesError });
      } else if (table === 'payments') {
        chain.lte = vi.fn().mockResolvedValue({ data: [], error: cfg.paymentsError });
      } else if (table === 'payout_adjustments') {
        if (cfg.adjustmentsError) {
          chain.is = vi.fn().mockResolvedValue({ data: null, error: cfg.adjustmentsError });
        } else {
          chain.is = vi.fn().mockResolvedValue({ data: [], error: null });
        }
        chain.in = vi.fn().mockResolvedValue({ error: null });
      } else if (table === 'payout_accounts') {
        chain.maybeSingle = vi.fn().mockResolvedValue({ data: cfg.payoutAccountData, error: null });
      } else if (table === 'admin_audit_logs') {
        chain.insert = vi.fn().mockResolvedValue({ error: null });
      }
      // For the INSERT on business_payouts via the service client
      chain.insert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue(cfg.insertResult),
        }),
      });
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
});
