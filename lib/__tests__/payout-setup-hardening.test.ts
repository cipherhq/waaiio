/**
 * Payout setup hardening tests
 *
 * Tests proving:
 * 1. Non-owner is rejected (403/404)
 * 2. Account saved unverified when provider resolve fails or key missing
 * 3. Re-authentication is required (no password → 403, wrong password → 403)
 * 4. Browser client never writes payout_accounts (disconnect goes through API)
 * 5. Resolve route returns 503 when provider key is missing (no mock)
 * 6. Re-auth uses a separate non-persisting client, not the session client
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

  async function loadSetupRoute(opts: {
    userId?: string;
    userEmail?: string;
    businessOwnerId?: string;
    authSuccess?: boolean;
  } = {}) {
    const userId = opts.userId || 'user-1';
    const userEmail = opts.userEmail || 'user@test.com';
    const authSuccess = opts.authSuccess !== false;
    const businessOwnerId = opts.businessOwnerId || userId;

    // Throwaway client for password check (non-persisting)
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn().mockReturnValue({
        auth: {
          signInWithPassword: vi.fn().mockResolvedValue(
            authSuccess ? { error: null } : { error: { message: 'Invalid credentials' } },
          ),
        },
      }),
    }));

    // Session client — for auth and ownership check (RLS-bound)
    const sessionFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'businesses') {
        const chain = mockSupabaseChain();
        // Only return data if owner matches
        chain.single = vi.fn().mockResolvedValue({
          data: businessOwnerId === userId
            ? { id: 'biz-1', name: 'Test Biz', payout_mode: 'platform_managed', country_code: 'NG' }
            : null,
          error: businessOwnerId !== userId ? { message: 'not found' } : null,
        });
        return chain;
      }
      return mockSupabaseChain();
    });

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: userId, email: userEmail } },
          }),
        },
        from: sessionFrom,
      }),
    }));

    // Service client — for DB writes
    const serviceInsert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: { id: 'payout-1' }, error: null }),
      }),
    });
    const serviceFrom = vi.fn().mockImplementation(() => {
      const chain = mockSupabaseChain();
      chain.insert = serviceInsert;
      return chain;
    });

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({ from: serviceFrom }),
    }));

    vi.doMock('@/lib/email/client', () => ({
      sendEmail: vi.fn().mockResolvedValue({ success: true }),
    }));

    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    return { mod, serviceInsert, serviceFrom };
  }

  it('rejects when user does not own the business', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'test-key-placeholder';
    const { mod } = await loadSetupRoute({
      userId: 'user-1',
      businessOwnerId: 'user-2', // different owner
    });

    const req = makePostRequest('/api/payouts/setup', {
      business_id: 'biz-1',
      gateway: 'paystack',
      bank_code: '058',
      account_number: '0123456789',
      password: 'correct-pass',
    });

    const res = await mod.POST(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Business not found');
  });

  it('rejects unauthenticated users', async () => {
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn().mockReturnValue({
        auth: { signInWithPassword: vi.fn() },
      }),
    }));
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
        },
      }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn(),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const req = makePostRequest('/api/payouts/setup', {
      business_id: 'biz-1',
      gateway: 'paystack',
      bank_code: '058',
      account_number: '0123456789',
      password: 'pass',
    });

    const res = await mod.POST(req);
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 2: Setup route — re-auth required
// ═══════════════════════════════════════════════════════════

describe('Payout setup: re-auth required', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadSetupWithAuth(authSuccess: boolean) {
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn().mockReturnValue({
        auth: {
          signInWithPassword: vi.fn().mockResolvedValue(
            authSuccess ? { error: null } : { error: { message: 'Invalid credentials' } },
          ),
        },
      }),
    }));
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'user-1', email: 'user@test.com' } },
          }),
        },
        from: vi.fn().mockImplementation(() => mockSupabaseChain({
          single: vi.fn().mockResolvedValue({
            data: { id: 'biz-1', name: 'Test', payout_mode: 'platform_managed', country_code: 'NG' },
            error: null,
          }),
        })),
      }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => {
          const c = mockSupabaseChain();
          c.insert = vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'p-1' }, error: null }),
            }),
          });
          return c;
        }),
      }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    return import('@/app/api/payouts/setup/route');
  }

  it('returns 403 when password is missing', async () => {
    const mod = await loadSetupWithAuth(true);
    const req = makePostRequest('/api/payouts/setup', {
      business_id: 'biz-1',
      gateway: 'paystack',
      bank_code: '058',
      account_number: '0123456789',
      // no password
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Password required');
  });

  it('returns 403 when password is wrong', async () => {
    const mod = await loadSetupWithAuth(false);
    const req = makePostRequest('/api/payouts/setup', {
      business_id: 'biz-1',
      gateway: 'paystack',
      bank_code: '058',
      account_number: '0123456789',
      password: 'wrong-password',
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Incorrect password');
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

  it('saves with verified_at = null when PAYSTACK_SECRET_KEY is missing', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;

    let insertedRecord: Record<string, unknown> | null = null;

    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn().mockReturnValue({
        auth: {
          signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
        },
      }),
    }));

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'user-1', email: 'user@test.com' } },
          }),
        },
        from: vi.fn().mockImplementation(() => mockSupabaseChain({
          single: vi.fn().mockResolvedValue({
            data: { id: 'biz-1', name: 'Test', payout_mode: 'platform_managed', country_code: 'NG' },
            error: null,
          }),
        })),
      }),
    }));

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => {
          const c = mockSupabaseChain();
          c.insert = vi.fn().mockImplementation((record: Record<string, unknown>) => {
            insertedRecord = record;
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: 'p-1' }, error: null }),
              }),
            };
          });
          return c;
        }),
      }),
    }));

    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const req = makePostRequest('/api/payouts/setup', {
      business_id: 'biz-1',
      gateway: 'paystack',
      bank_code: '058',
      account_number: '0123456789',
      account_name: 'Client Typed Name',
      password: 'correct-pass',
    });

    const res = await mod.POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(false);

    // Verify the inserted record has null verified_at
    expect(insertedRecord).not.toBeNull();
    expect(insertedRecord!.verified_at).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 4: Disconnect route — server-side only
// ═══════════════════════════════════════════════════════════

describe('Payout disconnect: server-side with ownership check', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadDisconnectRoute(opts: {
    userId?: string;
    businessOwnerId?: string;
    authSuccess?: boolean;
  } = {}) {
    const userId = opts.userId || 'user-1';
    const authSuccess = opts.authSuccess !== false;
    const businessOwnerId = opts.businessOwnerId || userId;

    // Throwaway client for password check
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn().mockReturnValue({
        auth: {
          signInWithPassword: vi.fn().mockResolvedValue(
            authSuccess ? { error: null } : { error: { message: 'Invalid credentials' } },
          ),
        },
      }),
    }));

    const sessionFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'businesses') {
        const chain = mockSupabaseChain();
        chain.single = vi.fn().mockResolvedValue({
          data: businessOwnerId === userId
            ? { id: 'biz-1', name: 'Test Biz' }
            : null,
          error: businessOwnerId !== userId ? { message: 'not found' } : null,
        });
        return chain;
      }
      return mockSupabaseChain();
    });

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: userId, email: 'user@test.com' } },
          }),
        },
        from: sessionFrom,
      }),
    }));

    const serviceFrom = vi.fn().mockImplementation(() => mockSupabaseChain());

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({ from: serviceFrom }),
    }));

    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/disconnect/route');
    return { mod, serviceFrom };
  }

  it('rejects non-owner', async () => {
    const { mod } = await loadDisconnectRoute({
      userId: 'user-1',
      businessOwnerId: 'user-2',
    });

    const req = makePostRequest('/api/payouts/disconnect', {
      business_id: 'biz-1',
      password: 'correct-pass',
    });

    const res = await mod.POST(req);
    expect(res.status).toBe(404);
  });

  it('rejects without password', async () => {
    const { mod } = await loadDisconnectRoute();
    const req = makePostRequest('/api/payouts/disconnect', {
      business_id: 'biz-1',
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(403);
  });

  it('rejects wrong password', async () => {
    const { mod } = await loadDisconnectRoute({ authSuccess: false });
    const req = makePostRequest('/api/payouts/disconnect', {
      business_id: 'biz-1',
      password: 'wrong',
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Incorrect password');
  });

  it('uses service client for DB writes on success', async () => {
    const { mod, serviceFrom } = await loadDisconnectRoute();
    const req = makePostRequest('/api/payouts/disconnect', {
      business_id: 'biz-1',
      password: 'correct-pass',
    });

    const res = await mod.POST(req);
    expect(res.status).toBe(200);

    // Service client should be called for payout_accounts and businesses updates
    const calls = serviceFrom.mock.calls.map((c: string[][]) => c[0]);
    expect(calls).toContain('payout_accounts');
    expect(calls).toContain('businesses');
  });

  it('returns 500 when deactivation fails', async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn().mockReturnValue({
        auth: {
          signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
        },
      }),
    }));

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'user-1', email: 'user@test.com' } },
          }),
        },
        from: vi.fn().mockImplementation(() => {
          const chain = mockSupabaseChain();
          chain.single = vi.fn().mockResolvedValue({
            data: { id: 'biz-1', name: 'Test' },
            error: null,
          });
          return chain;
        }),
      }),
    }));

    // Service client returns error on payout_accounts update
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => {
          const chain = mockSupabaseChain();
          chain.update = vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ error: { message: 'DB error' } }),
            }),
          });
          return chain;
        }),
      }),
    }));

    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/disconnect/route');
    const req = makePostRequest('/api/payouts/disconnect', {
      business_id: 'biz-1',
      password: 'correct-pass',
    });

    const res = await mod.POST(req);
    expect(res.status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 5: Resolve route — no mock verification
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
    const req = makePostRequest('/api/payouts/resolve', {
      gateway: 'paystack',
      bank_code: '058',
      account_number: '0123456789',
    });

    const res = await mod.POST(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('not configured');
  });

  it('returns 503 for flutterwave when FLUTTERWAVE_SECRET_KEY is missing', async () => {
    delete process.env.FLUTTERWAVE_SECRET_KEY;
    const mod = await loadResolveRoute();
    const req = makePostRequest('/api/payouts/resolve', {
      gateway: 'flutterwave',
      bank_code: '058',
      account_number: '0123456789',
    });

    const res = await mod.POST(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('not configured');
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 6: Dashboard page — no browser-side payout_accounts writes
// ═══════════════════════════════════════════════════════════

describe('Dashboard payouts page: no browser-side payout_accounts writes', () => {
  it('disconnect handler calls the API, not the browser supabase client', async () => {
    // Statically verify the page source does not contain browser-side
    // supabase.from('payout_accounts').update() in the disconnect flow
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'app/dashboard/payouts/page.tsx'),
      'utf-8',
    );

    // The disconnect flow should call /api/payouts/disconnect, not write directly
    expect(source).toContain('/api/payouts/disconnect');

    // There should be no browser-side payout_accounts update in the disconnect section.
    // Search for the pattern of createClient() followed by .from('payout_accounts').update()
    // in the disconnect confirmation area
    const disconnectSection = source.slice(
      source.indexOf('Disconnect payout account'),
      source.indexOf('Disconnect payout account') + 2000,
    );

    // Should NOT contain direct supabase writes to payout_accounts
    expect(disconnectSection).not.toMatch(/supabase\.from\(['"]payout_accounts['"]\)\.update/);
    // Should NOT contain direct supabase writes to businesses
    expect(disconnectSection).not.toMatch(/supabase\.from\(['"]businesses['"]\)\.update/);
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 7: Re-auth uses a separate non-persisting client
// ═══════════════════════════════════════════════════════════

describe('Payout setup: re-auth uses throwaway client, not session client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

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
          single: vi.fn().mockResolvedValue({
            data: { id: 'biz-1', name: 'Test', payout_mode: 'platform_managed', country_code: 'NG' },
            error: null,
          }),
        })),
      }),
    }));

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => {
          const c = mockSupabaseChain();
          c.insert = vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'p-1' }, error: null }),
            }),
          });
          return c;
        }),
      }),
    }));

    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/setup/route');
    const req = makePostRequest('/api/payouts/setup', {
      business_id: 'biz-1',
      gateway: 'paystack',
      bank_code: '058',
      account_number: '0123456789',
      account_name: 'Test',
      password: 'correct-pass',
    });

    await mod.POST(req);

    // The throwaway client's signInWithPassword must be called
    expect(throwawaySignIn).toHaveBeenCalledWith({
      email: 'user@test.com',
      password: 'correct-pass',
    });

    // The session client's signInWithPassword must NOT be called
    expect(sessionSignIn).not.toHaveBeenCalled();
  });
});

describe('Payout disconnect: re-auth uses throwaway client, not session client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

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
          single: vi.fn().mockResolvedValue({
            data: { id: 'biz-1', name: 'Test Biz' },
            error: null,
          }),
        })),
      }),
    }));

    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => mockSupabaseChain()),
      }),
    }));

    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const mod = await import('@/app/api/payouts/disconnect/route');
    const req = makePostRequest('/api/payouts/disconnect', {
      business_id: 'biz-1',
      password: 'correct-pass',
    });

    await mod.POST(req);

    // The throwaway client's signInWithPassword must be called
    expect(throwawaySignIn).toHaveBeenCalledWith({
      email: 'user@test.com',
      password: 'correct-pass',
    });

    // The session client's signInWithPassword must NOT be called
    expect(sessionSignIn).not.toHaveBeenCalled();
  });
});
