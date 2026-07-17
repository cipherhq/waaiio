/**
 * Admin Finance Integration Tests
 *
 * Execute actual route handlers with controlled auth.
 * Each test sets the mock role before importing the route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Shared state for the mock — set before each test
let mockRole: string | null = null;
let mockUserId = 'test-user';

// Mock Supabase at module level (hoisted by vitest)
// Chain builder that returns proper shape for any depth of .eq().eq().maybeSingle()
function chainBuilder(data: unknown) {
  const chain: Record<string, unknown> = {};
  const terminal = {
    maybeSingle: vi.fn().mockResolvedValue({ data }),
    single: vi.fn().mockResolvedValue({ data }),
    select: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) }),
  };
  chain.eq = vi.fn().mockReturnValue({ ...terminal, eq: vi.fn().mockReturnValue(terminal), in: vi.fn().mockReturnValue({ neq: vi.fn().mockResolvedValue({ data: [] }), eq: vi.fn().mockResolvedValue({ data: [] }) }), is: vi.fn().mockResolvedValue({ data: [] }) });
  chain.in = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [] }), neq: vi.fn().mockResolvedValue({ data: [] }) });
  chain.maybeSingle = terminal.maybeSingle;
  chain.single = terminal.single;
  return chain;
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
      // All other tables return null/empty — simulates "not found"
      return { select: vi.fn().mockReturnValue(chainBuilder(null)) };
    }),
  })),
}));

beforeEach(() => {
  vi.resetModules();
  mockRole = null;
  mockUserId = 'test-user';
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Admin: passes auth, reaches business logic ──

describe('Admin role: authorized mutations', () => {
  it('admin approve: passes auth, gets 404 (payout not found)', async () => {
    mockRole = 'admin';
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'nonexistent' }) });
    // 404 = passed auth, reached business logic, payout not found
    expect(res.status).toBe(404);
  });

  it('admin reject: passes auth, gets 404', async () => {
    mockRole = 'admin';
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test rejection' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'nonexistent' }) });
    expect(res.status).toBe(404);
  });

  it('admin generate: passes auth, reaches business logic', async () => {
    mockRole = 'admin';
    const { POST } = await import('@/app/api/admin/payouts/generate/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    // Passes auth — either processes or returns an error from business logic
    expect([200, 500]).toContain(res.status); // Not 401/403
  });
});

// ── Finance: blocked from mutations ──

describe('Finance role: blocked from all mutations', () => {
  it('finance cannot approve payouts', async () => {
    mockRole = 'finance';
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'test' }) });
    expect(res.status).toBe(401);
  });

  it('finance cannot reject payouts', async () => {
    mockRole = 'finance';
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'test' }) });
    expect(res.status).toBe(401);
  });

  it('finance cannot generate payouts', async () => {
    mockRole = 'finance';
    const { POST } = await import('@/app/api/admin/payouts/generate/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});

// ── Ordinary user: blocked from everything ──

describe('Ordinary user: blocked from all admin routes', () => {
  it('restaurant_owner cannot approve payouts', async () => {
    mockRole = 'restaurant_owner';
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'test' }) });
    expect(res.status).toBe(401);
  });

  it('restaurant_owner cannot list payouts', async () => {
    mockRole = 'restaurant_owner';
    const { GET } = await import('@/app/api/admin/payouts/route');
    const req = new NextRequest('http://localhost/api/admin/payouts');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});

// ── Unauthenticated: blocked ──

describe('Unauthenticated: blocked from all routes', () => {
  it('no user: approve returns 401', async () => {
    mockRole = null;
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'test' }) });
    expect(res.status).toBe(401);
  });

  it('no user: list returns 401', async () => {
    mockRole = null;
    const { GET } = await import('@/app/api/admin/payouts/route');
    const req = new NextRequest('http://localhost/test');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('no user: generate returns 401', async () => {
    mockRole = null;
    const { POST } = await import('@/app/api/admin/payouts/generate/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('no user: reject returns 401', async () => {
    mockRole = null;
    const { POST } = await import('@/app/api/admin/payouts/[id]/reject/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      body: JSON.stringify({ reason: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'test' }) });
    expect(res.status).toBe(401);
  });
});
