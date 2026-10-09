/**
 * #592 Transfer non-regression — end-to-end proof
 *
 * Proves the coexistence fence introduced in #592 does NOT break the standard
 * transfer/embedded-signup path. Exercises the actual POST handler with mocked
 * Supabase + Meta provider dependencies and asserts:
 *
 *   SUCCESS PATH:
 *   - HTTP 200 (not just "not 409")
 *   - promote_channel_candidate RPC called with correct candidate + business IDs
 *   - Response contains activated channel data (channel_id, connection_status, display_name, phone_number)
 *
 *   NEGATIVE PATH (registration failure):
 *   - HTTP error status (422)
 *   - promote_channel_candidate NOT called
 *   - Candidate marked failed
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock infrastructure ──

const mockGetUser = vi.fn();
const mockAuthClientFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: mockGetUser }, from: mockAuthClientFrom }),
}));

let candidateInserts: Record<string, unknown>[] = [];
let candidateUpdates: Record<string, unknown>[] = [];
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

function dc(data: unknown): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  for (const m of ['eq','neq','in','gt','lt','gte','lte','limit','order','select','update','insert','delete','is','or','not','filter','upsert']) s[m] = () => s;
  s.single = () => Promise.resolve({ data, error: null });
  s.maybeSingle = () => Promise.resolve({ data, error: null });
  return s;
}

const defaultBiz = {
  id: 'biz-1', name: 'TestBiz', owner_id: 'user-1', country_code: 'NG', address: '1 Lagos St',
  assigned_channel_id: null, whatsapp_channel_id: null, wa_method: 'shared', status: 'pending',
};

const PROMOTED_CHANNEL_ID = 'ch-promoted-abc';

const mockServiceFrom = vi.fn((table: string) => {
  if (table === 'whatsapp_channel_candidates') {
    return {
      insert: (data: Record<string, unknown>) => {
        candidateInserts.push(data);
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'cand-592' }, error: null }) }) };
      },
      update: (data: Record<string, unknown>) => ({
        eq: () => { candidateUpdates.push(data); return Promise.resolve({ error: null }); },
      }),
      select: () => dc(null),
    };
  }
  if (table === 'whatsapp_channels') return { select: () => dc(null) };
  if (table === 'admin_onboarding_invites') return { select: () => dc(null) };
  if (table === 'admin_audit_logs') return { insert: () => Promise.resolve({ error: null }) };
  return { select: () => dc(null), update: () => dc(null), insert: () => dc(null) };
});

const mockServiceRpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
  rpcCalls.push({ fn, args });
  if (fn === 'check_phone_conflict') return { data: { conflict: false }, error: null };
  if (fn === 'promote_channel_candidate') return { data: { ok: true, channel_id: PROMOTED_CHANNEL_ID, action: 'first_connect' }, error: null };
  if (fn === 'reconcile_paid_allowance') return { data: null, error: null };
  return { data: null, error: null };
});

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: mockServiceFrom, rpc: mockServiceRpc }),
}));

vi.mock('@/lib/encryption', () => ({
  encryptToken: (v: string) => `enc:${v}`,
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn(() => Promise.resolve(null)),
  getRateLimitKey: (_r: Request, p: string) => `${p}:127.0.0.1`,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeReq(body: Record<string, unknown>) {
  return new NextRequest(new URL('/api/auth/facebook/callback', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
  });
}

function resetAll() {
  vi.resetAllMocks();
  candidateInserts = [];
  candidateUpdates = [];
  rpcCalls = [];

  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 't@t.com' } } });
  mockAuthClientFrom.mockImplementation(() => ({ select: () => dc(defaultBiz) }));

  process.env.META_GRAPH_API_VERSION = 'v22.0';

  // Default: all Meta provider calls succeed
  mockFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/register')) return { ok: true, json: async () => ({ success: true }) };
    if (u.includes('subscribed_apps')) return { ok: true, json: async () => ({ success: true }) };
    if (u.includes('pn-1') && !u.includes('/register')) return { ok: true, json: async () => ({ display_phone_number: '+2349001234567', verified_name: 'TestBiz', quality_rating: 'GREEN', messaging_limit: 'TIER_1K' }) };
    if (u.includes('whatsapp_business_profile')) return { ok: true, json: async () => ({ success: true }) };
    return { ok: true, json: async () => ({}), text: async () => '' };
  });
}

// ── Tests ──

describe('#592 transfer non-regression — end-to-end route handler proof', () => {
  beforeEach(resetAll);

  it('connection_method="transfer": HTTP 200 with activated channel in response', async () => {
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeReq({
      business_id: 'biz-1',
      access_token: 'test-long-lived-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      connection_method: 'transfer',
    }));

    // Exact HTTP status — not "not 409", but exactly 200
    expect(res.status).toBe(200);

    // Response body contains activated channel data
    const body = await res.json();
    expect(body.channel_id).toBe(PROMOTED_CHANNEL_ID);
    expect(body.connection_status).toBe('active');
    expect(body.message).toBe('WhatsApp number connected successfully');
    expect(body.display_name).toBe('TestBiz');
    expect(body.phone_number).toBe('+2349001234567');
  });

  it('connection_method="transfer": promote_channel_candidate called with correct IDs', async () => {
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    await POST(makeReq({
      business_id: 'biz-1',
      access_token: 'test-long-lived-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      connection_method: 'transfer',
    }));

    const promo = rpcCalls.find(c => c.fn === 'promote_channel_candidate');
    expect(promo).toBeDefined();
    expect(promo!.args.p_candidate_id).toBe('cand-592');
    expect(promo!.args.p_business_id).toBe('biz-1');
  });

  it('omitted connection_method (undefined): HTTP 200, full promotion chain', async () => {
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeReq({
      business_id: 'biz-1',
      access_token: 'test-long-lived-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      // connection_method intentionally omitted
    }));

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.channel_id).toBe(PROMOTED_CHANNEL_ID);
    expect(body.connection_status).toBe('active');

    // Promotion RPC called with correct IDs
    const promo = rpcCalls.find(c => c.fn === 'promote_channel_candidate');
    expect(promo).toBeDefined();
    expect(promo!.args.p_candidate_id).toBe('cand-592');
    expect(promo!.args.p_business_id).toBe('biz-1');

    // Candidate was inserted with embedded_signup source
    expect(candidateInserts.length).toBe(1);
    expect(candidateInserts[0].connection_source).toBe('embedded_signup');
  });

  it('candidate marked ready before promotion', async () => {
    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    await POST(makeReq({
      business_id: 'biz-1',
      access_token: 'test-long-lived-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      connection_method: 'transfer',
    }));

    // Candidate goes through validating -> ready before promotion
    const validatingUpdate = candidateUpdates.find(u => u.status === 'validating');
    const readyUpdate = candidateUpdates.find(u => u.status === 'ready');
    expect(validatingUpdate).toBeDefined();
    expect(readyUpdate).toBeDefined();

    // No failed status
    expect(candidateUpdates.find(u => u.status === 'failed')).toBeUndefined();
  });
});

describe('#592 transfer negative path — failed registration blocks promotion', () => {
  beforeEach(resetAll);

  it('registerPhoneNumber throws: HTTP 422, no promote_channel_candidate call', async () => {
    // Make registration fail
    mockFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/register')) throw new Error('Meta registration failed: invalid PIN');
      if (u.includes('pn-1')) return { ok: true, json: async () => ({ display_phone_number: '+2349001234567', verified_name: 'TestBiz' }) };
      return { ok: true, json: async () => ({}), text: async () => '' };
    });

    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeReq({
      business_id: 'biz-1',
      access_token: 'test-long-lived-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      connection_method: 'transfer',
    }));

    // Error status — NOT 200
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.error).toContain('Phone registration failed');
    expect(body.recoverable).toBe(true);

    // promote_channel_candidate MUST NOT be called on failure
    const promo = rpcCalls.find(c => c.fn === 'promote_channel_candidate');
    expect(promo).toBeUndefined();

    // Candidate is marked failed
    expect(candidateUpdates.some(u => u.status === 'failed')).toBe(true);
    const failedUpdate = candidateUpdates.find(u => u.status === 'failed');
    expect(failedUpdate!.failure_reason).toContain('Phone registration failed');
  });

  it('webhook subscription fails: HTTP 422, no promotion', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/register')) return { ok: true, json: async () => ({ success: true }) };
      if (u.includes('subscribed_apps')) throw new Error('Webhook subscription network error');
      if (u.includes('pn-1') && !u.includes('/register')) return { ok: true, json: async () => ({ display_phone_number: '+2349001234567', verified_name: 'TestBiz' }) };
      return { ok: true, json: async () => ({}), text: async () => '' };
    });

    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeReq({
      business_id: 'biz-1',
      access_token: 'test-long-lived-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      connection_method: 'transfer',
    }));

    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.error).toContain('webhook subscription failed');

    // No promotion on webhook failure
    expect(rpcCalls.find(c => c.fn === 'promote_channel_candidate')).toBeUndefined();

    // Candidate marked failed
    expect(candidateUpdates.some(u => u.status === 'failed')).toBe(true);
  });

  it('promotion RPC itself fails: HTTP 409, candidate marked failed', async () => {
    mockServiceRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'check_phone_conflict') return { data: { conflict: false }, error: null };
      if (fn === 'promote_channel_candidate') return { data: { ok: false, reason: 'concurrent_mutation' }, error: null };
      return { data: null, error: null };
    });

    const { POST } = await import('@/app/api/auth/facebook/callback/route');
    const res = await POST(makeReq({
      business_id: 'biz-1',
      access_token: 'test-long-lived-token',
      waba_id: 'waba-1',
      phone_number_id: 'pn-1',
      connection_method: 'transfer',
    }));

    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toContain('Channel activation failed');

    // promote was called but failed — candidate should be marked failed
    const promo = rpcCalls.find(c => c.fn === 'promote_channel_candidate');
    expect(promo).toBeDefined();
    expect(candidateUpdates.some(u => u.status === 'failed')).toBe(true);
  });
});
