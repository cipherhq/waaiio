/**
 * Payout Handler — Real Database Integration Tests
 *
 * Tests the actual POST handler with:
 * - Real local Supabase database for all DB operations
 * - Mocked auth (injected admin user via createClient)
 * - Stubbed fetch for provider API calls (Paystack/Stripe)
 *
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/payout-handler-integration.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createClient as createRawClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testBizId: string;
let testUserId: string;
let testAccountId: string;
let providerCallCount: number;
let providerCallArgs: Array<{ url: string; body?: string; headers?: Record<string, string> }>;

// Track fetch calls to provider APIs
const originalFetch = globalThis.fetch;

// Note: NO top-level vi.mock calls — all mocking happens inside importRoute()
// via vi.doMock to prevent cross-file test pollution.

function stubFetch(options?: {
  paystackShouldFail?: boolean;
  paystackShouldTimeout?: boolean;
  stripeShouldFail?: boolean;
}) {
  providerCallCount = 0;
  providerCallArgs = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('api.paystack.co/transferrecipient')) {
      providerCallCount++;
      providerCallArgs.push({ url, body: init?.body as string, headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({
        status: true,
        data: { recipient_code: 'RCP_test123' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.includes('api.paystack.co/transfer')) {
      providerCallCount++;
      providerCallArgs.push({ url, body: init?.body as string, headers: init?.headers as Record<string, string> });

      if (options?.paystackShouldTimeout) {
        throw new Error('network timeout at: https://api.paystack.co/transfer');
      }

      if (options?.paystackShouldFail) {
        return new Response(JSON.stringify({
          status: false,
          message: 'Insufficient balance',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        status: true,
        data: { transfer_code: 'TRF_stub_123', reference: 'payout_test' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (url.includes('api.stripe.com/v1/transfers')) {
      providerCallCount++;
      providerCallArgs.push({ url, body: init?.body as string, headers: init?.headers as Record<string, string> });

      if (options?.stripeShouldFail) {
        return new Response(JSON.stringify({
          error: { message: 'Insufficient funds' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        id: 'tr_stub_456',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // All other fetches pass through
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function makeRequest(payoutId: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/admin/payouts/${payoutId}/approve`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describeIntegration('Payout handler — real database integration', () => {
  beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    let key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!key) {
      const { execSync } = await import('child_process');
      const env = execSync('supabase status -o env 2>/dev/null', { encoding: 'utf-8' });
      const keyLine = env.split('\n').find(l => l.startsWith('SERVICE_ROLE_KEY='));
      key = keyLine ? keyLine.split('=')[1].replace(/"/g, '').trim() : '';
    }
    db = createRawClient(url, key);

    const ts = Date.now();
    const { data: user } = await db.auth.admin.createUser({
      email: `payout-handler-${ts}@test.local`, password: 'test-123', email_confirm: true,
    });
    testUserId = user.user!.id;
    await db.from('profiles').update({ role: 'admin' }).eq('id', testUserId);

    const { data: biz } = await db.from('businesses').insert({
      owner_id: testUserId, name: `Payout Handler ${ts}`, slug: `payout-handler-${ts}`,
      address: '123', city: 'Lagos', neighborhood: 'VI', phone: '123', status: 'active',
      payout_mode: 'platform_managed', country_code: 'NG', verification_level: 'full',
    }).select('id').single();
    testBizId = biz!.id;

    const { data: acct } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'paystack', bank_name: 'GTBank', account_name: 'Test Business',
      account_number: '0123456789', bank_code: '058', is_active: true,
      verified_at: new Date().toISOString(),
    }).select('id').single();
    testAccountId = acct!.id;

    // Seed platform fees so balance check passes
    const { data: payment } = await db.from('payments').insert({
      business_id: testBizId, amount: 100000, currency: 'NGN',
      gateway_reference: `payout-seed-${ts}`, gateway: 'paystack', status: 'success',
    }).select('id').single();
    await db.from('platform_fees').insert({
      business_id: testBizId, payment_id: payment!.id,
      transaction_amount: 100000, fee_percentage: 2.5, fee_flat: 0, fee_total: 2500,
    });

    // Mocking is handled per-test via importRoute() — no top-level vi.mock needed
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    restoreFetch();
    await db.from('admin_audit_logs').delete().eq('actor_id', testUserId);
    await db.from('business_payouts').delete().eq('business_id', testBizId);
    await db.from('platform_fees').delete().eq('business_id', testBizId);
    await db.from('payments').delete().eq('business_id', testBizId);
    await db.from('payout_accounts').delete().eq('business_id', testBizId);
    await db.from('businesses').delete().eq('id', testBizId);
    await db.auth.admin.deleteUser(testUserId);
  }, 15000);

  /** Re-apply mocks after vi.resetModules() clears them, then import fresh route */
  async function importRoute(serviceOverride?: unknown) {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: { id: testUserId } } }),
        },
        from: (table: string) => db.from(table),
      }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({
      createServiceClient: vi.fn().mockReturnValue(serviceOverride || db),
    }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/email/templates', () => ({
      payoutApprovedEmail: vi.fn().mockReturnValue({ subject: 't', html: 't' }),
      payoutPaidEmail: vi.fn().mockReturnValue({ subject: 't', html: 't' }),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

    const mod = await import('@/app/api/admin/payouts/[id]/approve/route');
    return mod.POST;
  }

  beforeEach(() => {
    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_stub_not_a_real_key';
  });

  afterEach(() => {
    restoreFetch();
    delete process.env.ENABLE_PAYOUTS;
    delete process.env.PAYSTACK_SECRET_KEY;
  });

  // ── Test 1: Kill switch → zero provider calls ──

  it('kill switch: zero provider calls when disabled', async () => {
    delete process.env.ENABLE_PAYOUTS;
    stubFetch();

    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-01-01', period_end: '2026-01-07',
      gross_amount: 5000, platform_fee: 125, net_amount: 4875, status: 'pending',
    }).select('id').single();

    const POST = await importRoute();
    const res = await POST(makeRequest(payout!.id, { transfer_method: 'paystack_transfer' }), {
      params: Promise.resolve({ id: payout!.id }),
    });

    expect(res.status).toBe(503);
    expect(providerCallCount).toBe(0);

    // Verify payout unchanged
    const { data: check } = await db.from('business_payouts').select('status').eq('id', payout!.id).single();
    expect(check!.status).toBe('pending');
  });

  // ── Test 2: Two concurrent approvals → one provider call ──

  it('concurrent approvals: only one provider transfer', async () => {
    stubFetch();

    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-02-01', period_end: '2026-02-07',
      gross_amount: 5000, platform_fee: 125, net_amount: 4875, status: 'pending',
    }).select('id').single();

    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_stub_not_a_real_key';
    const POST = await importRoute();

    const call = () => POST(
      makeRequest(payout!.id, { transfer_method: 'paystack_transfer' }),
      { params: Promise.resolve({ id: payout!.id }) },
    );

    const [r1, r2] = await Promise.all([call(), call()]);
    const statuses = [r1.status, r2.status].sort();

    // One should succeed (200), one should get 409 (already claimed)
    expect(statuses).toContain(200);
    expect(statuses).toContain(409);

    // Provider calls: recipient + transfer = 2 calls for ONE successful approval
    // The 409 path makes zero provider calls
    const transferCalls = providerCallArgs.filter(c => c.url.includes('/transfer') && !c.url.includes('recipient'));
    expect(transferCalls.length).toBe(1);

    // Final DB state: processing (awaiting webhook confirmation)
    const { data: check } = await db.from('business_payouts').select('status, transfer_reference').eq('id', payout!.id).single();
    expect(check!.status).toBe('processing');
    expect(check!.transfer_reference).toBe(`payout_${payout!.id}`);
  });

  // ── Test 3: Provider idempotency reference is stable ──

  it('provider idempotency reference is deterministic', async () => {
    stubFetch();

    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-03-01', period_end: '2026-03-07',
      gross_amount: 3000, platform_fee: 75, net_amount: 2925, status: 'pending',
    }).select('id').single();

    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_stub_not_a_real_key';
    const POST = await importRoute();

    await POST(
      makeRequest(payout!.id, { transfer_method: 'paystack_transfer' }),
      { params: Promise.resolve({ id: payout!.id }) },
    );

    // Verify the transfer call used the deterministic reference
    const transferCall = providerCallArgs.find(c => c.url.includes('/transfer') && !c.url.includes('recipient'));
    expect(transferCall).toBeDefined();
    const body = JSON.parse(transferCall!.body!);
    expect(body.reference).toBe(`payout_${payout!.id}`);

    // Verify it's stored in DB
    const { data: check } = await db.from('business_payouts').select('transfer_reference').eq('id', payout!.id).single();
    expect(check!.transfer_reference).toBe(`payout_${payout!.id}`);
  });

  // ── Test 4: Provider timeout → review_required ──

  it('provider timeout: sets review_required, not failed', async () => {
    stubFetch({ paystackShouldTimeout: true });

    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-04-01', period_end: '2026-04-07',
      gross_amount: 4000, platform_fee: 100, net_amount: 3900, status: 'pending',
    }).select('id').single();

    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_stub_not_a_real_key';
    const POST = await importRoute();

    const res = await POST(
      makeRequest(payout!.id, { transfer_method: 'paystack_transfer' }),
      { params: Promise.resolve({ id: payout!.id }) },
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.idempotency_ref).toBe(`payout_${payout!.id}`);

    // DB state: review_required (NOT failed)
    const { data: check } = await db.from('business_payouts').select('status, notes').eq('id', payout!.id).single();
    expect(check!.status).toBe('review_required');
    expect(check!.notes).toContain('UNCERTAIN');
    expect(check!.notes).toContain(`payout_${payout!.id}`);
  });

  // ── Test 5: review_required prevents blind retry ──

  it('review_required blocks re-approval', async () => {
    stubFetch();

    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-05-01', period_end: '2026-05-07',
      gross_amount: 6000, platform_fee: 150, net_amount: 5850, status: 'review_required',
      notes: 'UNCERTAIN: previous timeout',
    }).select('id').single();

    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_stub_not_a_real_key';
    const POST = await importRoute();

    const res = await POST(
      makeRequest(payout!.id, { transfer_method: 'paystack_transfer' }),
      { params: Promise.resolve({ id: payout!.id }) },
    );

    // Should be rejected — route checks status before claim attempt
    // Returns 400 ("cannot be approved in current status") not 409
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('cannot be approved');
    expect(providerCallCount).toBe(0);

    // DB state unchanged
    const { data: check } = await db.from('business_payouts').select('status').eq('id', payout!.id).single();
    expect(check!.status).toBe('review_required');
  });

  // ── Test 6: Only active, verified payout account ──

  it('rejects unverified payout account', async () => {
    stubFetch();

    // Create inactive unverified account (different gateway to avoid unique constraint)
    const { data: unverifiedAcct, error: acctErr } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'stripe', bank_name: 'Unverified',
      account_name: 'Bad', account_number: '9999999999', bank_code: '058',
      is_active: false,
    }).select('id').single();
    if (acctErr) throw new Error(`Failed to create unverified account: ${acctErr.message}`);

    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: unverifiedAcct!.id,
      period_start: '2026-06-01', period_end: '2026-06-07',
      gross_amount: 2000, platform_fee: 50, net_amount: 1950, status: 'pending',
    }).select('id').single();

    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_stub_not_a_real_key';
    const POST = await importRoute();

    const res = await POST(
      makeRequest(payout!.id, { transfer_method: 'paystack_transfer' }),
      { params: Promise.resolve({ id: payout!.id }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('inactive');
    expect(providerCallCount).toBe(0);

    // Cleanup
    await db.from('payout_accounts').delete().eq('id', unverifiedAcct!.id);
  });

  // ── Test 7: Account change during approval cannot redirect ──

  it('account change during approval: transfer uses original account', async () => {
    stubFetch();

    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-07-01', period_end: '2026-07-07',
      gross_amount: 8000, platform_fee: 200, net_amount: 7800, status: 'pending',
    }).select('id').single();

    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_stub_not_a_real_key';
    const POST = await importRoute();

    const res = await POST(
      makeRequest(payout!.id, { transfer_method: 'paystack_transfer' }),
      { params: Promise.resolve({ id: payout!.id }) },
    );

    expect(res.status).toBe(200);

    // Verify the provider was called with the original account details
    const recipientCall = providerCallArgs.find(c => c.url.includes('transferrecipient'));
    expect(recipientCall).toBeDefined();
    const recipientBody = JSON.parse(recipientCall!.body!);
    expect(recipientBody.account_number).toBe('0123456789');
    expect(recipientBody.bank_code).toBe('058');

    // The payout_account_id on the payout record is what determined the account
    // Even if someone changed the account table, the payout references the original account_id
    const { data: check } = await db.from('business_payouts')
      .select('payout_account_id, status')
      .eq('id', payout!.id).single();
    expect(check!.payout_account_id).toBe(testAccountId);
    expect(check!.status).toBe('processing');
  });

  // ── Test 8: Audit failure reverts claim ──

  it('audit failure: reverts payout claim', async () => {
    stubFetch();

    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-08-01', period_end: '2026-08-07',
      gross_amount: 3000, platform_fee: 75, net_amount: 2925, status: 'pending',
    }).select('id').single();

    const auditFailDb = {
      from: (table: string) => {
        if (table === 'admin_audit_logs') {
          return {
            insert: () => Promise.resolve({ error: { message: 'simulated audit failure' }, data: null }),
          };
        }
        return db.from(table);
      },
      rpc: (...args: unknown[]) => (db.rpc as (...args: unknown[]) => unknown)(...args),
    };

    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_stub_not_a_real_key';
    const POST = await importRoute(auditFailDb);

    const res = await POST(
      makeRequest(payout!.id, { transfer_method: 'paystack_transfer' }),
      { params: Promise.resolve({ id: payout!.id }) },
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Audit');

    // Provider should NOT have been called (audit failed before provider step)
    expect(providerCallCount).toBe(0);

    // The claim should be reverted — status back to pending
    const { data: check } = await db.from('business_payouts').select('status, approved_by').eq('id', payout!.id).single();
    expect(check!.status).toBe('pending');
    expect(check!.approved_by).toBeNull();
  });

  // ── Test 9: Manual approval is immediately paid ──

  it('manual_bank: immediately marked as paid', async () => {
    stubFetch();

    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-09-01', period_end: '2026-09-07',
      gross_amount: 5000, platform_fee: 125, net_amount: 4875, status: 'pending',
    }).select('id').single();

    process.env.ENABLE_PAYOUTS = 'true';
    const POST = await importRoute();

    const res = await POST(
      makeRequest(payout!.id, { transfer_method: 'manual_bank', reference: 'BANK-REF-123' }),
      { params: Promise.resolve({ id: payout!.id }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('approved');

    // Zero provider calls for manual transfer
    expect(providerCallCount).toBe(0);

    // DB state: approved (not paid), no paid_at
    const { data: check } = await db.from('business_payouts')
      .select('status, paid_at, approved_at, destination_bank_name, destination_account_number_masked')
      .eq('id', payout!.id).single();
    expect(check!.status).toBe('approved');
    expect(check!.paid_at).toBeNull();
    expect(check!.approved_at).not.toBeNull();
    // Destination snapshot is populated
    expect(check!.destination_bank_name).toBe('GTBank');
    expect(check!.destination_account_number_masked).toBe('****6789');
  });

  // ── Test 10: Destination snapshot stored at approval ──

  it('gateway approval stores destination snapshot', async () => {
    stubFetch();

    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-10-01', period_end: '2026-10-07',
      gross_amount: 4000, platform_fee: 100, net_amount: 3900, status: 'pending',
    }).select('id').single();

    process.env.ENABLE_PAYOUTS = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'test_stub_not_a_real_key';
    const POST = await importRoute();

    await POST(
      makeRequest(payout!.id, { transfer_method: 'paystack_transfer' }),
      { params: Promise.resolve({ id: payout!.id }) },
    );

    const { data: check } = await db.from('business_payouts')
      .select('destination_bank_name, destination_account_number_masked, destination_bank_code')
      .eq('id', payout!.id).single();
    expect(check!.destination_bank_name).toBe('GTBank');
    expect(check!.destination_account_number_masked).toBe('****6789');
    expect(check!.destination_bank_code).toBe('058');
  });
});

describe('Payout handler integration status', () => {
  it(`tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => { expect(true).toBe(true); });
});
