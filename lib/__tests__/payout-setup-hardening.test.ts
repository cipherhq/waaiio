/**
 * Payout setup hardening tests
 *
 * Tests proving:
 * 1. Non-owner is rejected (403/404)
 * 2. Account saved unverified when provider key missing
 * 3. Re-authentication is required (no password → 403, wrong password → 403)
 * 4. Browser client never writes payout_accounts (disconnect goes through API)
 * 5. Resolve route returns 503 when provider key is missing (no mock)
 * 6. Re-auth uses a separate non-persisting client, not the session client
 * 7. RPC error paths return 500 with no success response
 * 8. Missing/invalid RPC result treated as failure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Helpers ──

function makePostRequest(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockLogger() {
  const noop = (..._args: unknown[]) => {};
  return {
    error: noop, info: noop, debug: noop, warn: noop,
    withContext: () => ({ error: noop, info: noop, debug: noop, warn: noop }),
  };
}

function mockSupabaseChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {};
  ['select', 'eq', 'neq', 'in', 'is', 'update', 'insert', 'order', 'limit', 'delete'].forEach(m => {
    chain[m] = vi.fn().mockReturnValue(chain);
  });
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  Object.assign(chain, overrides);
  return chain;
}

function mockThrowawayClient(authSuccess: boolean) {
  vi.doMock('@supabase/supabase-js', () => ({
    createClient: vi.fn().mockReturnValue({
      auth: {
        signInWithPassword: vi.fn().mockResolvedValue(
          authSuccess ? { error: null } : { error: { message: 'Invalid credentials' } },
        ),
      },
    }),
  }));
}

function mockSessionClient(opts: {
  userId?: string | null;
  userEmail?: string;
  businessData?: Record<string, unknown> | null;
}) {
  const userId = opts.userId === undefined ? 'user-1' : opts.userId;
  const userEmail = opts.userEmail ?? 'user@test.com';

  vi.doMock('@/lib/supabase/server', () => ({
    createClient: vi.fn().mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: userId ? { id: userId, email: userEmail } : null },
        }),
      },
      from: vi.fn().mockImplementation(() => mockSupabaseChain({
        single: vi.fn().mockResolvedValue({
          data: opts.businessData ?? null,
          error: opts.businessData ? null : { message: 'not found' },
        }),
      })),
    }),
  }));
}

function mockServiceClient(rpcResult: { data: unknown; error: unknown }) {
  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: vi.fn().mockReturnValue({
      rpc: vi.fn().mockResolvedValue(rpcResult),
      from: vi.fn().mockImplementation(() => mockSupabaseChain()),
    }),
  }));
}

const BIZ_DATA = { id: 'biz-1', name: 'Test Biz', payout_mode: 'platform_managed', country_code: 'NG' };
const SETUP_BODY = {
  business_id: 'biz-1',
  gateway: 'paystack',
  bank_code: '058',
  account_number: '0123456789',
  account_name: 'Test',
  password: 'correct-pass',
};

// ═══════════════════════════════════════════════════════════
// Scope 1: Setup route — non-owner rejection
// ═══════════════════════════════════════════════════════════

describe('Payout setup: non-owner rejected', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    savedEnv.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('rejects when user does not own the business', async () => {
    mockThrowawayClient(true);
    mockSessionClient({ businessData: null }); // RLS returns nothing
    mockServiceClient({ data: 'payout-1', error: null });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const res = await mod.POST(makePostRequest('/api/payouts/setup', SETUP_BODY));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Business not found');
  });

  it('rejects unauthenticated users', async () => {
    mockThrowawayClient(true);
    mockSessionClient({ userId: null });
    mockServiceClient({ data: null, error: null });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const res = await mod.POST(makePostRequest('/api/payouts/setup', SETUP_BODY));
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 2: Setup route — re-auth required
// ═══════════════════════════════════════════════════════════

describe('Payout setup: re-auth required', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('returns 403 when password is missing', async () => {
    mockThrowawayClient(true);
    mockSessionClient({ businessData: BIZ_DATA });
    mockServiceClient({ data: 'id-1', error: null });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const { password: _, ...noPassword } = SETUP_BODY;
    const res = await mod.POST(makePostRequest('/api/payouts/setup', noPassword));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('Password required');
  });

  it('returns 403 when password is wrong', async () => {
    mockThrowawayClient(false);
    mockSessionClient({ businessData: BIZ_DATA });
    mockServiceClient({ data: 'id-1', error: null });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const res = await mod.POST(makePostRequest('/api/payouts/setup', { ...SETUP_BODY, password: 'wrong' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Incorrect password');
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 3: Setup route — unverified when no provider key
// ═══════════════════════════════════════════════════════════

describe('Payout setup: unverified when no provider key', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    savedEnv.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    savedEnv.FLUTTERWAVE_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('saves with verified = false when PAYSTACK_SECRET_KEY is missing', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    mockThrowawayClient(true);
    mockSessionClient({ businessData: BIZ_DATA });
    mockServiceClient({ data: 'new-id', error: null });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const res = await mod.POST(makePostRequest('/api/payouts/setup', SETUP_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 4: Setup route — RPC error paths
// ═══════════════════════════════════════════════════════════

describe('Payout setup: RPC error returns 500', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('returns 500 when swap_payout_account RPC fails', async () => {
    mockThrowawayClient(true);
    mockSessionClient({ businessData: BIZ_DATA });
    mockServiceClient({ data: null, error: { message: 'unique violation', code: '23505' } });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const res = await mod.POST(makePostRequest('/api/payouts/setup', SETUP_BODY));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to save payout account');
  });

  it('returns 500 when RPC returns null id', async () => {
    mockThrowawayClient(true);
    mockSessionClient({ businessData: BIZ_DATA });
    mockServiceClient({ data: null, error: null }); // no error but no id
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const res = await mod.POST(makePostRequest('/api/payouts/setup', SETUP_BODY));
    expect(res.status).toBe(500);
  });

  it('returns 500 when RPC raises a conflict (concurrent change)', async () => {
    mockThrowawayClient(true);
    mockSessionClient({ businessData: BIZ_DATA });
    mockServiceClient({ data: null, error: { message: 'could not serialize access', code: '40001' } });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const res = await mod.POST(makePostRequest('/api/payouts/setup', SETUP_BODY));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
  });

  it('returns 200 on happy path with valid RPC result', async () => {
    mockThrowawayClient(true);
    mockSessionClient({ businessData: BIZ_DATA });
    mockServiceClient({ data: 'new-payout-id', error: null });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const res = await mod.POST(makePostRequest('/api/payouts/setup', SETUP_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.payout_account_id).toBe('new-payout-id');
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 5: Disconnect route — server-side with ownership check
// ═══════════════════════════════════════════════════════════

describe('Payout disconnect: server-side with ownership check', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('rejects non-owner', async () => {
    mockThrowawayClient(true);
    mockSessionClient({ businessData: null });
    mockServiceClient({ data: null, error: null });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/disconnect/route');
    const res = await mod.POST(makePostRequest('/api/payouts/disconnect', { business_id: 'biz-1', password: 'pass' }));
    expect(res.status).toBe(404);
  });

  it('rejects without password', async () => {
    mockThrowawayClient(true);
    mockSessionClient({ businessData: { id: 'biz-1', name: 'Test' } });
    mockServiceClient({ data: null, error: null });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/disconnect/route');
    const res = await mod.POST(makePostRequest('/api/payouts/disconnect', { business_id: 'biz-1' }));
    expect(res.status).toBe(403);
  });

  it('rejects wrong password', async () => {
    mockThrowawayClient(false);
    mockSessionClient({ businessData: { id: 'biz-1', name: 'Test' } });
    mockServiceClient({ data: null, error: null });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/disconnect/route');
    const res = await mod.POST(makePostRequest('/api/payouts/disconnect', { business_id: 'biz-1', password: 'wrong' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Incorrect password');
  });

  it('returns 200 on happy path', async () => {
    mockThrowawayClient(true);
    mockSessionClient({ businessData: { id: 'biz-1', name: 'Test' } });
    mockServiceClient({ data: null, error: null }); // void RPC returns null data
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/disconnect/route');
    const res = await mod.POST(makePostRequest('/api/payouts/disconnect', { business_id: 'biz-1', password: 'pass' }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('returns 500 when disconnect RPC fails', async () => {
    mockThrowawayClient(true);
    mockSessionClient({ businessData: { id: 'biz-1', name: 'Test' } });
    mockServiceClient({ data: null, error: { message: 'business_not_found', code: 'P0001' } });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/disconnect/route');
    const res = await mod.POST(makePostRequest('/api/payouts/disconnect', { business_id: 'biz-1', password: 'pass' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 6: Resolve route — no mock when key missing
// ═══════════════════════════════════════════════════════════

describe('Payout resolve: no mock when key missing', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    savedEnv.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    savedEnv.FLUTTERWAVE_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  async function loadResolveRoute() {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'user-1', email: 'user@test.com' } },
          }),
        },
      }),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    return import('@/app/api/payouts/resolve/route');
  }

  it('returns 503 for paystack when PAYSTACK_SECRET_KEY is missing', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    const mod = await loadResolveRoute();
    const res = await mod.POST(makePostRequest('/api/payouts/resolve', {
      gateway: 'paystack', bank_code: '058', account_number: '0123456789',
    }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('not configured');
  });

  it('returns 400 unavailable for flutterwave even when its key is missing', async () => {
    delete process.env.FLUTTERWAVE_SECRET_KEY;
    const mod = await loadResolveRoute();
    const res = await mod.POST(makePostRequest('/api/payouts/resolve', {
      gateway: 'flutterwave', bank_code: '058', account_number: '0123456789',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Flutterwave is unavailable for new payout setup');
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 7: Dashboard page — no browser-side payout_accounts writes
// ═══════════════════════════════════════════════════════════

describe('Dashboard payouts page: no browser-side payout_accounts writes', () => {
  it('disconnect handler calls the API, not the browser supabase client', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'app/dashboard/payouts/page.tsx'),
      'utf-8',
    );

    expect(source).toContain('/api/payouts/disconnect');

    const disconnectSection = source.slice(
      source.indexOf('Disconnect payout account'),
      source.indexOf('Disconnect payout account') + 2000,
    );

    expect(disconnectSection).not.toMatch(/supabase\.from\(['"]payout_accounts['"]\)\.update/);
    expect(disconnectSection).not.toMatch(/supabase\.from\(['"]businesses['"]\)\.update/);
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 8: Re-auth uses throwaway client, not session client
// ═══════════════════════════════════════════════════════════

describe('Payout setup: re-auth uses throwaway client, not session client', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('setup route calls signInWithPassword on the throwaway client, not the session client', async () => {
    const throwawaySignIn = vi.fn().mockResolvedValue({ error: null });
    const sessionSignIn = vi.fn().mockResolvedValue({ error: null });

    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn().mockReturnValue({
        auth: { signInWithPassword: throwawaySignIn },
      }),
    }));

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'user-1', email: 'user@test.com' } },
          }),
          signInWithPassword: sessionSignIn,
        },
        from: vi.fn().mockImplementation(() => mockSupabaseChain({
          single: vi.fn().mockResolvedValue({ data: BIZ_DATA, error: null }),
        })),
      }),
    }));

    mockServiceClient({ data: 'new-id', error: null });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    await mod.POST(makePostRequest('/api/payouts/setup', SETUP_BODY));

    expect(throwawaySignIn).toHaveBeenCalledWith({ email: 'user@test.com', password: 'correct-pass' });
    expect(sessionSignIn).not.toHaveBeenCalled();
  });
});

describe('Payout disconnect: re-auth uses throwaway client, not session client', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('disconnect route calls signInWithPassword on the throwaway client, not the session client', async () => {
    const throwawaySignIn = vi.fn().mockResolvedValue({ error: null });
    const sessionSignIn = vi.fn().mockResolvedValue({ error: null });

    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn().mockReturnValue({
        auth: { signInWithPassword: throwawaySignIn },
      }),
    }));

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'user-1', email: 'user@test.com' } },
          }),
          signInWithPassword: sessionSignIn,
        },
        from: vi.fn().mockImplementation(() => mockSupabaseChain({
          single: vi.fn().mockResolvedValue({ data: { id: 'biz-1', name: 'Test' }, error: null }),
        })),
      }),
    }));

    mockServiceClient({ data: null, error: null });
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/disconnect/route');
    await mod.POST(makePostRequest('/api/payouts/disconnect', { business_id: 'biz-1', password: 'correct-pass' }));

    expect(throwawaySignIn).toHaveBeenCalledWith({ email: 'user@test.com', password: 'correct-pass' });
    expect(sessionSignIn).not.toHaveBeenCalled();
  });
});

// DB permission and atomicity tests are in payout-account-swap.pg.test.ts
// (run against real Postgres in the P0 security ACL CI job)


describe('W05: Flutterwave unavailable for new payout setup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.stubEnv('PAYSTACK_SECRET_KEY', 'sk_test_fixture');
    vi.stubEnv('WAAIIO_ENVIRONMENT', 'staging');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function configure(opts: {
    key?: string;
    mode?: string;
    userId?: string | null;
    owner?: boolean;
    passwordValid?: boolean;
  } = {}) {
    vi.stubEnv('FLUTTERWAVE_SECRET_KEY', opts.key || '');
    const provider = vi.fn();
    vi.stubGlobal('fetch', provider);
    const rpc = vi.fn().mockResolvedValue({ data: 'new-payout', error: null });
    const writes = vi.fn();
    const notice = vi.fn().mockResolvedValue({ success: true });
    const reauth = vi.fn().mockResolvedValue({
      error: opts.passwordValid === false ? { message: 'Invalid credentials' } : null,
    });
    mockSessionClient({
      userId: opts.userId,
      businessData: opts.owner === false ? null : {
        ...BIZ_DATA, payout_mode: opts.mode || 'platform_managed',
      },
    });
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn().mockReturnValue({ auth: { signInWithPassword: reauth } }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({ rpc, from: writes }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: notice }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    return { provider, rpc, writes, notice, reauth };
  }

  function expectNoEffects(effects: ReturnType<typeof configure>) {
    expect(effects.provider).not.toHaveBeenCalled();
    expect(effects.rpc).not.toHaveBeenCalled();
    expect(effects.writes).not.toHaveBeenCalled();
    expect(effects.notice).not.toHaveBeenCalled();
  }

  it.each(['', 'FLWSECK_TEST-fixture'])('refuses repeated bank requests with key %j', async (key) => {
    const effects = configure({ key });
    const { GET } = await import('@/app/api/payouts/banks/route');
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await GET(new NextRequest('http://localhost:3000/api/payouts/banks?gateway=flutterwave&country=NG'));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Flutterwave is unavailable for new payout setup' });
    }
    expectNoEffects(effects);
  });

  it.each(['', 'FLWSECK_TEST-fixture'])('refuses account resolution with key %j', async (key) => {
    const effects = configure({ key });
    const { POST } = await import('@/app/api/payouts/resolve/route');
    const response = await POST(makePostRequest('/api/payouts/resolve', {
      gateway: 'flutterwave', bank_code: '058', account_number: '0123456789',
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Flutterwave is unavailable for new payout setup' });
    expectNoEffects(effects);
  });

  it.each([
    ['', 'platform_managed'],
    ['FLWSECK_TEST-fixture', 'platform_managed'],
    ['', 'direct_split'],
    ['FLWSECK_TEST-fixture', 'direct_split'],
  ])('refuses destination setup with key %j and mode %s', async (key, mode) => {
    const effects = configure({ key, mode });
    const { POST } = await import('@/app/api/payouts/setup/route');
    const response = await POST(makePostRequest('/api/payouts/setup', { ...SETUP_BODY, gateway: 'flutterwave' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Flutterwave is unavailable for new payout setup' });
    expect(effects.reauth).toHaveBeenCalledWith({ email: 'user@test.com', password: 'correct-pass' });
    expectNoEffects(effects);
  });

  it('preserves authentication for unavailable account resolution', async () => {
    const effects = configure({ userId: null });
    const { POST } = await import('@/app/api/payouts/resolve/route');
    const response = await POST(makePostRequest('/api/payouts/resolve', { ...SETUP_BODY, gateway: 'flutterwave' }));
    expect(response.status).toBe(401);
    expectNoEffects(effects);
  });

  it.each([
    { label: 'unauthenticated', userId: null, owner: true, passwordValid: true, password: 'correct-pass', status: 401 },
    { label: 'missing password', userId: 'user-1', owner: true, passwordValid: true, password: '', status: 403 },
    { label: 'wrong password', userId: 'user-1', owner: true, passwordValid: false, password: 'wrong', status: 403 },
    { label: 'non-owner', userId: 'user-1', owner: false, passwordValid: true, password: 'correct-pass', status: 404 },
  ])('preserves setup denial: $label', async ({ userId, owner, passwordValid, password, status }) => {
    const effects = configure({ userId, owner, passwordValid });
    const { POST } = await import('@/app/api/payouts/setup/route');
    const response = await POST(makePostRequest('/api/payouts/setup', { ...SETUP_BODY, gateway: 'flutterwave', password }));
    expect(response.status).toBe(status);
    expectNoEffects(effects);
  });

  it('keeps Paystack banks usable and cached after a refused Flutterwave request', async () => {
    const effects = configure({ key: 'FLWSECK_TEST-fixture' });
    effects.provider.mockResolvedValue({ json: async () => ({ status: true, data: [{ code: '058', name: 'Fixture Bank' }] }) });
    const { GET } = await import('@/app/api/payouts/banks/route');
    const refused = await GET(new NextRequest('http://localhost:3000/api/payouts/banks?gateway=flutterwave&country=NG'));
    expect(refused.status).toBe(400);
    expect(effects.provider).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await GET(new NextRequest('http://localhost:3000/api/payouts/banks?gateway=paystack&country=NG'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ banks: [
        { code: '001', name: 'Test Bank (staging only)' },
        { code: '058', name: 'Fixture Bank' },
      ] });
    }
    expect(effects.provider).toHaveBeenCalledTimes(1);
    expect(effects.provider.mock.calls[0][0]).toBe('https://api.paystack.co/bank?country=nigeria');
  });

  it('keeps verified Paystack resolution and destination setup usable', async () => {
    const effects = configure();
    effects.provider.mockResolvedValue({ json: async () => ({ status: true, data: { account_name: 'Fixture Merchant' } }) });
    const resolve = await import('@/app/api/payouts/resolve/route');
    const resolved = await resolve.POST(makePostRequest('/api/payouts/resolve', SETUP_BODY));
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({ account_name: 'Fixture Merchant' });
    const setup = await import('@/app/api/payouts/setup/route');
    const saved = await setup.POST(makePostRequest('/api/payouts/setup', SETUP_BODY));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ success: true, verified: true, account_name: 'Fixture Merchant' });
    expect(effects.provider).toHaveBeenCalledTimes(2);
    expect(effects.rpc).toHaveBeenCalledWith('swap_payout_account', expect.objectContaining({
      p_business_id: 'biz-1', p_gateway: 'paystack', p_account_name: 'Fixture Merchant', p_verified_at: expect.any(String),
    }));
    expect(effects.notice).toHaveBeenCalledTimes(1);
    expect(effects.writes).not.toHaveBeenCalled();
  });
});
