/**
 * Admin Provider Config — Route Contract Tests
 *
 * Validates the API contract for save_refs and switch_provider actions,
 * including exact M378 RPC parameter names and UUID CAS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

// Track RPC calls to verify exact parameter names
const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
const mockServiceClient = {
  rpc: vi.fn(async (fn: string, params: Record<string, unknown>) => {
    rpcCalls.push({ fn, params });
    return { data: 'new-version-uuid', error: null };
  }),
  from: vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: {
        pricing: {
          growth: { price: 5000, provider_plan_refs: { flutterwave: '243206' } },
          business: { price: 10000, provider_plan_refs: { flutterwave: '243207' } },
        },
        currency_code: 'NGN',
      },
      error: null,
    }),
  })),
};

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => mockServiceClient,
}));

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(async () => ({
    id: 'admin-uuid-1',
    userId: 'admin-uuid-1',
    email: 'admin@test.com',
    role: 'admin',
  })),
}));

// Mock fetch for Flutterwave plan verification
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Admin Provider Config Route', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    vi.clearAllMocks();
    mockServiceClient.rpc.mockImplementation(async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params });
      return { data: 'new-version-uuid', error: null };
    });
  });

  describe('RPC parameter contracts', () => {
    it('save_refs uses exact M378 parameter names: p_country_code, p_plan_refs, p_expected_version_id, p_actor_id', async () => {
      const { POST } = await import('@/app/api/admin/provider-config/route');

      const request = new Request('http://localhost/api/admin/provider-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_refs',
          country_code: 'NG',
          plan_refs: { growth: { flutterwave: '243206' }, business: { flutterwave: '243207' } },
          expected_version_id: 'uuid-version-1',
        }),
      });

      const response = await POST(request as never);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(rpcCalls).toHaveLength(1);
      expect(rpcCalls[0].fn).toBe('save_provider_plan_refs');

      // Verify exact parameter names — NOT p_provider, p_tier_refs, p_admin_id
      const params = rpcCalls[0].params;
      expect(params).toHaveProperty('p_country_code', 'NG');
      expect(params).toHaveProperty('p_plan_refs');
      expect(params).toHaveProperty('p_expected_version_id', 'uuid-version-1');
      expect(params).toHaveProperty('p_actor_id', 'admin-uuid-1');

      // Verify nested plan_refs structure
      expect(params.p_plan_refs).toEqual({
        growth: { flutterwave: '243206' },
        business: { flutterwave: '243207' },
      });

      // Must NOT have old wrong parameter names
      expect(params).not.toHaveProperty('p_provider');
      expect(params).not.toHaveProperty('p_tier_refs');
      expect(params).not.toHaveProperty('p_admin_id');
    });

    it('switch_provider uses exact M378 parameter names: p_country_code, p_new_gateway, p_expected_version_id, p_actor_id', async () => {
      // Mock the Flutterwave plan verification
      mockFetch.mockResolvedValue({
        json: async () => ({
          status: 'success',
          data: { amount: 5000, currency: 'NGN' },
        }),
      });

      const { POST } = await import('@/app/api/admin/provider-config/route');

      const request = new Request('http://localhost/api/admin/provider-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'switch_provider',
          country_code: 'NG',
          new_gateway: 'flutterwave',
          expected_version_id: 'uuid-version-2',
        }),
      });

      const response = await POST(request as never);
      const data = await response.json();

      expect(data.success).toBe(true);

      // Find the switch RPC call (last one, after any preflight)
      const switchCall = rpcCalls.find(c => c.fn === 'switch_country_provider');
      expect(switchCall).toBeDefined();

      const params = switchCall!.params;
      expect(params).toHaveProperty('p_country_code', 'NG');
      expect(params).toHaveProperty('p_new_gateway', 'flutterwave');
      expect(params).toHaveProperty('p_expected_version_id', 'uuid-version-2');
      expect(params).toHaveProperty('p_actor_id', 'admin-uuid-1');

      // Must NOT have old wrong parameter names
      expect(params).not.toHaveProperty('p_new_provider');
      expect(params).not.toHaveProperty('p_expected_version');
      expect(params).not.toHaveProperty('p_admin_id');
    });

    it('uses UUID version IDs, not numeric config_version', async () => {
      const { POST } = await import('@/app/api/admin/provider-config/route');

      const request = new Request('http://localhost/api/admin/provider-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_refs',
          country_code: 'NG',
          plan_refs: { growth: { flutterwave: '111' } },
          expected_version_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        }),
      });

      await POST(request as never);

      const params = rpcCalls[0].params;
      // p_expected_version_id must be the UUID string, not a number
      expect(typeof params.p_expected_version_id).toBe('string');
      expect(params.p_expected_version_id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });
  });

  describe('Flutterwave switch preflight', () => {
    it('rejects switch to flutterwave when Growth ref is missing', async () => {
      // Override country to have no Growth ref
      mockServiceClient.from.mockReturnValueOnce({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: {
            pricing: {
              growth: { price: 5000 },
              business: { price: 10000, provider_plan_refs: { flutterwave: '243207' } },
            },
            currency_code: 'NGN',
          },
          error: null,
        }),
      });

      const { POST } = await import('@/app/api/admin/provider-config/route');

      const request = new Request('http://localhost/api/admin/provider-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'switch_provider',
          country_code: 'NG',
          new_gateway: 'flutterwave',
          expected_version_id: 'uuid-version-3',
        }),
      });

      const response = await POST(request as never);
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('Growth');
    });

    it('rejects switch to flutterwave when preflight API call fails', async () => {
      mockFetch.mockResolvedValue({
        json: async () => ({
          status: 'error',
          message: 'Plan not found',
        }),
      });

      const { POST } = await import('@/app/api/admin/provider-config/route');

      const request = new Request('http://localhost/api/admin/provider-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'switch_provider',
          country_code: 'NG',
          new_gateway: 'flutterwave',
          expected_version_id: 'uuid-version-4',
        }),
      });

      const response = await POST(request as never);
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toContain('preflight failed');
    });
  });

  describe('get_version action', () => {
    it('returns UUID version from get_effective_config RPC', async () => {
      mockServiceClient.rpc.mockResolvedValueOnce({
        data: 'a1b2c3d4-uuid-version',
        error: null,
      });

      const { POST } = await import('@/app/api/admin/provider-config/route');

      const request = new Request('http://localhost/api/admin/provider-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_version' }),
      });

      const response = await POST(request as never);
      const data = await response.json();

      expect(data.version_id).toBe('a1b2c3d4-uuid-version');
    });
  });
});
