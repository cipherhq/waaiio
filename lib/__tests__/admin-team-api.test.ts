/**
 * AdminTeam API route-level + admin-provision contract tests (#217)
 *
 * Tests the /api/admin/team route handlers directly and the shared
 * admin-provision helpers for deterministic auth, audit, and metadata behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock infrastructure ──

const mockUsers = new Map<string, { id: string; email: string; app_metadata: Record<string, unknown> }>();
let lastAuditInsert: Record<string, unknown> | null = null;
let auditInsertShouldFail = false;

const mockAuthAdmin = {
  getUserById: vi.fn(async (id: string) => {
    const user = mockUsers.get(id);
    if (!user) return { data: null, error: { message: 'User not found' } };
    return { data: { user: { ...user, app_metadata: { ...user.app_metadata } } }, error: null };
  }),
  updateUserById: vi.fn(async (id: string, updates: { app_metadata: Record<string, unknown> }) => {
    const user = mockUsers.get(id);
    if (!user) return { data: null, error: { message: 'User not found' } };
    user.app_metadata = { ...updates.app_metadata };
    return { data: { user: { ...user, app_metadata: { ...user.app_metadata } } }, error: null };
  }),
  listUsers: vi.fn(async () => ({
    data: { users: Array.from(mockUsers.values()).map(u => ({ id: u.id, email: u.email, app_metadata: { ...u.app_metadata } })) },
    error: null,
  })),
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
  if (table === 'profiles') {
    return {
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    };
  }
  return { select: vi.fn().mockReturnValue({ in: vi.fn().mockResolvedValue({ data: [], error: null }) }) };
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

describe('AdminTeam API route tests (#217)', () => {
  beforeEach(() => {
    mockUsers.clear();
    lastAuditInsert = null;
    auditInsertShouldFail = false;
    vi.clearAllMocks();

    mockUsers.set(ADMIN_ID, { id: ADMIN_ID, email: 'admin@test.com', app_metadata: { role: 'admin' } });
    mockUsers.set(TARGET_ID, { id: TARGET_ID, email: 'target@test.com', app_metadata: { provider: 'google' } });

    mockAdminUser = { id: ADMIN_ID, userId: ADMIN_ID, email: 'admin@test.com', role: 'admin' };

    // Re-setup mocks after clearAllMocks
    mockAuthAdmin.getUserById.mockImplementation(async (id: string) => {
      const user = mockUsers.get(id);
      if (!user) return { data: null, error: { message: 'User not found' } };
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
  });

  // ── GET authorization ──

  it('GET: admin allowed', async () => {
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.team).toBeDefined();
  });

  it('GET: support denied', async () => {
    mockAdminUser = { id: ADMIN_ID, userId: ADMIN_ID, email: 'support@test.com', role: 'support' };
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(403);
  });

  it('GET: finance denied', async () => {
    mockAdminUser = { id: ADMIN_ID, userId: ADMIN_ID, email: 'fin@test.com', role: 'finance' };
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(403);
  });

  it('GET: operations denied', async () => {
    mockAdminUser = { id: ADMIN_ID, userId: ADMIN_ID, email: 'ops@test.com', role: 'operations' };
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(403);
  });

  it('GET: unauthenticated denied', async () => {
    mockAdminUser = null;
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(403);
  });

  // ── POST/DELETE non-admin denied ──

  it('POST: support denied', async () => {
    mockAdminUser = { id: ADMIN_ID, userId: ADMIN_ID, email: 's@t.com', role: 'support' };
    const res = await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'support' }));
    expect(res.status).toBe(403);
  });

  it('DELETE: finance denied', async () => {
    mockAdminUser = { id: ADMIN_ID, userId: ADMIN_ID, email: 'f@t.com', role: 'finance' };
    const res = await DELETE(makeRequest('DELETE', { identifier: TARGET_ID }));
    expect(res.status).toBe(403);
  });

  // ── Self-mutation rejected ──

  it('POST: self-promotion rejected', async () => {
    const res = await POST(makeRequest('POST', { identifier: ADMIN_ID, role: 'support' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('your own');
  });

  it('DELETE: self-demotion rejected', async () => {
    const res = await DELETE(makeRequest('DELETE', { identifier: ADMIN_ID }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('your own');
  });

  // ── Invalid role ──

  it('POST: invalid role rejected', async () => {
    const res = await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'superadmin' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Invalid role');
  });

  // ── Grant preserves metadata ──

  it('POST: grant preserves unrelated app_metadata keys', async () => {
    const res = await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'finance' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.user.role).toBe('finance');
    // Verify metadata preserved
    const user = mockUsers.get(TARGET_ID)!;
    expect(user.app_metadata.role).toBe('finance');
    expect(user.app_metadata.provider).toBe('google');
  });

  // ── Revoke removes only role key ──

  it('DELETE: revoke removes only role key, not customer', async () => {
    mockUsers.get(TARGET_ID)!.app_metadata = { role: 'support', provider: 'google' };
    const res = await DELETE(makeRequest('DELETE', { identifier: TARGET_ID }));
    expect(res.status).toBe(200);
    const user = mockUsers.get(TARGET_ID)!;
    expect(user.app_metadata.role).toBeUndefined();
    expect(user.app_metadata).not.toHaveProperty('role');
    expect(user.app_metadata.provider).toBe('google');
  });

  // ── Auth user not found (email) ──

  it('POST: nonexistent email returns AUTH_USER_REQUIRED', async () => {
    const res = await POST(makeRequest('POST', { identifier: 'nobody@nowhere.com', role: 'support' }));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('AUTH_USER_REQUIRED');
  });

  // ── Auth user not found (UUID) ──

  it('POST: nonexistent UUID returns AUTH_USER_REQUIRED', async () => {
    const res = await POST(makeRequest('POST', { identifier: NONEXISTENT_UUID, role: 'support' }));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('AUTH_USER_REQUIRED');
  });

  it('DELETE: nonexistent UUID returns AUTH_USER_REQUIRED', async () => {
    const res = await DELETE(makeRequest('DELETE', { identifier: NONEXISTENT_UUID }));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe('AUTH_USER_REQUIRED');
  });

  // ── List uses app_metadata despite stale profiles.role ──

  it('GET: list derives role from app_metadata, not profiles.role', async () => {
    const res = await GET(makeRequest('GET'));
    const data = await res.json();
    // Only ADMIN_ID has a platform role in app_metadata
    expect(data.team).toHaveLength(1);
    expect(data.team[0].id).toBe(ADMIN_ID);
    expect(data.team[0].role).toBe('admin');
    // TARGET_ID has no role in app_metadata (only provider=google)
    expect(data.team.find((t: any) => t.id === TARGET_ID)).toBeUndefined();
  });

  // ── Audit behavior ──

  it('POST: server-side audit insert is exercised on grant', async () => {
    await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'operations' }));
    expect(lastAuditInsert).not.toBeNull();
    expect(lastAuditInsert!.action).toBe('grant_platform_role');
    expect(lastAuditInsert!.actor_id).toBe(ADMIN_ID);
    expect(lastAuditInsert!.entity_id).toBe(TARGET_ID);
  });

  it('POST: auditRecorded=true when audit succeeds', async () => {
    const res = await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'support' }));
    const data = await res.json();
    expect(data.auditRecorded).toBe(true);
  });

  it('POST: auditRecorded=false when audit fails (partial failure visible)', async () => {
    auditInsertShouldFail = true;
    const res = await POST(makeRequest('POST', { identifier: TARGET_ID, role: 'support' }));
    const data = await res.json();
    expect(data.success).toBe(true); // role mutation succeeded
    expect(data.auditRecorded).toBe(false); // but audit failed — visible to caller
  });

  // ── AuthUserNotFoundError contract ──

  it('AuthUserNotFoundError has deterministic code property', () => {
    const err = new AuthUserNotFoundError('test@test.com');
    expect(err.code).toBe('AUTH_USER_NOT_FOUND');
    expect(err.name).toBe('AuthUserNotFoundError');
    expect(err instanceof Error).toBe(true);
  });
});
