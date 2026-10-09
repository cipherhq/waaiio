/**
 * #592 coexistence readiness route — tenant authority, eq() predicate
 * verification, cross-tenant denial, and no provider writes.
 *
 * CTO review correction: mock eq() now records calls so tests can assert
 * exact column/value predicates rather than silently passing any filter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

type EqCall = { column: string; value: unknown };
let eqCalls: EqCall[] = [];

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockFrom }),
}));

const BUSINESS_ID = '00000000-0000-4000-8000-000000000123';
const request = (id = BUSINESS_ID) =>
  new NextRequest('http://localhost/api/whatsapp/business-app-connect/readiness?businessId=' + id);

/** Build a Supabase query chain that records eq() predicate calls */
const query = (result: { data: unknown; error: unknown }) => ({
  select() { return this; },
  eq(column: string, value: unknown) {
    eqCalls.push({ column, value });
    return this;
  },
  maybeSingle: vi.fn(async () => result),
});

describe('#592 coexistence readiness handler — tenant authority / no provider writes', () => {
  const saved = {
    enabled: process.env.META_BUSINESS_APP_COEXISTENCE_ENABLED,
    config: process.env.NEXT_PUBLIC_META_BUSINESS_APP_COEXISTENCE_CONFIG_ID,
    transfer: process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    eqCalls = [];
    mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
    mockFrom.mockImplementation(() => query({
      data: { id: BUSINESS_ID, country_code: 'NG' }, error: null,
    }));
    process.env.META_BUSINESS_APP_COEXISTENCE_ENABLED = 'true';
    process.env.NEXT_PUBLIC_META_BUSINESS_APP_COEXISTENCE_CONFIG_ID = '1234567891234567';
    process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID = '9999999999999999';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries({
      META_BUSINESS_APP_COEXISTENCE_ENABLED: saved.enabled,
      NEXT_PUBLIC_META_BUSINESS_APP_COEXISTENCE_CONFIG_ID: saved.config,
      NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID: saved.transfer,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects invalid business ID without DB call', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    expect((await GET(request('not-an-id'))).status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('requires authenticated owner before exposing local readiness', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await GET(request())).status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('denies other businesses before returning any local readiness (cross-tenant denial)', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    mockFrom.mockImplementation(() => query({ data: null, error: null }));
    const res = await GET(request());
    expect(res.status).toBe(403);
  });

  it('business query filters by owner_id = user.id (eq() predicate verification)', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    await GET(request());

    // Assert that eq() was called with exact expected predicates
    const ownerFilter = eqCalls.find(c => c.column === 'owner_id');
    expect(ownerFilter).toBeDefined();
    expect(ownerFilter!.value).toBe('owner-1');
  });

  it('business query filters by id = businessId (eq() predicate verification)', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    await GET(request());

    const idFilter = eqCalls.find(c => c.column === 'id');
    expect(idFilter).toBeDefined();
    expect(idFilter!.value).toBe(BUSINESS_ID);
  });

  it('does not treat DB error as owner denial or eligible status', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    mockFrom.mockImplementation(() => query({ data: null, error: { message: 'fail' } }));
    expect((await GET(request())).status).toBe(503);
  });

  it('local config never means meta approval, even for a supported Waaiio country', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(request());
    const value = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(value.configured).toBe(true);
    expect(value.country).toBe('NG');
    expect(value.countryEligibility).toBe('requires_meta_confirmation');
    expect(value.appEligibility).toBe('requires_meta_confirmation');
    expect(value.canConnect).toBe(false);
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('returns configured: false when env is disabled', async () => {
    process.env.META_BUSINESS_APP_COEXISTENCE_ENABLED = 'false';
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(request());
    const value = await res.json();
    expect(res.status).toBe(200);
    expect(value.configured).toBe(false);
    expect(value.canConnect).toBe(false);
    expect(value.reason).toBe('disabled');
  });

  it('returns configured: false when coexist config ID matches transfer config ID', async () => {
    process.env.NEXT_PUBLIC_META_BUSINESS_APP_COEXISTENCE_CONFIG_ID = '9999999999999999'; // same as transfer
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(request());
    const value = await res.json();
    expect(res.status).toBe(200);
    expect(value.configured).toBe(false);
    expect(value.reason).toBe('reused_transfer_configuration');
    expect(value.canConnect).toBe(false);
  });

  it('includes warning about not connecting through standard transfer', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(request());
    const value = await res.json();
    expect(value.warning).toContain('standard transfer');
  });

  // Gap 5: canConnect always false — regardless of config
  it('canConnect is always false even with every config gate passing', async () => {
    // All env vars set correctly, business ownership verified, country NG
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(request());
    const value = await res.json();

    // Despite configured: true, canConnect must be false
    expect(value.configured).toBe(true);
    expect(value.canConnect).toBe(false);

    // canConnect: false is hardcoded in the route. It cannot be changed by
    // any combination of environment variables, business data, or country code.
    // Real enablement requires Meta provider-level confirmation:
    //   1. Partner entitlement verification
    //   2. Phone number eligibility check
    //   3. Existing WhatsApp Business app verification
    //   4. Country/market support confirmation
    //   5. Signed FINISH attestation from Meta-hosted onboarding session
    //   6. Server-owned signup nonces
    // None of these are implemented. See lib/whatsapp/business-app-coexistence.ts.
  });
});
