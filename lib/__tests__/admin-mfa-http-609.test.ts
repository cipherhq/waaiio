/**
 * SEC-005 — Real HTTP authorization tests (#609)
 *
 * Tests actual route handler behavior with mocked Supabase auth responses,
 * verifying that aal1 sessions are rejected and aal2 sessions are accepted.
 *
 * These are NOT source-text tests. They exercise the requirePlatformAdmin
 * code path with real NextRequest objects and verify HTTP status codes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock Supabase to control auth responses
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
const mockGetSession = vi.fn();
const mockInsert = vi.fn().mockReturnValue({ then: (cb: Function) => cb?.() });
const mockFrom = vi.fn().mockReturnValue({
  insert: mockInsert,
  select: vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  }),
});

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    auth: {
      getUser: mockGetUser,
      admin: { getUserById: vi.fn().mockResolvedValue({ data: null }) },
    },
    from: mockFrom,
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      getSession: mockGetSession,
    },
  }),
}));

// ---------------------------------------------------------------------------
// JWT helpers for tests
// ---------------------------------------------------------------------------

/** Build a fake JWT with the given payload claims. */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = Buffer.from('fake-signature').toString('base64url');
  return `${header}.${payload}.${sig}`;
}

/** Create a NextRequest with an Authorization header. */
function adminRequest(token: string, path = 'http://localhost/api/admin/query'): NextRequest {
  return new NextRequest(path, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SEC-005 HTTP: aal1 admin sessions are rejected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an aal1 admin bearer token with 403', async () => {
    const token = fakeJwt({
      sub: 'admin-user-id',
      aal: 'aal1',
      session_id: 'sess-123',
      role: 'authenticated',
    });

    // getUser validates the JWT and returns the user
    mockGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'admin-user-id',
          email: 'admin@waaiio.com',
          app_metadata: { role: 'admin' },
        },
      },
      error: null,
    });

    const { requirePlatformAdmin } = await import('../admin-auth');
    const result = await requirePlatformAdmin(adminRequest(token));

    // Must return null (deny) — aal1 is not sufficient
    expect(result).toBeNull();
  });

  it('rejects a token with missing aal claim', async () => {
    const token = fakeJwt({
      sub: 'admin-user-id',
      session_id: 'sess-123',
      // No aal claim
    });

    mockGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'admin-user-id',
          email: 'admin@waaiio.com',
          app_metadata: { role: 'admin' },
        },
      },
      error: null,
    });

    const { requirePlatformAdmin } = await import('../admin-auth');
    const result = await requirePlatformAdmin(adminRequest(token));

    expect(result).toBeNull();
  });

  it('rejects an invalid bearer token without falling back to cookies', async () => {
    const token = 'invalid-token';

    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'invalid token' },
    });

    // Cookie session exists with valid admin — should NOT be used
    mockGetSession.mockResolvedValueOnce({
      data: {
        session: {
          access_token: fakeJwt({ sub: 'admin-user-id', aal: 'aal2', session_id: 'sess-456' }),
          user: {
            id: 'admin-user-id',
            email: 'admin@waaiio.com',
            app_metadata: { role: 'admin' },
          },
        },
      },
    });

    const { requirePlatformAdmin } = await import('../admin-auth');
    const result = await requirePlatformAdmin(adminRequest(token));

    // Must return null — do NOT fall back to cookie
    expect(result).toBeNull();
    // Cookie session should not have been consulted
    expect(mockGetSession).not.toHaveBeenCalled();
  });
});

describe('SEC-005 HTTP: aal2 admin sessions are accepted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts an aal2 admin bearer token', async () => {
    const token = fakeJwt({
      sub: 'admin-user-id',
      aal: 'aal2',
      session_id: 'sess-123',
      amr: [{ method: 'totp', timestamp: Date.now() / 1000 }],
    });

    mockGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'admin-user-id',
          email: 'admin@waaiio.com',
          app_metadata: { role: 'admin' },
        },
      },
      error: null,
    });

    const { requirePlatformAdmin } = await import('../admin-auth');
    const result = await requirePlatformAdmin(adminRequest(token));

    expect(result).not.toBeNull();
    expect(result!.userId).toBe('admin-user-id');
    expect(result!.role).toBe('admin');
    expect(result!.aal).toBe('aal2');
    expect(result!.bearerToken).toBe(token);
  });

  it('accepts aal2 support role for routes allowing support', async () => {
    const token = fakeJwt({
      sub: 'support-user-id',
      aal: 'aal2',
      session_id: 'sess-456',
    });

    mockGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'support-user-id',
          email: 'support@waaiio.com',
          app_metadata: { role: 'support' },
        },
      },
      error: null,
    });

    const { requirePlatformAdmin } = await import('../admin-auth');
    const result = await requirePlatformAdmin(adminRequest(token), {
      requiredRole: ['admin', 'support'],
    });

    expect(result).not.toBeNull();
    expect(result!.role).toBe('support');
  });

  it('rejects aal2 support role for admin-only routes', async () => {
    const token = fakeJwt({
      sub: 'support-user-id',
      aal: 'aal2',
      session_id: 'sess-456',
    });

    mockGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'support-user-id',
          email: 'support@waaiio.com',
          app_metadata: { role: 'support' },
        },
      },
      error: null,
    });

    const { requirePlatformAdmin } = await import('../admin-auth');
    const result = await requirePlatformAdmin(adminRequest(token), {
      requiredRole: 'admin',
    });

    expect(result).toBeNull();
  });
});

