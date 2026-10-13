/**
 * #592 Business App Connect coexistence safety — CTO review corrections.
 *
 * Replaces source-text string-matching tests with executable route tests that
 * PROVE zero provider-token exchange, zero candidate INSERT, and zero phone
 * registration on denied paths. Tests invoke the real route handlers with
 * mocked Supabase + Meta provider dependencies.
 *
 * Coverage:
 * - Local readiness gate logic (evaluateBusinessAppCoexistenceConfig)
 * - Facebook callback route: coexist denial, unknown method rejection, transfer non-regression
 * - Readiness API route: exact eq() predicates, cross-tenant denial, DB error handling
 * - canConnect always false regardless of config state (Gap 5)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  buildCoexistenceSignupOptions,
  evaluateBusinessAppCoexistenceConfig,
} from '@/lib/whatsapp/business-app-coexistence';

// ─────────────────────────────────────────────────────────────────────────
// Mock infrastructure for callback route
// ─────────────────────────────────────────────────────────────────────────

const mockGetUser = vi.fn();
const mockAuthClientFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: mockGetUser }, from: mockAuthClientFrom }),
}));

let candidateInserts: Record<string, unknown>[] = [];
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

// Deep auto-chain for Supabase queries — records eq() calls for predicate verification
type EqCall = { column: string; value: unknown };
let eqCalls: EqCall[] = [];

function dc(data: unknown, opts?: { error?: unknown }): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  for (const m of ['neq', 'in', 'gt', 'lt', 'gte', 'lte', 'limit', 'order', 'select', 'update', 'insert', 'delete', 'is', 'or', 'not', 'filter', 'upsert']) s[m] = () => s;
  s.eq = (col: string, val: unknown) => { eqCalls.push({ column: col, value: val }); return s; };
  s.single = () => Promise.resolve({ data, error: opts?.error ?? null });
  s.maybeSingle = () => Promise.resolve({ data, error: opts?.error ?? null });
  return s;
}

const defaultBiz = {
  id: 'biz-1', name: 'Test Biz', owner_id: 'user-1', country_code: 'NG', address: '1 St',
  assigned_channel_id: null, whatsapp_channel_id: null, wa_method: 'shared', status: 'active',
};

const mockServiceFrom = vi.fn((table: string) => {
  if (table === 'whatsapp_channel_candidates') {
    return {
      insert: (data: Record<string, unknown>) => {
        candidateInserts.push(data);
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'cand-test' }, error: null }) }) };
      },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      select: () => dc(null),
    };
  }
  if (table === 'whatsapp_channels') return { select: () => dc(null) };
  if (table === 'admin_onboarding_invites') return { select: () => dc(null), update: () => dc(null) };
  if (table === 'admin_audit_logs') return { insert: () => Promise.resolve({ error: null }) };
  return { select: () => dc(null), update: () => dc(null), insert: () => dc(null) };
});

const mockServiceRpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
  rpcCalls.push({ fn, args });
  if (fn === 'check_phone_conflict') return { data: { conflict: false }, error: null };
  if (fn === 'promote_channel_candidate') return { data: { ok: true, channel_id: 'ch-new', action: 'first_connect' }, error: null };
  if (fn === 'reconcile_paid_allowance') return { data: null, error: null };
  return { data: null, error: null };
});

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: mockServiceFrom, rpc: mockServiceRpc }),
}));

vi.mock('@/lib/encryption', () => ({
  encryptToken: (v: string) => `enc:${v}`,
  decryptToken: (v: string) => v.startsWith('enc:') ? v.slice(4) : v,
}));

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: vi.fn(() => Promise.resolve(null)), getRateLimitKey: () => 'test' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeCallbackReq(body: Record<string, unknown>) {
  return new NextRequest(new URL('/api/auth/facebook/callback', 'http://localhost:3000'), {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
  });
}

function resetAll() {
  vi.resetAllMocks();
  candidateInserts = [];
  rpcCalls = [];
  eqCalls = [];
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 't@t.com' } } });
  mockAuthClientFrom.mockImplementation(() => dc(defaultBiz));
  process.env.META_CLOUD_WABA_ID = 'waba-test';
  process.env.META_CLOUD_ACCESS_TOKEN = 'token-test';
  process.env.META_GRAPH_API_VERSION = 'v22.0';
  process.env.NEXT_PUBLIC_META_APP_ID = 'app-123';
  process.env.META_APP_SECRET = 'secret-456';
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('register')) return { ok: true, json: async () => ({ success: true }) };
    if (String(url).includes('subscribed_apps')) return { ok: true, json: async () => ({ success: true }) };
    if (String(url).includes('oauth/access_token')) return { ok: true, json: async () => ({ access_token: 'long-lived-token', expires_in: 3600 }) };
    if (String(url).includes('debug_token')) return { ok: true, json: async () => ({ data: { granular_scopes: [{ permission: 'whatsapp_business_management', target_ids: ['waba-1'] }] } }) };
    if (String(url).includes('/phone_numbers')) return { ok: true, json: async () => ({ data: [{ id: 'pn-1', display_phone_number: '+234900', verified_name: 'Test' }] }) };
    if (String(url).includes('whatsapp_business_profile')) return { ok: true, json: async () => ({}) };
    // Default phone info
    return { ok: true, json: async () => ({ display_phone_number: '+234900', verified_name: 'Test', quality_rating: 'GREEN', messaging_limit: 'TIER_1K' }), text: async () => '' };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Local readiness gate logic (kept — these are already executable)
// ─────────────────────────────────────────────────────────────────────────

const valid = {
  enabled: 'true',
  coexistConfigId: '1234567890123456',
  transferConfigId: '6543210987654321',
};

describe('#592 Business App coexistence — executable local readiness gates', () => {
  it('denies opt-in when unset, false, or malformed', () => {
    for (const enabled of [undefined, '', 'false', '1', 'TRUE']) {
      expect(evaluateBusinessAppCoexistenceConfig({ ...valid, enabled })).toMatchObject({
        configured: false, reason: 'disabled',
      });
      expect(() => buildCoexistenceSignupOptions({ ...valid, enabled })).toThrow();
    }
  });

  it('denies missing or invalid Meta-assigned dedicated config ID', () => {
    for (const coexistConfigId of [undefined, '', 'abc', '123']) {
      expect(evaluateBusinessAppCoexistenceConfig({ ...valid, coexistConfigId })).toMatchObject({
        configured: false, reason: 'missing_configuration',
      });
    }
  });

  it('never reuses standard phone-transfer configuration', () => {
    expect(evaluateBusinessAppCoexistenceConfig({
      ...valid, coexistConfigId: valid.transferConfigId,
    })).toMatchObject({ configured: false, reason: 'reused_transfer_configuration' });
  });

  it('configuration readiness is NOT proof that Meta approves number, market or app', () => {
    const gate = evaluateBusinessAppCoexistenceConfig(valid);
    expect(gate).toEqual({
      configured: true, reason: 'provider_verification_required',
      message: expect.stringContaining('Meta must verify'),
    });
    expect(gate).not.toHaveProperty('eligible');
    expect(gate).not.toHaveProperty('canConnect');
  });

  it('builds a separate v4 code-only configuration, no browser token or unauthorized featureType', () => {
    const options = buildCoexistenceSignupOptions(valid);
    expect(options).toEqual({
      config_id: valid.coexistConfigId,
      response_type: 'code',
      override_default_response_type: true,
      extras: {},
    });
    expect(JSON.stringify(options)).not.toContain('access_token');
    expect(JSON.stringify(options)).not.toContain('featureType');
  });

  it('does not infer eligibility from country alone', () => {
    const gate = evaluateBusinessAppCoexistenceConfig(valid);
    expect(gate.configured).toBe(true);
    expect(gate.reason).toBe('provider_verification_required');
    expect(gate).not.toHaveProperty('eligible');
    expect(gate).not.toHaveProperty('canConnect');
    expect(gate).not.toHaveProperty('country');
    expect(gate).not.toHaveProperty('region');
    expect(gate).not.toHaveProperty('countryEligible');
  });

  it('treats whitespace-only config ID as missing', () => {
    const result = evaluateBusinessAppCoexistenceConfig({ ...valid, coexistConfigId: '   ' });
    expect(result.configured).toBe(false);
    expect(result.reason).toBe('missing_configuration');
  });

  // Gap 5: canConnect is always false
  it('evaluateBusinessAppCoexistenceConfig never returns canConnect regardless of config state', () => {
    // When disabled
    const disabled = evaluateBusinessAppCoexistenceConfig({ ...valid, enabled: 'false' });
    expect(disabled).not.toHaveProperty('canConnect');

    // When missing config
    const missing = evaluateBusinessAppCoexistenceConfig({ ...valid, coexistConfigId: '' });
    expect(missing).not.toHaveProperty('canConnect');

    // When reused config
    const reused = evaluateBusinessAppCoexistenceConfig({ ...valid, coexistConfigId: valid.transferConfigId });
    expect(reused).not.toHaveProperty('canConnect');

    // When fully configured — still no canConnect
    // evaluateBusinessAppCoexistenceConfig checks LOCAL config readiness ONLY.
    // Meta eligibility verification requires separate provider-level confirmation
    // (partner entitlement, phone number check, existing Business app check,
    // country/market check, signed FINISH attestation) — none of which is
    // implemented yet. canConnect is NOT a gate property; it exists only in the
    // readiness API response and is always hardcoded to false.
    const configured = evaluateBusinessAppCoexistenceConfig(valid);
    expect(configured).not.toHaveProperty('canConnect');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Facebook callback route — executable tests proving zero mutation on
//    coexist denial and transfer non-regression (replaces string-matching)
// ─────────────────────────────────────────────────────────────────────────

describe('#592 Facebook callback — executable coexistence fence', () => {
  beforeEach(resetAll);

  it('connection_method=coexist returns 409 BEFORE any token exchange, candidate INSERT, or phone registration', async () => {
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeCallbackReq({
      business_id: 'biz-1',
      access_token: 'pre-exchanged-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      connection_method: 'coexist',
    }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('coexistence_not_ready');

    // PROOF: zero provider calls — no token exchange, no phone registration, no webhook subscription
    expect(mockFetch).not.toHaveBeenCalled();

    // PROOF: zero candidate INSERTs
    expect(candidateInserts).toHaveLength(0);

    // PROOF: zero service client calls (no DB mutation beyond auth)
    expect(mockServiceFrom).not.toHaveBeenCalled();
    expect(mockServiceRpc).not.toHaveBeenCalled();
  });

  it('connection_method=coexistence (alternate spelling) returns 409 with zero mutations', async () => {
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeCallbackReq({
      business_id: 'biz-1',
      access_token: 'pre-exchanged-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      connection_method: 'coexistence',
    }));

    expect(res.status).toBe(409);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(candidateInserts).toHaveLength(0);
    expect(mockServiceFrom).not.toHaveBeenCalled();
  });

  it('unknown connection_method returns 400 with zero mutations', async () => {
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeCallbackReq({
      business_id: 'biz-1',
      access_token: 'pre-exchanged-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      connection_method: 'magicmethod',
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Unsupported connection method');

    // PROOF: zero provider calls
    expect(mockFetch).not.toHaveBeenCalled();
    expect(candidateInserts).toHaveLength(0);
    expect(mockServiceFrom).not.toHaveBeenCalled();
  });

  it('connection_method=transfer proceeds through standard flow (non-regression)', async () => {
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeCallbackReq({
      business_id: 'biz-1',
      access_token: 'pre-exchanged-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      connection_method: 'transfer',
    }));

    // Standard transfer should succeed (200) or at least proceed past the fence
    // into the business ownership check and provider flow
    expect(res.status).not.toBe(409); // Not coexist rejection
    expect(res.status).not.toBe(400); // Not unknown method rejection

    // PROOF: provider calls were made (fetch was invoked for phone info, registration, etc.)
    expect(mockFetch).toHaveBeenCalled();

    // PROOF: candidate was inserted (standard flow proceeds)
    expect(candidateInserts.length).toBeGreaterThan(0);
    expect(candidateInserts[0]).toMatchObject({
      business_id: 'biz-1',
      business_wa_method: 'transfer',
      connection_source: 'embedded_signup',
    });
  });

  it('missing connection_method defaults to standard transfer behavior (non-regression)', async () => {
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeCallbackReq({
      business_id: 'biz-1',
      access_token: 'pre-exchanged-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      // connection_method intentionally omitted
    }));

    // Should proceed as standard transfer
    expect(res.status).not.toBe(409);
    expect(res.status).not.toBe(400);

    // Provider calls were made (not blocked)
    expect(mockFetch).toHaveBeenCalled();

    // Candidate insert uses 'transfer' as default
    expect(candidateInserts.length).toBeGreaterThan(0);
    expect(candidateInserts[0]).toMatchObject({
      business_wa_method: 'transfer',
    });
  });

  it('unauthenticated request returns 401 regardless of connection_method', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const { POST } = await import('@/app/api/auth/facebook/callback/route');

    const res = await POST(makeCallbackReq({
      business_id: 'biz-1',
      access_token: 'pre-exchanged-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      connection_method: 'transfer',
    }));

    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(candidateInserts).toHaveLength(0);
  });

  // Document that server-owned signup nonces and Meta signed FINISH provenance
  // are required for future coexistence enablement. This is a code comment test
  // that verifies the route source contains the required documentation.
  it('coexist denial message references Meta eligibility verification and dedicated onboarding', async () => {
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeCallbackReq({
      business_id: 'biz-1',
      access_token: 'tok',
      waba_id: 'w1',
      phone_number_id: 'pn-1',
      connection_method: 'coexist',
    }));

    const body = await res.json();
    expect(body.message).toContain('Meta eligibility verification');
    expect(body.message).toContain('dedicated onboarding');
    expect(body.message).toContain('has not been changed');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Readiness API — executable tests with eq() predicate verification,
//    cross-tenant denial, and DB error handling (replaces string-matching)
// ─────────────────────────────────────────────────────────────────────────

// Separate mock setup for readiness route — uses its own mock functions
const mockReadinessGetUser = vi.fn();
const mockReadinessFrom = vi.fn();

// We need to re-import the readiness route because it uses the same mock
// for createClient. Instead, we'll test within the same mock infrastructure.

function makeReadinessReq(businessId?: string) {
  const url = businessId
    ? `http://localhost/api/whatsapp/business-app-connect/readiness?businessId=${businessId}`
    : 'http://localhost/api/whatsapp/business-app-connect/readiness';
  return new NextRequest(url);
}

const BUSINESS_ID = '00000000-0000-4000-8000-000000000123';

describe('#592 readiness API — executable route tests with eq() predicate verification', () => {
  const saved = {
    enabled: process.env.META_BUSINESS_APP_COEXISTENCE_ENABLED,
    config: process.env.NEXT_PUBLIC_META_BUSINESS_APP_COEXISTENCE_CONFIG_ID,
    transfer: process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    eqCalls = [];
    mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
    mockAuthClientFrom.mockImplementation(() => {
      const chain = dc({ id: BUSINESS_ID, country_code: 'NG' });
      return chain;
    });
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
    const res = await GET(makeReadinessReq('not-an-id'));
    expect(res.status).toBe(400);
    expect(mockAuthClientFrom).not.toHaveBeenCalled();
  });

  it('rejects missing business ID', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq());
    expect(res.status).toBe(400);
  });

  it('requires authenticated user before any DB query', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    expect(res.status).toBe(401);
    expect(mockAuthClientFrom).not.toHaveBeenCalled();
  });

  it('business query filters by both id and owner_id (eq() predicates)', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    await GET(makeReadinessReq(BUSINESS_ID));

    // Verify that eq() was called with the correct column/value pairs
    const idFilter = eqCalls.find(c => c.column === 'id' && c.value === BUSINESS_ID);
    const ownerFilter = eqCalls.find(c => c.column === 'owner_id' && c.value === 'owner-1');
    expect(idFilter).toBeDefined();
    expect(ownerFilter).toBeDefined();
  });

  it('cross-tenant denial: requesting readiness for a business you do not own returns 403', async () => {
    // Mock returns null — no matching business for this owner + business_id
    mockAuthClientFrom.mockImplementation(() => dc(null));

    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    expect(res.status).toBe(403);
  });

  it('DB error returns 503, not 403 or 200', async () => {
    mockAuthClientFrom.mockImplementation(() => dc(null, { error: { message: 'connection timeout' } }));

    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('unavailable');
  });

  // Gap 5: canConnect always false regardless of config state
  it('canConnect is ALWAYS false when config is fully enabled and configured', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.canConnect).toBe(false);
    expect(body.configured).toBe(true);
    // countryEligibility is always 'requires_meta_confirmation' — never 'eligible'
    expect(body.countryEligibility).toBe('requires_meta_confirmation');
    expect(body.appEligibility).toBe('requires_meta_confirmation');
  });

  it('canConnect is false when config is disabled', async () => {
    process.env.META_BUSINESS_APP_COEXISTENCE_ENABLED = 'false';
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.canConnect).toBe(false);
    expect(body.configured).toBe(false);
  });

  it('canConnect is false when coexist config reuses transfer config', async () => {
    process.env.NEXT_PUBLIC_META_BUSINESS_APP_COEXISTENCE_CONFIG_ID = '9999999999999999'; // same as transfer
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.canConnect).toBe(false);
    expect(body.reason).toBe('reused_transfer_configuration');
  });

  it('canConnect is false when coexist config is missing', async () => {
    delete process.env.NEXT_PUBLIC_META_BUSINESS_APP_COEXISTENCE_CONFIG_ID;
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.canConnect).toBe(false);
  });

  it('response sets Cache-Control: no-store', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('never makes Meta API calls or provider mutations', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    await GET(makeReadinessReq(BUSINESS_ID));

    // No fetch calls to Meta Graph API
    expect(mockFetch).not.toHaveBeenCalled();

    // No service client calls (no admin/bypass-RLS operations)
    expect(mockServiceFrom).not.toHaveBeenCalled();
    expect(mockServiceRpc).not.toHaveBeenCalled();
  });

  it('includes warning about not connecting through standard transfer', async () => {
    const { GET } = await import('@/app/api/whatsapp/business-app-connect/readiness/route');
    const res = await GET(makeReadinessReq(BUSINESS_ID));
    const body = await res.json();
    expect(body.warning).toContain('standard transfer');
  });
});
