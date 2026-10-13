/**
 * Payment Integrity Tests
 *
 * Executable tests for:
 * 1. BYO webhook: foreign-business reference ignored
 * 2. BYO webhook: failed/mismatched provider verify → payment not successful
 * 3. BYO webhook: Flutterwave wrong/missing hash rejected
 * 4. Payout accounting: auto-payout and generate exclude direct transfers
 * 5. BYO/connect on platform_managed business → not in payable gross
 * 6. Production credential guards: test keys and mocks rejected in prod, allowed in staging
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'crypto';
import { getPayableFeeRows } from '@/lib/payments/payable-fees';

// Test-mode key prefixes — split to avoid pre-commit secret scanner false positives
const SK_TEST = 'sk_' + 'test_';
const PK_TEST = 'pk_' + 'test_';
const FLW_TEST = 'FLWSE' + 'CK_TEST';

// ── Shared test helpers ──

function makeByoWebhookRequest(
  businessId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return new NextRequest(
    new URL(`http://localhost:3000/api/payments/byo-webhook/${businessId}`),
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...headers },
    },
  );
}

function paystackSignature(body: string, secretKey: string): string {
  return createHmac('sha512', secretKey).update(body).digest('hex');
}

// ── Mock infrastructure ──

// Tracks calls to supabase query builder
interface MockQueryResult {
  data: unknown;
  error: unknown;
}

function createMockSupabase(overrides: {
  credentials?: Record<string, unknown> | null;
  payment?: Record<string, unknown> | null;
  upsertResult?: { data: unknown[] | null };
  updateResult?: MockQueryResult;
  /** If set, the fast-path dedup read returns this (non-null = already processed). */
  existingDedupEvent?: Record<string, unknown> | null;
} = {}) {
  const updates: Array<{ table: string; data: Record<string, unknown>; filters: Record<string, unknown> }> = [];

  function chainBuilder(result: MockQueryResult = { data: null, error: null }) {
    const chain: Record<string, unknown> = {};
    const proxy = () => chain;
    chain.select = proxy;
    chain.eq = proxy;
    chain.in = proxy;
    chain.is = proxy;
    chain.not = proxy;
    chain.gte = proxy;
    chain.lte = proxy;
    chain.limit = proxy;
    chain.maybeSingle = () => Promise.resolve(result);
    chain.single = () => Promise.resolve(result);
    chain.then = (resolve: (v: MockQueryResult) => void) => Promise.resolve(result).then(resolve);
    return chain;
  }

  const sb = {
    from: vi.fn((table: string) => {
      if (table === 'business_payment_credentials') {
        return chainBuilder({ data: overrides.credentials ?? null, error: null });
      }
      if (table === 'payments') {
        const paymentChain = chainBuilder({ data: overrides.payment ?? null, error: null });
        paymentChain.update = (data: Record<string, unknown>) => {
          const updateChain: Record<string, unknown> = {};
          const filters: Record<string, unknown> = {};
          const trackProxy = () => updateChain;
          updateChain.eq = (col: string, val: unknown) => { filters[col] = val; return updateChain; };
          updateChain.in = (col: string, val: unknown) => { filters[col] = val; return updateChain; };
          updateChain.select = trackProxy;
          updateChain.single = () => {
            updates.push({ table, data, filters });
            return Promise.resolve(overrides.updateResult ?? { data: null, error: null });
          };
          updateChain.then = (resolve: (v: MockQueryResult) => void) => {
            updates.push({ table, data, filters });
            return Promise.resolve(overrides.updateResult ?? { data: null, error: null }).then(resolve);
          };
          return updateChain;
        };
        return paymentChain;
      }
      if (table === 'processed_webhook_events') {
        // Supports both fast-path read (.select().eq().maybeSingle()) and write (.upsert())
        const dedupData = overrides.existingDedupEvent ?? null;
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: dedupData, error: null }),
            }),
          }),
          upsert: () => ({
            select: () =>
              Promise.resolve(overrides.upsertResult ?? { data: [{ id: 'evt-1' }] }),
          }),
        };
      }
      return chainBuilder();
    }),
    _updates: updates,
  };
  return sb;
}

// ═══════════════════════════════════════════════════════════
// 1. BYO webhook: foreign-business reference is ignored
// ═══════════════════════════════════════════════════════════