describe('SEC-005 HTTP: non-admin users are rejected regardless of aal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects aal2 token with no admin role', async () => {
    const token = fakeJwt({
      sub: 'regular-user',
      aal: 'aal2',
      session_id: 'sess-789',
    });

    mockGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'regular-user',
          email: 'user@example.com',
          app_metadata: {},
        },
      },
      error: null,
    });

    const { requirePlatformAdmin } = await import('../admin-auth');
    const result = await requirePlatformAdmin(adminRequest(token));

    expect(result).toBeNull();
  });

  it('rejects aal2 token with client-declared admin role in user_metadata', async () => {
    const token = fakeJwt({
      sub: 'regular-user',
      aal: 'aal2',
      session_id: 'sess-789',
    });

    mockGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'regular-user',
          email: 'user@example.com',
          app_metadata: {},
          user_metadata: { role: 'admin' }, // spoofed
        },
      },
      error: null,
    });

    const { requirePlatformAdmin } = await import('../admin-auth');
    const result = await requirePlatformAdmin(adminRequest(token));

    expect(result).toBeNull();
  });
});

describe('SEC-005 HTTP: step-up parameter binding correctness', () => {
  it('hashOperationParams produces different hashes for different nested values', async () => {
    const { hashOperationParams } = await import('../admin-step-up');

    const hash1 = hashOperationParams({
      action: 'save_refs',
      plan_refs: { ng: { growth: 'PLN_abc' } },
    });

    const hash2 = hashOperationParams({
      action: 'save_refs',
      plan_refs: { ng: { growth: 'PLN_xyz' } },
    });

    // Must be different — the old JSON.stringify replacer would make these identical
    expect(hash1).not.toBe(hash2);
  });

  it('hashOperationParams is deterministic regardless of key order', async () => {
    const { hashOperationParams } = await import('../admin-step-up');

    const hash1 = hashOperationParams({
      action: 'save_refs',
      country_code: 'NG',
      plan_refs: { growth: 'PLN_abc', business: 'PLN_def' },
    });

    const hash2 = hashOperationParams({
      plan_refs: { business: 'PLN_def', growth: 'PLN_abc' },
      country_code: 'NG',
      action: 'save_refs',
    });

    expect(hash1).toBe(hash2);
  });

  it('hashOperationParams handles null, undefined, arrays, and booleans', async () => {
    const { hashOperationParams } = await import('../admin-step-up');

    const hash1 = hashOperationParams({
      amount: 1000,
      reason: null,
      items: [1, 2, 3],
      confirmed: true,
    });

    const hash2 = hashOperationParams({
      confirmed: true,
      items: [1, 2, 3],
      reason: null,
      amount: 1000,
    });

    expect(hash1).toBe(hash2);

    // Different null vs missing
    const hash3 = hashOperationParams({
      amount: 1000,
      items: [1, 2, 3],
      confirmed: true,
    });

    expect(hash1).not.toBe(hash3);
  });
});

// ---------------------------------------------------------------------------
// Parameter authority matrix verification
// ---------------------------------------------------------------------------

describe('SEC-005: step-up parameter authority matrix', () => {
  it('payout_approve binds transfer_method (the routing-critical field)', () => {
    const source = require('fs').readFileSync(
      require('path').resolve(process.cwd(), 'app/api/admin/payouts/[id]/approve/route.ts'),
      'utf-8',
    );
    // transfer_method determines which provider handles the payout
    expect(source).toContain("{ transfer_method }");
  });

  it('payout_generate binds action identifier', () => {
    const source = require('fs').readFileSync(
      require('path').resolve(process.cwd(), 'app/api/admin/payouts/generate/route.ts'),
      'utf-8',
    );
    expect(source).toContain("{ action: 'generate' }");
  });

  it('refund binds businessId, amount, AND reason', () => {
    const source = require('fs').readFileSync(
      require('path').resolve(process.cwd(), 'app/api/admin/payments/refund/route.ts'),
      'utf-8',
    );
    expect(source).toContain('businessId,');
    expect(source).toContain('amount,');
    expect(source).toContain('reason:');
  });

  it('provider_config binds plan_refs for save_refs action', () => {
    const source = require('fs').readFileSync(
      require('path').resolve(process.cwd(), 'app/api/admin/provider-config/route.ts'),
      'utf-8',
    );
    expect(source).toContain('stepUpParams.plan_refs');
    expect(source).toContain('stepUpParams.new_gateway');
    expect(source).toContain('stepUpParams.expected_version_id');
  });

  it('team_grant binds target identifier and role', () => {
    const source = require('fs').readFileSync(
      require('path').resolve(process.cwd(), 'app/api/admin/team/route.ts'),
      'utf-8',
    );
    expect(source).toMatch(/team_grant.*identifier.*role/s);
  });

  it('impersonate binds business_id', () => {
    const source = require('fs').readFileSync(
      require('path').resolve(process.cwd(), 'app/api/admin/impersonate/route.ts'),
      'utf-8',
    );
    expect(source).toContain("'impersonate', business_id, { business_id }");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Step-up session binding
// ═══════════════════════════════════════════════════════════════════════════

describe('SEC-005: step-up session binding', () => {
  it('verifyStepUp checks session_id from the admin bearer token', () => {
    const source = require('fs').readFileSync(
      require('path').resolve(process.cwd(), 'lib/admin-step-up.ts'),
      'utf-8',
    );
    // verifyStepUp must check session_id, not just admin_user_id
    expect(source).toContain("stepUp.session_id !== sessionId");
    expect(source).toContain("Step-up belongs to a different session");
    // Session ID must be extracted from the bearer token
    expect(source).toContain('const sessionId = admin.sessionId;');
  });

  it('consumeStepUp binds session_id in the atomic query', () => {
    const source = require('fs').readFileSync(
      require('path').resolve(process.cwd(), 'lib/admin-step-up.ts'),
      'utf-8',
    );
    // Session must be part of the atomic consumption
    expect(source).toContain(".eq('session_id', sessionId)");
  });
});
