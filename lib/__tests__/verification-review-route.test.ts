/**
 * Verification review route tests.
 *
 * Tests the POST /api/verification/review route for:
 * - Non-admin 403
 * - aal1 403
 * - Missing reason 400
 * - set_level persists and writes audit
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock admin-auth
vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(),
}));

vi.mock('@/lib/admin-step-up', () => ({ consumeStepUp: vi.fn().mockResolvedValue(true) }));

// Mock service client
const mockUpdate = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockSingle = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockFrom,
  }),
}));

vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/templates', () => ({
  kycApprovedEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
  kycRejectedEmail: vi.fn().mockReturnValue({ subject: 's', html: 'h' }),
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

// Mock constants
vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants');
  return {
    ...actual,
    getPayoutLimit: vi.fn().mockReturnValue(500_000),
    formatPayoutLimit: vi.fn().mockReturnValue('₦500,000'),
  };
});

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/verification/review', {
    method: 'POST',
    body: JSON.stringify({ stepUpId: '00000000-0000-0000-0000-000000000762', ...body }),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/verification/review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 for non-admin', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue(null);

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: '00000000-0000-0000-0000-000000000001', action: 'set_level', level: 'standard', reason: 'test' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 for set_level without reason', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'tok',
    });

    // Mock business lookup
    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { name: 'Test', owner_id: 'o1', country_code: 'NG' }, error: null }),
            }),
          }),
        };
      }
      return { select: () => ({ in: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    });

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: '00000000-0000-0000-0000-000000000001', action: 'set_level', level: 'standard' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Reason is required');
  });

  it('set_level unverified→standard persists and writes audit', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'tok',
    });

    // Mock chain for set_level
    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: vi.fn().mockImplementation((cols: string) => {
            if (cols.includes('name')) {
              return {
                eq: () => ({
                  single: () => Promise.resolve({ data: { name: 'Test', owner_id: 'o1', country_code: 'NG' }, error: null }),
                }),
              };
            }
            if (cols.includes('verification_level')) {
              return {
                eq: () => ({
                  single: () => Promise.resolve({
                    data: { verification_level: 'unverified', verification_status: 'unverified', payout_limit_monthly: 0 },
                    error: null,
                  }),
                }),
              };
            }
            return {
              eq: () => ({
                single: () => Promise.resolve({ data: null, error: null }),
              }),
            };
          }),
          update: () => ({
            eq: () => ({
              select: () => Promise.resolve({
                data: [{ id: '00000000-0000-0000-0000-000000000001', verification_level: 'standard', verification_status: 'verified', payout_limit_monthly: 500_000 }],
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: () => ({ in: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    });

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: '00000000-0000-0000-0000-000000000001', action: 'set_level', level: 'standard', reason: 'KYC complete' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.verification_level).toBe('standard');

    const { logAdminAudit } = await import('@/lib/admin-audit');
    expect(logAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'set_verification_level',
        entityType: 'business',
        entityId: '00000000-0000-0000-0000-000000000001',
      }),
    );
  });

  it('set_level standard→basic persists', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'tok',
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: vi.fn().mockImplementation((cols: string) => {
            if (cols.includes('name')) {
              return {
                eq: () => ({
                  single: () => Promise.resolve({ data: { name: 'Test', owner_id: 'o1', country_code: 'NG' }, error: null }),
                }),
              };
            }
            if (cols.includes('verification_level')) {
              return {
                eq: () => ({
                  single: () => Promise.resolve({
                    data: { verification_level: 'standard', verification_status: 'verified', payout_limit_monthly: 2_000_000 },
                    error: null,
                  }),
                }),
              };
            }
            return { eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) };
          }),
          update: () => ({
            eq: () => ({
              select: () => Promise.resolve({
                data: [{ id: '00000000-0000-0000-0000-000000000001', verification_level: 'basic', verification_status: 'verified', payout_limit_monthly: 500_000 }],
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: () => ({ in: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    });

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: '00000000-0000-0000-0000-000000000001', action: 'set_level', level: 'basic', reason: 'Downgrade' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verification_level).toBe('basic');
    expect(body.payout_limit_monthly).toBe(500_000);
  });

  it('returns 401 for aal1 admin (requirePlatformAdmin returns null)', async () => {
    // requirePlatformAdmin checks aal2; aal1 returns null
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue(null);

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: '00000000-0000-0000-0000-000000000001', action: 'set_level', level: 'standard', reason: 'test' }));
    expect(res.status).toBe(401);
  });

  it('set_custom_fees requires a reason', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'tok',
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { name: 'Test', owner_id: 'o1', country_code: 'NG' }, error: null }),
            }),
          }),
        };
      }
      return { select: () => ({ in: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    });

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({
      business_id: '00000000-0000-0000-0000-000000000001',
      action: 'set_custom_fees',
      custom_fee_percentage: 3.5,
      custom_fee_flat: 50,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Reason is required');
  });

  it('set_custom_fees persists and writes audit row', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'tok',
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: vi.fn().mockImplementation((cols: string) => {
            if (cols.includes('name')) {
              return {
                eq: () => ({
                  single: () => Promise.resolve({ data: { name: 'Test', owner_id: 'o1', country_code: 'NG' }, error: null }),
                }),
              };
            }
            if (cols.includes('custom_fee')) {
              return {
                eq: () => ({
                  single: () => Promise.resolve({
                    data: { custom_fee_percentage: null, custom_fee_flat: null },
                    error: null,
                  }),
                }),
              };
            }
            return { eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) };
          }),
          update: () => ({
            eq: () => ({
              select: () => Promise.resolve({
                data: [{ id: '00000000-0000-0000-0000-000000000001', custom_fee_percentage: 3.5, custom_fee_flat: 50 }],
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: () => ({ in: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    });

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({
      business_id: '00000000-0000-0000-0000-000000000001',
      action: 'set_custom_fees',
      custom_fee_percentage: 3.5,
      custom_fee_flat: 50,
      reason: 'Volume discount',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.custom_fee_percentage).toBe(3.5);
    expect(body.custom_fee_flat).toBe(50);

    const { logAdminAudit } = await import('@/lib/admin-audit');
    expect(logAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'set_custom_fees',
        entityType: 'business',
        entityId: '00000000-0000-0000-0000-000000000001',
      }),
    );
  });

  it('reject requires reason', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'tok',
    });

    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { name: 'Test', owner_id: 'o1', country_code: 'NG' }, error: null }),
            }),
          }),
        };
      }
      return { select: () => ({ in: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) };
    });

    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: '00000000-0000-0000-0000-000000000001', action: 'reject' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('reason');
  });
});

describe('operation-bound verification review and CORS', () => {
  const businessId = '00000000-0000-0000-0000-000000000001';
  const docA = '00000000-0000-0000-0000-000000000011';
  const docB = '00000000-0000-0000-0000-000000000012';
  const stepUpId = '00000000-0000-0000-0000-000000000762';
  const writes: string[] = [];
  let foreignDocument = false;
  let failWrite = '';
  const actions = [
    { action: 'set_level', level: 'standard', reason: 'review complete' },
    { action: 'set_custom_fees', custom_fee_percentage: 0, custom_fee_flat: 0, reason: 'review complete' },
    { action: 'approve', level: 'standard', notes: 'review complete', document_ids: [docB, docA] },
    { action: 'reject', reason: 'review incomplete', document_ids: [docB, docA] },
  ];
  beforeEach(async () => {
    vi.clearAllMocks(); writes.length = 0; foreignDocument = false; failWrite = '';
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      userId: 'admin', email: 'synthetic@example.test', role: 'admin', aal: 'aal2', bearerToken: 'token', sessionId: 'session',
    });
    const { consumeStepUp } = await import('@/lib/admin-step-up');
    vi.mocked(consumeStepUp).mockReset().mockResolvedValue(true);
    mockFrom.mockImplementation((table: string) => {
      let mutation: Record<string, unknown> | null = null;
      const result = () => ({
        data: mutation ? (table === 'business_documents' ? [{ id: docA }, { id: docB }] : [{ id: businessId, ...mutation }]) :
          table === 'business_documents' ? (foreignDocument ? [{ id: docA }] : [{ id: docA }, { id: docB }]) : [],
        error: mutation && failWrite === table ? { message: 'synthetic failure' } : null,
      });
      const chain = {
        select: () => chain, eq: () => chain, in: () => chain,
        update: (value: Record<string, unknown>) => { mutation = value; writes.push(table); return chain; },
        single: async () => ({ data: table === 'businesses' ? { name: 'Synthetic', owner_id: 'owner', country_code: 'NG' } : null, error: null }),
        then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return chain;
    });
  });
  it.each(actions)('authorizes and persists $action after validation', async payload => {
    const { POST } = await import('@/app/api/verification/review/route');
    const { consumeStepUp } = await import('@/lib/admin-step-up');
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    const res = await POST(makeRequest({ business_id: businessId, ...payload }));
    expect(res.status).toBe(200);
    expect(requirePlatformAdmin).toHaveBeenCalledWith(expect.anything(), { requiredRole: 'admin' });
    const params = { ...payload, scope: 'business_verification_review',
      ...('document_ids' in payload ? { document_ids: [docA, docB] } : {}) };
    expect(consumeStepUp).toHaveBeenCalledWith(expect.anything(), stepUpId, 'commercial_config', businessId, params);
    expect(writes).toContain('businesses');
  });
  it.each(actions)('missing authorization makes no mutation for $action', async payload => {
    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: businessId, ...payload, stepUpId: null }));
    expect(res.status).toBe(403); expect(writes).toEqual([]);
  });
  it.each(actions)('mismatched/replayed authorization makes no mutation for $action', async payload => {
    const { consumeStepUp } = await import('@/lib/admin-step-up');
    vi.mocked(consumeStepUp).mockRejectedValue(new Error('not authorized'));
    const { POST } = await import('@/app/api/verification/review/route');
    const res = await POST(makeRequest({ business_id: businessId, ...payload }));
    expect(res.status).toBe(403); expect(writes).toEqual([]);
  });
  it('does not consume or write when document ownership fails', async () => {
    foreignDocument = true;
    const { consumeStepUp } = await import('@/lib/admin-step-up');
    const { POST } = await import('@/app/api/verification/review/route');
    const response = await POST(makeRequest({ business_id: businessId, ...actions[2] }));
    expect(response.status).toBe(400);
    expect(consumeStepUp).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it.each([
    { action: 'set_level', level: 'invalid', reason: 'test' },
    { action: 'set_level', level: 'basic', reason: '  ' },
    { action: 'approve', level: 'invalid' },
    { action: 'approve', document_ids: [docA, docA] },
    { action: 'reject', reason: 2 },
    { action: 'set_custom_fees', reason: 'test', custom_fee_percentage: 101 },
    { action: 'set_custom_fees', reason: 'test', custom_fee_flat: 1.5 },
    { action: 'set_custom_fees', reason: 'test', custom_fee_flat: -1 },
  ])('invalid input creates no write or consumption: %j', async payload => {
    const { consumeStepUp } = await import('@/lib/admin-step-up');
    const { POST } = await import('@/app/api/verification/review/route');
    expect((await POST(makeRequest({ business_id: businessId, ...payload }))).status).toBe(400);
    expect(consumeStepUp).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it('normalizes notes, reasons and document order and preserves null versus zero', async () => {
    const { consumeStepUp } = await import('@/lib/admin-step-up');
    const { POST } = await import('@/app/api/verification/review/route');
    await POST(makeRequest({ business_id: businessId, action: 'set_custom_fees', reason: '  clear  ', custom_fee_percentage: null, custom_fee_flat: 0 }));
    expect(consumeStepUp).toHaveBeenLastCalledWith(expect.anything(), stepUpId, 'commercial_config', businessId,
      { scope: 'business_verification_review', action: 'set_custom_fees', reason: 'clear', custom_fee_percentage: null, custom_fee_flat: 0 });
    await POST(makeRequest({ business_id: businessId, action: 'approve', notes: '  ', document_ids: [docB, docA] }));
    expect(consumeStepUp).toHaveBeenLastCalledWith(expect.anything(), stepUpId, 'commercial_config', businessId,
      { scope: 'business_verification_review', action: 'approve', level: 'basic', notes: null, document_ids: [docA, docB] });
  });
  it('retains truthful partial-write failure and requires a new authorization', async () => {
    failWrite = 'businesses';
    const { POST } = await import('@/app/api/verification/review/route');
    const { consumeStepUp } = await import('@/lib/admin-step-up');
    const result = await POST(makeRequest({ business_id: businessId, ...actions[2] }));
    expect(result.status).toBe(500);
    expect((await result.json()).error).toContain('documents were already updated');
    expect(writes).toEqual(['business_documents', 'verification_requests', 'businesses']);
    writes.length = 0;
    vi.mocked(consumeStepUp).mockRejectedValue(new Error('used'));
    expect((await POST(makeRequest({ business_id: businessId, ...actions[2] }))).status).toBe(403);
    expect(writes).toEqual([]);
  });
  it.each(['https://admin.waaiio.com', 'https://admin-staging.waaiio.com', 'https://untrusted.example'])('CORS boundary for %s on preflight, success and errors', async origin => {
    const { POST, OPTIONS } = await import('@/app/api/verification/review/route');
    const allowed = origin.includes('untrusted') ? '' : origin;
    const preflight = await OPTIONS(new NextRequest('http://localhost/api/verification/review', { method: 'OPTIONS', headers: { Origin: origin } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(allowed);
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    for (const body of [
      { business_id: businessId, ...actions[0], stepUpId },
      { business_id: businessId, ...actions[0], stepUpId: null },
      { business_id: businessId, action: 'invalid' },
    ]) {
      const res = await POST(new NextRequest('http://localhost/api/verification/review', {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }));
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(allowed);
    }
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue(null);
    const denied = await POST(new NextRequest('http://localhost/api/verification/review', {
      method: 'POST', headers: { Origin: origin }, body: '{}',
    }));
    expect(denied.status).toBe(401);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBe(allowed);
    expect(writes.filter(t => t === 'businesses')).toHaveLength(1);
  });
});
