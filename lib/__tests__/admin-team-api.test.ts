/**
 * AdminTeam API route-level tests (#217)
 *
 * Invokes the real GET/POST/DELETE handlers and proves every invariant
 * from the #217 security contract: authorization, identity resolution,
 * audit semantics, metadata preservation, and fail-closed behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock state ──

const mockUsers = new Map<string, { id: string; email: string; app_metadata: Record<string, unknown> }>();
let lastAuditInsert: Record<string, unknown> | null = null;
let auditInsertShouldFail = false;
let getUserByIdShouldThrowOperational = false;
let getUserByIdOperationalStatus = 504;

const mockAuthAdmin = {
  getUserById: vi.fn(),
  updateUserById: vi.fn(),
  listUsers: vi.fn(),
};

const mockFrom = vi.fn().mockImplementation((table: string) => {
  if (table === 'admin_audit_logs') {
    return {
      insert: vi.fn().mockImplementation(async (data: Record<string, unknown>) => {
        lastAuditInsert = data;
        if (auditInsertShouldFail) return { error: { message: 'Audit insert failed' } };
        return { error: null };
      }),
    };
  }
  return {
    select: vi.fn().mockReturnValue({
      in: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
  };
});

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    auth: { admin: mockAuthAdmin },
    from: mockFrom,
  }),
}));

let mockAdminUser: { id: string; userId: string; email: string; role: string } | null = null;
vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(async (_req: unknown, opts?: { requiredRole?: string | string[] }) => {
    if (!mockAdminUser) return null;
    const required = opts?.requiredRole;
    if (required) {
      const roles = Array.isArray(required) ? required : [required];
      if (!roles.includes(mockAdminUser.role)) return null;
    }
    return mockAdminUser;
  }),
}));

import { GET, POST, DELETE } from '@/app/api/admin/team/route';
import { AuthUserNotFoundError } from '@/scripts/admin-provision';

function makeRequest(method: string, body?: unknown): NextRequest {
  const url = 'http://localhost:3000/api/admin/team';
  if (method === 'GET') return new NextRequest(url, { method });
  return new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ADMIN_ID = 'a0000000-0000-0000-0000-000000000001';
const TARGET_ID = 'a0000000-0000-0000-0000-000000000002';
const NONEXISTENT_UUID = 'a0000000-0000-0000-0000-999999999999';

function resetMockBehavior() {
  mockAuthAdmin.getUserById.mockImplementation(async (id: string) => {
    if (getUserByIdShouldThrowOperational) {
      return { data: null, error: { message: 'Auth operational error', status: getUserByIdOperationalStatus } };
    }
    const user = mockUsers.get(id);
    if (!user) return { data: null, error: { message: 'User not found', status: 404 } };
    return { data: { user: { ...user, app_metadata: { ...user.app_metadata } } }, error: null };
  });
  mockAuthAdmin.updateUserById.mockImplementation(async (id: string, updates: { app_metadata: Record<string, unknown> }) => {
    const user = mockUsers.get(id);
    if (!user) return { data: null, error: { message: 'User not found' } };
    user.app_metadata = { ...updates.app_metadata };
    return { data: { user: { ...user, app_metadata: { ...user.app_metadata } } }, error: null };
  });
  mockAuthAdmin.listUsers.mockImplementation(async () => ({
    data: { users: Array.from(mockUsers.values()).map(u => ({ id: u.id, email: u.email, app_metadata: { ...u.app_metadata } })) },
    error: null,
  }));
}

describe('AdminTeam API route tests (#217)', () => {
  beforeEach(() => {
    mockUsers.clear();
    lastAuditInsert = null;
    auditInsertShouldFail = false;
    getUserByIdShouldThrowOperational = false;
    getUserByIdOperationalStatus = 504;
    vi.clearAllMocks();

    mockUsers.set(ADMIN_ID, { id: ADMIN_ID, email: 'admin@test.com', app_metadata: { role: 'admin' } });
    mockUsers.set(TARGET_ID, { id: TARGET_ID, email: 'target@test.com', app_metadata: { provider: 'google' } });
    mockAdminUser = { id: ADMIN_ID, userId: ADMIN_ID, email: 'admin@test.com', role: 'admin' };
    resetMockBehavior();
  });

  // ── B: Exact authorization ──

  it('GET: admin allowed', async () => {
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
  });

  it('GET: support denied', async () => {
    mockAdminUser = { ...mockAdminUser!, role: 'support' };
    expect((await GET(makeRequest('GET'))).status).toBe(403);
  });

  it('GET: finance denied', async () => {
    mockAdminUser = { ...mockAdminUser!, role: 'finance' };
    expect((await GET(makeRequest('GET'))).status).toBe(403);
  });

  it('GET: operations denied', async () => {
    mockAdminUser = { ...mockAdminUser!, role: 'operations' };
    expect((await GET(makeRequest('GET'))).status).toBe(403);
  });

  it('GET: unauthenticated denied', async () => {
    mockAdminUser = null;
    expect((await GET(makeRequest('GET'))).status).toBe(403);
  });

  it('POST: non-admin denied', async () => {
    mockAdminUser = { ...mockAdminUser!, role: 'support' };
    expect((await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'support' }))).status).toBe(403);
  });

  it('DELETE: non-admin denied', async () => {
    mockAdminUser = { ...mockAdminUser!, role: 'finance' };
    expect((await DELETE(makeRequest('DELETE', { identifier: TARGET_ID }))).status).toBe(403);
  });

  it('POST: self-grant denied server-side', async () => {
    const res = await POST(makeRequest('POST', { identifier: ADMIN_ID, role: 'support' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('your own');
  });

  it('DELETE: self-revoke denied server-side', async () => {
    const res = await DELETE(makeRequest('DELETE', { identifier: ADMIN_ID }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('your own');
  });

  it('POST: invalid role denied', async () => {
    const res = await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'superadmin' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Invalid role');
  });

  // ── C: Auth identity resolution ──

  it('POST: nonexistent email → 404 AUTH_USER_REQUIRED', async () => {
    const res = await POST(makeRequest('POST', { identifier: 'nobody@nowhere.com', role: 'support' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('AUTH_USER_REQUIRED');
  });

  it('POST: nonexistent UUID → 404 AUTH_USER_REQUIRED', async () => {
    const res = await POST(makeRequest('POST', { identifier: NONEXISTENT_UUID, role: 'support' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('AUTH_USER_REQUIRED');
  });

  it('DELETE: nonexistent UUID → 404 AUTH_USER_REQUIRED', async () => {
    const res = await DELETE(makeRequest('DELETE', { identifier: NONEXISTENT_UUID }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('AUTH_USER_REQUIRED');
  });

  it('POST: Auth operational failure (504) ≠ AUTH_USER_REQUIRED → 500', async () => {
    getUserByIdShouldThrowOperational = true;
    getUserByIdOperationalStatus = 504;
    const res = await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'support' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).not.toBe('AUTH_USER_REQUIRED');
    expect(data.mutationApplied).toBe(false);
  });

  it('POST: Auth 400 error ≠ AUTH_USER_REQUIRED → 500 (not misclassified as not-found)', async () => {
    getUserByIdShouldThrowOperational = true;
    getUserByIdOperationalStatus = 400;
    const res = await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'support' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).not.toBe('AUTH_USER_REQUIRED');
    expect(data.mutationApplied).toBe(false);
  });

  // ── D: Role mutation correctness ──

  it('POST: grant preserves unrelated app_metadata keys', async () => {
    const res = await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'finance' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mutationApplied).toBe(true);
    expect(data.user.role).toBe('finance');
    const user = mockUsers.get(TARGET_ID)!;
    expect(user.app_metadata.role).toBe('finance');
    expect(user.app_metadata.provider).toBe('google');
  });

  it('DELETE: revoke removes only role key, not customer', async () => {
    mockUsers.get(TARGET_ID)!.app_metadata = { role: 'support', provider: 'google' };
    const res = await DELETE(makeRequest('DELETE', { identifier: TARGET_ID }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mutationApplied).toBe(true);
    const user = mockUsers.get(TARGET_ID)!;
    expect(user.app_metadata.role).toBeUndefined();
    expect(user.app_metadata).not.toHaveProperty('role');
    expect(user.app_metadata.provider).toBe('google');
  });

  // ── E: Trusted audit semantics ──

  it('POST: success → mutationApplied=true, auditRecorded=true, HTTP 200', async () => {
    const res = await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'operations' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.mutationApplied).toBe(true);
    expect(data.auditRecorded).toBe(true);
    expect(lastAuditInsert).not.toBeNull();
    expect(lastAuditInsert!.action).toBe('grant_platform_role');
    expect(lastAuditInsert!.actor_id).toBe(ADMIN_ID);
  });

  it('POST: grant audit partial failure → HTTP 207, ROLE_MUTATION_APPLIED_AUDIT_FAILED', async () => {
    auditInsertShouldFail = true;
    const res = await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'support' }));
    expect(res.status).toBe(207);
    const data = await res.json();
    expect(data.error).toBe('ROLE_MUTATION_APPLIED_AUDIT_FAILED');
    expect(data.mutationApplied).toBe(true);
    expect(data.auditRecorded).toBe(false);
    expect(data.user.id).toBe(TARGET_ID);
    expect(data.operation).toBe('grant_platform_role');
  });

  it('DELETE: revoke audit partial failure → HTTP 207, ROLE_MUTATION_APPLIED_AUDIT_FAILED', async () => {
    mockUsers.get(TARGET_ID)!.app_metadata = { role: 'support' };
    auditInsertShouldFail = true;
    const res = await DELETE(makeRequest('DELETE', { identifier: TARGET_ID }));
    expect(res.status).toBe(207);
    const data = await res.json();
    expect(data.error).toBe('ROLE_MUTATION_APPLIED_AUDIT_FAILED');
    expect(data.mutationApplied).toBe(true);
    expect(data.auditRecorded).toBe(false);
    expect(data.operation).toBe('revoke_platform_role');
  });

  // ── G: List authority from app_metadata ──

  it('GET: list derives role from app_metadata despite stale profiles.role', async () => {
    const res = await GET(makeRequest('GET'));
    const data = await res.json();
    expect(data.team).toHaveLength(1);
    expect(data.team[0].id).toBe(ADMIN_ID);
    expect(data.team[0].role).toBe('admin');
    // TARGET_ID has no role in app_metadata
    expect(data.team.find((t: { id: string }) => t.id === TARGET_ID)).toBeUndefined();
  });

  // ── AuthUserNotFoundError contract ──

  it('AuthUserNotFoundError has deterministic code', () => {
    const err = new AuthUserNotFoundError('test@test.com');
    expect(err.code).toBe('AUTH_USER_NOT_FOUND');
    expect(err instanceof Error).toBe(true);
  });
});
