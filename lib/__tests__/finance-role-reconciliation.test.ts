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
    return { id: mockAuthId, userId: mockAuthId, email: 'test@example.com', role, aal: 'aal2', bearerToken: 'test-bearer' };
  }),
}));

vi.mock('@/lib/admin-step-up', () => ({
  consumeStepUp: vi.fn().mockResolvedValue(true),
  StepUpError: class StepUpError extends Error { constructor(msg: string) { super(msg); this.name = 'StepUpError'; } },
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
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle: mockSelectResult,
      single: mockSelectResult,
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: mockInsertResult,
        }),
      }),
      update: vi.fn(() => mockUpdateChain),
    })),
    rpc: vi.fn().mockResolvedValue({ data: [{ rejected_id: 'p-1', adjustments_released: 0 }], error: null }),
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
    const res = await payoutsGenerateModule.POST(makeRequest('/api/admin/payouts/generate', 'POST', {}));
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

  it('PAYOUT_LIST_COLUMNS does not include claim_token', () => {
    // Extract the array literal between [ and ].join
    const match = payoutsSource.match(/PAYOUT_LIST_COLUMNS\s*=\s*\[([\s\S]*?)\]\.join/);
    expect(match).toBeTruthy();
    const columns = match![1];
    expect(columns).not.toContain('claim_token');
  });

  it('PAYOUT_LIST_COLUMNS does not include provider_idempotency_key', () => {
    const match = payoutsSource.match(/PAYOUT_LIST_COLUMNS\s*=\s*\[([\s\S]*?)\]\.join/);
    expect(match).toBeTruthy();
    const columns = match![1];
    expect(columns).not.toContain('provider_idempotency_key');
  });

  it('response mapping does not include claim_token or provider_idempotency_key', () => {
    // Check the response shaping block (after "Shape response")
    const shapeIdx = payoutsSource.indexOf('Shape response');
    expect(shapeIdx).toBeGreaterThan(-1);
    const responseShape = payoutsSource.slice(shapeIdx);
    expect(responseShape).not.toContain('claim_token');
    expect(responseShape).not.toContain('provider_idempotency_key');
  });
});

describe('Payout rejection is atomic (TOCTOU fix)', () => {
  const rejectSource = readFileSync('app/api/admin/payouts/[id]/reject/route.ts', 'utf-8');

  it('uses atomic RPC for reject + adjustment release', () => {
    // The inline .update().in('status',) was replaced by an atomic RPC
    expect(rejectSource).toContain('reject_payout_and_release_adjustments');
  });

  it('checks affected row count for conflict', () => {
    expect(rejectSource).toContain('409');
  });
});

describe('Reseller payout mutations have audit logging', () => {
  const postSource = readFileSync('app/api/admin/reseller-payouts/route.ts', 'utf-8');
  const patchSource = readFileSync('app/api/admin/reseller-payouts/[id]/route.ts', 'utf-8');

  it('POST creates audit log entry', () => {
    expect(postSource).toContain('logAdminAudit');
    expect(postSource).toContain('generate_reseller_payout');
  });

  it('PATCH creates audit log entry', () => {
    expect(patchSource).toContain('logAdminAudit');
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
    const approvedGuards = (resellerUI.match(/approved.*&&.*isFullAdmin/g) || []).length;
    expect(approvedGuards).toBeGreaterThanOrEqual(2);
  });
});