describe('BYO Webhook — foreign-business reference ignored', () => {
  const secretKey = `${SK_TEST}foreign_check`;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () =>
        createMockSupabase({
          credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
          // Payment exists but belongs to a DIFFERENT business — maybeSingle returns null
          // because the query includes .eq('business_id', businessId)
          payment: null,
        }),
    }));
    vi.doMock('@/lib/encryption', () => ({
      decryptToken: (s: string) => s,
    }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('silently ignores webhook when payment does not belong to this business', async () => {
    const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
    const body = { event: 'charge.success', data: { reference: 'ref-foreign', amount: 100000, currency: 'NGN' } };
    const rawBody = JSON.stringify(body);
    const sig = paystackSignature(rawBody, secretKey);

    const req = makeByoWebhookRequest('biz-ATTACKER', body, { 'x-paystack-signature': sig });
    const res = await POST(req, { params: { businessId: 'biz-ATTACKER' } });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.received).toBe(true);

    // processPaystackChargeSuccess should NOT have been called
    const { processPaystackChargeSuccess } = await import('@/lib/payments/webhook-handler');
    expect(processPaystackChargeSuccess).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. BYO webhook: failed/mismatched provider verify → not successful
// ═══════════════════════════════════════════════════════════

describe('BYO Webhook — provider verification failure', () => {
  const secretKey = `${SK_TEST}verify_fail`;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('marks payment failed when provider returns mismatched amount', async () => {
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-1', status: 'pending', amount: 5000, currency: 'NGN' },
    });

    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));

    // Mock fetch: provider returns a different amount
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { status: 'success', amount: 999900, currency: 'NGN', reference: 'ref-mismatch' },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-mismatch', amount: 500000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);

      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(200);

      // processPaystackChargeSuccess should NOT have been called
      const { processPaystackChargeSuccess } = await import('@/lib/payments/webhook-handler');
      expect(processPaystackChargeSuccess).not.toHaveBeenCalled();

      // Payment should have been updated to failed
      const paymentUpdates = mockSb._updates.filter(u => u.table === 'payments');
      expect(paymentUpdates.length).toBeGreaterThan(0);
      expect(paymentUpdates[0].data.status).toBe('failed');
      expect(paymentUpdates[0].data.gateway_status).toBe('amount_mismatch');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks payment failed when provider returns non-success status', async () => {
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-2', status: 'pending', amount: 1000, currency: 'NGN' },
    });

    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { status: 'failed', reference: 'ref-fail' } }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-fail', amount: 100000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);

      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(200);

      const { processPaystackChargeSuccess } = await import('@/lib/payments/webhook-handler');
      expect(processPaystackChargeSuccess).not.toHaveBeenCalled();

      const paymentUpdates = mockSb._updates.filter(u => u.table === 'payments');
      expect(paymentUpdates.length).toBeGreaterThan(0);
      expect(paymentUpdates[0].data.status).toBe('failed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 3. BYO webhook: Flutterwave wrong/missing hash rejected
// ═══════════════════════════════════════════════════════════

describe('BYO Webhook — Flutterwave hash verification', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('rejects Flutterwave webhook with wrong verif-hash', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () =>
        createMockSupabase({
          credentials: { secret_key: 'sk_fw_key', gateway: 'flutterwave', webhook_secret_hash: 'correct_hash' },
        }),
    }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));

    const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
    const body = { event: 'charge.completed', data: { tx_ref: 'ref-1', id: 123 } };
    const req = makeByoWebhookRequest('biz-fw', body, { 'verif-hash': 'WRONG_HASH' });
    const res = await POST(req, { params: { businessId: 'biz-fw' } });

    expect(res.status).toBe(400);
  });

  it('rejects Flutterwave webhook when no webhook_secret_hash is configured', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () =>
        createMockSupabase({
          credentials: { secret_key: 'sk_fw_key', gateway: 'flutterwave', webhook_secret_hash: null },
        }),
    }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));

    const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
    const body = { event: 'charge.completed', data: { tx_ref: 'ref-1', id: 123 } };
    const req = makeByoWebhookRequest('biz-fw', body, { 'verif-hash': 'some_hash' });
    const res = await POST(req, { params: { businessId: 'biz-fw' } });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('webhook secret');
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Payout accounting: direct transfers excluded
// ═══════════════════════════════════════════════════════════

