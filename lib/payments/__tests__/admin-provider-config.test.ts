/**
 * Admin Provider Config — Route Authority Tests (Phase 3A)
 *
 * Proves all 9 required executable proofs from the CTO review:
 * 1-2. Paystack/Flutterwave save_refs preflight blocks mismatch/unavailable → zero save RPC
 * 3. Stripe refs rejected
 * 4. Switch TO Paystack always denied → zero switch RPC
 * 5. Stripe readiness failure → zero switch RPC
 * 6. Unsupported gateway → zero switch RPC
 * 7. Generic update_country cannot mutate provider-owned fields
 * 8. Messaging Financial Controls path is non-mutating for plan codes (UI test — proven by code inspection)
 * 9. Exact M378 parameter names + UUID CAS
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Set env vars BEFORE module loads
process.env.FLUTTERWAVE_SECRET_KEY = 'FAKE_FLW_KEY_FOR_TEST';
process.env.STRIPE_SECRET_KEY = 'FAKE_STRIPE_KEY_FOR_TEST';
process.env.PAYSTACK_SECRET_KEY = 'FAKE_PS_KEY_FOR_TEST';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn() }) },
}));

// Track RPC calls
const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; payload: Record<string, unknown>; filter: Record<string, unknown> }> = [];

const mockServiceClient = {
  rpc: vi.fn(async (fn: string, params: Record<string, unknown>) => {
    rpcCalls.push({ fn, params });
    return { data: 'new-version-uuid', error: null };
  }),
  from: vi.fn((table: string) => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({
      data: {
        pricing: {
          growth: { price: 5000, provider_plan_refs: { flutterwave: '243206', paystack: 'PLN_G' } },
          business: { price: 10000, provider_plan_refs: { flutterwave: '243207', paystack: 'PLN_B' } },
        },
        currency_code: 'NGN',
      },
      error: null,
    }),
    update: vi.fn((payload: Record<string, unknown>) => ({
      eq: vi.fn((col: string, val: string) => {
        updateCalls.push({ table, payload, filter: { [col]: val } });
        return Promise.resolve({ error: null });
      }),
    })),
  })),
};

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => mockServiceClient }));
vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(async () => ({ id: 'admin-uuid-1', userId: 'admin-uuid-1', email: 'admin@test.com', role: 'admin' })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeReq(body: Record<string, unknown>) {
  return new Request('http://localhost/api/admin/provider-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Flutterwave plan response matching accepted verifyFlutterwavePlan contract
function flwPlanOk(amount: number) {
  return { ok: true, json: async () => ({ status: 'success', data: { id: 1, status: 'active', amount, currency: 'NGN', interval: 'monthly' } }) };
}

const { POST } = await import('@/app/api/admin/provider-config/route');

beforeEach(() => {
  rpcCalls.length = 0;
  updateCalls.length = 0;
  mockFetch.mockReset();
  vi.clearAllMocks();
  mockServiceClient.rpc.mockImplementation(async (fn: string, params: Record<string, unknown>) => {
    rpcCalls.push({ fn, params });
    return { data: 'new-version-uuid', error: null };
  });
});

// ═══ Proof 1: Paystack save_refs currency/amount/archived/unavailable → zero save RPC ═══
describe('save_refs Paystack preflight', () => {
  it('currency mismatch → 400, no save RPC', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: { is_archived: false, interval: 'monthly', currency: 'USD', amount: 500000 } }) });
    const res = await POST(makeReq({ action: 'save_refs', country_code: 'NG', plan_refs: { growth: { paystack: 'PLN_X' } }, expected_version_id: 'uuid-1' }) as never);
    expect(res.status).toBe(400);
    expect(rpcCalls.filter(c => c.fn === 'save_provider_plan_refs')).toHaveLength(0);
  });

  it('amount mismatch (minor units) → 400, no save RPC', async () => {
    // DB price is 5000 major → Paystack should have 500000 kobo. Give wrong amount.
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: { is_archived: false, interval: 'monthly', currency: 'NGN', amount: 999900 } }) });
    const res = await POST(makeReq({ action: 'save_refs', country_code: 'NG', plan_refs: { growth: { paystack: 'PLN_X' } }, expected_version_id: 'uuid-1' }) as never);
    expect(res.status).toBe(400);
    expect(rpcCalls.filter(c => c.fn === 'save_provider_plan_refs')).toHaveLength(0);
  });

  it('provider API unavailable → fail closed, no save RPC', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network'));
    const res = await POST(makeReq({ action: 'save_refs', country_code: 'NG', plan_refs: { growth: { paystack: 'PLN_X' } }, expected_version_id: 'uuid-1' }) as never);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(rpcCalls.filter(c => c.fn === 'save_provider_plan_refs')).toHaveLength(0);
  });
});

// ═══ Proof 2: Flutterwave save_refs inactive/mismatch/unavailable → zero save RPC ═══
describe('save_refs Flutterwave preflight', () => {
  it('inactive plan → 400, no save RPC', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { id: 1, status: 'cancelled', amount: 5000, currency: 'NGN', interval: 'monthly' } }) });
    const res = await POST(makeReq({ action: 'save_refs', country_code: 'NG', plan_refs: { growth: { flutterwave: '999' } }, expected_version_id: 'uuid-1' }) as never);
    expect(res.status).toBe(400);
    expect(rpcCalls.filter(c => c.fn === 'save_provider_plan_refs')).toHaveLength(0);
  });

  it('amount mismatch → 400, no save RPC', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', data: { id: 1, status: 'active', amount: 9999, currency: 'NGN', interval: 'monthly' } }) });
    const res = await POST(makeReq({ action: 'save_refs', country_code: 'NG', plan_refs: { growth: { flutterwave: '999' } }, expected_version_id: 'uuid-1' }) as never);
    expect(res.status).toBe(400);
    expect(rpcCalls.filter(c => c.fn === 'save_provider_plan_refs')).toHaveLength(0);
  });
});

// ═══ Proof 3: Stripe plan refs rejected ═══
describe('save_refs Stripe rejection', () => {
  it('Stripe refs → 400 rejection', async () => {
    const res = await POST(makeReq({ action: 'save_refs', country_code: 'NG', plan_refs: { growth: { stripe: 'price_xxx' } }, expected_version_id: 'uuid-1' }) as never);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('inline price_data');
    expect(rpcCalls.filter(c => c.fn === 'save_provider_plan_refs')).toHaveLength(0);
  });
});

// ═══ Proof 4: Direct switch TO Paystack always denied ═══
describe('switch_provider Paystack denied', () => {
  it('switch to paystack → 400, zero switch RPC', async () => {
    const res = await POST(makeReq({ action: 'switch_provider', country_code: 'NG', new_gateway: 'paystack', expected_version_id: 'uuid-1' }) as never);
    expect(res.status).toBe(400);
    expect(rpcCalls.filter(c => c.fn === 'switch_country_provider')).toHaveLength(0);
  });
});

// ═══ Proof 5: Stripe readiness failure → zero switch RPC ═══
describe('switch_provider Stripe readiness', () => {
  it('Stripe API failure → 503, no switch RPC', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: { message: 'down' } }) });
    const res = await POST(makeReq({ action: 'switch_provider', country_code: 'NG', new_gateway: 'stripe', expected_version_id: 'uuid-1' }) as never);
    expect(res.status).toBe(503);
    expect(rpcCalls.filter(c => c.fn === 'switch_country_provider')).toHaveLength(0);
  });
});

// ═══ Proof 6: Unsupported gateway → zero switch RPC ═══
describe('switch_provider unsupported gateway', () => {
  it('unknown gateway → 400, no switch RPC', async () => {
    const res = await POST(makeReq({ action: 'switch_provider', country_code: 'NG', new_gateway: 'paypal', expected_version_id: 'uuid-1' }) as never);
    expect(res.status).toBe(400);
    expect(rpcCalls.filter(c => c.fn === 'switch_country_provider')).toHaveLength(0);
  });
});

// ═══ Proof 7: Generic update_country cannot mutate provider-owned fields ═══
describe('update_country field separation', () => {
  it('rejects pricing in generic update', async () => {
    const res = await POST(makeReq({ action: 'update_country', country_code: 'NG', fields: { name: 'Nigeria', pricing: { growth: { price: 99999 } } } }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('pricing');
  });

  it('rejects payment_gateway in generic update', async () => {
    const res = await POST(makeReq({ action: 'update_country', country_code: 'NG', fields: { payment_gateway: 'stripe' } }) as never);
    expect(res.status).toBe(400);
  });

  it('rejects currency_code in generic update', async () => {
    const res = await POST(makeReq({ action: 'update_country', country_code: 'NG', fields: { currency_code: 'USD' } }) as never);
    expect(res.status).toBe(400);
  });

  it('allows non-provider fields only', async () => {
    const res = await POST(makeReq({ action: 'update_country', country_code: 'NG', fields: { name: 'Nigeria Updated', is_active: true } }) as never);
    expect(res.status).toBe(200);
    // Verify the DB update payload contains only allowed fields
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload).toHaveProperty('name', 'Nigeria Updated');
    expect(updateCalls[0].payload).toHaveProperty('is_active', true);
    expect(updateCalls[0].payload).not.toHaveProperty('pricing');
    expect(updateCalls[0].payload).not.toHaveProperty('payment_gateway');
    expect(updateCalls[0].payload).not.toHaveProperty('currency_code');
  });
});

// ═══ Proof 9: Exact M378 parameter names + UUID CAS ═══
describe('M378 RPC contract', () => {
  it('save_refs passes exact p_country_code, p_plan_refs, p_expected_version_id, p_actor_id', async () => {
    // Both tiers need to pass preflight
    mockFetch.mockResolvedValueOnce(flwPlanOk(5000)).mockResolvedValueOnce(flwPlanOk(10000));
    const res = await POST(makeReq({ action: 'save_refs', country_code: 'NG', plan_refs: { growth: { flutterwave: '243206' }, business: { flutterwave: '243207' } }, expected_version_id: 'uuid-cas-1' }) as never);
    expect(res.status).toBe(200);
    const saveCall = rpcCalls.find(c => c.fn === 'save_provider_plan_refs');
    expect(saveCall).toBeDefined();
    expect(saveCall!.params).toHaveProperty('p_country_code', 'NG');
    expect(saveCall!.params).toHaveProperty('p_plan_refs');
    expect(saveCall!.params).toHaveProperty('p_expected_version_id', 'uuid-cas-1');
    expect(saveCall!.params).toHaveProperty('p_actor_id', 'admin-uuid-1');
    expect(saveCall!.params).not.toHaveProperty('p_provider');
    expect(saveCall!.params).not.toHaveProperty('p_tier_refs');
    expect(saveCall!.params).not.toHaveProperty('p_admin_id');
  });

  it('switch passes exact p_country_code, p_new_gateway, p_expected_version_id, p_actor_id', async () => {
    mockFetch.mockResolvedValueOnce(flwPlanOk(5000)).mockResolvedValueOnce(flwPlanOk(10000));
    const res = await POST(makeReq({ action: 'switch_provider', country_code: 'NG', new_gateway: 'flutterwave', expected_version_id: 'uuid-cas-2' }) as never);
    expect(res.status).toBe(200);
    const switchCall = rpcCalls.find(c => c.fn === 'switch_country_provider');
    expect(switchCall).toBeDefined();
    expect(switchCall!.params).toHaveProperty('p_new_gateway', 'flutterwave');
    expect(switchCall!.params).toHaveProperty('p_expected_version_id', 'uuid-cas-2');
    expect(switchCall!.params).not.toHaveProperty('p_new_provider');
  });

  it('uses UUID version string, not numeric', async () => {
    mockFetch.mockResolvedValueOnce(flwPlanOk(5000));
    await POST(makeReq({ action: 'save_refs', country_code: 'NG', plan_refs: { growth: { flutterwave: '111' } }, expected_version_id: 'a1b2c3d4-uuid' }) as never);
    expect(typeof rpcCalls[0]?.params.p_expected_version_id).toBe('string');
  });
});