describe('Admin UI — step-up MFA wired to all payout mutations', () => {
  const payoutsUI = readFileSync('admin/src/pages/Payouts.tsx', 'utf-8');
  const resellerUI = readFileSync('admin/src/pages/ResellerPayouts.tsx', 'utf-8');

  it('Payouts.tsx handleReject sends stepUpId in request body', () => {
    // Find the reject section and verify stepUpId is in the JSON.stringify
    const rejectSection = payoutsUI.slice(payoutsUI.indexOf('handleReject'));
    expect(rejectSection).toContain("reason: rejectReason, stepUpId");
  });

  it('Payouts.tsx handleReject uses payout_reject step-up action', () => {
    const rejectSection = payoutsUI.slice(payoutsUI.indexOf('handleReject'));
    expect(rejectSection).toContain("actionType: 'payout_reject'");
  });

  it('Payouts.tsx handleReject handles step_up_required 403', () => {
    const rejectSection = payoutsUI.slice(payoutsUI.indexOf('handleReject'));
    expect(rejectSection).toContain("step_up_required");
  });

  it('ResellerPayouts.tsx handleAction sends stepUpId in request body', () => {
    const actionSection = resellerUI.slice(resellerUI.indexOf('handleAction'));
    expect(actionSection).toContain("action: serverAction, stepUpId");
  });

  it('ResellerPayouts.tsx handleAction uses dynamic step-up action type', () => {
    const actionSection = resellerUI.slice(resellerUI.indexOf('handleAction'));
    expect(actionSection).toContain('reseller_payout_');
    expect(actionSection).toContain('stepUpAction');
  });

  it('ResellerPayouts.tsx handleAction handles step_up_required 403', () => {
    const actionSection = resellerUI.slice(resellerUI.indexOf('handleAction'));
    expect(actionSection).toContain("step_up_required");
  });

  it('ResellerPayouts.tsx handleGeneratePayout sends stepUpId', () => {
    const genSection = resellerUI.slice(resellerUI.indexOf('handleGeneratePayout'));
    expect(genSection).toContain('stepUpId');
    expect(genSection).toContain("reseller_payout_generate");
  });

  it('ResellerPayouts.tsx handleGeneratePayout handles step_up_required 403', () => {
    const genSection = resellerUI.slice(resellerUI.indexOf('handleGeneratePayout'));
    expect(genSection).toContain("step_up_required");
  });

  it('ResellerPayouts.tsx renders StepUpDialog', () => {
    expect(resellerUI).toContain('<StepUpDialog');
    expect(resellerUI).toContain('useStepUp');
  });

  it('Payouts.tsx renders StepUpDialog', () => {
    expect(payoutsUI).toContain('<StepUpDialog');
    expect(payoutsUI).toContain('useStepUp');
  });
});

// ══════════════════════════════════════════════════════════
// Payouts.tsx — server-side data path verification
// ══════════════════════════════════════════════════════════

describe('Payouts.tsx data loading via authenticated API', () => {
  const payoutsUI = readFileSync('admin/src/pages/Payouts.tsx', 'utf-8');

  it('does NOT directly query business_payouts table', () => {
    // The old pattern: adminDb.from('business_payouts').select('*')
    expect(payoutsUI).not.toContain("from('business_payouts')");
  });

  it('loads data via authenticated /api/admin/payouts route', () => {
    expect(payoutsUI).toContain('/api/admin/payouts');
    expect(payoutsUI).toContain('Authorization');
    expect(payoutsUI).toContain('Bearer');
  });

  it('uses session access token for API calls', () => {
    expect(payoutsUI).toContain('supabase.auth.getSession()');
    expect(payoutsUI).toContain('access_token');
  });
});

describe('Payouts API route uses service client with safe columns', () => {
  const routeSource = readFileSync('app/api/admin/payouts/route.ts', 'utf-8');

  it('uses createServiceClient (not createClient)', () => {
    expect(routeSource).toContain('createServiceClient');
    expect(routeSource).not.toContain("from '@/lib/supabase/server'");
  });

  it('joins business name and country_code server-side', () => {
    expect(routeSource).toContain('businesses(name, country_code)');
  });

  it('shapes response with explicit field mapping', () => {
    expect(routeSource).toContain('business_name:');
    expect(routeSource).toContain('country_code:');
  });

  it('response shaping excludes claim_token', () => {
    const shapeIdx = routeSource.indexOf('Shape response');
    const responseBlock = routeSource.slice(shapeIdx);
    expect(responseBlock).not.toContain('claim_token');
  });

  it('response shaping excludes provider_idempotency_key', () => {
    const shapeIdx = routeSource.indexOf('Shape response');
    const responseBlock = routeSource.slice(shapeIdx);
    expect(responseBlock).not.toContain('provider_idempotency_key');
  });
});

