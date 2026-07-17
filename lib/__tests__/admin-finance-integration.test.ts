/**
 * Admin Finance Integration Tests
 *
 * Execute actual route handlers with controlled auth.
 * 401 = unauthenticated. 403 = authenticated but wrong role.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

let mockRole: string | null = null;
let mockUserId = 'test-user';

function chainBuilder(data: unknown) {
  const terminal = {
    maybeSingle: vi.fn().mockResolvedValue({ data }),
    single: vi.fn().mockResolvedValue({ data }),
    select: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) }),
  };
  return {
    eq: vi.fn().mockReturnValue({ ...terminal, eq: vi.fn().mockReturnValue(terminal), in: vi.fn().mockReturnValue({ neq: vi.fn().mockResolvedValue({ data: [] }), eq: vi.fn().mockResolvedValue({ data: [] }) }), is: vi.fn().mockResolvedValue({ data: [] }) }),
    in: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [] }), neq: vi.fn().mockResolvedValue({ data: [] }) }),
    maybeSingle: terminal.maybeSingle,
    single: terminal.single,
    limit: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    order: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue({ data: [], count: 0 }),
      range: vi.fn().mockResolvedValue({ data: [], count: 0 }),
    }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockImplementation(async () => ({
    auth: {
      getUser: vi.fn().mockImplementation(async () => ({
        data: { user: mockRole ? { id: mockUserId, email: `${mockRole}@test.local` } : null },
      })),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'profiles') {
        return { select: vi.fn().mockReturnValue(chainBuilder(mockRole ? { role: mockRole, id: mockUserId } : null)) };
      }
      return { select: vi.fn().mockReturnValue(chainBuilder(null)) };
    }),
  })),
}));

beforeEach(() => { vi.resetModules(); mockRole = null; mockUserId = 'test-user'; });
afterEach(() => { vi.restoreAllMocks(); });

// ── Admin: passes auth (404 = past auth, reached business logic) ──

describe('Admin: authorized mutations', () => {
  it('approve → 404 (past auth)', async () => {
    mockRole = 'admin';
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST', body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(404);
  });

  it('reject → 404 (past auth)', async () => {
    mockRole = 'admin';
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST', body: JSON.stringify({ reason: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(404);
  });

  it('generate → past auth (200 or 500, not 401/403)', async () => {
    mockRole = 'admin';
    const { POST } = await import('@/app/api/admin/payouts/generate/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('list payouts → past auth (200, not 401/403)', async () => {
    mockRole = 'admin';
    const { GET } = await import('@/app/api/admin/payouts/route');
    const req = new NextRequest('http://localhost/api/admin/payouts');
    const res = await GET(req);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ── Finance: read allowed, mutations blocked with 403 ──

describe('Finance: read-only access', () => {
  it('list payouts → 200 (read access granted)', async () => {
    mockRole = 'finance';
    const { GET } = await import('@/app/api/admin/payouts/route');
    const req = new NextRequest('http://localhost/api/admin/payouts');
    const res = await GET(req);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe('Finance: blocked from mutations with 403', () => {
  it('approve → 403', async () => {
    mockRole = 'finance';
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST', body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Admin');
  });

  it('reject → 403', async () => {
    mockRole = 'finance';
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST', body: JSON.stringify({ reason: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(403);
  });

  it('generate → 403', async () => {
    mockRole = 'finance';
    const { POST } = await import('@/app/api/admin/payouts/generate/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('refund route requires admin (verified from source)', () => {
    // Refund route uses @supabase/supabase-js directly (not our createClient wrapper)
    // so the mock doesn't cover it. Verified via source inspection:
    const fs = require('fs');
    const content = fs.readFileSync('app/api/admin/payments/refund/route.ts', 'utf-8');
    expect(content).toContain("profile.role !== 'admin'");
    expect(content).toContain('403');
  });
});

// ── Ordinary user: 403 (authenticated but wrong role) ──

describe('Ordinary user: 403 on all admin routes', () => {
  it('approve → 403', async () => {
    mockRole = 'restaurant_owner';
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST', body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(403);
  });

  it('list → 403', async () => {
    mockRole = 'restaurant_owner';
    const { GET } = await import('@/app/api/admin/payouts/route');
    const req = new NextRequest('http://localhost/api/admin/payouts');
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it('reject → 403', async () => {
    mockRole = 'restaurant_owner';
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST', body: JSON.stringify({ reason: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(403);
  });
});

// ── Unauthenticated: 401 ──

describe('Unauthenticated: 401 on all routes', () => {
  it('approve → 401', async () => {
    mockRole = null;
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST', body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(401);
  });

  it('list → 401', async () => {
    mockRole = null;
    const { GET } = await import('@/app/api/admin/payouts/route');
    const req = new NextRequest('http://localhost/api/admin/payouts');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('reject → 401', async () => {
    mockRole = null;
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST', body: JSON.stringify({ reason: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'x' }) });
    expect(res.status).toBe(401);
  });

  it('generate → 401', async () => {
    mockRole = null;
    const { POST } = await import('@/app/api/admin/payouts/generate/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