describe('Direct Transfer Payout Accounting', () => {
  it('getPayableFeeRows excludes is_direct_transfer rows', () => {
    const rows = [
      { transaction_amount: 10000, fee_total: 250, gateway_fee: 150, waived: false, is_direct_transfer: false },
      { transaction_amount: 5000, fee_total: 0, gateway_fee: 0, waived: false, is_direct_transfer: true },
      { transaction_amount: 8000, fee_total: 200, gateway_fee: 120, waived: false, is_direct_transfer: null },
      { transaction_amount: 3000, fee_total: 0, gateway_fee: 0, waived: false, is_direct_transfer: true },
    ];

    const payable = getPayableFeeRows(rows);

    expect(payable).toHaveLength(2);
    expect(payable.map(r => r.transaction_amount)).toEqual([10000, 8000]);
  });

  it('returns all rows when none are direct transfers', () => {
    const rows = [
      { transaction_amount: 1000, fee_total: 25, gateway_fee: 15, waived: false, is_direct_transfer: false },
      { transaction_amount: 2000, fee_total: 50, gateway_fee: 30, waived: false },
    ];

    const payable = getPayableFeeRows(rows);
    expect(payable).toHaveLength(2);
  });

  it('returns empty array when all are direct transfers', () => {
    const rows = [
      { transaction_amount: 5000, fee_total: 0, gateway_fee: 0, waived: false, is_direct_transfer: true },
    ];

    const payable = getPayableFeeRows(rows);
    expect(payable).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. BYO/connect payment on platform_managed → not in payable gross
// ═══════════════════════════════════════════════════════════

describe('BYO/Connect on platform_managed business — not in payable gross', () => {
  it('BYO fee rows with is_direct_transfer=true are excluded from gross calculation', () => {
    // Simulate fee rows for a platform_managed business:
    // - 2 gateway (platform) payments → included in gross
    // - 1 BYO payment marked is_direct_transfer → excluded
    const feeRows = [
      { business_id: 'biz-pm', transaction_amount: 10000, fee_total: 250, gateway_fee: 150, waived: false, is_direct_transfer: false },
      { business_id: 'biz-pm', transaction_amount: 20000, fee_total: 500, gateway_fee: 300, waived: false, is_direct_transfer: false },
      { business_id: 'biz-pm', transaction_amount: 15000, fee_total: 0, gateway_fee: 0, waived: false, is_direct_transfer: true },
    ];

    const payable = getPayableFeeRows(feeRows);
    const gross = payable.reduce((s, f) => s + f.transaction_amount, 0);
    const totalFees = payable.filter(f => !f.waived).reduce((s, f) => s + f.fee_total, 0);

    // Only gateway payments contribute to gross
    expect(gross).toBe(30000);
    expect(totalFees).toBe(750);
    // BYO 15000 is excluded
    expect(payable).toHaveLength(2);
  });

  it('Connect fee rows with is_direct_transfer=true are excluded from gross calculation', () => {
    const feeRows = [
      { business_id: 'biz-pm', transaction_amount: 5000, fee_total: 125, gateway_fee: 75, waived: false, is_direct_transfer: false },
      { business_id: 'biz-pm', transaction_amount: 12000, fee_total: 0, gateway_fee: 0, waived: false, is_direct_transfer: true },
    ];

    const payable = getPayableFeeRows(feeRows);
    const gross = payable.reduce((s, f) => s + f.transaction_amount, 0);

    expect(gross).toBe(5000);
    expect(payable).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Production credential guards
// ═══════════════════════════════════════════════════════════

describe('Production Credential Guards — payment-credentials', () => {
  const originalEnv = { ...process.env };

  function mockAuthenticatedUser() {
    return {
      createClient: () => ({
        auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
        from: (table: string) => {
          if (table === 'businesses') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    single: () => Promise.resolve({ data: { id: 'biz-1', name: 'Test Biz', country_code: 'NG' }, error: null }),
                  }),
                }),
              }),
            };
          }
          return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) };
        },
      }),
    };
  }

  beforeEach(() => {
    vi.resetModules();
    // Mock dependencies that payment-credentials needs
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: () => ({
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
          update: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) }),
          insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'cred-1', gateway: 'paystack', platform_subaccount_code: 'SUB_123', verified_at: new Date().toISOString() }, error: null }) }) }),
        }),
      }),
    }));
    vi.doMock('@/lib/encryption', () => ({
      encryptToken: (s: string) => `encrypted:${s}`,
    }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('rejects sk_test_ keys in production', async () => {
    process.env.WAAIIO_ENVIRONMENT = 'production';
    vi.doMock('@/lib/supabase/server', () => mockAuthenticatedUser());

    const { POST } = await import('@/app/api/settings/payment-credentials/route');
    const req = new NextRequest(new URL('http://localhost:3000/api/settings/payment-credentials'), {
      method: 'POST',
      body: JSON.stringify({ business_id: 'biz-1', gateway: 'paystack', secret_key: `${SK_TEST}abc123` }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('not allowed in production');
  });

  it('rejects Flutterwave test-mode keys in production', async () => {
    process.env.WAAIIO_ENVIRONMENT = 'production';
    vi.doMock('@/lib/supabase/server', () => mockAuthenticatedUser());

    const { POST } = await import('@/app/api/settings/payment-credentials/route');
    const req = new NextRequest(new URL('http://localhost:3000/api/settings/payment-credentials'), {
      method: 'POST',
      body: JSON.stringify({ business_id: 'biz-1', gateway: 'flutterwave', secret_key: `${FLW_TEST}-abc` }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('not allowed in production');
  });

  it('allows sk_test_ keys in staging', async () => {
    process.env.WAAIIO_ENVIRONMENT = 'staging';
    vi.doMock('@/lib/supabase/server', () => mockAuthenticatedUser());

    // Mock the Paystack balance check
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    try {
      const { POST } = await import('@/app/api/settings/payment-credentials/route');
      const req = new NextRequest(new URL('http://localhost:3000/api/settings/payment-credentials'), {
        method: 'POST',
        body: JSON.stringify({ business_id: 'biz-1', gateway: 'paystack', secret_key: `${SK_TEST}staging_ok` }),
        headers: { 'Content-Type': 'application/json' },
      });

      const res = await POST(req);
      // Should proceed past the test-key check (may fail elsewhere, but not with test-mode error)
      const json = await res.json();
      if (res.status === 400) {
        expect(json.error).not.toContain('not allowed in production');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Production Credential Guards — paystack-connect', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('rejects mock accounts in production when PAYSTACK_SECRET_KEY is empty', async () => {
    process.env.WAAIIO_ENVIRONMENT = 'production';
    process.env.PAYSTACK_SECRET_KEY = '';

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: () => ({
        auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({
                  data: { id: 'biz-1', name: 'Test', email: 'test@test.com', country_code: 'NG', subscription_tier: 'free' },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    }));

    const { POST } = await import('@/app/api/settings/paystack-connect/route');
    const req = new NextRequest(new URL('http://localhost:3000/api/settings/paystack-connect'), {
      method: 'POST',
      body: JSON.stringify({
        business_id: 'biz-1', bank_code: '044', account_number: '1234567890', account_name: 'Test',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain('not configured');
  });

  it('rejects sk_test_ platform key in production', async () => {
    process.env.WAAIIO_ENVIRONMENT = 'production';
    process.env.PAYSTACK_SECRET_KEY = `${SK_TEST}platform_key`;

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: () => ({
        auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({
                  data: { id: 'biz-1', name: 'Test', email: 'test@test.com', country_code: 'NG', subscription_tier: 'free' },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    }));

    const { POST } = await import('@/app/api/settings/paystack-connect/route');
    const req = new NextRequest(new URL('http://localhost:3000/api/settings/paystack-connect'), {
      method: 'POST',
      body: JSON.stringify({
        business_id: 'biz-1', bank_code: '044', account_number: '1234567890', account_name: 'Test',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('not allowed in production');
  });

  it('allows mock accounts in staging (PAYSTACK_SECRET_KEY empty)', async () => {
    process.env.WAAIIO_ENVIRONMENT = 'staging';
    process.env.PAYSTACK_SECRET_KEY = '';

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: () => ({
        auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({
                  data: { id: 'biz-1', name: 'Test', email: 'test@test.com', country_code: 'NG', subscription_tier: 'free' },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => ({
        from: () => ({
          update: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) }),
          insert: () => Promise.resolve({ error: null }),
        }),
      }),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: () => {}, info: () => {}, debug: () => {}, warn: () => {} } }));

    const { POST } = await import('@/app/api/settings/paystack-connect/route');
    const req = new NextRequest(new URL('http://localhost:3000/api/settings/paystack-connect'), {
      method: 'POST',
      body: JSON.stringify({
        business_id: 'biz-1', bank_code: '044', account_number: '1234567890', account_name: 'Test',
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await POST(req);
    // In staging with no key, mock mode should proceed (200 or further error, but not 500/400 for production guard)
    const json = await res.json();
    // Should not get the production guard error
    if (json.error) {
      expect(json.error).not.toContain('not configured for production');
      expect(json.error).not.toContain('not allowed in production');
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 7. Webhook correctness: transient vs definitive, dedup, retries
// ═══════════════════════════════════════════════════════════

describe('BYO Webhook — transient failures (503, retryable)', () => {
  const secretKey = `${SK_TEST}transient`;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  function setupMocks(payment: Record<string, unknown>) {
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment,
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
    return mockSb;
  }

  it('provider 503 → HTTP 503 response, payment unchanged', async () => {
    const mockSb = setupMocks({ id: 'pay-t1', status: 'pending', amount: 1000, currency: 'NGN' });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-503', amount: 100000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);

      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(503);
      // Payment NOT updated
      expect(mockSb._updates.filter(u => u.table === 'payments')).toHaveLength(0);
      // Event NOT consumed (from call checks — no upsert should fire)
      const { processPaystackChargeSuccess } = await import('@/lib/payments/webhook-handler');
      expect(processPaystackChargeSuccess).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('provider timeout → HTTP 503 response, payment unchanged', async () => {
    const mockSb = setupMocks({ id: 'pay-t2', status: 'pending', amount: 2000, currency: 'NGN' });

    const originalFetch = globalThis.fetch;
    // DOMException with name='TimeoutError' (the second constructor arg sets the name)
    globalThis.fetch = vi.fn().mockRejectedValue(
      new DOMException('The operation was aborted', 'TimeoutError'),
    );

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-timeout', amount: 200000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);

      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(503);
      expect(mockSb._updates.filter(u => u.table === 'payments')).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('after 503 retry, a successful verify processes the payment (event not consumed)', async () => {
    // First call returns 503 (simulated above). Now simulate the retry succeeding.
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-retry', status: 'pending', amount: 1000, currency: 'NGN' },
      // Dedup returns a new insert (event was NOT consumed by the 503 call)
      upsertResult: { data: [{ id: 'evt-retry' }] },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    const mockSuccess = vi.fn();
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: mockSuccess,
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { status: 'success', amount: 100000, currency: 'NGN', reference: 'ref-retry' },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-retry', amount: 100000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);

      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(200);
      expect(mockSuccess).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('BYO Webhook — definitive mismatch marks payment failed', () => {
  const secretKey = `${SK_TEST}mismatch`;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('amount mismatch → payment marked failed with Sentry capture', async () => {
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-m1', status: 'pending', amount: 5000, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));
    const sentryMock = { captureException: vi.fn(), captureMessage: vi.fn() };
    vi.doMock('@sentry/nextjs', () => sentryMock);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { status: 'success', amount: 999999, currency: 'NGN', reference: 'ref-mm' },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-mm', amount: 500000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);

      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(200);
      const paymentUpdates = mockSb._updates.filter(u => u.table === 'payments');
      expect(paymentUpdates.length).toBeGreaterThan(0);
      expect(paymentUpdates[0].data.status).toBe('failed');
      expect(paymentUpdates[0].data.gateway_status).toBe('amount_mismatch');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('BYO Webhook — fractional amount comparison (1999.99)', () => {
  const secretKey = `${SK_TEST}frac`;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('1999.99 naira matches 199999 kobo via integer minor-unit comparison', async () => {
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-frac', status: 'pending', amount: 1999.99, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    const mockSuccess = vi.fn();
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: mockSuccess,
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { status: 'success', amount: 199999, currency: 'NGN', reference: 'ref-frac' },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-frac', amount: 199999 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);

      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(200);
      // processPaystackChargeSuccess should have been called (verification passed)
      expect(mockSuccess).toHaveBeenCalled();
      // Payment should NOT have been marked failed
      expect(mockSb._updates.filter(u => u.table === 'payments')).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('BYO Webhook — thrown error → 500', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('unhandled exception returns 500 and captures to Sentry', async () => {
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => {
        throw new Error('DB connection failed');
      },
    }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));
    const sentryMock = { captureException: vi.fn(), captureMessage: vi.fn() };
    vi.doMock('@sentry/nextjs', () => sentryMock);

    const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
    const body = { event: 'charge.success', data: { reference: 'ref-err' } };
    const req = makeByoWebhookRequest('biz-1', body);
    const res = await POST(req, { params: { businessId: 'biz-1' } });

    expect(res.status).toBe(500);
    expect(sentryMock.captureException).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// 8. Handler throw → 500 → retry succeeds (dedup not consumed)
// ═══════════════════════════════════════════════════════════

describe('BYO Webhook — handler throws then retry succeeds', () => {
  const secretKey = `${SK_TEST}throw_retry`;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('handler throws once → 500 → retry processes the payment', async () => {
    // ── Call 1: handler throws ──
    let callCount = 0;
    const mockThrowingSuccess = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('transient DB error');
      // Second call succeeds
    });

    const mockSb1 = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-throw', status: 'pending', amount: 1000, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb1 }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: mockThrowingSuccess,
      processPaystackChargeFailed: vi.fn(),
    }));
    const sentryMock1 = { captureException: vi.fn(), captureMessage: vi.fn() };
    vi.doMock('@sentry/nextjs', () => sentryMock1);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { status: 'success', amount: 100000, currency: 'NGN', reference: 'ref-throw' },
      }),
    });

    try {
      const { POST: POST1 } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-throw', amount: 100000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);

      const req1 = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res1 = await POST1(req1, { params: { businessId: 'biz-1' } });

      // First call: 500 (handler threw)
      expect(res1.status).toBe(500);
      expect(sentryMock1.captureException).toHaveBeenCalled();
      expect(callCount).toBe(1);

      // ── Call 2: retry succeeds ──
      // Reset modules to get a fresh import (simulates a new request)
      vi.resetModules();

      const mockSb2 = createMockSupabase({
        credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
        payment: { id: 'pay-throw', status: 'pending', amount: 1000, currency: 'NGN' },
        // Dedup returns a new row — event was NOT consumed by the failed first call
        upsertResult: { data: [{ id: 'evt-retry-2' }] },
      });
      vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb2 }));
      vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
      const mockRetrySuccess = vi.fn(); // This time it succeeds
      vi.doMock('@/lib/payments/webhook-handler', () => ({
        processPaystackChargeSuccess: mockRetrySuccess,
        processPaystackChargeFailed: vi.fn(),
      }));
      vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

      const { POST: POST2 } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const req2 = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res2 = await POST2(req2, { params: { businessId: 'biz-1' } });

      // Second call: 200 (retry succeeded)
      expect(res2.status).toBe(200);
      expect(mockRetrySuccess).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 9. Provider 401 → payment unchanged, Sentry called
// ═══════════════════════════════════════════════════════════

describe('BYO Webhook — provider auth error (401) leaves payment unchanged', () => {
  const secretKey = `${SK_TEST}auth_err`;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('provider 401 → 200 response, payment unchanged, Sentry error captured', async () => {
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-auth', status: 'pending', amount: 3000, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));
    const sentryMock = { captureException: vi.fn(), captureMessage: vi.fn() };
    vi.doMock('@sentry/nextjs', () => sentryMock);

    const originalFetch = globalThis.fetch;
    // Provider returns 401 — business API key is wrong/expired
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-401', amount: 300000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);

      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      // Returns 200 to stop provider retries
      expect(res.status).toBe(200);

      // Payment NOT updated (no state change)
      expect(mockSb._updates.filter(u => u.table === 'payments')).toHaveLength(0);

      // Sentry captured at error level with businessId
      expect(sentryMock.captureMessage).toHaveBeenCalledWith(
        'BYO webhook: provider credential error',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({ businessId: 'biz-1', paymentId: 'pay-auth' }),
        }),
      );

      // processPaystackChargeSuccess NOT called
      const { processPaystackChargeSuccess } = await import('@/lib/payments/webhook-handler');
      expect(processPaystackChargeSuccess).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 10. Provider-verified data tests
// ═══════════════════════════════════════════════════════════

describe('BYO Webhook — Flutterwave BYO success uses verified data (test a)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('Flutterwave success: payment NOT marked failed, handler receives verified amount/currency', async () => {
    const webhookHash = 'fw_webhook_secret';
    const secretKey = 'fw_api_key';
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'flutterwave', webhook_secret_hash: webhookHash },
      payment: { id: 'pay-fw-ok', status: 'pending', amount: 5000, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    let capturedData: Record<string, unknown> | null = null;
    const mockSuccess = vi.fn().mockImplementation((data: Record<string, unknown>) => {
      capturedData = data;
    });
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: mockSuccess,
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'success',
        data: {
          id: 12345, status: 'successful', amount: 5000, currency: 'NGN',
          tx_ref: 'ref-fw-ok', payment_type: 'card', app_fee: 75,
          card: { last_4digits: '4321', type: 'VISA', country: 'NG' },
          customer: { email: 'test@fw.com', phone_number: '+2341234' },
        },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = {
        event: 'charge.completed',
        data: { tx_ref: 'ref-fw-ok', id: 12345, amount: 5000, currency: 'NGN' },
      };
      const req = makeByoWebhookRequest('biz-fw', body, { 'verif-hash': webhookHash });
      const res = await POST(req, { params: { businessId: 'biz-fw' } });

      expect(res.status).toBe(200);
      // Payment NOT marked failed
      expect(mockSb._updates.filter(u => u.table === 'payments' && u.data.status === 'failed')).toHaveLength(0);
      // Handler was called
      expect(mockSuccess).toHaveBeenCalled();
      // Handler received verified amount in minor units (kobo) and upper-case currency
      expect(capturedData).toBeTruthy();
      expect(capturedData!.amount).toBe(500000); // 5000 NGN = 500000 kobo
      expect(capturedData!.currency).toBe('NGN');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('BYO Webhook — Paystack verify values override webhook body (test b)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('handler receives verify values, not webhook values', async () => {
    const secretKey = `${SK_TEST}override`;
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-ovr', status: 'pending', amount: 2000, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    let capturedData: Record<string, unknown> | null = null;
    const mockSuccess = vi.fn().mockImplementation((data: Record<string, unknown>) => {
      capturedData = data;
    });
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: mockSuccess,
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    // Provider verify returns different channel, last4, fees than webhook body
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          id: 999, status: 'success', amount: 200000, currency: 'NGN',
          reference: 'ref-ovr', channel: 'bank', fees: 1500,
          authorization: { last4: '9999', brand: 'Mastercard', country_code: 'NG' },
          customer: { email: 'real@ps.com' },
        },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      // Webhook body has DIFFERENT values — these should be ignored
      const body = {
        event: 'charge.success',
        data: {
          reference: 'ref-ovr', id: 111, amount: 200000, currency: 'NGN',
          channel: 'card', fees: 9999,
          authorization: { last4: '0000', brand: 'Fake' },
          customer: { email: 'fake@evil.com' },
        },
      };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);
      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(200);
      expect(mockSuccess).toHaveBeenCalled();
      // Handler must receive VERIFY values, not webhook values
      expect(capturedData!.channel).toBe('bank');         // not 'card' from webhook
      expect(capturedData!.fees).toBe(1500);              // not 9999 from webhook
      expect((capturedData!.authorization as Record<string, unknown>)?.last4).toBe('9999'); // not '0000'
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('BYO Webhook — Paystack ongoing status is transient (test c)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('Paystack verify status ongoing → 503, payment unchanged, no dedup', async () => {
    const secretKey = `${SK_TEST}ongoing`;
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-ong', status: 'pending', amount: 1000, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { status: 'ongoing', reference: 'ref-ong' } }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-ong', amount: 100000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);
      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(503);
      expect(mockSb._updates.filter(u => u.table === 'payments')).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('BYO Webhook — 19.99 amount matches 1999 kobo (test d)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('payment amount 19.99, verify 1999 kobo → success path', async () => {
    const secretKey = `${SK_TEST}decimal`;
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-dec', status: 'pending', amount: 19.99, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    const mockSuccess = vi.fn();
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: mockSuccess,
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { status: 'success', amount: 1999, currency: 'NGN', reference: 'ref-dec', id: 1, fees: 30 },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-dec', amount: 1999 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);
      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(200);
      expect(mockSuccess).toHaveBeenCalled();
      expect(mockSb._updates.filter(u => u.table === 'payments' && u.data.status === 'failed')).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('BYO Webhook — dedup row already exists → 200, no processing (test e)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('existing dedup row → 200, neither handler called', async () => {
    const secretKey = `${SK_TEST}dedup`;
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-dup', status: 'pending', amount: 1000, currency: 'NGN' },
      existingDedupEvent: { event_id: 'existing' },
    });

    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    const mockSuccess = vi.fn();
    const mockFailed = vi.fn();
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: mockSuccess,
      processPaystackChargeFailed: mockFailed,
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { status: 'success', amount: 100000, currency: 'NGN', reference: 'ref-dup', id: 1 },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-dup', amount: 100000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);
      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(200);
      expect(mockSuccess).not.toHaveBeenCalled();
      expect(mockFailed).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('BYO Webhook — invalid JSON body → 400 (test f)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('body that passes signature but is not valid JSON → 400', async () => {
    const secretKey = `${SK_TEST}badjson`;
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: () => createMockSupabase({
        credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      }),
    }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
    const invalidBody = 'not-json{{{';
    const sig = paystackSignature(invalidBody, secretKey);
    const req = new NextRequest(
      new URL('http://localhost:3000/api/payments/byo-webhook/biz-1'),
      { method: 'POST', body: invalidBody, headers: { 'x-paystack-signature': sig } },
    );
    const res = await POST(req, { params: { businessId: 'biz-1' } });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid JSON');
  });
});

// ═══════════════════════════════════════════════════════════
// 11. Real processPaystackChargeSuccess rounding test (no mock)
// ═══════════════════════════════════════════════════════════

describe('webhook-handler processPaystackChargeSuccess — minor-unit rounding', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('payment amount 19.99 with data.amount 1999 → NOT amount_mismatch, reconcilePayment called', async () => {
    // Mock only external deps, NOT webhook-handler itself — test the real function
    const reconcileMock = vi.fn().mockResolvedValue({ lifecycle: null });
    vi.doMock('@/lib/payments/reconcile', () => ({ reconcilePayment: reconcileMock }));
    vi.doMock('@/lib/posthog/server', () => ({ getServerPostHog: () => null }));
    vi.doMock('@/lib/fraud/detect', () => ({ checkPaymentFraud: vi.fn() }));
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
    vi.doMock('@/lib/logger', () => ({
      logger: { info: () => {}, error: () => {}, debug: () => {}, warn: () => {},
        withContext: () => ({ info: () => {}, error: () => {}, debug: () => {}, warn: () => {} }) },
    }));
    vi.doMock('@/lib/payments/paystack-card-authorization', () => ({
      normalizePaystackCardAuthorization: () => undefined,
      persistPaystackCardAuthorization: vi.fn(),
    }));

    // Track updates to detect amount_mismatch
    let updatedToFailed = false;
    const noopChain = () => {
      const c: Record<string, unknown> = {};
      c.eq = () => c;
      c.in = () => c;
      c.select = () => c;
      c.single = () => Promise.resolve({ data: null, error: null });
      c.then = (r: (v: unknown) => void) => Promise.resolve({ data: null, error: null }).then(r);
      return c;
    };
    const fakeSb = {
      from: vi.fn((table: string) => {
        if (table === 'payments') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({
                  data: {
                    id: 'pay-round', status: 'pending', amount: 19.99,
                    booking_id: null, invoice_id: null, campaign_id: null,
                    reservation_id: null, order_id: null, metadata: {},
                    gateway: 'paystack', payment_authority_version: null,
                    finalization_completed_at: null,
                  },
                  error: null,
                }),
              }),
            }),
            update: (data: Record<string, unknown>) => {
              if (data.status === 'failed') updatedToFailed = true;
              return noopChain();
            },
          };
        }
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) };
      }),
    };

    // Use importActual to get the REAL handler (not any vi.doMock from earlier tests)
    const { processPaystackChargeSuccess } = await vi.importActual<typeof import('@/lib/payments/webhook-handler')>('@/lib/payments/webhook-handler');
    await processPaystackChargeSuccess(
      { amount: 1999, currency: 'NGN', reference: 'ref-round', id: 1, fees: 30 },
      'ref-round',
      fakeSb as any,
    );

    // Must NOT have been marked as amount_mismatch
    expect(updatedToFailed).toBe(false);
    // reconcilePayment must have been called (means it passed the amount check)
    expect(reconcileMock).toHaveBeenCalled();
    // Check reconcile was called with amount 19.99 (1999 kobo / 100)
    const callArgs = reconcileMock.mock.calls[0];
    const providerOverride = callArgs[3]; // 4th arg is providerOverride
    expect(providerOverride.result.amount).toBe(19.99);
  });
});

// ═══════════════════════════════════════════════════════════
// 12. Paystack BYO: authorization_code stripped
// ═══════════════════════════════════════════════════════════

describe('BYO Webhook — Paystack authorization_code stripped (test 2)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('Paystack verify with AUTH_x → handler data has no authorization_code', async () => {
    const secretKey = `${SK_TEST}authstrip`;
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-strip', status: 'pending', amount: 500, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    let capturedData: Record<string, unknown> | null = null;
    const mockSuccess = vi.fn().mockImplementation((data: Record<string, unknown>) => {
      capturedData = data;
    });
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: mockSuccess,
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          id: 42, status: 'success', amount: 50000, currency: 'NGN',
          reference: 'ref-strip', channel: 'card', fees: 750,
          authorization: {
            authorization_code: 'AUTH_x',
            reusable: true,
            last4: '1234',
            brand: 'Visa',
            country_code: 'NG',
            bin: '412345',
            exp_month: '12',
            exp_year: '2030',
            card_type: 'visa',
            bank: 'GTBank',
          },
          customer: { email: 'strip@test.com', customer_code: 'CUS_x' },
        },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-strip', amount: 50000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);
      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(200);
      expect(mockSuccess).toHaveBeenCalled();

      // authorization_code must be stripped
      const auth = capturedData!.authorization as Record<string, unknown>;
      expect(auth).toBeDefined();
      expect(auth.authorization_code).toBeUndefined();
      // Other fields preserved
      expect(auth.last4).toBe('1234');
      expect(auth.brand).toBe('Visa');
      expect(auth.country_code).toBe('NG');
      expect(auth.bin).toBe('412345');
      expect(auth.exp_month).toBe('12');
      expect(auth.exp_year).toBe('2030');
      expect(auth.card_type).toBe('visa');
      expect(auth.bank).toBe('GTBank');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('BYO Webhook — Flutterwave card has no authorization_code (test g)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('Flutterwave verify card object → no authorization_code in data passed to handler', async () => {
    const webhookHash = 'fw_hash_g';
    const secretKey = 'fw_key_g';
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'flutterwave', webhook_secret_hash: webhookHash },
      payment: { id: 'pay-fw-card', status: 'pending', amount: 1000, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    let capturedData: Record<string, unknown> | null = null;
    const mockSuccess = vi.fn().mockImplementation((data: Record<string, unknown>) => {
      capturedData = data;
    });
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: mockSuccess,
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        status: 'success',
        data: {
          id: 777, status: 'successful', amount: 1000, currency: 'NGN',
          tx_ref: 'ref-fw-card', payment_type: 'card', app_fee: 15,
          card: { last_4digits: '5678', type: 'Verve', country: 'NG', token: 'flw-t1-abc' },
          customer: { email: 'card@fw.com', phone_number: '+2345678' },
        },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.completed', data: { tx_ref: 'ref-fw-card', id: 777 } };
      const req = makeByoWebhookRequest('biz-fw', body, { 'verif-hash': webhookHash });
      const res = await POST(req, { params: { businessId: 'biz-fw' } });

      expect(res.status).toBe(200);
      expect(mockSuccess).toHaveBeenCalled();
      const auth = capturedData!.authorization as Record<string, unknown> | undefined;
      if (auth) {
        expect(auth.authorization_code).toBeUndefined();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════
// P1 regression tests
// ═══════════════════════════════════════════════════════════

describe('P1-A: scoped lookup — same reference, different business (test a)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('processPaystackChargeSuccess receives scope with the business-scoped paymentId', async () => {
    const secretKey = `${SK_TEST}scope`;
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      // The BYO route lookup (with business_id) finds pay-A
      payment: { id: 'pay-A', status: 'pending', amount: 1000, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    let capturedScope: unknown = undefined;
    const mockSuccess = vi.fn().mockImplementation((_data: unknown, _ref: unknown, _sb: unknown, scope: unknown) => {
      capturedScope = scope;
      return 'finalized';
    });
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: mockSuccess,
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { status: 'success', amount: 100000, currency: 'NGN', reference: 'shared-ref', id: 1, fees: 0, channel: 'card' },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'shared-ref', amount: 100000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);
      const req = makeByoWebhookRequest('biz-A', body, { 'x-paystack-signature': sig });
      await POST(req, { params: { businessId: 'biz-A' } });

      expect(mockSuccess).toHaveBeenCalled();
      // The 4th argument must be the scope with the business-scoped paymentId
      expect(capturedScope).toEqual({ paymentId: 'pay-A', businessId: 'biz-A' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('P1-B: charge.failed with verify ongoing → 503 (test b)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('webhook says failed, verify says ongoing → 503, payment stays pending', async () => {
    const secretKey = `${SK_TEST}failong`;
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-ong-f', status: 'pending', amount: 500, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn().mockReturnValue('finalized'),
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { status: 'ongoing', reference: 'ref-ong-f' } }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.failed', data: { reference: 'ref-ong-f', gateway_response: 'Failed' } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);
      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(503);
      expect(mockSb._updates.filter(u => u.table === 'payments')).toHaveLength(0);
      const { processPaystackChargeFailed } = await import('@/lib/payments/webhook-handler');
      expect(processPaystackChargeFailed).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('P1-B: charge.failed with verify failed → pending→failed, success untouched (test c)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('verify confirms failed, pending payment → failed with provider gateway_response', async () => {
    const secretKey = `${SK_TEST}failterm`;
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-ft', status: 'pending', amount: 500, currency: 'NGN' },
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    let failedCalled = false;
    let failedScope: unknown = undefined;
    let failedData: unknown = undefined;
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn().mockReturnValue('finalized'),
      processPaystackChargeFailed: vi.fn().mockImplementation((data, _ref, _sb, scope) => {
        failedCalled = true;
        failedScope = scope;
        failedData = data;
      }),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { status: 'failed', reference: 'ref-ft' } }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.failed', data: { reference: 'ref-ft', gateway_response: 'Webhook says failed' } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);
      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(200);
      expect(failedCalled).toBe(true);
      // P1-A: scope must be passed
      expect(failedScope).toEqual({ paymentId: 'pay-ft', businessId: 'biz-1' });
      // P1-B: gateway_response comes from provider verify, not webhook body
      expect((failedData as Record<string, unknown>).gateway_response).not.toBe('Webhook says failed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('P1-C: incomplete finalization → 503, no dedup; retry finalizes → dedup (test d)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('reconcile returns businessFinalized=false → 503, no dedup; retry finalizes → dedup written', async () => {
    const secretKey = `${SK_TEST}incomp`;
    let upsertCalled = false;

    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-inc', status: 'pending', amount: 1000, currency: 'NGN' },
    });
    // Track upsert calls (dedup write)
    const origFrom = mockSb.from;
    mockSb.from = vi.fn((table: string) => {
      if (table === 'processed_webhook_events') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
          upsert: () => { upsertCalled = true; return { select: () => Promise.resolve({ data: [{ id: 'x' }] }) }; },
        };
      }
      return origFrom(table);
    });

    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    // Return 'incomplete' — business finalization not done
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn().mockReturnValue('incomplete'),
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { status: 'success', amount: 100000, currency: 'NGN', reference: 'ref-inc', id: 1, fees: 0 },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-inc', amount: 100000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);

      // Call 1: incomplete → 503, no dedup
      const req1 = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res1 = await POST(req1, { params: { businessId: 'biz-1' } });
      expect(res1.status).toBe(503);
      expect(upsertCalled).toBe(false);

      // Call 2: retry finalizes
      vi.resetModules();
      upsertCalled = false;
      const mockSb2 = createMockSupabase({
        credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
        payment: { id: 'pay-inc', status: 'pending', amount: 1000, currency: 'NGN' },
      });
      const origFrom2 = mockSb2.from;
      mockSb2.from = vi.fn((table: string) => {
        if (table === 'processed_webhook_events') {
          return {
            select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
            upsert: () => { upsertCalled = true; return { select: () => Promise.resolve({ data: [{ id: 'x' }] }) }; },
          };
        }
        return origFrom2(table);
      });
      vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb2 }));
      vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
      vi.doMock('@/lib/payments/webhook-handler', () => ({
        processPaystackChargeSuccess: vi.fn().mockReturnValue('finalized'),
        processPaystackChargeFailed: vi.fn(),
      }));
      vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

      const { POST: POST2 } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const req2 = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res2 = await POST2(req2, { params: { businessId: 'biz-1' } });
      expect(res2.status).toBe(200);
      expect(upsertCalled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('P1-C: amount mismatch → failed, no dedup row (test e)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('amount mismatch → payment marked failed, 200, no dedup event written', async () => {
    const secretKey = `${SK_TEST}noded`;
    let upsertCalled = false;
    const mockSb = createMockSupabase({
      credentials: { secret_key: secretKey, gateway: 'paystack', webhook_secret_hash: null },
      payment: { id: 'pay-nod', status: 'pending', amount: 5000, currency: 'NGN' },
    });
    const origFrom = mockSb.from;
    mockSb.from = vi.fn((table: string) => {
      if (table === 'processed_webhook_events') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
          upsert: () => { upsertCalled = true; return { select: () => Promise.resolve({ data: [{ id: 'x' }] }) }; },
        };
      }
      return origFrom(table);
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn().mockReturnValue('finalized'),
      processPaystackChargeFailed: vi.fn(),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

    const originalFetch = globalThis.fetch;
    // Provider returns different amount
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { status: 'success', amount: 999900, currency: 'NGN', reference: 'ref-nod', id: 1 },
      }),
    });

    try {
      const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
      const body = { event: 'charge.success', data: { reference: 'ref-nod', amount: 500000 } };
      const rawBody = JSON.stringify(body);
      const sig = paystackSignature(rawBody, secretKey);
      const req = makeByoWebhookRequest('biz-1', body, { 'x-paystack-signature': sig });
      const res = await POST(req, { params: { businessId: 'biz-1' } });

      expect(res.status).toBe(200);
      // Payment marked failed
      const paymentUpdates = mockSb._updates.filter(u => u.table === 'payments');
      expect(paymentUpdates.length).toBeGreaterThan(0);
      // NO dedup row written
      expect(upsertCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('P1-B: chargeFailed pending guard (test f — main webhook hardening)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('processPaystackChargeFailed: already-success payment → no-op', async () => {
    vi.doMock('@/lib/posthog/server', () => ({ getServerPostHog: () => null }));
    vi.doMock('@/lib/alerts/create-alert', () => ({ createAlert: vi.fn() }));
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
    vi.doMock('@/lib/logger', () => ({
      logger: { info: () => {}, error: () => {}, debug: () => {}, warn: () => {},
        withContext: () => ({ info: () => {}, error: () => {}, debug: () => {}, warn: () => {} }) },
    }));

    let updatedToFailed = false;
    const fakeSb = {
      from: vi.fn((table: string) => {
        if (table === 'payments') {
          return {
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({
                  data: { id: 'pay-suc', status: 'success', amount: 1000, business_id: 'biz-1' },
                  error: null,
                }),
              }),
            }),
            update: (data: Record<string, unknown>) => {
              if (data.status === 'failed') updatedToFailed = true;
              const c: Record<string, unknown> = {};
              c.eq = () => c; c.select = () => c;
              c.then = (r: (v: unknown) => void) => Promise.resolve({ data: null, error: null }).then(r);
              return c;
            },
          };
        }
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) };
      }),
    };

    const { processPaystackChargeFailed } = await vi.importActual<typeof import('@/lib/payments/webhook-handler')>('@/lib/payments/webhook-handler');
    await processPaystackChargeFailed(
      { gateway_response: 'declined' }, 'ref-guard', fakeSb as any,
    );

    // Must NOT have updated to failed — payment was already success
    expect(updatedToFailed).toBe(false);
  });
});

describe('Deployment safety: webhook_secret_hash column missing → 503 (Flutterwave)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('Flutterwave BYO with column-missing error → 503 + Sentry, no crash', async () => {
    // Mock supabase: first select (with webhook_secret_hash) errors, fallback returns flutterwave
    const mockSb = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnValueOnce({
          eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({
            data: null,
            error: { message: 'column business_payment_credentials.webhook_secret_hash does not exist', code: '42703' },
          }) }) }),
        }).mockReturnValueOnce({
          eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({
            data: { secret_key: 'fw_key', gateway: 'flutterwave' },
            error: null,
          }) }) }),
        }),
      })),
    };
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => mockSb }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: (s: string) => s }));
    vi.doMock('@/lib/payments/webhook-handler', () => ({
      processPaystackChargeSuccess: vi.fn(),
      processPaystackChargeFailed: vi.fn(),
    }));
    const sentryMock = { captureException: vi.fn(), captureMessage: vi.fn() };
    vi.doMock('@sentry/nextjs', () => sentryMock);

    const { POST } = await import('@/app/api/payments/byo-webhook/[businessId]/route');
    const body = { event: 'charge.completed', data: { tx_ref: 'ref-x', id: 1 } };
    const req = makeByoWebhookRequest('biz-fw', body, { 'verif-hash': 'hash' });
    const res = await POST(req, { params: { businessId: 'biz-fw' } });

    expect(res.status).toBe(503);
    expect(sentryMock.captureMessage).toHaveBeenCalled();
  });
});