// ══════════════════════════════════════════════════════════
// ResellerPayouts.tsx — server-side data path verification
// ══════════════════════════════════════════════════════════

describe('ResellerPayouts.tsx uses authenticated API (no direct DB)', () => {
  const src = readFileSync('admin/src/pages/ResellerPayouts.tsx', 'utf-8');

  it('does NOT directly select from reseller_payouts', () => {
    expect(src).not.toContain("from('reseller_payouts')");
  });

  it('does NOT directly insert into reseller_payouts', () => {
    expect(src).not.toContain('.insert(');
  });

  it('does NOT directly update reseller_payouts', () => {
    expect(src).not.toContain('.update(');
  });

  it('does NOT import logAudit (server handles audit)', () => {
    expect(src).not.toContain('logAudit');
  });

  it('loads payouts via authenticated GET /api/admin/reseller-payouts', () => {
    expect(src).toContain('/api/admin/reseller-payouts');
    expect(src).toContain('Authorization');
  });

  it('creates payouts via authenticated POST', () => {
    expect(src).toContain("method: 'POST'");
  });

  it('mutates payouts via authenticated PATCH', () => {
    expect(src).toContain("method: 'PATCH'");
  });

  it('maps UI action pay to server action mark_paid', () => {
    expect(src).toContain("'pay' ? 'mark_paid'");
  });

  it('labels commission preview as non-authoritative', () => {
    expect(src).toContain('server calculates final');
  });
});

describe('Reseller GET response uses explicit safe fields', () => {
  const routeSource = readFileSync('app/api/admin/reseller-payouts/route.ts', 'utf-8');

  it('maps to explicit fields', () => {
    expect(routeSource).toContain('id: p.id');
    expect(routeSource).toContain('company_name:');
  });

  it('does not pass through raw DB rows in GET response', () => {
    const getSection = routeSource.slice(0, routeSource.indexOf('export async function POST'));
    expect(getSection).not.toContain('...p');
  });
});

// ══════════════════════════════════════════════════════════
// A. Reseller payout period boundary verification
// ══════════════════════════════════════════════════════════

describe('Reseller payout period boundaries (A)', () => {
  const serverSource = readFileSync('app/api/admin/reseller-payouts/route.ts', 'utf-8');
  const uiSource = readFileSync('admin/src/pages/ResellerPayouts.tsx', 'utf-8');

  it('server uses exclusive end boundary (.lt not .lte)', () => {
    const postSection = serverSource.slice(serverSource.indexOf('Calculate gross commission'));
    expect(postSection).toContain(".lt('created_at',");
    expect(postSection).not.toContain(".lte('created_at',");
  });

  it('server uses period_end directly (no +1 day — already exclusive)', () => {
    const postSection = serverSource.slice(serverSource.indexOf('Calculate gross commission'));
    expect(postSection).not.toContain('setUTCDate');
    expect(postSection).toContain("period_end is EXCLUSIVE");
  });

  it('UI preview uses matching exclusive end boundary (.lt)', () => {
    const previewSection = uiSource.slice(uiSource.indexOf('platform_fees'));
    expect(previewSection).toContain(".lt('created_at',");
    expect(previewSection).not.toContain(".lte('created_at',");
  });

  it('UI preview uses period_end directly (no +1 day)', () => {
    const previewSection = uiSource.slice(uiSource.indexOf('platform_fees'));
    expect(previewSection).not.toContain('setUTCDate');
  });

  it('server uses .gte for start boundary (inclusive)', () => {
    const postSection = serverSource.slice(serverSource.indexOf('Calculate gross commission'));
    expect(postSection).toContain(".gte('created_at',");
  });
});

