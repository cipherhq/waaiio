/**
 * Route-level tests for POST /api/capabilities/configure
 *
 * Tests the API layer logic: validation, snapshot passing, error handling.
 * Mocks Supabase — real PostgreSQL tests are in migration-299-301-db.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock setup ��─

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

vi.mock('@/lib/capabilities/policy', () => ({
  canModifyCapability: () => ({ allowed: true }),
}));

vi.mock('@/lib/capabilities/dependencies', () => ({
  getMissingDependencies: () => [],
}));

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/capabilities/configure'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/capabilities/configure', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });

    // Default business lookup
    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({
                  data: { id: 'biz-1', owner_id: 'user-1', subscription_tier: 'free', trial_ends_at: null, status: 'active' },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'capability_overrides') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }
      if (table === 'business_capabilities') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: [{ capability: 'scheduling', is_enabled: true }], error: null }),
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    });

    mockRpc.mockResolvedValue({ data: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], error: null });
  });

  it('passes expected_selected and expected_overrides to RPC', async () => {
    const { POST } = await import('@/app/api/capabilities/configure/route');
    const req = makeRequest({ businessId: 'biz-1', capabilities: ['scheduling'] });
    await POST(req);

    expect(mockRpc).toHaveBeenCalledWith('configure_business_capabilities', expect.objectContaining({
      p_expected_selected: ['scheduling'],
      p_expected_overrides: [],
    }));
  });

  it('returns 409 on configuration_conflict from RPC', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'configuration_conflict: selected capabilities changed' } });
    const { POST } = await import('@/app/api/capabilities/configure/route');
    const req = makeRequest({ businessId: 'biz-1', capabilities: ['scheduling'] });
    const res = await POST(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe('configuration_conflict');
  });

  it('returns 500 on non-conflict RPC error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'some other error' } });
    const { POST } = await import('@/app/api/capabilities/configure/route');
    const req = makeRequest({ businessId: 'biz-1', capabilities: ['scheduling'] });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.reason).toBe('configuration_failed');
  });

  it('returns 403 for suspended business', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({
                  data: { id: 'biz-1', owner_id: 'user-1', subscription_tier: 'free', trial_ends_at: null, status: 'suspended' },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    });

    const { POST } = await import('@/app/api/capabilities/configure/route');
    const req = makeRequest({ businessId: 'biz-1', capabilities: ['scheduling'] });
    const res = await POST(req);

    expect(res.status).toBe(403);
  });
});
