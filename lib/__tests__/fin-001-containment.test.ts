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
  let supabaseFromCalled: boolean;

  beforeEach(() => {
    capturedLogs = [];
    capturedSelectArg = undefined;
    supabaseFromCalled = false;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function mockAdminQuery(role: string, tableData: Record<string, unknown>[]) {
    vi.doMock('@/lib/admin-auth', () => ({
      requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', role }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => {
          supabaseFromCalled = true;
          return {
            select: vi.fn().mockImplementation((selectStr: string) => {
              capturedSelectArg = selectStr;
              const result = { data: tableData, error: null, count: null };
              const chainable: Record<string, unknown> = {};
              const methods = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is', 'order', 'limit'];
              for (const m of methods) chainable[m] = vi.fn().mockReturnValue(chainable);
              chainable.then = (resolve: (r: typeof result) => void) => resolve(result);
              return chainable;
            }),
          };
        }),
      }),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: mockLogger() }));
  }

  async function queryAs(
    role: string,
    table: string,
    data: Record<string, unknown>[],
    opts?: { select?: string; filters?: unknown[]; order?: unknown },
  ) {
    mockAdminQuery(role, data);
    const mod = await import('@/app/api/admin/query/route');
    const req = makePostRequest('/api/admin/query', {
      table,
      select: opts?.select ?? '*',
      filters: opts?.filters,
      order: opts?.order,
    }, { origin: 'http://localhost:8083' });
    return mod.POST(req);
  }

  // ── Non-admin roles: every accessible table must have a registry or fail 403 ──

  const SUPPORT_TABLES = [
    'businesses', 'bookings', 'orders', 'order_items', 'services', 'products',
    'support_tickets', 'support_ticket_messages', 'events', 'event_tickets',
    'feedback', 'invoices', 'quote_requests', 'campaigns', 'alerts',
    'notifications', 'queue_entries', 'customer_subscriptions', 'surveys', 'survey_responses',
  ];

  const FINANCE_ONLY_TABLES = [
    'payments', 'platform_fees', 'business_payouts', 'refunds', 'refund_requests',
    'subscriptions', 'payout_accounts', 'campaign_donations', 'customer_profiles',
  ];

  const OPERATIONS_ONLY_TABLES = [
    'whatsapp_channels', 'whatsapp_config', 'bot_sessions', 'bot_keywords',
    'business_capabilities', 'capability_overrides', 'business_staff',
    'delivery_zones', 'reservations', 'loyalty_points',
  ];

  for (const table of SUPPORT_TABLES) {
    it(`support: ${table} select=* sends explicit columns (not *)`, async () => {
      const res = await queryAs('support', table, [{ id: 't1' }]);
      expect(res.status).toBe(200);
      expect(capturedSelectArg).not.toBe('*');
    });
  }

  for (const table of FINANCE_ONLY_TABLES) {
    it(`finance: ${table} select=* sends explicit columns (not *)`, async () => {
      const res = await queryAs('finance', table, [{ id: 't1' }]);
      expect(res.status).toBe(200);
      expect(capturedSelectArg).not.toBe('*');
    });
  }

  for (const table of OPERATIONS_ONLY_TABLES) {
    it(`operations: ${table} select=* sends explicit columns (not *)`, async () => {
      const res = await queryAs('operations', table, [{ id: 't1' }]);
      expect(res.status).toBe(200);
      expect(capturedSelectArg).not.toBe('*');
    });
  }

  // ── Unregistered tables fail before database query ──

  it('finance cannot access whatsapp_channels (table not in role list)', async () => {
    const res = await queryAs('finance', 'whatsapp_channels', []);
    expect(res.status).toBe(403);
    expect(supabaseFromCalled).toBe(false);
  });

  it('support cannot access payout_accounts (table not in role list)', async () => {
    const res = await queryAs('support', 'payout_accounts', []);
    expect(res.status).toBe(403);
    expect(supabaseFromCalled).toBe(false);
  });

  // ── Credential-like columns are rejected before query ──

  it('operations cannot request meta_access_token from whatsapp_channels', async () => {
    const res = await queryAs('operations', 'whatsapp_channels', [], {
      select: 'id,meta_access_token',
    });
    expect(res.status).toBe(403);
    expect(supabaseFromCalled).toBe(false);
  });

  it('finance cannot request account_number from payout_accounts', async () => {
    const res = await queryAs('finance', 'payout_accounts', [], {
      select: 'id,account_number',
    });
    expect(res.status).toBe(403);
    expect(supabaseFromCalled).toBe(false);
  });

  it('admin cannot request square_access_token from payout_accounts', async () => {
    const res = await queryAs('admin', 'payout_accounts', [], {
      select: 'id,square_access_token',
    });
    expect(res.status).toBe(403);
    expect(supabaseFromCalled).toBe(false);
  });

  // ── Filter and order column validation ──

  it('finance cannot filter on unapproved column', async () => {
    const res = await queryAs('finance', 'payout_accounts', [], {
      filters: [{ column: 'square_access_token', op: 'eq', value: 'test' }],
    });
    expect(res.status).toBe(403);
    expect(supabaseFromCalled).toBe(false);
    const body = await res.json();
    expect(body.error).toContain('Filter column not allowed');
  });

  it('operations cannot order by unapproved column', async () => {
    const res = await queryAs('operations', 'whatsapp_channels', [], {
      order: { column: 'meta_access_token', ascending: true },
    });
    expect(res.status).toBe(403);
    expect(supabaseFromCalled).toBe(false);
    const body = await res.json();
    expect(body.error).toContain('Order column not allowed');
  });

  it('finance can filter on approved column', async () => {
    const res = await queryAs('finance', 'platform_fees', [{ id: 'f1' }], {
      filters: [{ column: 'waived', op: 'eq', value: false }],
    });
    expect(res.status).toBe(200);
  });

  it('support can order by approved column', async () => {
    const res = await queryAs('support', 'alerts', [{ id: 'a1' }], {
      order: { column: 'created_at', ascending: false },
    });
    expect(res.status).toBe(200);
  });

  // ── Sensitive table enforcement applies to admin too ──

  it('admin select=* on payout_accounts sends explicit safe columns', async () => {
    const res = await queryAs('admin', 'payout_accounts', [{ id: 'pa1' }]);
    expect(res.status).toBe(200);
    expect(capturedSelectArg).not.toBe('*');
    expect(capturedSelectArg).not.toContain('account_number');
    expect(capturedSelectArg).not.toContain('square_access_token');
  });

  it('admin select=* on whatsapp_channels sends explicit safe columns', async () => {
    const res = await queryAs('admin', 'whatsapp_channels', [{ id: 'ch1' }]);
    expect(res.status).toBe(200);
    expect(capturedSelectArg).not.toBe('*');
    expect(capturedSelectArg).not.toContain('meta_access_token');
  });

  // ── Defense in depth: response scrubbing ──

  it('defense-in-depth scrubs nested credential fields', async () => {
    const res = await queryAs('admin', 'audit_logs', [
      { id: 'a1', nested: { meta_access_token: 'secret', name: 'safe' } },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    const nested = body.data[0].nested;
    expect(nested).not.toHaveProperty('meta_access_token');
    expect(nested.name).toBe('safe');
  });

  // ── Legitimate workflows preserved ──

  it('finance: Dashboard platform_fees query works', async () => {
    const res = await queryAs('finance', 'platform_fees', [
      { fee_total: 250, transaction_amount: 5000, business_id: 'b1' },
    ], { select: 'fee_total,transaction_amount,business_id' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].fee_total).toBe(250);
  });

  it('finance: Dashboard business_payouts query works', async () => {
    const res = await queryAs('finance', 'business_payouts', [
      { net_amount: 1000, status: 'pending', business_id: 'b1' },
    ], { select: 'net_amount,status,business_id' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].status).toBe('pending');
  });

  it('support: Dashboard businesses count query works', async () => {
    const res = await queryAs('support', 'businesses', [{ id: 'b1' }], {
      select: 'id',
      filters: [{ column: 'status', op: 'eq', value: 'active' }],
    });
    expect(res.status).toBe(200);
  });

  it('operations: Dashboard bot_sessions count works', async () => {
    const res = await queryAs('operations', 'bot_sessions', [{ id: 's1' }], {
      select: 'id',
      filters: [{ column: 'is_active', op: 'eq', value: true }],
    });
    expect(res.status).toBe(200);
  });

  it('admin workflows on unrestricted tables continue to work', async () => {
    const res = await queryAs('admin', 'audit_logs', [
      { id: 'a1', action: 'login', created_at: '2024-01-01' },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].action).toBe('login');
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
    // Manual methods are handled in a separate branch before the try block
    // and never enter the automated provider code path (claim + provider call).
    // The AUTOMATED_TRANSFER_METHODS set separates them explicitly.
    expect(source).toContain("AUTOMATED_TRANSFER_METHODS.has(transfer_method)");
    // Manual path sets status to 'paid' directly without claim
    const manualSection = source.indexOf('!AUTOMATED_TRANSFER_METHODS.has');
    const paidAssign = source.indexOf("status: 'paid'", manualSection);
    expect(paidAssign).toBeGreaterThan(manualSection);
    // The automated try block does NOT contain a 'paid' assignment
    const tryBlock = source.indexOf('try {', manualSection + 200);
    const automatedSection = source.slice(tryBlock, source.indexOf('} catch', tryBlock));
    expect(automatedSection).not.toContain("status: 'paid'");
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