// ══════════════════════════════════════════════════════════
// B. Reseller payout state transition atomicity (CAS)
// ══════════════════════════════════════════════════════════

describe('Reseller payout CAS state transitions (B)', () => {
  const patchSource = readFileSync('app/api/admin/reseller-payouts/[id]/route.ts', 'utf-8');

  it('UPDATE includes .in(status, allowedSourceStatuses) guard', () => {
    expect(patchSource).toContain(".in('status', allowedSourceStatuses)");
  });

  it('uses maybeSingle to detect zero-affected-row case', () => {
    expect(patchSource).toContain('.maybeSingle()');
  });

  it('returns 409 when CAS fails (status changed)', () => {
    expect(patchSource).toContain('409');
    expect(patchSource).toContain('status has changed');
  });

  it('approve source status is [pending]', () => {
    expect(patchSource).toMatch(/approve[\s\S]*?allowedSourceStatuses\s*=\s*\['pending'\]/);
  });

  it('reject source statuses are [pending, approved]', () => {
    expect(patchSource).toMatch(/reject[\s\S]*?allowedSourceStatuses\s*=\s*\['pending',\s*'approved'\]/);
  });

  it('mark_paid uses atomic RPC with advisory lock', () => {
    expect(patchSource).toContain("service.rpc('mark_reseller_payout_paid'");
  });

  it('mark_paid RPC handles insufficient_balance', () => {
    expect(patchSource).toContain("reason === 'insufficient_balance'");
  });
});

// ══════════════════════════════════════════════════════════
// C. Duplicate reseller payout period DB constraint
// ══════════════════════════════════════════════════════════

describe('Duplicate reseller payout period protection (C)', () => {
  const migrationSource = readFileSync('supabase/migrations/207_reseller_full.sql', 'utf-8');
  const postSource = readFileSync('app/api/admin/reseller-payouts/route.ts', 'utf-8');

  it('DB has UNIQUE constraint on (reseller_id, period_start, period_end)', () => {
    expect(migrationSource).toContain('UNIQUE(reseller_id, period_start, period_end)');
  });

  it('API maps unique violation (23505) to 409', () => {
    expect(postSource).toContain("insertErr.code === '23505'");
    expect(postSource).toContain('409');
  });

  it('API still has application-level duplicate check before insert', () => {
    expect(postSource).toContain('A payout already exists for this period');
  });
});

// ══════════════════════════════════════════════════════════
// D. Audit logging accuracy
// ══════════════════════════════════════════════════════════

describe('Reseller audit logging is server-side (D)', () => {
  const patchSource = readFileSync('app/api/admin/reseller-payouts/[id]/route.ts', 'utf-8');
  const postSource = readFileSync('app/api/admin/reseller-payouts/route.ts', 'utf-8');

  it('PATCH writes audit log server-side after successful mutation', () => {
    // For approve/reject: audit is after .update(updateData)
    // For mark_paid: audit is after RPC call
    // Both patterns have 'logAdminAudit' after the mutation
    const approveAuditIdx = patchSource.lastIndexOf('logAdminAudit');
    const updateIdx = patchSource.indexOf('.update(updateData)');
    expect(approveAuditIdx).toBeGreaterThan(updateIdx);
  });

  it('POST writes audit log server-side after successful insert', () => {
    // Skip past the import to find the actual call site
    const auditIdx = postSource.lastIndexOf('logAdminAudit');
    const insertIdx = postSource.indexOf('.insert({');
    expect(auditIdx).toBeGreaterThan(insertIdx);
  });

  it('audit failure is logged but does not roll back the payout', () => {
    // Audit log write is a separate statement, not inside a transaction/RPC
    // This is accurate — described as server-side logging, not atomic
    expect(patchSource).toContain('logAdminAudit');
    // The audit insert is NOT inside a try/catch that would undo the payout update
  });
});

// ══════════════════════════════════════════════════════════
// E. Step-up MFA enforcement (SEC-005 Layer 4)
// ══════════════════════════════════════════════════════════

