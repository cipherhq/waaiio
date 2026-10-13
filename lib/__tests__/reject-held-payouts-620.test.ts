/**
 * #620 — Reject held payouts: executable route-level tests
 *
 * Each test calls the actual POST handler with mocked Supabase responses.
 * a) held → rejected (success)
 * b) pending → rejected (success)
 * c) paid → 400 (ineligible status)
 * d) processing → 400 (ineligible status)
 * e) race: status changed between read and RPC → 409
 * f) step-up failure → no writes
 * g) linked adjustments are released (adjustments_released count)
 * h) RPC error → 500 with nothing changed
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

function makePostRequest(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

interface RejectTestConfig {
  /** Payout status returned by the initial read */
  payoutStatus?: string;
  /** RPC result (array of rows) */
  rpcResult?: unknown[] | null;
  /** RPC error */
  rpcError?: { message: string } | null;
  /** Whether consumeStepUp should throw */
  stepUpFails?: boolean;
}

let rpcCalls: Array<{ name: string; params: Record<string, unknown> }>;
let auditLogCalls: Array<Record<string, unknown>>;

function setupMocks(config: RejectTestConfig = {}) {
  const {
    payoutStatus = 'held',
    rpcResult = [{ rejected_id: 'p1', adjustments_released: 0 }],
    rpcError = null,
    stepUpFails = false,
  } = config;

  rpcCalls = [];
  auditLogCalls = [];

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    ['select', 'eq', 'neq', 'in', 'is', 'not', 'single', 'maybeSingle', 'update', 'insert'].forEach(m => {
      chain[m] = vi.fn().mockReturnValue(chain);
    });

    if (table === 'business_payouts') {
      chain.single = vi.fn().mockResolvedValue({
        data: {
          id: 'p1', business_id: 'b1', net_amount: 100, status: payoutStatus,
        },
      });
    } else if (table === 'businesses') {
      chain.single = vi.fn().mockResolvedValue({
        data: { name: 'Test Biz', owner_id: 'u1', country_code: 'NG' },
      });
    } else if (table === 'profiles') {
      chain.single = vi.fn().mockResolvedValue({
        data: { email: 'test@test.com' },
      });
    } else {
      chain.single = vi.fn().mockResolvedValue({ data: null });
      chain.insert = vi.fn().mockResolvedValue({});
    }
    return chain;
  });

  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: vi.fn().mockReturnValue({
      from: mockFrom,
      rpc: vi.fn().mockImplementation((name: string, params: Record<string, unknown>) => {
        rpcCalls.push({ name, params });
        if (rpcError) {
          return Promise.resolve({ data: null, error: rpcError });
        }
        return Promise.resolve({ data: rpcResult, error: null });
      }),
    }),
  }));

  vi.doMock('@/lib/supabase/server', () => ({
    createClient: vi.fn().mockResolvedValue({ from: mockFrom }),
  }));

  vi.doMock('@/lib/admin-auth', () => ({
    requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin', aal: 'aal2', bearerToken: 'test-bearer' }),
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

  vi.doMock('@/lib/admin-audit', () => ({
    logAdminAudit: vi.fn().mockImplementation((entry: Record<string, unknown>) => {
      auditLogCalls.push(entry);
      return Promise.resolve();
    }),
  }));
  vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
  vi.doMock('@/lib/email/templates', () => ({ payoutRejectedEmail: vi.fn() }));
}

describe('#620 — Reject route: executable tests', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('(a) held → rejected: calls RPC and returns success', async () => {
    setupMocks({ payoutStatus: 'held' });
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = makePostRequest('/api/admin/payouts/p1/reject', {
      reason: 'Suspicious activity', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe('reject_payout_and_release_adjustments');
    expect(rpcCalls[0].params.p_payout_id).toBe('p1');
    expect(rpcCalls[0].params.p_reason).toBe('Suspicious activity');
  });

  it('(b) pending → rejected: calls RPC and returns success', async () => {
    setupMocks({ payoutStatus: 'pending' });
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = makePostRequest('/api/admin/payouts/p1/reject', {
      reason: 'Duplicate', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(200);
  });

  it('(c) paid → 400: rejected before RPC', async () => {
    setupMocks({ payoutStatus: 'paid' });
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = makePostRequest('/api/admin/payouts/p1/reject', {
      reason: 'Test', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('cannot be rejected');
    // No RPC call
    expect(rpcCalls).toHaveLength(0);
  });

  it('(c) processing → 400: rejected before RPC', async () => {
    setupMocks({ payoutStatus: 'processing' });
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = makePostRequest('/api/admin/payouts/p1/reject', {
      reason: 'Test', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('(e) race: RPC returns ineligible_status → 409', async () => {
    setupMocks({
      payoutStatus: 'held',
      rpcError: { message: 'ineligible_status: processing' },
    });
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = makePostRequest('/api/admin/payouts/p1/reject', {
      reason: 'Test', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('status has changed');
    // RPC was called but audit was not
    expect(rpcCalls).toHaveLength(1);
    expect(auditLogCalls).toHaveLength(0);
  });

  it('(f) step-up failure → no RPC, no writes', async () => {
    setupMocks({ payoutStatus: 'held', stepUpFails: true });
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = makePostRequest('/api/admin/payouts/p1/reject', {
      reason: 'Test', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('step_up_required');
    // Zero RPC calls, zero audit
    expect(rpcCalls).toHaveLength(0);
    expect(auditLogCalls).toHaveLength(0);
  });

  it('(g) linked adjustments are released: audit logs count', async () => {
    setupMocks({
      payoutStatus: 'held',
      rpcResult: [{ rejected_id: 'p1', adjustments_released: 3 }],
    });
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = makePostRequest('/api/admin/payouts/p1/reject', {
      reason: 'Refund pending', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });

    expect(res.status).toBe(200);
    expect(auditLogCalls).toHaveLength(1);
    expect(auditLogCalls[0].details).toMatchObject({ adjustments_released: 3 });
  });

  it('(h) RPC error → 500, no audit', async () => {
    setupMocks({
      payoutStatus: 'held',
      rpcError: { message: 'deadlock detected' },
    });
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = makePostRequest('/api/admin/payouts/p1/reject', {
      reason: 'Test', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toContain('Failed to reject payout');
    // RPC was called but audit was not
    expect(rpcCalls).toHaveLength(1);
    expect(auditLogCalls).toHaveLength(0);
  });

  it('linkage flag blocks rejection → 409', async () => {
    setupMocks({
      payoutStatus: 'held',
      rpcError: { message: 'linkage_flag_blocks_rejection: adjustment_link_pending' },
    });
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = makePostRequest('/api/admin/payouts/p1/reject', {
      reason: 'Test', stepUpId: 'step1',
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'p1' }) });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain('unresolved adjustment linkage flag');
  });
});
