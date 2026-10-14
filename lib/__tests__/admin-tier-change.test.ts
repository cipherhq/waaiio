/**
 * Admin tier-change route tests.
 *
 * Tests for POST /api/admin/businesses/[id]/tier:
 * 1. Non-admin gets 403
 * 2. Admin with non-full-admin role (e.g. support) gets 403
 * 3. Invalid tier gets 400
 * 4. Unknown business gets 404
 * 5. Valid change updates both businesses and subscriptions, writes audit
 * 6. Subscriptions update failure rolls back businesses update
 * 7. Invalid UUID gets 400
 * 8. Same-tier no-op returns the tier without writes
 * 9. Rollback also fails → 500, Sentry.captureException and logger.error called
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

const mockSentryCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockSentryCaptureException(...args),
}));

const mockLoggerError = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));

// Track per-table update calls and their responses
const bizUpdateResponse = { error: null as { message: string } | null };
const subUpdateResponse = { error: null as { message: string } | null };
const bizRollbackResponse = { error: null as { message: string } | null };

let bizSelectData: { id: string; name: string; subscription_tier: string } | null = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Test Biz',
  subscription_tier: 'free',
};

// Track calls for assertions
const updateCalls: Array<{ table: string; data: Record<string, unknown>; id: string }> = [];

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, _val: string) => ({
          single: () => Promise.resolve({
            data: table === 'businesses' ? bizSelectData : null,
            error: bizSelectData ? null : { message: 'not found' },
          }),
        }),
      }),
      update: (data: Record<string, unknown>) => ({
        eq: (_col: string, val: string) => {
          updateCalls.push({ table, data, id: val });
          if (table === 'businesses') {
            // Check if this is a rollback (restoring previous tier)
            if (updateCalls.filter(c => c.table === 'businesses').length > 1) {
              return Promise.resolve(bizRollbackResponse);
            }
            return Promise.resolve({ error: bizUpdateResponse.error });
          }
          return Promise.resolve({ error: subUpdateResponse.error });
        },
      }),
    }),
  }),
}));

function makeRequest(bizId: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/admin/businesses/${bizId}/tier`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
  });
}

const VALID_BIZ_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('Admin tier-change route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateCalls.length = 0;
    bizUpdateResponse.error = null;
    subUpdateResponse.error = null;
    bizRollbackResponse.error = null;
    bizSelectData = {
      id: VALID_BIZ_ID,
      name: 'Test Biz',
      subscription_tier: 'free',
    };
  });

  it('1. non-admin gets 403', async () => {
    mockRequirePlatformAdmin.mockResolvedValue(null);

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, { tier: 'growth' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );

    expect(res.status).toBe(403);
    expect(updateCalls).toHaveLength(0);
    expect(mockLogAdminAudit).not.toHaveBeenCalled();
  });

  it('2. support role (not full-admin) gets 403', async () => {
    // requirePlatformAdmin with requiredRole: 'admin' should reject 'support'
    mockRequirePlatformAdmin.mockResolvedValue(null);

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, { tier: 'growth' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );

    expect(res.status).toBe(403);
    // Verify the route requested 'admin' role specifically
    expect(mockRequirePlatformAdmin).toHaveBeenCalledWith(
      expect.anything(),
      { requiredRole: 'admin' },
    );
  });

  it('3. invalid tier gets 400', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
      role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
    });

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, { tier: 'enterprise' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Invalid tier');
    expect(updateCalls).toHaveLength(0);
  });

  it('4. unknown business gets 404', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
      role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
    });
    bizSelectData = null;

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, { tier: 'growth' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );

    expect(res.status).toBe(404);
    expect(updateCalls).toHaveLength(0);
  });

  it('5. valid change updates both records and writes audit', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
      role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
    });

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, { tier: 'business' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tier).toBe('business');

    // businesses.subscription_tier was updated
    expect(updateCalls[0]).toEqual({
      table: 'businesses',
      data: { subscription_tier: 'business' },
      id: VALID_BIZ_ID,
    });

    // subscriptions.tier was updated
    expect(updateCalls[1]).toEqual({
      table: 'subscriptions',
      data: { tier: 'business' },
      id: VALID_BIZ_ID,
    });

    // Audit was logged
    expect(mockLogAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        action: 'change_subscription_tier',
        entityType: 'business',
        entityId: VALID_BIZ_ID,
        details: {
          previous_tier: 'free',
          new_tier: 'business',
          business_name: 'Test Biz',
        },
      }),
    );
  });

  it('6. subscriptions update failure rolls back businesses and returns error', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
      role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
    });
    subUpdateResponse.error = { message: 'constraint violation' };

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, { tier: 'growth' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );

    expect(res.status).toBe(500);

    // Should have 3 calls: biz update, sub update (failed), biz rollback
    expect(updateCalls).toHaveLength(3);

    // Third call is the rollback — restoring previous tier
    expect(updateCalls[2]).toEqual({
      table: 'businesses',
      data: { subscription_tier: 'free' },
      id: VALID_BIZ_ID,
    });

    // No audit logged on failure
    expect(mockLogAdminAudit).not.toHaveBeenCalled();
  });

  it('7. invalid UUID gets 400', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
      role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
    });

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest('not-a-uuid', { tier: 'growth' }),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Invalid business ID');
  });

  it('8. same-tier no-op returns tier without writes', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
      role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
    });

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, { tier: 'free' }), // same as current
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tier).toBe('free');
    expect(updateCalls).toHaveLength(0);
    expect(mockLogAdminAudit).not.toHaveBeenCalled();
  });

  it('9. rollback also fails → 500, Sentry and logger capture the error', async () => {
    mockRequirePlatformAdmin.mockResolvedValue({
      id: 'admin-1', userId: 'admin-1', email: 'admin@test.com',
      role: 'admin', aal: 'aal2', bearerToken: 'test-bearer',
    });
    subUpdateResponse.error = { message: 'constraint violation' };
    bizRollbackResponse.error = { message: 'connection lost' };

    const { POST } = await import('@/app/api/admin/businesses/[id]/tier/route');
    const res = await POST(
      makeRequest(VALID_BIZ_ID, { tier: 'growth' }),
      { params: Promise.resolve({ id: VALID_BIZ_ID }) },
    );

    expect(res.status).toBe(500);

    // Sentry captured the rollback failure
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Tier rollback failed') }),
      expect.objectContaining({
        tags: { component: 'admin-tier-change', operation: 'rollback' },
        extra: { businessId: VALID_BIZ_ID, previousTier: 'free', attemptedTier: 'growth' },
      }),
    );

    // logger.error was called with business context
    expect(mockLoggerError).toHaveBeenCalledWith(
      '[ADMIN-TIER] Rollback failed:',
      expect.objectContaining({
        businessId: VALID_BIZ_ID,
        previousTier: 'free',
        attemptedTier: 'growth',
        rollbackError: 'connection lost',
      }),
    );

    // No audit logged on failure
    expect(mockLogAdminAudit).not.toHaveBeenCalled();
  });
});
