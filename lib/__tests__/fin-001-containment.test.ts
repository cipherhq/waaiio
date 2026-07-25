/**
 * FIN-001: Financial and credential containment tests
 *
 * Tests proving:
 * - Payout kill switch blocks transfers when disabled
 * - Auto-payout cron authenticates before gate, returns 503 when disabled
 * - Square Connect gate blocks OAuth with 503 when disabled
 * - Stripe Connect gate blocks connection with 503 when disabled
 * - Admin query enforces column allowlists at query level and scrubs response
 * - Transfer-method allowlist rejects unknown values
 * - Automated methods fail when provider config is missing
 * - Safe logging in touched error paths
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Shared log capture ──

let capturedLogs: string[] = [];

function captureAll(...args: unknown[]): void {
  capturedLogs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
}

function assertNoSensitiveData(lines: string[], sensitiveValues: string[]) {
  for (const line of lines) {
    for (const val of sensitiveValues) {
      expect(line).not.toContain(val);
    }
  }
}

// ── Helpers ──

function makeRequest(url: string, opts: RequestInit = {}) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

function makePostRequest(url: string, body: Record<string, unknown>, headers?: Record<string, string>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function mockLogger() {
  return {
    error: captureAll, info: captureAll, debug: captureAll, warn: captureAll,
    withContext: () => ({ error: captureAll, info: captureAll, debug: captureAll, warn: captureAll }),
  };
}

// ═══════════════════════════════════════════════════════════
// Scope 1: Payout Kill Switch (approve route)
// ═══════════════════════════════════════════════════════════

describe('FIN-001: Payout kill switch (approve route)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
    savedEnv.ENABLE_PAYOUTS = process.env.ENABLE_PAYOUTS;
    savedEnv.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    savedEnv.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  async function loadApproveRoute() {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null }),
      }),
    }));
    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin' }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
    vi.doMock('@/lib/email/templates', () => ({
      payoutApprovedEmail: vi.fn(),
      payoutPaidEmail: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    return import('@/app/api/admin/payouts/[id]/approve/route');
  }

  it('returns 503 when ENABLE_PAYOUTS is missing', async () => {
    delete process.env.ENABLE_PAYOUTS;
    const { POST } = await loadApproveRoute();
    const req = makePostRequest('/api/admin/payouts/test-id/approve', { transfer_method: 'manual_bank' });
    const res = await POST(req, { params: Promise.resolve({ id: 'test-id' }) });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('disabled');
  });

  it('returns 503 when ENABLE_PAYOUTS is "false"', async () => {
    process.env.ENABLE_PAYOUTS = 'false';
    const { POST } = await loadApproveRoute();
    const req = makePostRequest('/api/admin/payouts/test-id/approve', { transfer_method: 'manual_bank' });
    const res = await POST(req, { params: Promise.resolve({ id: 'test-id' }) });
    expect(res.status).toBe(503);
  });

  it('returns 503 when ENABLE_PAYOUTS is "1" (invalid truthy)', async () => {
    process.env.ENABLE_PAYOUTS = '1';
    const { POST } = await loadApproveRoute();
    const req = makePostRequest('/api/admin/payouts/test-id/approve', { transfer_method: 'manual_bank' });
    const res = await POST(req, { params: Promise.resolve({ id: 'test-id' }) });
    expect(res.status).toBe(503);
  });

  it('no provider call is made when disabled', async () => {
    delete process.env.ENABLE_PAYOUTS;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { POST } = await loadApproveRoute();
    const req = makePostRequest('/api/admin/payouts/test-id/approve', { transfer_method: 'paystack_transfer' });
    await POST(req, { params: Promise.resolve({ id: 'test-id' }) });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('proceeds past gate when ENABLE_PAYOUTS is "true"', async () => {
    process.env.ENABLE_PAYOUTS = 'true';
    const { POST } = await loadApproveRoute();
    const req = makePostRequest('/api/admin/payouts/test-id/approve', { transfer_method: 'manual_bank' });
    const res = await POST(req, { params: Promise.resolve({ id: 'test-id' }) });
    expect(res.status).not.toBe(503);
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 1b: Payout Kill Switch (auto-payout cron)
// ═══════════════════════════════════════════════════════════

describe('FIN-001: Payout kill switch (auto-payout cron)', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
  });

  async function loadAutoPayout(cronAuthResult: unknown = null) {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null }),
      }),
    }));
    vi.doMock('@/lib/cron-auth', () => ({
      verifyCronAuth: vi.fn().mockReturnValue(cronAuthResult),
    }));
    vi.doMock('@/lib/observability/cron', () => ({
      createCronLogger: vi.fn().mockReturnValue({
        started: vi.fn(), completed: vi.fn(), failed: vi.fn(),
      }),
    }));
    vi.doMock('@/lib/platformSettings', () => ({
      loadPlatformSettings: vi.fn().mockResolvedValue({
        payout_cooling_period_days: 7,
        fraud_velocity_threshold: 50,
        minimum_payout: { NG: 5000 },
      }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
    vi.doMock('@/lib/email/templates', () => ({ payoutFailedEmail: vi.fn() }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    return import('@/app/api/cron/auto-payout/route');
  }

  it('returns 401 for unauthorized request even when payouts disabled', async () => {
    delete process.env.ENABLE_PAYOUTS;
    const { NextResponse } = await import('next/server');
    const authErrorResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { GET } = await loadAutoPayout(authErrorResponse);
    const req = makeRequest('/api/cron/auto-payout');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns 503 when ENABLE_PAYOUTS is missing (after auth)', async () => {
    delete process.env.ENABLE_PAYOUTS;
    const { GET } = await loadAutoPayout(null);
    const req = makeRequest('/api/cron/auto-payout', {
      headers: { Authorization: 'Bearer test-cron-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('disabled');
  });

  it('returns 503 when ENABLE_PAYOUTS is "false"', async () => {
    process.env.ENABLE_PAYOUTS = 'false';
    const { GET } = await loadAutoPayout(null);
    const req = makeRequest('/api/cron/auto-payout');
    const res = await GET(req);
    expect(res.status).toBe(503);
  });

  it('returns 503 when ENABLE_PAYOUTS is "1" (invalid truthy)', async () => {
    process.env.ENABLE_PAYOUTS = '1';
    const { GET } = await loadAutoPayout(null);
    const req = makeRequest('/api/cron/auto-payout');
    const res = await GET(req);
    expect(res.status).toBe(503);
  });

  it('no provider call is made when disabled', async () => {
    delete process.env.ENABLE_PAYOUTS;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { GET } = await loadAutoPayout(null);
    const req = makeRequest('/api/cron/auto-payout');
    await GET(req);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 2: Square Connect Gate
// ═══════════════════════════════════════════════════════════

describe('FIN-001: Square Connect feature gate', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.ENABLE_SQUARE_CONNECT;
  });

  async function loadSquareConnect() {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } } }) },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: 'b1', name: 'Test' } }),
              }),
            }),
          }),
        }),
      }),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    return import('@/app/api/payouts/square-connect/route');
  }

  it('returns 503 when ENABLE_SQUARE_CONNECT is missing', async () => {
    delete process.env.ENABLE_SQUARE_CONNECT;
    const { POST } = await loadSquareConnect();
    const req = makePostRequest('/api/payouts/square-connect', { business_id: 'b1' });
    const res = await POST(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('disabled');
  });

  it('returns 503 when ENABLE_SQUARE_CONNECT is "false"', async () => {
    process.env.ENABLE_SQUARE_CONNECT = 'false';
    const { POST } = await loadSquareConnect();
    const req = makePostRequest('/api/payouts/square-connect', { business_id: 'b1' });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it('no OAuth URL generation occurs when disabled', async () => {
    delete process.env.ENABLE_SQUARE_CONNECT;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { POST } = await loadSquareConnect();
    const req = makePostRequest('/api/payouts/square-connect', { business_id: 'b1' });
    await POST(req);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('proceeds past gate when enabled', async () => {
    process.env.ENABLE_SQUARE_CONNECT = 'true';
    const { POST } = await loadSquareConnect();
    const req = makePostRequest('/api/payouts/square-connect', { business_id: 'b1' });
    const res = await POST(req);
    expect(res.status).not.toBe(503);
  });
});

describe('FIN-001: Square Callback feature gate', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.ENABLE_SQUARE_CONNECT;
  });

  async function loadSquareCallback() {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        from: vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) }),
          }),
          insert: vi.fn().mockResolvedValue({}),
        }),
      }),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    vi.doMock('@/lib/redact', () => ({
      safeProviderError: vi.fn().mockReturnValue('Provider error'),
    }));
    return import('@/app/api/payouts/square-callback/route');
  }

  it('returns 503 when ENABLE_SQUARE_CONNECT is missing', async () => {
    delete process.env.ENABLE_SQUARE_CONNECT;
    const { GET } = await loadSquareCallback();
    const req = makeRequest('/api/payouts/square-callback?code=test&state=biz:abc');
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('disabled');
  });

  it('no code exchange occurs when disabled', async () => {
    delete process.env.ENABLE_SQUARE_CONNECT;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { GET } = await loadSquareCallback();
    const req = makeRequest('/api/payouts/square-callback?code=test&state=biz:abc');
    await GET(req);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 3: Stripe Connect Gate
// ═══════════════════════════════════════════════════════════

describe('FIN-001: Stripe Connect feature gate', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.ENABLE_STRIPE_CONNECT;
  });

  async function loadStripeConnect() {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } } }) },
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: { id: 'b1', name: 'Test' } }),
              }),
            }),
          }),
        }),
      }),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    return import('@/app/api/payouts/stripe-connect/route');
  }

  it('returns 503 when ENABLE_STRIPE_CONNECT is missing', async () => {
    delete process.env.ENABLE_STRIPE_CONNECT;
    const { POST } = await loadStripeConnect();
    const req = makePostRequest('/api/payouts/stripe-connect', { business_id: 'b1' });
    const res = await POST(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('disabled');
  });

  it('returns 503 when ENABLE_STRIPE_CONNECT is "false"', async () => {
    process.env.ENABLE_STRIPE_CONNECT = 'false';
    const { POST } = await loadStripeConnect();
    const req = makePostRequest('/api/payouts/stripe-connect', { business_id: 'b1' });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it('no Stripe API call occurs when disabled', async () => {
    delete process.env.ENABLE_STRIPE_CONNECT;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { POST } = await loadStripeConnect();
    const req = makePostRequest('/api/payouts/stripe-connect', { business_id: 'b1' });
    await POST(req);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('FIN-001: Stripe Callback feature gate', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.ENABLE_STRIPE_CONNECT;
  });

  async function loadStripeCallback() {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        from: vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) }),
          }),
          insert: vi.fn().mockResolvedValue({}),
        }),
      }),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    return import('@/app/api/payouts/stripe-callback/route');
  }

  it('returns 503 when ENABLE_STRIPE_CONNECT is missing', async () => {
    delete process.env.ENABLE_STRIPE_CONNECT;
    const { GET } = await loadStripeCallback();
    const req = makeRequest('/api/payouts/stripe-callback?account_id=acct_123&business_id=b1');
    const res = await GET(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('disabled');
  });

  it('no Stripe API call occurs when disabled', async () => {
    delete process.env.ENABLE_STRIPE_CONNECT;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { GET } = await loadStripeCallback();
    const req = makeRequest('/api/payouts/stripe-callback?account_id=acct_123&business_id=b1');
    await GET(req);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 4: Admin Query Column Restrictions
// ═══════════════════════════════════════════════════════════

describe('FIN-001: Admin query column restrictions', () => {
  let capturedSelectArg: string | undefined;

  beforeEach(() => {
    capturedLogs = [];
    capturedSelectArg = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function mockAdminQuery(role: string, tableData: Record<string, unknown>[]) {
    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockImplementation((selectStr: string) => {
            capturedSelectArg = selectStr;
            const result = { data: tableData, error: null, count: null };
            const chainable: Record<string, unknown> = {};
            const methods = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is', 'order', 'limit'];
            for (const m of methods) chainable[m] = vi.fn().mockReturnValue(chainable);
            chainable.then = (resolve: (r: typeof result) => void) => resolve(result);
            return chainable;
          }),
        }),
      }),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
  }

  async function queryAs(role: string, table: string, data: Record<string, unknown>[], selectOverride?: string) {
    mockAdminQuery(role, data);
    const mod = await import('@/app/api/admin/query/route');
    const req = makePostRequest('/api/admin/query', { table, select: selectOverride ?? '*' }, {
      origin: 'http://localhost:8083',
    });
    return mod.POST(req);
  }

  it('finance cannot access whatsapp_channels (table not allowed)', async () => {
    const res = await queryAs('finance', 'whatsapp_channels', []);
    expect(res.status).toBe(403);
  });

  it('support cannot access payout_accounts (table not allowed)', async () => {
    const res = await queryAs('support', 'payout_accounts', []);
    expect(res.status).toBe(403);
  });

  it('operations select=* on whatsapp_channels sends explicit safe columns', async () => {
    const res = await queryAs('operations', 'whatsapp_channels', [
      { id: 'ch1', display_name: 'Test' },
    ]);
    expect(res.status).toBe(200);
    // The select string sent to Supabase must NOT be '*'
    expect(capturedSelectArg).not.toBe('*');
    expect(capturedSelectArg).toContain('id');
    expect(capturedSelectArg).toContain('display_name');
    expect(capturedSelectArg).not.toContain('meta_access_token');
  });

  it('finance select=* on payout_accounts sends explicit safe columns', async () => {
    const res = await queryAs('finance', 'payout_accounts', [
      { id: 'pa1', gateway: 'paystack', bank_name: 'GTB', account_name: 'John' },
    ]);
    expect(res.status).toBe(200);
    expect(capturedSelectArg).not.toBe('*');
    expect(capturedSelectArg).toContain('id');
    expect(capturedSelectArg).toContain('gateway');
    expect(capturedSelectArg).not.toContain('account_number');
    expect(capturedSelectArg).not.toContain('square_access_token');
    expect(capturedSelectArg).not.toContain('stripe_account_id');
  });

  it('admin select=* on payout_accounts sends explicit safe columns (not *)', async () => {
    const res = await queryAs('admin', 'payout_accounts', [
      { id: 'pa1', gateway: 'paystack' },
    ]);
    expect(res.status).toBe(200);
    // Even admin gets the allowlist for payout_accounts
    expect(capturedSelectArg).not.toBe('*');
    expect(capturedSelectArg).not.toContain('account_number');
    expect(capturedSelectArg).not.toContain('square_access_token');
  });

  it('admin select=* on whatsapp_channels sends explicit safe columns', async () => {
    const res = await queryAs('admin', 'whatsapp_channels', [
      { id: 'ch1', display_name: 'Test' },
    ]);
    expect(res.status).toBe(200);
    expect(capturedSelectArg).not.toBe('*');
    expect(capturedSelectArg).not.toContain('meta_access_token');
  });

  it('rejects requested column outside allowlist with 403', async () => {
    const res = await queryAs('finance', 'payout_accounts', [], 'id,account_number');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('account_number');
  });

  it('admin cannot request credential column explicitly', async () => {
    const res = await queryAs('admin', 'payout_accounts', [], 'id,square_access_token');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('square_access_token');
  });

  it('admin cannot receive full account_number from payout_accounts', async () => {
    // Even if DB somehow returns it, defense-in-depth scrubs it
    const res = await queryAs('admin', 'payout_accounts', [
      { id: 'pa1', account_number: '0123456789', gateway: 'paystack' },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0]).not.toHaveProperty('account_number');
  });

  it('defense-in-depth scrubs nested credential fields', async () => {
    // For tables without an allowlist, nested objects are scrubbed recursively
    const res = await queryAs('admin', 'profiles', [
      { id: 'p1', nested: { meta_access_token: 'secret', name: 'safe' } },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    const nested = body.data[0].nested;
    expect(nested).not.toHaveProperty('meta_access_token');
    expect(nested.name).toBe('safe');
  });

  it('legitimate finance queries return required safe fields', async () => {
    const res = await queryAs('finance', 'payments', [
      { id: 'p1', amount: 5000, currency: 'NGN', status: 'success', gateway: 'paystack' },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].id).toBe('p1');
    expect(body.data[0].amount).toBe(5000);
  });

  it('admin workflows on unrestricted tables continue to work', async () => {
    const res = await queryAs('admin', 'profiles', [
      { id: 'p1', full_name: 'Test User', email: 'test@example.com' },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].full_name).toBe('Test User');
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 5: Transfer-Method Allowlist + Provider Config
// ═══════════════════════════════════════════════════════════

describe('FIN-001: Transfer-method allowlist', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
    savedEnv.ENABLE_PAYOUTS = process.env.ENABLE_PAYOUTS;
    savedEnv.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    savedEnv.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    process.env.ENABLE_PAYOUTS = 'true';
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  async function loadApproveRoute() {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null }),
      }),
    }));
    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role: 'admin' }),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
    vi.doMock('@/lib/email/templates', () => ({
      payoutApprovedEmail: vi.fn(),
      payoutPaidEmail: vi.fn(),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
    return import('@/app/api/admin/payouts/[id]/approve/route');
  }

  const VALID_METHODS = ['paystack_transfer', 'stripe_transfer', 'manual_bank', 'manual_cash'];

  for (const method of VALID_METHODS) {
    it(`accepts valid transfer method: ${method}`, async () => {
      const { POST } = await loadApproveRoute();
      const req = makePostRequest('/api/admin/payouts/test-id/approve', { transfer_method: method });
      const res = await POST(req, { params: Promise.resolve({ id: 'test-id' }) });
      expect(res.status).not.toBe(400);
    });
  }

  it('rejects unknown transfer method with 400', async () => {
    const { POST } = await loadApproveRoute();
    const req = makePostRequest('/api/admin/payouts/test-id/approve', { transfer_method: 'bitcoin_transfer' });
    const res = await POST(req, { params: Promise.resolve({ id: 'test-id' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('transfer_method must be one of');
  });

  it('rejects missing transfer method with 400', async () => {
    const { POST } = await loadApproveRoute();
    const req = makePostRequest('/api/admin/payouts/test-id/approve', {});
    const res = await POST(req, { params: Promise.resolve({ id: 'test-id' }) });
    expect(res.status).toBe(400);
  });

  it('unknown transfer method cannot call a provider or update payout', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { POST } = await loadApproveRoute();
    const req = makePostRequest('/api/admin/payouts/test-id/approve', { transfer_method: 'unknown_method' });
    const res = await POST(req, { params: Promise.resolve({ id: 'test-id' }) });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('paystack_transfer rejects before status update when provider key missing', async () => {
    // Verify source: paystack_transfer checks for paystackSecretKey
    // and returns 400 before any .update() call
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'),
      'utf-8',
    );
    // The paystack_transfer branch must check for key absence FIRST
    const paystackBlock = source.indexOf("transfer_method === 'paystack_transfer'");
    const paystackKeyCheck = source.indexOf('!paystackSecretKey', paystackBlock);
    const paystackFetch = source.indexOf("api.paystack.co", paystackBlock);
    expect(paystackKeyCheck).toBeGreaterThan(paystackBlock);
    expect(paystackKeyCheck).toBeLessThan(paystackFetch);
    // Must return error, not fall through
    expect(source.slice(paystackKeyCheck, paystackKeyCheck + 200)).toContain('not configured');
  });

  it('stripe_transfer rejects before status update when provider key missing', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'),
      'utf-8',
    );
    const stripeBlock = source.indexOf("transfer_method === 'stripe_transfer'");
    const stripeKeyCheck = source.indexOf('!stripeSecretKey', stripeBlock);
    const stripeFetch = source.indexOf("api.stripe.com", stripeBlock);
    expect(stripeKeyCheck).toBeGreaterThan(stripeBlock);
    expect(stripeKeyCheck).toBeLessThan(stripeFetch);
    expect(source.slice(stripeKeyCheck, stripeKeyCheck + 200)).toContain('not configured');
  });

  it('stripe_transfer rejects when destination account ID is missing', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'),
      'utf-8',
    );
    const stripeBlock = source.indexOf("transfer_method === 'stripe_transfer'");
    // Must check for missing stripe_account_id before fetch
    const destCheck = source.indexOf('!payoutAccount?.stripe_account_id', stripeBlock);
    const stripeFetch = source.indexOf("api.stripe.com", stripeBlock);
    expect(destCheck).toBeGreaterThan(stripeBlock);
    expect(destCheck).toBeLessThan(stripeFetch);
  });

  it('automated methods never use the manual paid path', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'),
      'utf-8',
    );
    // finalStatus should NOT default to 'paid' — only manual methods set it
    // The code should NOT have: let finalStatus = 'paid' followed by automated branches
    // Instead, finalStatus should be declared without initial value or set per branch
    const tryBlock = source.indexOf('try {');
    const manualBlock = source.indexOf("finalStatus = 'paid'", tryBlock);
    // The 'paid' assignment must only appear in the manual (else) branch
    const elseBlock = source.indexOf('// Manual methods', tryBlock);
    expect(manualBlock).toBeGreaterThan(elseBlock);
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 6: Safe Logging
// ═══════════════════════════════════════════════════════════

describe('FIN-001: Safe logging in touched error paths', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
  });

  it('approve route error path uses safeLogErrorContext (not raw error)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'),
      'utf-8',
    );
    expect(source).toContain('safeLogErrorContext');
    expect(source).not.toContain("(error as Error).message");
    expect(source).toContain("import { safeLogErrorContext } from '@/lib/errors'");
  });

  it('auto-payout cron error paths use safeLogErrorContext', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/cron/auto-payout/route.ts'),
      'utf-8',
    );
    expect(source).toContain('safeLogErrorContext');
    expect(source).toContain("import { safeLogErrorContext } from '@/lib/errors'");
    expect(source).not.toMatch(/logger\.error\([^)]*,\s*err\s*\)/);
  });
});
