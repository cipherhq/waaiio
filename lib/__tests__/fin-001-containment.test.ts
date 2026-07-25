/**
 * FIN-001: Financial and credential containment tests
 *
 * Tests proving:
 * - Payout kill switch blocks transfers when disabled
 * - Square Connect gate blocks OAuth when disabled
 * - Stripe Connect gate blocks connection when disabled
 * - Admin query strips credential columns and enforces allowlists
 * - Transfer-method allowlist rejects unknown values
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

// ═══════════════════════════════════════════════════════════
// Scope 1: Payout Kill Switch
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
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: captureAll, info: captureAll, debug: captureAll, warn: captureAll,
        withContext: () => ({ error: captureAll, info: captureAll, debug: captureAll, warn: captureAll }),
      },
    }));
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
    // Should get past the gate — will fail on payout not found (404) which is expected
    expect(res.status).not.toBe(503);
  });
});

describe('FIN-001: Payout kill switch (auto-payout cron)', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
  });

  async function loadAutoPayout() {
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
      verifyCronAuth: vi.fn().mockReturnValue(null),
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
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: captureAll, info: captureAll, debug: captureAll, warn: captureAll,
        withContext: () => ({ error: captureAll, info: captureAll, debug: captureAll, warn: captureAll }),
      },
    }));
    return import('@/app/api/cron/auto-payout/route');
  }

  it('returns immediately when ENABLE_PAYOUTS is missing', async () => {
    delete process.env.ENABLE_PAYOUTS;
    const { GET } = await loadAutoPayout();
    const req = makeRequest('/api/cron/auto-payout', {
      headers: { Authorization: 'Bearer test-cron-secret' },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.message).toContain('disabled');
    expect(body.generated).toBe(0);
  });

  it('no provider call is made when disabled', async () => {
    delete process.env.ENABLE_PAYOUTS;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { GET } = await loadAutoPayout();
    const req = makeRequest('/api/cron/auto-payout', {
      headers: { Authorization: 'Bearer test-cron-secret' },
    });
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
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: captureAll, info: captureAll, debug: captureAll, warn: captureAll,
        withContext: () => ({ error: captureAll, info: captureAll, debug: captureAll, warn: captureAll }),
      },
    }));
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
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: captureAll, info: captureAll, debug: captureAll, warn: captureAll,
        withContext: () => ({ error: captureAll, info: captureAll, debug: captureAll, warn: captureAll }),
      },
    }));
    vi.doMock('@/lib/redact', () => ({
      safeProviderError: vi.fn().mockReturnValue('Provider error'),
    }));
    return import('@/app/api/payouts/square-callback/route');
  }

  it('redirects with error when ENABLE_SQUARE_CONNECT is missing', async () => {
    delete process.env.ENABLE_SQUARE_CONNECT;
    const { GET } = await loadSquareCallback();
    const req = makeRequest('/api/payouts/square-callback?code=test&state=biz:abc');
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location') || '';
    expect(location).toContain('square_disabled');
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
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: captureAll, info: captureAll, debug: captureAll, warn: captureAll,
        withContext: () => ({ error: captureAll, info: captureAll, debug: captureAll, warn: captureAll }),
      },
    }));
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
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: captureAll, info: captureAll, debug: captureAll, warn: captureAll,
        withContext: () => ({ error: captureAll, info: captureAll, debug: captureAll, warn: captureAll }),
      },
    }));
    return import('@/app/api/payouts/stripe-callback/route');
  }

  it('redirects with error when ENABLE_STRIPE_CONNECT is missing', async () => {
    delete process.env.ENABLE_STRIPE_CONNECT;
    const { GET } = await loadStripeCallback();
    const req = makeRequest('/api/payouts/stripe-callback?account_id=acct_123&business_id=b1');
    const res = await GET(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location') || '';
    expect(location).toContain('stripe_connect_disabled');
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
  beforeEach(() => {
    capturedLogs = [];
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
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnThis(),
            neq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            then: undefined,
            // Resolve the query
            ...(() => {
              const result = { data: tableData, error: null, count: null };
              return {
                eq: vi.fn().mockReturnThis(),
                neq: vi.fn().mockReturnThis(),
                gt: vi.fn().mockReturnThis(),
                gte: vi.fn().mockReturnThis(),
                lt: vi.fn().mockReturnThis(),
                lte: vi.fn().mockReturnThis(),
                like: vi.fn().mockReturnThis(),
                ilike: vi.fn().mockReturnThis(),
                in: vi.fn().mockReturnThis(),
                is: vi.fn().mockReturnThis(),
                order: vi.fn().mockReturnThis(),
                limit: vi.fn().mockReturnThis(),
                then: (resolve: (r: typeof result) => void) => resolve(result),
              };
            })(),
          }),
        }),
      }),
    }));
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: captureAll, info: captureAll, debug: captureAll, warn: captureAll,
        withContext: () => ({ error: captureAll, info: captureAll, debug: captureAll, warn: captureAll }),
      },
    }));
  }

  async function queryAs(role: string, table: string, data: Record<string, unknown>[]) {
    mockAdminQuery(role, data);
    const mod = await import('@/app/api/admin/query/route');
    const req = makePostRequest('/api/admin/query', { table, select: '*' }, {
      origin: 'http://localhost:8083',
    });
    return mod.POST(req);
  }

  it('finance cannot retrieve meta_access_token from whatsapp_channels', async () => {
    // Finance doesn't have whatsapp_channels in their table allowlist
    const res = await queryAs('finance', 'whatsapp_channels', []);
    expect(res.status).toBe(403);
  });

  it('operations cannot retrieve credential fields from whatsapp_channels', async () => {
    const res = await queryAs('operations', 'whatsapp_channels', [
      { id: 'ch1', business_id: 'b1', phone_number: '+1234', meta_access_token: 'EAABx...secret', display_name: 'Test' },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data[0];
    expect(row).not.toHaveProperty('meta_access_token');
    expect(row.id).toBe('ch1');
    expect(row.display_name).toBe('Test');
  });

  it('support cannot retrieve credential fields', async () => {
    // Support doesn't have whatsapp_channels or payout_accounts
    const res = await queryAs('support', 'payout_accounts', []);
    expect(res.status).toBe(403);
  });

  it('finance gets safe payout_accounts columns only', async () => {
    const res = await queryAs('finance', 'payout_accounts', [
      {
        id: 'pa1', business_id: 'b1', gateway: 'paystack', bank_name: 'GTB',
        account_name: 'John Doe', account_number: '0123456789', bank_code: '058',
        square_access_token: 'sq-secret-token', stripe_account_id: 'acct_xxx',
        routing_number: '123456', iban: 'DE89...', swift_code: 'DEUTDEFF',
        platform_percentage: 2.5, is_active: true, verified_at: '2024-01-01',
        created_at: '2024-01-01', updated_at: '2024-01-01',
      },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data[0];
    // Approved columns present
    expect(row.id).toBe('pa1');
    expect(row.gateway).toBe('paystack');
    expect(row.bank_name).toBe('GTB');
    expect(row.account_name).toBe('John Doe');
    // Sensitive columns stripped
    expect(row).not.toHaveProperty('account_number');
    expect(row).not.toHaveProperty('bank_code');
    expect(row).not.toHaveProperty('square_access_token');
    expect(row).not.toHaveProperty('stripe_account_id');
    expect(row).not.toHaveProperty('routing_number');
    expect(row).not.toHaveProperty('iban');
    expect(row).not.toHaveProperty('swift_code');
  });

  it('admin cannot retrieve credential columns via generic query route', async () => {
    const res = await queryAs('admin', 'whatsapp_channels', [
      { id: 'ch1', business_id: 'b1', meta_access_token: 'EAABx...secret', display_name: 'Test' },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data[0];
    // Credential columns stripped even for admin
    expect(row).not.toHaveProperty('meta_access_token');
    // Safe columns preserved
    expect(row.id).toBe('ch1');
    expect(row.display_name).toBe('Test');
  });

  it('admin cannot retrieve square_access_token via generic query route', async () => {
    const res = await queryAs('admin', 'payout_accounts', [
      { id: 'pa1', square_access_token: 'sq-secret', stripe_account_id: 'acct_x', account_number: '1234' },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data[0];
    expect(row).not.toHaveProperty('square_access_token');
    expect(row).not.toHaveProperty('stripe_account_id');
    // account_number is NOT in CREDENTIAL_COLUMNS but admin doesn't have column allowlist
    // so it passes through for admin (admin gets all non-credential columns)
    expect(row.id).toBe('pa1');
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

  it('admin workflows that do not require secrets continue to work', async () => {
    const res = await queryAs('admin', 'businesses', [
      { id: 'b1', name: 'Test Biz', status: 'active', country_code: 'NG' },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].name).toBe('Test Biz');
  });
});

// ═══════════════════════════════════════════════════════════
// Scope 5: Transfer-Method Allowlist
// ═══════════════════════════════════════════════════════════

describe('FIN-001: Transfer-method allowlist', () => {
  beforeEach(() => {
    capturedLogs = [];
    vi.restoreAllMocks();
    vi.resetModules();
    process.env.ENABLE_PAYOUTS = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_PAYOUTS;
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
    vi.doMock('@/lib/logger', () => ({
      logger: {
        error: captureAll, info: captureAll, debug: captureAll, warn: captureAll,
        withContext: () => ({ error: captureAll, info: captureAll, debug: captureAll, warn: captureAll }),
      },
    }));
    return import('@/app/api/admin/payouts/[id]/approve/route');
  }

  const VALID_METHODS = ['paystack_transfer', 'stripe_transfer', 'manual_bank', 'manual_cash'];

  for (const method of VALID_METHODS) {
    it(`accepts valid transfer method: ${method}`, async () => {
      const { POST } = await loadApproveRoute();
      const req = makePostRequest('/api/admin/payouts/test-id/approve', { transfer_method: method });
      const res = await POST(req, { params: Promise.resolve({ id: 'test-id' }) });
      // Should get past allowlist — 404 means payout not found, which is expected
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

  it('unknown transfer method cannot call a provider', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { POST } = await loadApproveRoute();
    const req = makePostRequest('/api/admin/payouts/test-id/approve', { transfer_method: 'unknown_method' });
    await POST(req, { params: Promise.resolve({ id: 'test-id' }) });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
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
    // Verify by reading the source that the catch block uses safeLogErrorContext
    // instead of logging raw error.message. This is a static verification test.
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve('app/api/admin/payouts/[id]/approve/route.ts'),
      'utf-8',
    );
    // The catch block should use safeLogErrorContext
    expect(source).toContain('safeLogErrorContext');
    // The catch block should NOT log raw error.message
    expect(source).not.toContain("(error as Error).message");
    // Should import safeLogErrorContext
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
    // Should not log raw error objects in payout-related catch blocks
    expect(source).not.toMatch(/logger\.error\([^)]*,\s*err\s*\)/);
  });
});
