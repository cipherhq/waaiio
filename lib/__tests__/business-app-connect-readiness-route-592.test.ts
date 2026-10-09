import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockFrom }),
}));

const BUSINESS_ID = '00000000-0000-4000-8000-000000000123';
const request = (id = BUSINESS_ID) =>
  new NextRequest('http://localhost/api/whatsapp/business-app-connect/readiness?businessId=' + id);
const query = (result: { data: unknown; error: unknown }) => ({
  select() { return this; },
  eq() { return this; },
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

  it('denies other businesses before returning any local readiness', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    mockFrom.mockImplementation(() => query({ data: null, error: null }));
    expect((await GET(request())).status).toBe(403);
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
});
