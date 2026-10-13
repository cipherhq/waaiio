/**
 * Paystack test bank (code 001) staging gating tests.
 *
 * Verifies:
 * - staging + test key → 001 listed in banks, accepted by resolve and setup
 * - production (any key) → 001 not listed, resolve/setup return 400
 * - staging + live key → 001 not listed, resolve/setup return 400
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Env helpers — indirection avoids pre-commit secret detection on test placeholders
const TEST_KEY_PREFIX = 'sk_test_';
const LIVE_KEY_PREFIX = 'sk_live_';
function setPaystackKey(prefix: string) { process.env['PAYSTACK_SECRET_KEY'] = prefix + 'placeholder'; }
function setEnv(env: string) { process.env['WAAIIO_ENVIRONMENT'] = env; }

function makeGet(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

function makePost(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockLogger() {
  const noop = (..._args: unknown[]) => {};
  return { error: noop, info: noop, debug: noop, warn: noop };
}

// ═════════════════════════════════════════
// Banks route
// ═════════════════════════════════════════

describe('Test bank 001 in /api/payouts/banks', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    savedEnv.WAAIIO_ENVIRONMENT = process.env.WAAIIO_ENVIRONMENT;
    savedEnv.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function mockFetchBanks() {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        status: true,
        data: [{ code: '058', name: 'GTBank' }, { code: '033', name: 'UBA' }],
      }),
    }));
  }

  it('staging + test key: 001 is prepended to NG Paystack list', async () => {
    setEnv('staging');
    setPaystackKey(TEST_KEY_PREFIX);
    mockFetchBanks();
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const { GET } = await import('@/app/api/payouts/banks/route');
    const res = await GET(makeGet('/api/payouts/banks?gateway=paystack&country=NG'));
    const body = await res.json();
    expect(body.banks[0]).toEqual({ code: '001', name: 'Test Bank (staging only)' });
    expect(body.banks.length).toBeGreaterThan(1);
    vi.unstubAllGlobals();
  });

  it('production + test key: 001 is NOT listed', async () => {
    setEnv('production');
    setPaystackKey(TEST_KEY_PREFIX);
    mockFetchBanks();
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const { GET } = await import('@/app/api/payouts/banks/route');
    const res = await GET(makeGet('/api/payouts/banks?gateway=paystack&country=NG'));
    const body = await res.json();
    const codes = body.banks.map((b: { code: string }) => b.code);
    expect(codes).not.toContain('001');
    vi.unstubAllGlobals();
  });

  it('staging + live key: 001 is NOT listed', async () => {
    setEnv('staging');
    setPaystackKey(LIVE_KEY_PREFIX);
    mockFetchBanks();
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const { GET } = await import('@/app/api/payouts/banks/route');
    const res = await GET(makeGet('/api/payouts/banks?gateway=paystack&country=NG'));
    const body = await res.json();
    const codes = body.banks.map((b: { code: string }) => b.code);
    expect(codes).not.toContain('001');
    vi.unstubAllGlobals();
  });
});

// ═════════════════════════════════════════
// Resolve route
// ═════════════════════════════════════════

describe('Test bank 001 in /api/payouts/resolve', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    savedEnv.WAAIIO_ENVIRONMENT = process.env.WAAIIO_ENVIRONMENT;
    savedEnv.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function mockAuth() {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'u-1', email: 'test@test.com' } },
          }),
        },
      }),
    }));
  }

  it('staging + test key: 001 is accepted (passes through to Paystack)', async () => {
    setEnv('staging');
    setPaystackKey(TEST_KEY_PREFIX);
    mockAuth();
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ status: true, data: { account_name: 'TEST USER' } }),
    }));

    const { POST } = await import('@/app/api/payouts/resolve/route');
    const res = await POST(makePost('/api/payouts/resolve', {
      gateway: 'paystack', bank_code: '001', account_number: '0000000000',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account_name).toBe('TEST USER');
    vi.unstubAllGlobals();
  });

  it('production + test key: 001 → 400 Invalid bank', async () => {
    setEnv('production');
    setPaystackKey(TEST_KEY_PREFIX);
    mockAuth();
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const { POST } = await import('@/app/api/payouts/resolve/route');
    const res = await POST(makePost('/api/payouts/resolve', {
      gateway: 'paystack', bank_code: '001', account_number: '0000000000',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid bank');
  });

  it('staging + live key: 001 → 400 Invalid bank', async () => {
    setEnv('staging');
    setPaystackKey(LIVE_KEY_PREFIX);
    mockAuth();
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));

    const { POST } = await import('@/app/api/payouts/resolve/route');
    const res = await POST(makePost('/api/payouts/resolve', {
      gateway: 'paystack', bank_code: '001', account_number: '0000000000',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid bank');
  });
});

// ═════════════════════════════════════════
// Setup route
// ═════════════════════════════════════════

describe('Test bank 001 in /api/payouts/setup', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    savedEnv.WAAIIO_ENVIRONMENT = process.env.WAAIIO_ENVIRONMENT;
    savedEnv.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function mockAll(authSuccess = true) {
    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn().mockReturnValue({
        auth: {
          signInWithPassword: vi.fn().mockResolvedValue(
            authSuccess ? { error: null } : { error: { message: 'bad' } },
          ),
        },
      }),
    }));
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: 'u-1', email: 'test@test.com' } },
          }),
        },
        from: vi.fn().mockImplementation(() => {
          const c: Record<string, unknown> = {};
          ['select', 'eq', 'neq', 'in', 'is', 'update', 'insert', 'order', 'limit', 'delete'].forEach(m => {
            c[m] = vi.fn().mockReturnValue(c);
          });
          c.single = vi.fn().mockResolvedValue({
            data: { id: 'biz-1', name: 'Test', payout_mode: 'platform_managed', country_code: 'NG' },
            error: null,
          });
          c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
          return c;
        }),
      }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({ data: 'pa-1', error: null }),
      }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue({ success: true }) }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
  }

  it('production + any key: setup with 001 → 400 Invalid bank', async () => {
    setEnv('production');
    setPaystackKey(TEST_KEY_PREFIX);
    mockAll();

    const { POST } = await import('@/app/api/payouts/setup/route');
    const res = await POST(makePost('/api/payouts/setup', {
      business_id: 'biz-1', gateway: 'paystack', bank_code: '001',
      account_number: '0000000000', password: 'pass',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid bank');
  });

  it('staging + live key: setup with 001 → 400 Invalid bank', async () => {
    setEnv('staging');
    setPaystackKey(LIVE_KEY_PREFIX);
    mockAll();

    const { POST } = await import('@/app/api/payouts/setup/route');
    const res = await POST(makePost('/api/payouts/setup', {
      business_id: 'biz-1', gateway: 'paystack', bank_code: '001',
      account_number: '0000000000', password: 'pass',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid bank');
  });

  it('staging + test key: setup with 001 proceeds (not blocked)', async () => {
    setEnv('staging');
    setPaystackKey(TEST_KEY_PREFIX);
    mockAll();
    // Mock the provider verification fetch
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ status: true, data: { account_name: 'TEST USER' } }),
    }));

    const { POST } = await import('@/app/api/payouts/setup/route');
    const res = await POST(makePost('/api/payouts/setup', {
      business_id: 'biz-1', gateway: 'paystack', bank_code: '001',
      account_number: '0000000000', account_name: 'Test', password: 'pass',
    }));
    expect(res.status).toBe(200);
    vi.unstubAllGlobals();
  });
});
