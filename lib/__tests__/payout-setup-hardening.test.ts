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

  it('returns 503 for flutterwave when FLUTTERWAVE_SECRET_KEY is missing', async () => {
    delete process.env.FLUTTERWAVE_SECRET_KEY;
    const mod = await loadResolveRoute();
    const res = await mod.POST(makePostRequest('/api/payouts/resolve', {
      gateway: 'flutterwave', bank_code: '058', account_number: '0123456789',
    }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('not configured');
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

// ═══════════════════════════════════════════════════════════
// Scope 9: Migration — EXECUTE granted only to service_role
// ═══════════════════════════════════════════════════════════

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeIfDb = !TEST_DB ? describe.skip : describe;

function runSQL(sql: string): string {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  const { execSync } = require('child_process');
  try {
    return execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: sql },
    ).trim();
  } catch (err: any) {
    return `ERROR: ${err.stderr || err.stdout || err.message || ''}`;
  }
}

describeIfDb('Migration 441: payout account atomic RPCs — permission grants', () => {
  it('swap_payout_account EXECUTE denied to authenticated', () => {
    const r = runSQL("SELECT has_function_privilege('authenticated', 'swap_payout_account(uuid,text,text,text,text,text,text,timestamptz)', 'EXECUTE');");
    expect(r).toBe('f');
  });

  it('swap_payout_account EXECUTE denied to anon', () => {
    const r = runSQL("SELECT has_function_privilege('anon', 'swap_payout_account(uuid,text,text,text,text,text,text,timestamptz)', 'EXECUTE');");
    expect(r).toBe('f');
  });

  it('swap_payout_account EXECUTE granted to service_role', () => {
    const r = runSQL("SELECT has_function_privilege('service_role', 'swap_payout_account(uuid,text,text,text,text,text,text,timestamptz)', 'EXECUTE');");
    expect(r).toBe('t');
  });

  it('disconnect_payout_account EXECUTE denied to authenticated', () => {
    const r = runSQL("SELECT has_function_privilege('authenticated', 'disconnect_payout_account(uuid)', 'EXECUTE');");
    expect(r).toBe('f');
  });

  it('disconnect_payout_account EXECUTE denied to anon', () => {
    const r = runSQL("SELECT has_function_privilege('anon', 'disconnect_payout_account(uuid)', 'EXECUTE');");
    expect(r).toBe('f');
  });

  it('disconnect_payout_account EXECUTE granted to service_role', () => {
    const r = runSQL("SELECT has_function_privilege('service_role', 'disconnect_payout_account(uuid)', 'EXECUTE');");
    expect(r).toBe('t');
  });
});