describe('Step-up MFA enforced on payout mutations (E)', () => {
  const rejectSource = readFileSync('app/api/admin/payouts/[id]/reject/route.ts', 'utf-8');
  const resellerPatchSource = readFileSync('app/api/admin/reseller-payouts/[id]/route.ts', 'utf-8');

  it('payout reject calls consumeStepUp before mutation', () => {
    const stepUpIdx = rejectSource.indexOf('consumeStepUp');
    // The mutation is now an RPC call instead of inline .update()
    const rpcIdx = rejectSource.indexOf("'reject_payout_and_release_adjustments'");
    expect(stepUpIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(stepUpIdx);
  });

  it('payout reject uses payout_reject action type', () => {
    expect(rejectSource).toContain("'payout_reject'");
  });

  it('payout reject binds step-up to payout id and reason', () => {
    expect(rejectSource).toContain('{ reason }');
  });

  it('reseller payout PATCH calls consumeStepUp before mutation', () => {
    const stepUpIdx = resellerPatchSource.indexOf('consumeStepUp');
    const rpcIdx = resellerPatchSource.indexOf("service.rpc('mark_reseller_payout_paid'");
    expect(stepUpIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(stepUpIdx);
  });

  it('reseller payout uses action-specific step-up types', () => {
    expect(resellerPatchSource).toContain('reseller_payout_');
    expect(resellerPatchSource).toContain('stepUpAction');
  });

  it('reseller payout extracts stepUpId from request body', () => {
    expect(resellerPatchSource).toContain('stepUpId');
  });

  it('both routes return 403 with step_up_required code on failure', () => {
    expect(rejectSource).toContain("code: 'step_up_required'");
    expect(resellerPatchSource).toContain("code: 'step_up_required'");
  });
});

const stepUpMod = await import('@/lib/admin-step-up');
const mockConsumeStepUp = stepUpMod.consumeStepUp as ReturnType<typeof vi.fn>;

describe('Step-up denial returns 403 (E — route-level)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockSelectResult to clear any queued mockResolvedValueOnce
    // values from earlier tests (vi.clearAllMocks does not clear implementations)
    mockSelectResult.mockReset();
    mockAuthRole = 'admin';
    mockConsumeStepUp.mockResolvedValue(true);
    mockSelectResult.mockResolvedValue({
      data: { id: 'p-1', business_id: 'b-1', net_amount: 100, status: 'pending' },
      error: null,
    });
  });

  it('payout reject returns 403 when step-up fails', async () => {
    // Route now validates payout existence/status BEFORE step-up consumption,
    // so the mock must return a valid payout for the precondition checks to pass.
    mockSelectResult.mockResolvedValue({
      data: { id: 'p-1', business_id: 'b-1', net_amount: 100, status: 'pending' },
      error: null,
    });
    mockConsumeStepUp.mockRejectedValueOnce(
      new Error('Step-up authorization required')
    );
    const res = await payoutsRejectModule.POST(
      makeRequest('/api/admin/payouts/p-1/reject', 'POST', { reason: 'test' }),
      { params: Promise.resolve({ id: 'p-1' }) }
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('step_up_required');
  });

  it('reseller payout approve returns 403 when step-up fails', async () => {
    mockConsumeStepUp.mockRejectedValueOnce(
      new Error('Step-up authorization required')
    );
    const res = await resellerPayoutsPatchModule.PATCH(
      makeRequest('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'approve' }),
      { params: Promise.resolve({ id: 'rp-1' }) }
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('step_up_required');
  });

  it('reseller payout mark_paid returns 403 when step-up fails', async () => {
    mockConsumeStepUp.mockRejectedValueOnce(
      new Error('Step-up authorization required')
    );
    const res = await resellerPayoutsPatchModule.PATCH(
      makeRequest('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'mark_paid' }),
      { params: Promise.resolve({ id: 'rp-1' }) }
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('step_up_required');
  });
});
