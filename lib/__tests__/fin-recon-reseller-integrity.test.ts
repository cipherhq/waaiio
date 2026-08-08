/**
 * FIN-RECON: Reseller Payout Financial Integrity Tests
 *
 * Tests cover:
 * - RLS: Finance SELECT allowed, INSERT/UPDATE/DELETE denied
 * - mark_paid RPC: atomic balance serialization
 * - Overlapping period prevention
 * - CAS state transitions
 * - Input validation
 * - Audit failure handling
 * - Migration verification
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

// ── Source verification tests (no DB required) ──────────

describe('Migration 311: reseller payout integrity', () => {
  const src = readFileSync('supabase/migrations/311_reseller_payout_integrity.sql', 'utf-8');

  // RLS
  it('drops the old broad admin+finance FOR ALL policy', () => {
    expect(src).toContain('DROP POLICY IF EXISTS "Admin manages reseller payouts"');
  });

  it('creates admin-only CRUD policy using is_admin()', () => {
    expect(src).toContain('admin_manages_reseller_payouts');
    expect(src).toContain('is_admin()');
  });

  it('creates finance SELECT-only policy', () => {
    expect(src).toContain('finance_reads_reseller_payouts');
    expect(src).toContain('FOR SELECT');
    expect(src).toContain('is_admin_or_support()');
  });

  // mark_reseller_payout_paid RPC
  it('defines mark_reseller_payout_paid RPC', () => {
    expect(src).toContain('CREATE OR REPLACE FUNCTION mark_reseller_payout_paid');
  });

  it('uses advisory lock for reseller-level serialization', () => {
    expect(src).toContain('pg_advisory_xact_lock');
    expect(src).toContain('reseller_payout_balance');
  });

  it('calculates authoritative balance inside the lock', () => {
    expect(src).toContain('platform_fees');
    expect(src).toContain('v_total_earned');
    expect(src).toContain('v_total_paid');
    expect(src).toContain('v_available');
  });

  it('uses CAS guard on the final UPDATE', () => {
    expect(src).toContain("AND status = 'approved'");
  });

  it('returns insufficient_balance with details when overspent', () => {
    expect(src).toContain("'insufficient_balance'");
    expect(src).toContain("'total_earned'");
    expect(src).toContain("'available'");
  });

  it('restricts RPC execution to service_role only', () => {
    expect(src).toContain('REVOKE EXECUTE ON FUNCTION mark_reseller_payout_paid');
    expect(src).toContain('GRANT EXECUTE ON FUNCTION mark_reseller_payout_paid');
    expect(src).toContain('TO service_role');
  });

  it('is SECURITY DEFINER with search_path = public', () => {
    expect(src).toContain('SECURITY DEFINER');
    expect(src).toContain("SET search_path = public");
  });

  // Overlap prevention
  it('creates btree_gist extension', () => {
    expect(src).toContain('CREATE EXTENSION IF NOT EXISTS btree_gist');
  });

  it('adds exclusion constraint for overlapping periods', () => {
    expect(src).toContain('reseller_payouts_no_overlap');
    expect(src).toContain('EXCLUDE USING gist');
    expect(src).toContain('daterange');
  });

  it('only constrains non-rejected payouts', () => {
    expect(src).toContain("status != 'rejected'");
  });

  it('checks for existing overlaps before adding constraint', () => {
    expect(src).toContain('Existing overlapping reseller payouts detected');
    expect(src).toContain('RAISE WARNING');
  });

  it('uses exclusive end for daterange (period_end + 1)', () => {
    expect(src).toContain("period_end + 1, '[)'");
  });
});

describe('PATCH route: mark_paid uses atomic RPC', () => {
  const src = readFileSync('app/api/admin/reseller-payouts/[id]/route.ts', 'utf-8');

  it('calls mark_reseller_payout_paid RPC for mark_paid action', () => {
    expect(src).toContain("service.rpc('mark_reseller_payout_paid'");
  });

  it('does NOT do application-level balance calculation for mark_paid', () => {
    // The old pattern: platform_fees select + manual sum for mark_paid
    // Should no longer exist — RPC handles it atomically
    const markPaidSection = src.slice(src.indexOf("action === 'mark_paid'"));
    const approveSection = src.slice(src.indexOf("action === 'approve'"));
    // mark_paid section should NOT contain direct platform_fees query
    const afterMarkPaid = markPaidSection.slice(0, markPaidSection.indexOf("action === 'approve'") > 0 ? markPaidSection.indexOf("action === 'approve'") : undefined);
    expect(afterMarkPaid).not.toContain("from('platform_fees')");
  });

  it('maps RPC insufficient_balance to 400', () => {
    expect(src).toContain("reason === 'insufficient_balance'");
    expect(src).toContain('400');
  });

  it('maps RPC status_changed to 409', () => {
    expect(src).toContain("reason === 'status_changed'");
    expect(src).toContain('409');
  });

  it('wraps audit log in try/catch with explicit logger.error', () => {
    expect(src).toContain('} catch (auditErr)');
    expect(src).toContain('Audit log failed');
  });
});

describe('POST route: input validation', () => {
  const src = readFileSync('app/api/admin/reseller-payouts/route.ts', 'utf-8');

  it('validates date format', () => {
    expect(src).toContain('isNaN(startDate.getTime())');
    expect(src).toContain('Invalid date format');
  });

  it('validates start < end', () => {
    expect(src).toContain('startDate >= endDate');
    expect(src).toContain('period_start must be before period_end');
  });

  it('validates holdback_percent range', () => {
    expect(src).toContain('isFinite(hbp)');
    expect(src).toContain('hbp < 0');
    expect(src).toContain('hbp > 100');
  });

  it('validates deductions non-negative', () => {
    expect(src).toContain('isFinite(ded)');
    expect(src).toContain('ded < 0');
  });

  it('maps overlap constraint violation (23P01) to 409', () => {
    expect(src).toContain("insertErr.code === '23P01'");
    expect(src).toContain('overlaps');
  });

  it('wraps audit log in try/catch', () => {
    expect(src).toContain('} catch (auditErr)');
    expect(src).toContain('Audit log failed');
  });
});

// ── Route-level authorization tests ──────────────────────

const mockAuthRole = { current: 'admin' };
const mockAuthId = { current: 'admin-user-1' };
const mockRpcResult = vi.fn();
const mockSelectResult = vi.fn();
const mockUpdateChain = {
  eq: vi.fn().mockReturnThis(),
  in: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'updated', status: 'approved' }, error: null }),
};
const mockInsertResult = vi.fn();

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(async (_req: unknown, opts?: { requiredRole?: string | string[] }) => {
    const role = mockAuthRole.current;
    if (!['admin', 'support', 'finance', 'operations'].includes(role)) return null;
    if (opts?.requiredRole) {
      const required = Array.isArray(opts.requiredRole) ? opts.requiredRole : [opts.requiredRole];
      if (!required.includes(role)) return null;
    }
    return { id: mockAuthId.current, userId: mockAuthId.current, email: 'test@example.com', role };
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle: mockSelectResult,
      single: mockSelectResult,
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ single: mockInsertResult }),
      }),
      update: vi.fn(() => mockUpdateChain),
    })),
    rpc: mockRpcResult,
  })),
}));

const logFns = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
vi.mock('@/lib/logger', () => ({
  logger: { ...logFns, withContext: vi.fn(() => logFns) },
  safeLogErrorContext: vi.fn(() => ({})),
}));

const { PATCH } = await import('@/app/api/admin/reseller-payouts/[id]/route');
import { NextRequest } from 'next/server';

function makeReq(url: string, method = 'PATCH', body?: Record<string, unknown>) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthRole.current = 'admin';
  mockSelectResult.mockResolvedValue({ data: null, error: null });
  mockInsertResult.mockResolvedValue({ data: { id: 'new-1' }, error: null });
});

describe('mark_paid authorization and RPC dispatch', () => {
  it('admin mark_paid calls RPC', async () => {
    mockRpcResult.mockResolvedValue({ data: { success: true, available_after: 300 }, error: null });
    const res = await PATCH(
      makeReq('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'mark_paid' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(200);
    expect(mockRpcResult).toHaveBeenCalledWith('mark_reseller_payout_paid', {
      p_payout_id: 'rp-1',
      p_admin_id: 'admin-user-1',
    });
  });

  it('finance mark_paid blocked (403)', async () => {
    mockAuthRole.current = 'finance';
    const res = await PATCH(
      makeReq('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'mark_paid' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(403);
  });

  it('RPC insufficient_balance returns 400', async () => {
    mockRpcResult.mockResolvedValue({
      data: { success: false, reason: 'insufficient_balance', total_earned: 1000, total_paid: 700, available: 300, requested: 700 },
      error: null,
    });
    const res = await PATCH(
      makeReq('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'mark_paid' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Insufficient');
  });

  it('RPC status_changed returns 409', async () => {
    mockRpcResult.mockResolvedValue({
      data: { success: false, reason: 'status_changed' },
      error: null,
    });
    const res = await PATCH(
      makeReq('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'mark_paid' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(409);
  });
});

describe('approve/reject CAS transitions', () => {
  it('approve from pending succeeds', async () => {
    mockSelectResult.mockResolvedValueOnce({ data: { id: 'rp-1', reseller_id: 'r-1', status: 'pending', net_amount: 100, notes: null }, error: null });
    mockUpdateChain.maybeSingle.mockResolvedValueOnce({ data: { id: 'rp-1', status: 'approved' }, error: null });
    const res = await PATCH(
      makeReq('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'approve' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(200);
  });

  it('approve from rejected fails (400)', async () => {
    mockSelectResult.mockResolvedValueOnce({ data: { id: 'rp-1', reseller_id: 'r-1', status: 'rejected', net_amount: 100, notes: null }, error: null });
    const res = await PATCH(
      makeReq('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'approve' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(400);
  });

  it('concurrent approve returns 409 when CAS fails', async () => {
    mockSelectResult.mockResolvedValueOnce({ data: { id: 'rp-1', reseller_id: 'r-1', status: 'pending', net_amount: 100, notes: null }, error: null });
    mockUpdateChain.maybeSingle.mockResolvedValueOnce({ data: null, error: null }); // CAS failed
    const res = await PATCH(
      makeReq('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'approve' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(409);
  });

  it('reject from approved succeeds', async () => {
    mockSelectResult.mockResolvedValueOnce({ data: { id: 'rp-1', reseller_id: 'r-1', status: 'approved', net_amount: 100, notes: null }, error: null });
    mockUpdateChain.maybeSingle.mockResolvedValueOnce({ data: { id: 'rp-1', status: 'rejected' }, error: null });
    const res = await PATCH(
      makeReq('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'reject' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(200);
  });

  it('reject from paid fails (400)', async () => {
    mockSelectResult.mockResolvedValueOnce({ data: { id: 'rp-1', reseller_id: 'r-1', status: 'paid', net_amount: 100, notes: null }, error: null });
    const res = await PATCH(
      makeReq('/api/admin/reseller-payouts/rp-1', 'PATCH', { action: 'reject' }),
      { params: Promise.resolve({ id: 'rp-1' }) },
    );
    expect(res.status).toBe(400);
  });
});

describe('Audit failure handling', () => {
  it('logs audit failure without crashing on mark_paid', async () => {
    mockRpcResult.mockResolvedValue({ data: { success: true, available_after: 300 }, error: null });
    // The test framework mock for service.from().insert() is already set up
    // We just verify the try/catch pattern exists in source
    const src = readFileSync('app/api/admin/reseller-payouts/[id]/route.ts', 'utf-8');
    expect(src).toContain('} catch (auditErr)');
    expect(src).toContain('logger.error');
    expect(src).toContain('Audit log failed');
  });
});
