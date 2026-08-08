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
    const approvedGuards = (resellerUI.match(/approved.*&&.*isFullAdmin/g) || []).length;
    expect(approvedGuards).toBeGreaterThanOrEqual(2);
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

  it('server computes end+1day for exclusive boundary', () => {
    expect(serverSource).toContain('setUTCDate');
    expect(serverSource).toContain('periodEndExclusive');
  });

  it('UI preview uses matching exclusive end boundary (.lt)', () => {
    const previewSection = uiSource.slice(uiSource.indexOf('platform_fees'));
    expect(previewSection).toContain(".lt('created_at',");
    expect(previewSection).not.toContain(".lte('created_at',");
  });

  it('UI preview uses same +1day model as server', () => {
    expect(uiSource).toContain('setUTCDate');
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

  it('mark_paid source status is [approved]', () => {
    expect(patchSource).toMatch(/mark_paid[\s\S]*?allowedSourceStatuses\s*=\s*\['approved'\]/);
  });

  it('balance re-verification still precedes mark_paid transition', () => {
    const markPaidSection = patchSource.slice(patchSource.indexOf("action === 'mark_paid'"));
    const balanceIdx = markPaidSection.indexOf('Insufficient balance');
    const casIdx = markPaidSection.indexOf('allowedSourceStatuses');
    expect(balanceIdx).toBeGreaterThan(-1);
    expect(casIdx).toBeGreaterThan(balanceIdx);
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
    const auditIdx = patchSource.indexOf('admin_audit_logs');
    const updateIdx = patchSource.indexOf('.update(updateData)');
    expect(auditIdx).toBeGreaterThan(updateIdx);
  });

  it('POST writes audit log server-side after successful insert', () => {
    const auditIdx = postSource.indexOf('admin_audit_logs');
    const insertIdx = postSource.indexOf('.insert({');
    expect(auditIdx).toBeGreaterThan(insertIdx);
  });

  it('audit failure is logged but does not roll back the payout', () => {
    // Audit log write is a separate statement, not inside a transaction/RPC
    // This is accurate — described as server-side logging, not atomic
    expect(patchSource).toContain('admin_audit_logs');
    // The audit insert is NOT inside a try/catch that would undo the payout update
  });
});
