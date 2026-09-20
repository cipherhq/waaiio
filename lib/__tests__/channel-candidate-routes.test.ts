/**
 * Real route-handler + onboarding orchestration tests (#346 R12/R13).
 *
 * Executes actual POST() handlers with mocked Supabase + provider deps.
 * M1: Free register->verify with activate_trial_if_eligible
 * M2: Paid register->subscribe with Paystack checkout
 * M3: FB callback ordering + cross-business conflict
 * M4: Decrypt-failure PIN
 * OTP request/verify/resend lifecycle
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- Mock infrastructure ---

const mockGetUser = vi.fn();
const mockAuthClientFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: mockGetUser }, from: mockAuthClientFrom }),
}));

let candidateInserts: Record<string, unknown>[] = [];
let candidateUpdates: Record<string, unknown>[] = [];
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let lastBusinessInsert: Record<string, unknown> | null = null;
let eventLog: string[] = [];

// Deep auto-chain for Supabase queries
function dc(data: unknown): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  for (const m of ['eq','neq','in','gt','lt','gte','lte','limit','order','select','update','insert','delete','is','or','not','filter','upsert']) s[m] = () => s;
  s.single = () => Promise.resolve({ data, error: null });
  s.maybeSingle = () => Promise.resolve({ data, error: null });
  return s;
}

const defaultBiz = {
  id: 'biz-1', name: 'Test', owner_id: 'user-1', country_code: 'NG', address: '1 St',
  assigned_channel_id: null, whatsapp_channel_id: null, wa_method: 'shared',
  status: 'pending', subscription_tier: 'free', category: 'salon', bot_code: 'TC', slug: 'tc',
};

const mockServiceFrom = vi.fn((table: string) => {
  if (table === 'whatsapp_channel_candidates') {
    const eqChain = (): Record<string, unknown> => ({
      eq: eqChain, in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
      single: () => Promise.resolve({
        data: {
          id: 'cand-test', phone_number_id: 'pn-1', phone_number: '+234900',
          display_name: 'Test', waba_id: 'w1', encrypted_registration_pin: 'enc:123456',
          provider_state: { phone_added: true, otp_requested: true },
          connection_source: 'waaiio_hosted', status: 'validating',
        },
        error: null,
      }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    });
    return {
      insert: (data: Record<string, unknown>) => {
        candidateInserts.push(data); eventLog.push('candidate_insert');
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'cand-test' }, error: null }) }) };
      },
      update: (data: Record<string, unknown>) => ({
        eq: () => { candidateUpdates.push(data); return Promise.resolve({ error: null }); },
      }),
      select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), eq: eqChain }) }),
    };
  }
  if (table === 'businesses') {
    return {
      select: (_c?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head || opts?.count) return dc(null);
        return dc(defaultBiz);
      },
      insert: (data: Record<string, unknown>) => {
        lastBusinessInsert = data;
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'biz-new', bot_code: 'TC', slug: 'tc' }, error: null }) }) };
      },
      update: () => dc(null),
    };
  }
  if (table === 'whatsapp_channels') return { select: () => dc(null) };
  if (table === 'countries') return { select: () => ({ eq: () => Promise.resolve({ data: [{ code: 'NG', dialing_code: '+234' }], error: null }) }) };
  if (table === 'business_capabilities') return { select: () => ({ eq: () => Promise.resolve({ data: [{ capability: 'chat', is_enabled: true }], error: null }) }) };
  if (table === 'subscriptions') return { select: () => dc(null), upsert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'sub-1' }, error: null }) }) }), update: () => dc(null) };
  if (table === 'whatsapp_config') return { insert: () => Promise.resolve({ error: null }) };
  if (table === 'category_templates') return { select: () => dc(null) };
  if (table === 'profiles') return { select: () => dc({ role: 'restaurant_owner' }), update: () => dc(null) };
  return { select: () => dc(null), update: () => dc(null), insert: () => dc(null), upsert: () => dc(null) };
});

const mockServiceRpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
  rpcCalls.push({ fn, args });
  if (fn === 'check_phone_conflict') return { data: { conflict: false }, error: null };
  if (fn === 'promote_channel_candidate') return { data: { ok: true, channel_id: 'ch-new', action: 'first_connect' }, error: null };
  if (fn === 'activate_trial_if_eligible') return { data: { activated: true }, error: null };
  return { data: null, error: null };
});

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: mockServiceFrom, rpc: mockServiceRpc }),
}));

vi.mock('@/lib/encryption', () => ({
  encryptToken: (v: string) => `enc:${v}`,
  decryptToken: (v: string) => { if (v === 'CORRUPT') throw new Error('decrypt failed'); return v.startsWith('enc:') ? v.slice(4) : v; },
}));

vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: vi.fn(() => Promise.resolve(null)), getRateLimitKey: (_r: Request, p: string) => `${p}:127.0.0.1` }));
vi.mock('@/lib/categoryConfig', () => ({ loadCategories: () => Promise.resolve(), getAllCategoryKeys: () => ['salon'] }));
vi.mock('@/lib/capabilities/service', () => ({ initCapabilities: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/onboarding/finalize', () => ({ finalizeOnboarding: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/constants', () => ({
  generateSlug: () => 'ts', generateBotCode: () => 'TC', CATEGORY_FLOW_MAP: {},
  PRICING_TIERS: { free: { name: 'Free', price: 0 }, growth: { name: 'Pro', price: 5000 }, business: { name: 'Premium', price: 15000 } },
}));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/email/templates', () => ({ welcomeEmail: () => ({ subject: 'x', html: 'x' }), businessRegisteredEmail: () => ({ subject: 'x', html: 'x' }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: () => Promise.resolve({ max_businesses_per_user: 5 }) }));
vi.mock('@/lib/observability/server-events', () => ({ emitServerEvent: vi.fn() }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeReq(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
  });
}

function resetAll() {
  vi.resetAllMocks();
  candidateInserts = []; candidateUpdates = []; rpcCalls = []; lastBusinessInsert = null; eventLog = [];
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 't@t.com' } } });
  mockAuthClientFrom.mockImplementation(() => ({ select: () => dc(defaultBiz) }));
  process.env.META_CLOUD_WABA_ID = 'waba-test';
  process.env.META_CLOUD_ACCESS_TOKEN = 'token-test';
  process.env.META_GRAPH_API_VERSION = 'v22.0';
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('/phone_numbers')) return { ok: true, json: async () => ({ id: 'pn-new', data: [{ id: 'pn-1', display_phone_number: '+234900', verified_name: 'Test' }] }) };
    if (String(url).includes('/request_code')) return { ok: true, json: async () => ({ success: true }) };
    if (String(url).includes('/verify_code')) return { ok: true, json: async () => ({ success: true }) };
    if (String(url).includes('/register')) { eventLog.push('provider_register'); return { ok: true, json: async () => ({ success: true }) }; }
    if (String(url).includes('subscribed_apps')) return { ok: true, json: async () => ({ success: true }) };
    if (String(url).includes('oauth/access_token')) return { ok: true, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) };
    if (String(url).includes('debug_token')) return { ok: true, json: async () => ({ data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['waba-1'] }] } }) };
    if (String(url).includes('pn-1') && !String(url).includes('register') && !String(url).includes('request_code')) return { ok: true, json: async () => ({ display_phone_number: '+234900', verified_name: 'Test' }) };
    return { ok: true, json: async () => ({}), text: async () => '' };
  });
}

// --- OTP Route Tests ---

describe('OTP add-number handler', () => {
  beforeEach(resetAll);

  it('request: candidate INSERT before Meta fetch', async () => {
    const { POST } = await import('@/app/api/whatsapp/add-number/route');
    const res = await POST(makeReq('/api/whatsapp/add-number', { business_id: 'biz-1', phone_number: '+234900', display_name: 'T' }));
    expect(res.status).toBe(200);
    expect(candidateInserts.length).toBe(1);
    expect(candidateInserts[0].connection_source).toBe('waaiio_hosted');
    expect(candidateInserts[0].status).toBe('pending');
    expect(rpcCalls.find(c => c.fn === 'check_phone_conflict')).toBeDefined();
  });

  it('#349: fresh add sends migrate_phone_number=false to Meta', async () => {
    const { POST } = await import('@/app/api/whatsapp/add-number/route');
    const res = await POST(makeReq('/api/whatsapp/add-number', { business_id: 'biz-1', phone_number: '+12025579406', display_name: 'Test' }));
    expect(res.status).toBe(200);

    // Find the POST call to /{WABA_ID}/phone_numbers
    const addCall = mockFetch.mock.calls.find((c: unknown[]) => String(c[0]).includes('/phone_numbers'));
    expect(addCall).toBeDefined();

    // Parse the request body to verify migrate_phone_number
    const fetchOpts = addCall![1] as { body?: string };
    const body = JSON.parse(fetchOpts.body || '{}');
    expect(body.migrate_phone_number).toBe(false);
  });

  it('#349 regression: Meta error 100 migrate_phone_number must be false does not recur', async () => {
    // Simulate Meta returning the exact error from #349
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/phone_numbers')) {
        return {
          ok: false,
          json: async () => ({ error: { message: '(#100) Param migrate_phone_number must be false.', type: 'OAuthException', code: 100 } }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { POST } = await import('@/app/api/whatsapp/add-number/route');
    const res = await POST(makeReq('/api/whatsapp/add-number', { business_id: 'biz-1', phone_number: '+12025579406', display_name: 'Test' }));

    // The route should NOT send migrate_phone_number=true, so this error should not occur
    // in normal production. But if Meta rejects for any other reason, candidate should be marked failed.
    expect(res.status).toBe(400);
    expect(candidateUpdates.some(u => u.status === 'failed')).toBe(true);

    // Verify the source code uses false, not true, for migrate_phone_number
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const routeSource = readFileSync(join(process.cwd(), 'app/api/whatsapp/add-number/route.ts'), 'utf-8');
    // Check the entire file for the migrate flag
    expect(routeSource).toContain('migrate_phone_number: false');
    expect(routeSource).not.toMatch(/migrate_phone_number:\s*true/);
  });

  it('request: provider failure marks candidate failed', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/phone_numbers')) return { ok: false, json: async () => ({ error: { message: 'fail' } }) };
      return { ok: true, json: async () => ({}) };
    });
    const { POST } = await import('@/app/api/whatsapp/add-number/route');
    const res = await POST(makeReq('/api/whatsapp/add-number', { business_id: 'biz-1', phone_number: '+234900' }));
    expect(res.status).toBe(400);
    expect(candidateUpdates.some(u => u.status === 'failed')).toBe(true);
  });

  it('resend: reuses candidate, no INSERT', async () => {
    const { POST } = await import('@/app/api/whatsapp/add-number/route');
    const res = await POST(makeReq('/api/whatsapp/add-number?action=resend', { business_id: 'biz-1', candidate_id: 'cand-test' }));
    expect(res.status).toBe(200);
    expect(candidateInserts.length).toBe(0);
  });

  it('verify: rejects missing candidate_id', async () => {
    const { POST } = await import('@/app/api/whatsapp/add-number/route');
    const res = await POST(makeReq('/api/whatsapp/add-number?action=verify', { business_id: 'biz-1', otp: '123456' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('candidate_id');
  });

  it('verify: registration failure -> failed, no promotion', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/verify_code')) return { ok: true, json: async () => ({ success: true }) };
      if (String(url).includes('/register')) return { ok: false, json: async () => ({ error: { message: 'reg fail' } }) };
      return { ok: true, json: async () => ({ success: true }) };
    });
    const { POST } = await import('@/app/api/whatsapp/add-number/route');
    const res = await POST(makeReq('/api/whatsapp/add-number?action=verify', { business_id: 'biz-1', otp: '123456', candidate_id: 'cand-test' }));
    expect(res.status).toBe(422);
    expect(candidateUpdates.some(u => u.status === 'failed')).toBe(true);
    expect(rpcCalls.find(c => c.fn === 'promote_channel_candidate')).toBeUndefined();
  });

  it('verify: webhook failure -> failed, no promotion', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/verify_code')) return { ok: true, json: async () => ({ success: true }) };
      if (String(url).includes('/register')) return { ok: true, json: async () => ({ success: true }) };
      if (String(url).includes('subscribed_apps')) return { ok: false, json: async () => ({ success: false }) };
      return { ok: true, json: async () => ({}) };
    });
    const { POST } = await import('@/app/api/whatsapp/add-number/route');
    const res = await POST(makeReq('/api/whatsapp/add-number?action=verify', { business_id: 'biz-1', otp: '123456', candidate_id: 'cand-test' }));
    expect(res.status).toBe(422);
    expect(rpcCalls.find(c => c.fn === 'promote_channel_candidate')).toBeUndefined();
  });

  it('verify: success -> promotion RPC called', async () => {
    const { POST } = await import('@/app/api/whatsapp/add-number/route');
    const res = await POST(makeReq('/api/whatsapp/add-number?action=verify', { business_id: 'biz-1', otp: '123456', candidate_id: 'cand-test' }));
    expect(res.status).toBe(200);
    const promo = rpcCalls.find(c => c.fn === 'promote_channel_candidate');
    expect(promo).toBeDefined();
    expect(promo!.args.p_candidate_id).toBe('cand-test');
  });
});

// --- M4: Decrypt-failure PIN ---

describe('K2/M4: encrypted PIN fail-closed', () => {
  beforeEach(resetAll);

  it('M4: null PIN -> 422, Meta register NOT called', async () => {
    // Override candidate mock to return null PIN
    const eqChain = (): Record<string, unknown> => ({
      eq: eqChain,
      single: () => Promise.resolve({
        data: { id: 'cand-nopin', phone_number_id: 'pn-1', phone_number: '+234900', display_name: 'T', waba_id: 'w1', encrypted_registration_pin: null, provider_state: {}, connection_source: 'waaiio_hosted', status: 'validating' },
        error: null,
      }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'whatsapp_channel_candidates') return {
        select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), eq: eqChain }) }),
        update: (data: Record<string, unknown>) => ({ eq: () => { candidateUpdates.push(data); return Promise.resolve({ error: null }); } }),
      };
      if (table === 'businesses') return { select: () => dc({ id: 'biz-1', owner_id: 'user-1' }) };
      return { select: () => dc(null) };
    });

    const { POST } = await import('@/app/api/whatsapp/add-number/route');
    const res = await POST(makeReq('/api/whatsapp/add-number?action=verify', { business_id: 'biz-1', otp: '123456', candidate_id: 'cand-nopin' }));
    expect(res.status).toBe(422);
    expect(candidateUpdates.some(u => u.status === 'failed')).toBe(true);
    expect(mockFetch.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/register')).length).toBe(0);
  });

  it('M4: corrupt/decrypt-fail PIN -> 422, Meta register NOT called', async () => {
    const eqChain = (): Record<string, unknown> => ({
      eq: eqChain,
      single: () => Promise.resolve({
        data: { id: 'cand-corrupt', phone_number_id: 'pn-1', phone_number: '+234900', display_name: 'T', waba_id: 'w1', encrypted_registration_pin: 'CORRUPT', provider_state: {}, connection_source: 'waaiio_hosted', status: 'validating' },
        error: null,
      }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'whatsapp_channel_candidates') return {
        select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), eq: eqChain }) }),
        update: (data: Record<string, unknown>) => ({ eq: () => { candidateUpdates.push(data); return Promise.resolve({ error: null }); } }),
      };
      if (table === 'businesses') return { select: () => dc({ id: 'biz-1', owner_id: 'user-1' }) };
      return { select: () => dc(null) };
    });

    const { POST } = await import('@/app/api/whatsapp/add-number/route');
    const res = await POST(makeReq('/api/whatsapp/add-number?action=verify', { business_id: 'biz-1', otp: '123456', candidate_id: 'cand-corrupt' }));
    expect(res.status).toBe(422);
    expect(candidateUpdates.some(u => u.status === 'failed')).toBe(true);
    expect(mockFetch.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/register')).length).toBe(0);
  });
});

// --- M3: Facebook callback ---

describe('Facebook callback handler', () => {
  beforeEach(resetAll);

  it('M3: candidate INSERT before provider_register (ordering proof)', async () => {
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeReq('/api/auth/facebook/callback', {
      business_id: 'biz-1', access_token: 'test-token', waba_id: 'waba-1', phone_number_id: 'pn-1',
    }));
    expect(candidateInserts.length).toBeGreaterThanOrEqual(1);
    expect(candidateInserts[0].connection_source).toBe('embedded_signup');
    // Ordering: candidate_insert must appear before provider_register in eventLog
    const insertIdx = eventLog.indexOf('candidate_insert');
    const registerIdx = eventLog.indexOf('provider_register');
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(registerIdx).toBeGreaterThan(insertIdx);
    // Promotion called
    expect(rpcCalls.find(c => c.fn === 'promote_channel_candidate')).toBeDefined();
  });

  it('registration failure: candidate failed, no promotion', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('oauth/access_token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      if (String(url).includes('debug_token')) return { ok: true, json: async () => ({ data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['waba-1'] }] } }) };
      if (String(url).includes('phone_numbers')) return { ok: true, json: async () => ({ data: [{ id: 'pn-1', display_phone_number: '+234900' }] }) };
      if (String(url).includes('pn-1') && !String(url).includes('register')) return { ok: true, json: async () => ({ display_phone_number: '+234900' }) };
      if (String(url).includes('/register')) throw new Error('registration failed');
      return { ok: true, json: async () => ({ success: true }), text: async () => '' };
    });
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeReq('/api/auth/facebook/callback', { business_id: 'biz-1', access_token: 'tok', waba_id: 'waba-1', phone_number_id: 'pn-1' }));
    expect(res.status).toBe(422);
    expect(candidateUpdates.some(u => u.status === 'failed')).toBe(true);
    expect(rpcCalls.find(c => c.fn === 'promote_channel_candidate')).toBeUndefined();
  });

  it('webhook failure: candidate failed, no promotion', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('oauth/access_token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
      if (String(url).includes('debug_token')) return { ok: true, json: async () => ({ data: { granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['waba-1'] }] } }) };
      if (String(url).includes('phone_numbers')) return { ok: true, json: async () => ({ data: [{ id: 'pn-1', display_phone_number: '+234900' }] }) };
      if (String(url).includes('pn-1') && !String(url).includes('register')) return { ok: true, json: async () => ({ display_phone_number: '+234900' }) };
      if (String(url).includes('/register')) { eventLog.push('provider_register'); return { ok: true, json: async () => ({ success: true }) }; }
      if (String(url).includes('subscribed_apps')) throw new Error('webhook failed');
      return { ok: true, json: async () => ({}), text: async () => '' };
    });
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeReq('/api/auth/facebook/callback', { business_id: 'biz-1', access_token: 'tok', waba_id: 'waba-1', phone_number_id: 'pn-1' }));
    expect(res.status).toBe(422);
    expect(candidateUpdates.some(u => u.status === 'failed')).toBe(true);
    expect(rpcCalls.find(c => c.fn === 'promote_channel_candidate')).toBeUndefined();
  });

  it('cross-source conflict: 409 before provider mutation', async () => {
    mockServiceRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'check_phone_conflict') return { data: { conflict: true, reason: 'cross_source_migration_unsupported' }, error: null };
      return { data: null, error: null };
    });
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeReq('/api/auth/facebook/callback', { business_id: 'biz-1', access_token: 'tok', waba_id: 'waba-1', phone_number_id: 'pn-1' }));
    expect(res.status).toBe(409);
    expect(candidateInserts.length).toBe(0);
    expect(rpcCalls.find(c => c.fn === 'promote_channel_candidate')).toBeUndefined();
  });

  it('M3: cross-business same-phone: 409 before provider mutation', async () => {
    mockServiceRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'check_phone_conflict') return { data: { conflict: true, reason: 'phone_owned_by_other_business' }, error: null };
      return { data: null, error: null };
    });
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeReq('/api/auth/facebook/callback', { business_id: 'biz-1', access_token: 'tok', waba_id: 'waba-1', phone_number_id: 'pn-1' }));
    expect(res.status).toBe(409);
    expect(candidateInserts.length).toBe(0);
    // No /register or /subscribed_apps calls
    expect(mockFetch.mock.calls.filter((c: unknown[]) => String(c[0]).includes('/register')).length).toBe(0);
    expect(mockFetch.mock.calls.filter((c: unknown[]) => String(c[0]).includes('subscribed_apps')).length).toBe(0);
  });
});

// --- M1: Free register -> verify ---

describe('M1: Free register -> verify orchestration', () => {
  beforeEach(resetAll);

  it('register enforces wa_method=shared, verify calls activate_trial_if_eligible', async () => {
    // Step 1: Register
    const { POST: registerPost } = await import('@/app/api/onboarding/register/route');
    const regRes = await registerPost(makeReq('/api/onboarding/register', {
      first_name: 'T', last_name: 'U', name: 'Test', city: 'Lagos',
      address: '1 St', phone: '+2341234567890', category: 'salon', country: 'NG',
      wa_method: 'transfer',
    }));
    expect(regRes.status).toBe(200);
    expect(lastBusinessInsert!.wa_method).toBe('shared');

    // Step 2: Verify — reconfigure mocks for the 600+ line verify route
    mockAuthClientFrom.mockImplementation(() => ({ select: () => dc(defaultBiz) }));
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') return { select: () => dc(defaultBiz), update: () => dc(null) };
      if (table === 'business_capabilities') return { select: () => ({ eq: () => Promise.resolve({ data: [{ capability: 'chat', is_enabled: true }], error: null }) }) };
      if (table === 'subscriptions') return { select: () => dc(null), upsert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'sub-1' }, error: null }) }) }), update: () => dc(null) };
      return { select: () => dc(null), update: () => dc(null), insert: () => dc(null), upsert: () => dc(null) };
    });
    rpcCalls = [];
    mockServiceRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: fn === 'activate_trial_if_eligible' ? { activated: true } : null, error: null };
    });
    const { finalizeOnboarding } = await import('@/lib/onboarding/finalize');
    (finalizeOnboarding as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { POST: verifyPost } = await import('@/app/api/onboarding/verify/route');
    const verifyRes = await verifyPost(makeReq('/api/onboarding/verify', { business_id: 'biz-new', plan: 'free' }));

    expect(verifyRes.status).toBe(200);
    const trialCall = rpcCalls.find(c => c.fn === 'activate_trial_if_eligible');
    expect(trialCall).toBeDefined();
    expect(trialCall!.args.p_business_id).toBe('biz-new');
    // No paid checkout
    expect(mockFetch.mock.calls.filter((c: unknown[]) => String(c[0]).includes('paystack')).length).toBe(0);
  });
});

// --- M2: Paid register -> subscribe ---

describe('M2: Paid register -> subscribe orchestration', () => {
  beforeEach(resetAll);

  it('register creates free/pending, subscribe invokes Paystack, no trial', async () => {
    // Register
    const { POST: registerPost } = await import('@/app/api/onboarding/register/route');
    const regRes = await registerPost(makeReq('/api/onboarding/register', {
      first_name: 'T', last_name: 'U', name: 'PaidBiz', city: 'Lagos',
      address: '1 St', phone: '+2341234567890', category: 'salon', country: 'NG',
    }));
    expect(regRes.status).toBe(200);
    expect(lastBusinessInsert!.subscription_tier).toBe('free');
    expect(rpcCalls.find(c => c.fn === 'activate_trial_if_eligible')).toBeUndefined();

    // Reconfigure for subscribe route
    process.env.PAYSTACK_SECRET_KEY = 'test_only_not_real';
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
    const countryData = { code: 'NG', pricing: { growth: { price: 5000, provider_plan_refs: { paystack: 'PLN_test' } } }, currency_code: 'NGN', payment_gateway: 'paystack' };
    // Auth client needs to return business AND profile
    mockAuthClientFrom.mockImplementation((table: string) => {
      if (table === 'businesses') return { select: () => dc({ id: 'biz-new', owner_id: 'user-1', country_code: 'NG' }) };
      if (table === 'profiles') return { select: () => dc({ email: 'test@test.com', phone: '+234900' }) };
      return { select: () => dc(null) };
    });
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'countries') return { select: () => dc(countryData) };
      if (table === 'subscription_checkout_intents') return { insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'intent-1' }, error: null }) }) }) };
      return { select: () => dc(null) };
    });
    rpcCalls = [];

    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('api.paystack.co/transaction/initialize')) {
        return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://paystack.co/pay/test', reference: 'ref-1' } }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const { POST: subscribePost } = await import('@/app/api/onboarding/subscribe/route');
    const subRes = await subscribePost(makeReq('/api/onboarding/subscribe', { business_id: 'biz-new', plan: 'growth', billing_interval: 'month' }));

    expect(subRes.status).toBe(200);
    const subData = await subRes.json();
    expect(subData.authorization_url).toBe('https://paystack.co/pay/test');
    // Paystack was called
    expect(mockFetch.mock.calls.some((c: unknown[]) => String(c[0]).includes('api.paystack.co/transaction/initialize'))).toBe(true);
    // Trial NOT called
    expect(rpcCalls.find(c => c.fn === 'activate_trial_if_eligible')).toBeUndefined();
  });
});
