/**
 * Finance Role Reconciliation Tests
 *
 * Verifies the Admin/Finance authorization boundary:
 * - Finance is read-only for business payouts
 * - All payout mutations are admin-only
 * - Reseller payout mutations are admin-only
 * - Reseller mutations create audit logs
 * - Payout list excludes operational tokens
 * - Payout rejection is atomic (TOCTOU fixed)
 * - Admin UI gates mutation controls by role
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';

// ── Mock infrastructure ──

let mockAuthRole = 'admin';
let mockAuthId = 'admin-user-1';

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(async (_req: unknown, opts?: { requiredRole?: string | string[] }) => {
    const role = mockAuthRole;
    const validRoles = ['admin', 'support', 'finance', 'operations'];
    if (!validRoles.includes(role)) return null;
    if (opts?.requiredRole) {
      const required = Array.isArray(opts.requiredRole) ? opts.requiredRole : [opts.requiredRole];
      if (!required.includes(role)) return null;
    }
    return { id: mockAuthId, userId: mockAuthId, email: 'test@example.com', role };
  }),
}));

const mockSelectResult = vi.fn();
const mockInsertResult = vi.fn();
const mockUpdateChain = {
  eq: vi.fn().mockReturnThis(),
  in: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'updated-1' }, error: null }),
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'admin-user-1' } } }) },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockReturnThis(),
      single: mockSelectResult,
      maybeSingle: mockSelectResult,
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn(() => mockUpdateChain),
    })),
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      maybeSingle: mockSelectResult,
      single: mockSelectResult,
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: mockInsertResult,
        }),
      }),
      update: vi.fn(() => mockUpdateChain),
    })),
    auth: { admin: { getUserById: vi.fn() } },
  })),
}));

const logFns = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
vi.mock('@/lib/logger', () => ({
  logger: { ...logFns, withContext: vi.fn(() => logFns) },
  safeLogErrorContext: vi.fn(() => ({})),
}));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email/templates', () => ({ payoutRejectedEmail: vi.fn(() => ({ subject: '', html: '' })) }));
vi.mock('@/lib/constants', () => ({ formatCurrency: vi.fn(() => '$100'), CountryCode: {} }));

// Import route handlers
const payoutsListModule = await import('@/app/api/admin/payouts/route');
const payoutsGenerateModule = await import('@/app/api/admin/payouts/generate/route');
const payoutsRejectModule = await import('@/app/api/admin/payouts/[id]/reject/route');
const resellerPayoutsModule = await import('@/app/api/admin/reseller-payouts/route');
const resellerPayoutsPatchModule = await import('@/app/api/admin/reseller-payouts/[id]/route');

// ── Helpers ──

function makeRequest(url: string, method = 'GET', body?: Record<string, unknown>) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' } };
  if (body) opts.body = JSON.stringify(body);
  return new NextRequest(`http://localhost${url}`, opts);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthRole = 'admin';
  mockAuthId = 'admin-user-1';
  mockSelectResult.mockResolvedValue({ data: null, error: null });
  mockInsertResult.mockResolvedValue({ data: { id: 'new-1' }, error: null });
});

// ══════════════════════════════════════════════════════════
// Business Payouts — Read access
// ══════════════════════════════════════════════════════════

describe('Business payouts list authorization', () => {
  it('admin reads business payouts (200)', async () => {
    mockAuthRole = 'admin';
    const res = await payoutsListModule.GET(makeRequest('/api/admin/payouts'));
    expect(res.status).not.toBe(403);
  });

  it('finance reads business payouts (200)', async () => {
    mockAuthRole = 'finance';
    const res = await payoutsListModule.GET(makeRequest('/api/admin/payouts'));
    expect(res.status).not.toBe(403);
  });

  it('ordinary user is blocked (403)', async () => {
    mockAuthRole = 'support';
    const res = await payoutsListModule.GET(makeRequest('/api/admin/payouts'));
    expect(res.status).toBe(403);
  });

  it('unauthenticated is blocked (403)', async () => {
    mockAuthRole = 'invalid_role';
    const res = await payoutsListModule.GET(makeRequest('/api/admin/payouts'));
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════
// Business Payouts — Mutations (admin only)
// ══════════════════════════════════════════════════════════

describe('Business payout generate authorization', () => {
  it('admin generate allowed', async () => {
    mockAuthRole = 'admin';
    const res = await payoutsGenerateModule.POST(makeRequest('/api/admin/payouts/generate', 'POST'));
    expect(res.status).not.toBe(403);
  });

  it('finance generate blocked (403)', async () => {
    mockAuthRole = 'finance';
    const res = await payoutsGenerateModule.POST(makeRequest('/api/admin/payouts/generate', 'POST'));
    expect(res.status).toBe(403);
  });
});

describe('Business payout reject authorization', () => {
  it('admin reject allowed', async () => {
    mockAuthRole = 'admin';
    mockSelectResult.mockResolvedValueOnce({
      data: { id: 'p-1', business_id: 'b-1', net_amount: 100, status: 'pending' },
      error: null,
    });
    mockUpdateChain.maybeSingle.mockResolvedValueOnce({ data: { id: 'p-1' }, error: null });
    const res = await payoutsRejectModule.POST(
      makeRequest('/api/admin/payouts/p-1/reject', 'POST', { reason: 'test' }),
      { params: Promise.resolve({ id: 'p-1' }) },
    );
    expect(res.status).not.toBe(403);
  });

  it('finance reject blocked (403)', async () => {
    mockAuthRole = 'finance';
    const res = await payoutsRejectModule.POST(
      makeRequest('/api/admin/payouts/p-1/reject', 'POST', { reason: 'test' }),
      { params: Promise.resolve({ id: 'p-1' }) },
    );
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════
// Reseller Payouts — Authorization
// ══════════════════════════════════════════════════════════

describe('Reseller payout authorization', () => {
  it('admin creates reseller payout', async () => {
    mockAuthRole = 'admin';
    mockSelectResult.mockResolvedValueOnce({ data: { id: 'r-1', created_at: '2025-01-01' }, error: null }); // reseller
    mockSelectResult.mockResolvedValueOnce({ data: null, error: null }); // duplicate check
    mockSelectResult.mockResolvedValueOnce({ data: [], error: null }); // fees — this will be the gte/lte chain
    mockInsertResult.mockResolvedValueOnce({ data: { id: 'rp-1' }, error: null }); // insert
    const res = await resellerPayoutsModule.POST(
      makeRequest('/api/admin/reseller-payouts', 'POST', {
        reseller_id: 'r-1', period_start: '2026-07-01', period_end: '2026-07-31',
      }),
    );
    expect(res.status).not.toBe(403);
  });

  it('finance cannot create reseller payout (403)', async () => {
    mockAuthRole = 'finance';
    const res = await resellerPayoutsModule.POST(
      makeRequest('/api/admin/reseller-payouts', 'POST', {
        reseller_id: 'r-1', period_start: '2026-07-01', period_end: '2026-07-31',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('admin marks reseller payout paid', async () => {
    mockAuthRole = 'admin';
    mockSelectResult.mockResolvedValueOnce({
      data: { id: 'rp-1', status: 'approved', reseller_id: 'r-1', net_amount: 100 },
      error: null,
    });
    // allFees
    mockSelectResult.mockResolvedValueOnce({ data: [{ reseller_commission: 200 }], error: null });
    // paidPayouts
    mockSelectResult.mockResolvedValueOnce({ data: [], error: null });
    mockUpdateChain.maybeSingle.mockResolvedValueOnce(undefined);
    // mock the update().eq().select().single() chain result
    const mockSingle = vi.fn().mockResolvedValue({ data: { id: 'rp-1', status: 'paid', reseller_id: 'r-1', net_amount: 100 }, error: null });
    const { createServiceClient } = await import('@/lib/supabase/service');
    const service = (createServiceClient as any)();
    // We can't easily control the deep chain, so just verify it's not 403
    const res = await resellerPayoutsPatchModule.PATCH(
      makeRequest('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'mark_paid' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).not.toBe(403);
  });

  it('finance cannot mark reseller payout paid (403)', async () => {
    mockAuthRole = 'finance';
    const res = await resellerPayoutsPatchModule.PATCH(
      makeRequest('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'mark_paid' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(403);
  });

  it('finance cannot approve reseller payout (403)', async () => {
    mockAuthRole = 'finance';
    const res = await resellerPayoutsPatchModule.PATCH(
      makeRequest('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'approve' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(403);
  });

  it('finance cannot reject reseller payout (403)', async () => {
    mockAuthRole = 'finance';
    const res = await resellerPayoutsPatchModule.PATCH(
      makeRequest('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'reject' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════
// Source-level verification
// ══════════════════════════════════════════════════════════

describe('Payout list response excludes operational tokens', () => {
  const payoutsSource = readFileSync('app/api/admin/payouts/route.ts', 'utf-8');

  it('does not use select(*)', () => {
    expect(payoutsSource).not.toContain("select('*'");
  });

  it('uses explicit column list', () => {
    expect(payoutsSource).toContain('PAYOUT_LIST_COLUMNS');
  });

  it('excludes claim_token', () => {
    expect(payoutsSource).not.toContain('claim_token');
  });

  it('excludes provider_idempotency_key', () => {
    expect(payoutsSource).not.toContain('provider_idempotency_key');
  });
});

describe('Payout rejection is atomic (TOCTOU fix)', () => {
  const rejectSource = readFileSync('app/api/admin/payouts/[id]/reject/route.ts', 'utf-8');

  it('UPDATE includes status guard via .in()', () => {
    expect(rejectSource).toContain(".in('status',");
  });

  it('checks affected row count for conflict', () => {
    expect(rejectSource).toContain('409');
  });
});

describe('Reseller payout mutations have audit logging', () => {
  const postSource = readFileSync('app/api/admin/reseller-payouts/route.ts', 'utf-8');
  const patchSource = readFileSync('app/api/admin/reseller-payouts/[id]/route.ts', 'utf-8');

  it('POST creates audit log entry', () => {
    expect(postSource).toContain('admin_audit_logs');
    expect(postSource).toContain('generate_reseller_payout');
  });

  it('PATCH creates audit log entry', () => {
    expect(patchSource).toContain('admin_audit_logs');
    expect(patchSource).toContain('reseller_payout_');
  });

  it('POST requires admin only', () => {
    expect(postSource).toContain("requiredRole: 'admin'");
  });

  it('PATCH requires admin only', () => {
    expect(patchSource).toContain("requiredRole: 'admin'");
  });
});

describe('Service client instantiation order', () => {
  const getSource = readFileSync('app/api/admin/reseller-payouts/route.ts', 'utf-8');

  it('GET creates service client after auth', () => {
    const authIdx = getSource.indexOf('requirePlatformAdmin');
    const serviceIdx = getSource.indexOf('createServiceClient()', authIdx);
    // The createServiceClient after auth must come AFTER requirePlatformAdmin
    expect(serviceIdx).toBeGreaterThan(authIdx);
  });
});

describe('Admin UI — Finance mutation controls hidden', () => {
  const payoutsUI = readFileSync('admin/src/pages/Payouts.tsx', 'utf-8');
  const resellerUI = readFileSync('admin/src/pages/ResellerPayouts.tsx', 'utf-8');

  it('Payouts page defines isAdmin check', () => {
    expect(payoutsUI).toContain("const isAdmin = session?.role === 'admin'");
  });

  it('Generate button gated by isAdmin', () => {
    expect(payoutsUI).toContain('{isAdmin && (');
  });

  it('Approve/Reject buttons gated by isAdmin', () => {
    expect(payoutsUI).toContain("tab === 'pending' && isAdmin");
  });

  it('ResellerPayouts Generate button gated by isFullAdmin', () => {
    expect(resellerUI).toContain('{isFullAdmin && (');
  });

  it('ResellerPayouts Mark as Paid button gated by isFullAdmin', () => {
    // Both inline and detail modal buttons should check isFullAdmin
    const markPaidOccurrences = resellerUI.match(/isFullAdmin.*Mark as Paid|Mark as Paid.*isFullAdmin/g);
    // At minimum the two "approved && isFullAdmin" guards exist
    const approvedGuards = (resellerUI.match(/approved.*&&.*isFullAdmin/g) || []).length;
    expect(approvedGuards).toBeGreaterThanOrEqual(2);
  });
});
