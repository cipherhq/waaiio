/**
 * Admin tier-change route tests.
 *
 * POST /api/admin/businesses/[id]/tier:
 * 1. Non-admin gets 403
 * 2. Support role (not full-admin) gets 403
 * 3. Invalid tier gets 400
 * 4. Unknown business gets 404
 * 5. Valid change updates businesses.subscription_tier only — never writes subscriptions
 * 6. Paying business: response has paidPlan and revertsOn; audit includes them
 * 7. Non-paying business: paidPlan null, revertsOn null
 * 8. Invalid UUID gets 400
 * 9. Same-tier no-op returns tier without writes
 *
 * GET /api/admin/businesses/[id]/tier:
 * 10. Non-admin gets 403
 * 11. Invalid UUID gets 400
 * 12. Unknown business gets 404
 * 13. Returns { tier, paidPlan, revertsOn } shape
 * 14. Returns 500 when subscriptions read errors
 *
 * Subscription read error handling:
 * 15. POST returns 500 when subscriptions read errors — no write, no audit
 *
 * Column evidence (migration file:line):
 * - businesses.subscription_tier: 002_multi_industry.sql:38
 * - subscriptions.status: 001_initial_schema.sql:273
 * - subscriptions.plan: 001_initial_schema.sql:272
 * - subscriptions.current_period_end: 001_initial_schema.sql:278
 * - subscriptions.business_id: 002_multi_industry.sql:103 (renamed from restaurant_id)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──

const mockRequirePlatformAdmin = vi.fn();
vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: (...args: unknown[]) => mockRequirePlatformAdmin(...args),
}));

const mockLogAdminAudit = vi.fn().mockResolvedValue({});
vi.mock('@/lib/admin-audit', () => ({
  logAdminAudit: (...args: unknown[]) => mockLogAdminAudit(...args),
}));

// ── Service client mock ──

let bizSelectData: { id: string; name: string; subscription_tier: string } | null = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Test Biz',
  subscription_tier: 'free',
};

let subSelectData: { status: string; plan: string; current_period_end: string } | null = null;
let subSelectError: { message: string } | null = null;

const updateCalls: Array<{ table: string; data: Record<string, unknown>; id: string }> = [];
const bizUpdateResponse = { error: null as { message: string } | null };

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, _val: string) => ({
          single: () => Promise.resolve({
            data: table === 'businesses' ? bizSelectData : null,
            error: bizSelectData ? null : { message: 'not found' },
          }),
          maybeSingle: () => Promise.resolve({
            data: table === 'subscriptions' ? subSelectData : null,
            error: table === 'subscriptions' ? subSelectError : null,
          }),
        }),
      }),
      update: (data: Record<string, unknown>) => ({
        eq: (_col: string, val: string) => {
          updateCalls.push({ table, data, id: val });
          if (table === 'businesses') {
            return Promise.resolve({ error: bizUpdateResponse.error });
          }
          // subscriptions.update should NEVER be called
          return Promise.resolve({ error: { message: 'unexpected subscriptions write' } });
        },
      }),
    }),
  }),
}));

function makeRequest(bizId: string, method: string, body?: Record<string, unknown>): NextRequest {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(`http://localhost/api/admin/businesses/${bizId}/tier`, init);
}

const VALID_BIZ_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ADMIN = {
  id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
  role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
};

describe('Admin tier-change route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateCalls.length = 0;
    bizUpdateResponse.error = null;
    bizSelectData = { id: VALID_BIZ_ID, name: 'Test Biz', subscription_tier: 'free' };
    subSelectData = null;
    subSelectError = null;
  });

  // ── POST tests ──

  it('1. non-admin gets 403', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(null);
    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, 'POST', { tier: 'growth' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(403);
    expect(updateCalls).toHaveLength(0);
  });

  it('2. support role (not full-admin) gets 403', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(null);
    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, 'POST', { tier: 'growth' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(403);
    expect(mockRequirePlatformAdmin).toHaveBeenCalledWith(
      expect.anything(),
      { requiredRole: 'admin' },
    );
  });

  it('3. invalid tier gets 400', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, 'POST', { tier: 'enterprise' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(400);
    expect(updateCalls).toHaveLength(0);
  });

  it('4. unknown business gets 404', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    bizSelectData = null;
    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, 'POST', { tier: 'growth' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(404);
    expect(updateCalls).toHaveLength(0);
  });

  it('5. valid change updates only businesses.subscription_tier — never writes subscriptions', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, 'POST', { tier: 'business' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tier).toBe('business');

    // Only one update call, and it's to businesses
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toEqual({
      table: 'businesses',
      data: { subscription_tier: 'business' },
      id: VALID_BIZ_ID,
    });

    // Never wrote to subscriptions
    expect(updateCalls.filter(c => c.table === 'subscriptions')).toHaveLength(0);

    // Audit was logged
    expect(mockLogAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        action: 'change_subscription_tier',
        entityType: 'business',
        entityId: VALID_BIZ_ID,
      }),
    );
  });

  it('6. paying business: response has paidPlan and revertsOn; audit includes them', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    subSelectData = { status: 'active', plan: 'growth', current_period_end: '2026-11-14T00:00:00Z' };

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, 'POST', { tier: 'business' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.paidPlan).toBe('growth');
    expect(json.revertsOn).toBe('2026-11-14T00:00:00Z');

    // Audit includes paid_plan and reverts_on
    expect(mockLogAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          paid_plan: 'growth',
          reverts_on: '2026-11-14T00:00:00Z',
        }),
      }),
    );
  });

  it('7. non-paying business: paidPlan null, revertsOn null', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    subSelectData = { status: 'trial', plan: 'free', current_period_end: '2026-11-14T00:00:00Z' };

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, 'POST', { tier: 'growth' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.paidPlan).toBeNull();
    expect(json.revertsOn).toBeNull();
  });

  it('8. invalid UUID gets 400', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest('not-a-uuid', 'POST', { tier: 'growth' }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );
    expect(res.status).toBe(400);
  });

  it('9. same-tier no-op returns tier without writes', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, 'POST', { tier: 'free' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(200);
    expect(updateCalls).toHaveLength(0);
    expect(mockLogAdminAudit).not.toHaveBeenCalled();
  });

  // ── GET tests ──

  it('10. GET: non-admin gets 403', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(null);
    const { GET } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await GET(
      makeRequest(VALID_BIZ_ID, 'GET'),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(403);
  });

  it('11. GET: invalid UUID gets 400', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    const { GET } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await GET(
      makeRequest('not-a-uuid', 'GET'),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );
    expect(res.status).toBe(400);
  });

  it('12. GET: unknown business gets 404', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    bizSelectData = null;
    const { GET } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await GET(
      makeRequest(VALID_BIZ_ID, 'GET'),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(404);
  });

  it('13. GET: returns { tier, paidPlan, revertsOn } shape', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    subSelectData = { status: 'active', plan: 'business', current_period_end: '2026-12-01T00:00:00Z' };

    const { GET } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await GET(
      makeRequest(VALID_BIZ_ID, 'GET'),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      tier: 'free',
      paidPlan: 'business',
      revertsOn: '2026-12-01T00:00:00Z',
    });
  });

  it('14. GET: returns 500 when subscriptions read errors', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    subSelectError = { message: 'connection refused' };

    const { GET } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await GET(
      makeRequest(VALID_BIZ_ID, 'GET'),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Could not check subscription status');
  });

  it('15. POST: returns 500 when subscriptions read errors — no write, no audit', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(ADMIN);
    subSelectError = { message: 'connection refused' };

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, 'POST', { tier: 'growth' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Could not check subscription status');

    // No write to businesses
    expect(updateCalls).toHaveLength(0);

    // No audit logged
    expect(mockLogAdminAudit).not.toHaveBeenCalled();
  });
});
