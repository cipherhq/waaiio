/**
 * Regression tests for M422 capability_overrides client correction.
 *
 * M422 revokes all table-level privileges from authenticated/anon on
 * capability_overrides — only service_role retains SELECT. These tests
 * verify that the two callers (capabilities/configure route and
 * dashboard/layout) read overrides via the service client, not the
 * authenticated client.
 *
 * Refs: #313, M419, M422
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Separate mocks for authenticated vs service client ──

const mockAuthFrom = vi.fn();
const mockServiceFrom = vi.fn();
const mockGetUser = vi.fn();
const mockRpc = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
    from: mockAuthFrom,
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
    rpc: mockRpc,
  }),
}));

vi.mock('@/lib/capabilities/policy', () => ({
  canModifyCapability: () => ({ allowed: true }),
}));

vi.mock('@/lib/capabilities/dependencies', () => ({
  getMissingDependencies: () => [],
}));

vi.mock('@/lib/trial-status', () => ({
  resolveTrialCredit: () => Promise.resolve(false),
}));

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/capabilities/configure'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('M422 regression: capability_overrides reads use service client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });

    // Authenticated client: businesses lookup succeeds
    mockAuthFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({
                  data: {
                    id: 'biz-1', owner_id: 'user-1',
                    subscription_tier: 'free', trial_ends_at: null, status: 'active',
                  },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      // If the authenticated client tries to read capability_overrides,
      // simulate the post-M422 permission denied error
      if (table === 'capability_overrides') {
        return {
          select: () => ({
            eq: () => Promise.resolve({
              data: null,
              error: { message: 'permission denied for table capability_overrides', code: '42501' },
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    });

    // Service client: override + capability reads succeed
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'capability_overrides') {
        return {
          select: () => ({
            eq: () => Promise.resolve({
              data: [{ capability: 'chat' }],
              error: null,
            }),
          }),
        };
      }
      if (table === 'business_capabilities') {
        return {
          select: () => ({
            eq: () => Promise.resolve({
              data: [{ capability: 'scheduling', is_enabled: true }],
              error: null,
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    });

    mockRpc.mockResolvedValue({
      data: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }],
      error: null,
    });
  });

  it('configure route reads overrides via service client, not authenticated', async () => {
    const { POST } = await import('@/app/api/capabilities/configure/route');
    const req = makeRequest({ businessId: 'biz-1', capabilities: ['scheduling'] });
    const res = await POST(req);

    expect(res.status).toBe(200);

    // Verify service client was called for capability_overrides
    const serviceOverrideCalls = mockServiceFrom.mock.calls
      .filter(([table]: [string]) => table === 'capability_overrides');
    expect(serviceOverrideCalls.length).toBeGreaterThanOrEqual(1);

    // Verify authenticated client was NOT called for capability_overrides
    const authOverrideCalls = mockAuthFrom.mock.calls
      .filter(([table]: [string]) => table === 'capability_overrides');
    expect(authOverrideCalls).toHaveLength(0);
  });

  it('configure route still validates business ownership via authenticated client', async () => {
    const { POST } = await import('@/app/api/capabilities/configure/route');
    const req = makeRequest({ businessId: 'biz-1', capabilities: ['scheduling'] });
    await POST(req);

    // Verify authenticated client was used for businesses lookup (ownership check)
    const authBusinessCalls = mockAuthFrom.mock.calls
      .filter(([table]: [string]) => table === 'businesses');
    expect(authBusinessCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('configure route returns 404 when user does not own business', async () => {
    // Override businesses mock to return not found (ownership mismatch)
    mockAuthFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    });

    const { POST } = await import('@/app/api/capabilities/configure/route');
    const req = makeRequest({ businessId: 'other-biz', capabilities: ['scheduling'] });
    const res = await POST(req);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe('business_not_found');

    // Verify service client was NOT called for overrides (short-circuited before)
    const serviceOverrideCalls = mockServiceFrom.mock.calls
      .filter(([table]: [string]) => table === 'capability_overrides');
    expect(serviceOverrideCalls).toHaveLength(0);
  });

  it('configure route passes overrides from service client to RPC snapshot', async () => {
    const { POST } = await import('@/app/api/capabilities/configure/route');
    const req = makeRequest({ businessId: 'biz-1', capabilities: ['scheduling'] });
    await POST(req);

    // The override 'chat' from the service client mock should appear in expected_overrides
    expect(mockRpc).toHaveBeenCalledWith(
      'configure_business_capabilities',
      expect.objectContaining({
        p_expected_overrides: ['chat'],
      }),
    );
  });
});
