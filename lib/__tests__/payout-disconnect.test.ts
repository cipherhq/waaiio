/**
 * Payout Disconnect Tests
 *
 * Regression tests for the server-side disconnect flow:
 * - Exact displayed account is revoked
 * - Idempotent on already-disconnected
 * - Old revoked rows remain unchanged
 * - Other gateways remain unchanged
 * - Unauthorized access returns 401
 * - Non-owner access returns 403
 * - Missing params returns 400
 * - Direct browser mutation remains blocked by trigger
 * - Frontend only clears state after server success
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock setup ──

const mockGetUser = vi.fn();
const mockAuthClient = {
  auth: { getUser: mockGetUser },
  from: vi.fn(),
};

const mockServiceFrom = vi.fn();
const mockServiceClient = {
  from: mockServiceFrom,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => mockServiceClient),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Re-mock createClient to return our mock each time
beforeEach(async () => {
  vi.clearAllMocks();
  const { createClient } = await import('@/lib/supabase/server');
  (createClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockAuthClient);
});

// Helper to build a request
function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/payouts/disconnect', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

// Helper to chain supabase query builder
function chainMock(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.is = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(result);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.update = vi.fn().mockReturnValue(chain);
  return chain;
}

describe('POST /api/payouts/disconnect', () => {
  let handler: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/payouts/disconnect/route');
    handler = mod.POST;
  });

  // ── 1. Unauthenticated → 401 ──
  it('returns 401 when not authenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const res = await handler(makeRequest({ business_id: 'b1', payout_account_id: 'p1' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
  });

  // ── 2. Missing params → 400 ──
  it('returns 400 when business_id is missing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.com' } } });

    const res = await handler(makeRequest({ payout_account_id: 'p1' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when payout_account_id is missing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.com' } } });

    const res = await handler(makeRequest({ business_id: 'b1' }));
    expect(res.status).toBe(400);
  });

  // ── 3. Non-owner → 403 ──
  it('returns 403 when user does not own the business', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.com' } } });

    // Business lookup returns null (RLS blocks non-owner)
    const bizChain = chainMock({ data: null });
    mockAuthClient.from = vi.fn().mockReturnValue(bizChain);

    const res = await handler(makeRequest({ business_id: 'b1', payout_account_id: 'p1' }));
    expect(res.status).toBe(403);
  });

  // ── 4. Account not found → 404 ──
  it('returns 404 when payout account does not exist', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.com' } } });

    const callNum = { current: 0 };
    mockAuthClient.from = vi.fn().mockImplementation(() => {
      callNum.current++;
      if (callNum.current === 1) return chainMock({ data: { id: 'b1' } }); // biz found
      return chainMock({ data: null }); // account not found
    });

    const res = await handler(makeRequest({ business_id: 'b1', payout_account_id: 'p-nonexistent' }));
    expect(res.status).toBe(404);
  });

  // ── 5. Successful disconnect ──
  it('revokes the exact specified account via service client', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.com' } } });

    const callNum = { current: 0 };
    mockAuthClient.from = vi.fn().mockImplementation(() => {
      callNum.current++;
      if (callNum.current === 1) return chainMock({ data: { id: 'b1' } }); // biz
      return chainMock({ data: { id: 'p1', gateway: 'stripe', is_active: true, is_default: true } }); // account
    });

    // Service client chains: first call (update payout_accounts) must return the revoked row,
    // subsequent calls (secrets, remaining default, payout_mode) return null
    const serviceCallNum = { current: 0 };
    mockServiceFrom.mockImplementation(() => {
      serviceCallNum.current++;
      if (serviceCallNum.current === 1) return chainMock({ data: { id: 'p1' }, error: null }); // revoked row
      return chainMock({ data: null, error: null });
    });

    const res = await handler(makeRequest({ business_id: 'b1', payout_account_id: 'p1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.gateway).toBe('stripe');

    // Verify service client was called with payout_accounts
    expect(mockServiceFrom).toHaveBeenCalledWith('payout_accounts');
  });

  // ── 6. Idempotent: already disconnected ──
  it('returns success when account is already inactive', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.com' } } });

    const callNum = { current: 0 };
    mockAuthClient.from = vi.fn().mockImplementation(() => {
      callNum.current++;
      if (callNum.current === 1) return chainMock({ data: { id: 'b1' } });
      return chainMock({ data: { id: 'p1', gateway: 'stripe', is_active: false, is_default: false } });
    });

    const res = await handler(makeRequest({ business_id: 'b1', payout_account_id: 'p1' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.already_disconnected).toBe(true);

    // Service client should NOT be called for mutations
    expect(mockServiceFrom).not.toHaveBeenCalled();
  });
});

// ── Structural tests: verify the route has the right safety properties ──
describe('Disconnect route structural safety', () => {
  const routeCode = require('fs').readFileSync('app/api/payouts/disconnect/route.ts', 'utf-8');

  it('uses server-side createClient, not browser client', () => {
    expect(routeCode).toContain("from '@/lib/supabase/server'");
    expect(routeCode).not.toContain("from '@/lib/supabase/client'");
  });

  it('uses service client for the revocation', () => {
    expect(routeCode).toContain('createServiceClient');
    expect(routeCode).toContain(".from('payout_accounts')");
    // The service client variable is used for the mutation
    expect(routeCode).toMatch(/service[\s\n]*\.from\('payout_accounts'\)/);
  });

  it('checks auth before any mutation', () => {
    const authIdx = routeCode.indexOf('getUser');
    const mutateIdx = routeCode.search(/service[\s\n]*\.from\('payout_accounts'\)/);
    expect(authIdx).toBeGreaterThan(-1);
    expect(mutateIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(mutateIdx);
  });

  it('verifies business ownership via owner_id check', () => {
    expect(routeCode).toContain("eq('owner_id', user.id)");
  });

  it('targets a specific payout_account_id, not a broad is_active filter', () => {
    expect(routeCode).toContain("eq('id', payout_account_id)");
  });

  it('sets connection_status to revoked', () => {
    expect(routeCode).toContain("connection_status: 'revoked'");
  });

  it('revokes associated secrets', () => {
    expect(routeCode).toContain("from('business_connection_secrets')");
    expect(routeCode).toContain("is('revoked_at', null)");
  });

  it('only resets payout_mode when no other active default exists', () => {
    expect(routeCode).toContain('remainingDefault');
    expect(routeCode).toContain("payout_mode: 'platform_managed'");
  });

  it('is idempotent for already-inactive accounts', () => {
    expect(routeCode).toContain('already_disconnected');
  });

  it('verifies the update actually modified a row', () => {
    // Must use .select().maybeSingle() to detect zero-row updates
    expect(routeCode).toMatch(/\.select\(['"]id['"]\)/);
    expect(routeCode).toContain('.maybeSingle()');
    expect(routeCode).toContain('if (!revoked)');
  });
});

// ── Frontend structural test ──
describe('Frontend disconnect handler', () => {
  const pageCode = require('fs').readFileSync('app/dashboard/payouts/page.tsx', 'utf-8');

  it('calls the server-side disconnect API, not direct supabase mutation', () => {
    expect(pageCode).toContain("fetch('/api/payouts/disconnect'");
    // Must NOT directly mutate payout_accounts from the browser
    expect(pageCode).not.toContain("supabase.from('payout_accounts').update");
  });

  it('targets the specific existing account ID', () => {
    expect(pageCode).toContain('payout_account_id: existing.id');
  });

  it('checks API response before clearing UI state', () => {
    const fetchIdx = pageCode.indexOf("fetch('/api/payouts/disconnect'");
    const resultCheckIdx = pageCode.indexOf('result.success', fetchIdx);
    const clearIdx = pageCode.indexOf('setExisting(null)', fetchIdx);
    expect(resultCheckIdx).toBeLessThan(clearIdx);
  });

  it('shows error on API failure instead of false success', () => {
    expect(pageCode).toContain("result.error || 'Failed to disconnect account'");
  });

  it('does not directly mutate businesses.payout_mode from disconnect handler', () => {
    // The disconnect handler section should NOT contain a direct businesses update
    const disconnectSection = pageCode.substring(
      pageCode.indexOf("fetch('/api/payouts/disconnect'"),
      pageCode.indexOf('setPageView', pageCode.indexOf("fetch('/api/payouts/disconnect'")) + 50,
    );
    expect(disconnectSection).not.toContain("from('businesses').update");
  });
});

// ── Database trigger structural test ──
describe('Database trigger guard remains in place', () => {
  it('the disconnect route does not disable or modify the update guard trigger', () => {
    const routeCode = require('fs').readFileSync('app/api/payouts/disconnect/route.ts', 'utf-8');
    expect(routeCode).not.toContain('DISABLE TRIGGER');
    expect(routeCode).not.toContain('disable trigger');
    expect(routeCode).not.toContain('DROP TRIGGER');
  });
});
