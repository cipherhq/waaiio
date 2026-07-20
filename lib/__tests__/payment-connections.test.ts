/**
 * Payment Connections — Real Database Integration Tests
 *
 * Tests the multi-connection model, default management,
 * secrets isolation, route resolver, and fee mode.
 *
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/payment-connections.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testUserId: string;
let testBizId: string;
let testUserEmail: string;
let userClient: SupabaseClient; // Authenticated as business owner (browser simulation)

describeIntegration('Payment connections — real database', () => {
  beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    let key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!key) {
      const { execSync } = await import('child_process');
      const env = execSync('supabase status -o env 2>/dev/null', { encoding: 'utf-8' });
      const keyLine = env.split('\n').find(l => l.startsWith('SERVICE_ROLE_KEY='));
      key = keyLine ? keyLine.split('=')[1].replace(/"/g, '').trim() : '';
    }
    db = createClient(url, key);

    const ts = Date.now();
    testUserEmail = `conn-test-${ts}@test.local`;
    const { data: user } = await db.auth.admin.createUser({
      email: testUserEmail, password: 'test-123', email_confirm: true,
    });
    testUserId = user.user!.id;

    const { data: biz } = await db.from('businesses').insert({
      owner_id: testUserId, name: `Conn Test ${ts}`, slug: `conn-test-${ts}`,
      address: '123', city: 'Lagos', neighborhood: 'VI', phone: '123',
      status: 'active', country_code: 'NG', payout_mode: 'platform_managed',
    }).select('id').single();
    testBizId = biz!.id;

    // Create authenticated client as business owner (simulates browser)
    userClient = createClient(url, anonKey);
    await userClient.auth.signInWithPassword({ email: testUserEmail, password: 'test-123' });
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    await db.from('business_connection_secrets').delete().eq('business_id', testBizId);
    await db.from('payout_accounts').delete().eq('business_id', testBizId);
    await db.from('businesses').delete().eq('id', testBizId);
    await db.auth.admin.deleteUser(testUserId);
  }, 15000);

  // ── Multiple connections ──

  it('allows multiple active connections for different providers', async () => {
    const { error: e1 } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'paystack', connection_mode: 'managed',
      connection_status: 'active', is_active: true, is_default: true,
      subaccount_code: 'ACCT_test_1', verified_at: new Date().toISOString(),
      bank_name: 'GTBank', account_name: 'Test', account_number: '1234567890', bank_code: '058',
    });
    expect(e1).toBeNull();

    const { error: e2 } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'flutterwave', connection_mode: 'managed',
      connection_status: 'active', is_active: true, is_default: false,
      subaccount_code: 'FLW_test_1', verified_at: new Date().toISOString(),
      bank_name: 'GTBank', account_name: 'Test', account_number: '1234567890', bank_code: '058',
    });
    expect(e2).toBeNull();

    const { data: conns } = await db.from('payout_accounts')
      .select('id, gateway')
      .eq('business_id', testBizId)
      .in('connection_status', ['active']);
    expect(conns!.length).toBe(2);
  });

  // ── One default ──

  it('exactly one default enforced by unique constraint', async () => {
    // Try to set second connection as default — should fail
    const { error } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'stripe', connection_mode: 'connect',
      connection_status: 'active', is_active: true, is_default: true,
      stripe_account_id: 'acct_test', verified_at: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('23505'); // unique violation
  });

  // ── One per provider ──

  it('prevents duplicate active connections for same provider', async () => {
    const { error } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'paystack', connection_mode: 'managed',
      connection_status: 'active', is_active: true, is_default: false,
      subaccount_code: 'ACCT_dup', verified_at: new Date().toISOString(),
      bank_name: 'X', account_name: 'X', account_number: '999', bank_code: '058',
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('23505');
  });

  // ── Unverified cannot be default ──

  it('DB allows unverified default (enforcement is via RPC, not constraint)', async () => {
    // The DB allows inserting an unverified default — this is a data model fact.
    // The BUSINESS RULE is enforced by set_default_connection RPC (tested in invariants).
    // Direct UPDATE of is_default should only be done via the RPC.
    await db.from('payout_accounts').update({ is_default: false }).eq('business_id', testBizId);

    const { error } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'square', connection_mode: 'connect',
      connection_status: 'pending', is_active: true, is_default: true,
      verified_at: null,
    });
    // DB insert succeeds (no constraint prevents it)
    expect(error).toBeNull();

    // Cleanup
    await db.from('payout_accounts').delete()
      .eq('business_id', testBizId).eq('gateway', 'square');
    await db.from('payout_accounts').update({ is_default: true })
      .eq('business_id', testBizId).eq('gateway', 'paystack');
  });

  // ── Secrets table: service-role-only ──

  it('service role can insert and read secrets', async () => {
    const { data: conn } = await db.from('payout_accounts')
      .select('id').eq('business_id', testBizId).eq('gateway', 'paystack').single();

    const { error } = await db.from('business_connection_secrets').insert({
      payout_account_id: conn!.id,
      business_id: testBizId,
      encrypted_secret_key: 'abc123:def456:encrypted_test_value',
      key_identifier: 'sk_****X4f2',
      verified_at: new Date().toISOString(),
      verification_method: 'balance_check',
    });
    expect(error).toBeNull();

    const { data } = await db.from('business_connection_secrets')
      .select('encrypted_secret_key, key_identifier')
      .eq('business_id', testBizId)
      .single();
    expect(data).not.toBeNull();
    expect(data!.encrypted_secret_key).toBe('abc123:def456:encrypted_test_value');
    expect(data!.key_identifier).toBe('sk_****X4f2');
  });

  it('authenticated browser client CANNOT read secrets', async () => {
    const { data, error } = await userClient.from('business_connection_secrets')
      .select('encrypted_secret_key')
      .eq('business_id', testBizId);

    // RLS denies SELECT for authenticated users — returns empty
    expect(data).toEqual([]);
  });

  // ── Route resolver ──

  it('resolver returns managed_split for default verified connection', async () => {
    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    const route = await resolvePaymentRoute(db, testBizId, 5000, 'NG');

    expect(route.mode).toBe('managed_split');
    expect(route.provider).toBe('paystack');
    expect(route.connectionId).not.toBeNull();
    expect(route.subaccountCode).toBe('ACCT_test_1');
    expect(route.paystackBearer).toBe('subaccount');
    expect(route.feeBearerMode).toBe('merchant');
  });

  it('resolver falls back to platform when no connection matches country', async () => {
    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    // US country — only Stripe/Square supported, but business only has Paystack/FLW
    const route = await resolvePaymentRoute(db, testBizId, 5000, 'US');

    expect(route.mode).toBe('platform');
    expect(route.warning).toBeDefined();
  });

  it('resolver falls back to platform for business with no connections', async () => {
    // Create a business with no connections
    const { data: emptyBiz } = await db.from('businesses').insert({
      owner_id: testUserId, name: 'Empty Biz', slug: `empty-${Date.now()}`,
      address: '1', city: 'L', neighborhood: 'V', phone: '1', status: 'active',
      country_code: 'NG',
    }).select('id').single();

    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    const route = await resolvePaymentRoute(db, emptyBiz!.id, 5000, 'NG');

    expect(route.mode).toBe('platform');
    expect(route.connectionId).toBeNull();

    await db.from('businesses').delete().eq('id', emptyBiz!.id);
  });

  // ── Fee mode on payments ──

  it('payment record stores fee mode columns', async () => {
    const { data: payment, error } = await db.from('payments').insert({
      business_id: testBizId, amount: 5000, currency: 'NGN',
      gateway_reference: `fee-mode-${Date.now()}`, gateway: 'paystack', status: 'pending',
      collection_mode: 'managed_split', fee_bearer: 'merchant',
      waaiio_fee: 125, actual_gateway_fee: null, merchant_net: null, fee_finalized: false,
    }).select('collection_mode, fee_bearer, waaiio_fee, fee_finalized').single();

    expect(error).toBeNull();
    expect(payment!.collection_mode).toBe('managed_split');
    expect(payment!.fee_bearer).toBe('merchant');
    expect(Number(payment!.waaiio_fee)).toBe(125);
    expect(payment!.fee_finalized).toBe(false);
  });

  // ── Stripe callback state ──

  it('OAuth state generation and verification work correctly', async () => {
    const { generateOAuthState, verifyOAuthState } = await import('@/lib/payments/oauth-state');
    const { token } = generateOAuthState(testUserId, testBizId, 'stripe', 'acct_test123');
    const result = verifyOAuthState(token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(testUserId);
    expect(result!.businessId).toBe(testBizId);
    expect(result!.provider).toBe('stripe');
    expect(result!.accountId).toBe('acct_test123');
  });

  it('rejects expired OAuth state', async () => {
    const { verifyOAuthState } = await import('@/lib/payments/oauth-state');
    // Construct an expired token — 7 pipe-separated parts
    expect(verifyOAuthState('u|b|s|a|nonce|0|sig')).toBeNull();
  });

  it('rejects tampered OAuth state', async () => {
    const { verifyOAuthState } = await import('@/lib/payments/oauth-state');
    const future = Date.now() + 30 * 60 * 1000;
    expect(verifyOAuthState(`attacker|victim|stripe|evil|nonce|${future}|bad_sig`)).toBeNull();
  });

  // ═══════════════════════════════════════════════════════
  // Transactional Stripe connection replacement
  // ═══════════════════════════════════════════════════════

  // Setup: install a temporary INSERT trigger that rejects a sentinel value.
  // This trigger exists ONLY in the local test database and is never included
  // in any migration. It forces the INSERT inside replace_stripe_connection
  // to fail AFTER the revoke mutation has executed, proving that Postgres
  // rolls back the entire transaction atomically.

  const SENTINEL = 'acct_FORCE_FAIL_TEST';
  let stripeConnId: string;

  it('setup: install failure-injection trigger for replacement test', async () => {
    // Install a temporary trigger on the local test database that rejects
    // INSERT when stripe_account_id matches the sentinel value.
    // Uses psql against the local Supabase Postgres (port 54322).
    const { execSync } = await import('child_process');
    const { writeFileSync, unlinkSync } = await import('fs');
    const { join } = await import('path');

    const triggerSQL = `
DROP TRIGGER IF EXISTS trg_test_reject_stripe ON public.payout_accounts;
DROP FUNCTION IF EXISTS public._test_reject_stripe_insert();
CREATE OR REPLACE FUNCTION public._test_reject_stripe_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stripe_account_id = '${SENTINEL}' THEN
    RAISE EXCEPTION 'Injected test failure' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_test_reject_stripe
  BEFORE INSERT ON public.payout_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public._test_reject_stripe_insert();
`;

    const tmpFile = join('/tmp', `_test_trigger_${Date.now()}.sql`);
    writeFileSync(tmpFile, triggerSQL);
    try {
      execSync(`psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f "${tmpFile}"`, {
        encoding: 'utf-8',
        timeout: 15000,
      });
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });

  it('setup: create a Stripe connection for replacement test', async () => {
    // Ensure paystack is default (from earlier tests)
    await db.from('payout_accounts').update({ is_default: true })
      .eq('business_id', testBizId).eq('gateway', 'paystack');

    // Add a non-default active Stripe connection
    const { data: stripe, error } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'stripe', connection_mode: 'connect',
      connection_status: 'active', is_active: true, is_default: false,
      stripe_account_id: 'acct_original_test', verified_at: new Date().toISOString(),
      health_status: 'healthy',
    }).select('id').single();

    expect(error).toBeNull();
    stripeConnId = stripe!.id;
  });

  it('forced replacement failure leaves previous Stripe active and preserves other providers', async () => {
    // Snapshot state before the failing call
    const { data: beforeStripe } = await db.from('payout_accounts')
      .select('id, is_active, connection_status, is_default, stripe_account_id')
      .eq('id', stripeConnId).single();

    const { data: beforePaystack } = await db.from('payout_accounts')
      .select('id, is_active, connection_status, is_default, gateway')
      .eq('business_id', testBizId).eq('gateway', 'paystack').single();

    // Call replace with the sentinel value — trigger will reject the INSERT
    const { data: result, error: rpcErr } = await db.rpc('replace_stripe_connection', {
      p_business_id: testBizId,
      p_account_id: SENTINEL,
    });

    // The RPC should have returned an error (not success=false, but a real DB error)
    // because the unhandled RAISE EXCEPTION aborts the transaction.
    expect(rpcErr).not.toBeNull();

    // Verify: old Stripe connection is UNCHANGED (transaction rolled back)
    const { data: afterStripe } = await db.from('payout_accounts')
      .select('id, is_active, connection_status, is_default, stripe_account_id')
      .eq('id', stripeConnId).single();

    expect(afterStripe!.is_active).toBe(beforeStripe!.is_active);
    expect(afterStripe!.connection_status).toBe(beforeStripe!.connection_status);
    expect(afterStripe!.is_default).toBe(beforeStripe!.is_default);
    expect(afterStripe!.stripe_account_id).toBe('acct_original_test');

    // Verify: Paystack connection is UNCHANGED
    const { data: afterPaystack } = await db.from('payout_accounts')
      .select('id, is_active, connection_status, is_default, gateway')
      .eq('business_id', testBizId).eq('gateway', 'paystack').single();

    expect(afterPaystack!.is_active).toBe(beforePaystack!.is_active);
    expect(afterPaystack!.connection_status).toBe(beforePaystack!.connection_status);
    expect(afterPaystack!.is_default).toBe(beforePaystack!.is_default);

    // Verify: no replacement row with the sentinel value exists
    const { data: sentinel } = await db.from('payout_accounts')
      .select('id')
      .eq('business_id', testBizId)
      .eq('stripe_account_id', SENTINEL);
    expect(sentinel).toEqual([]);
  });

  it('subsequent valid replacement succeeds', async () => {
    const { data: result, error: rpcErr } = await db.rpc('replace_stripe_connection', {
      p_business_id: testBizId,
      p_account_id: 'acct_valid_replacement',
    });

    expect(rpcErr).toBeNull();
    expect(result.success).toBe(true);
    expect(result.revoked_count).toBe(1); // the original Stripe connection

    // Old Stripe is now revoked
    const { data: oldStripe } = await db.from('payout_accounts')
      .select('connection_status, is_active')
      .eq('id', stripeConnId).single();
    expect(oldStripe!.connection_status).toBe('revoked');
    expect(oldStripe!.is_active).toBe(false);

    // New Stripe is active (not default — Paystack holds default)
    const { data: newStripe } = await db.from('payout_accounts')
      .select('connection_status, is_active, is_default, stripe_account_id')
      .eq('business_id', testBizId)
      .eq('stripe_account_id', 'acct_valid_replacement')
      .single();
    expect(newStripe!.connection_status).toBe('active');
    expect(newStripe!.is_active).toBe(true);
    expect(newStripe!.is_default).toBe(false); // Paystack is still default

    // Paystack still untouched
    const { data: paystack } = await db.from('payout_accounts')
      .select('is_default, is_active, connection_status')
      .eq('business_id', testBizId).eq('gateway', 'paystack').single();
    expect(paystack!.is_default).toBe(true);
    expect(paystack!.is_active).toBe(true);
    expect(paystack!.connection_status).toBe('active');
  });

  it('anon and authenticated clients cannot execute replace_stripe_connection', async () => {
    // Authenticated client (browser simulation)
    const { error: authErr } = await userClient.rpc('replace_stripe_connection', {
      p_business_id: testBizId,
      p_account_id: 'acct_unauthorized',
    });
    expect(authErr).not.toBeNull();

    // Anon client
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    if (!anonKey) return;

    const { createClient: createAnonClient } = await import('@supabase/supabase-js');
    const anonClient = createAnonClient(url, anonKey);
    const { error: anonErr } = await anonClient.rpc('replace_stripe_connection', {
      p_business_id: testBizId,
      p_account_id: 'acct_anon_attempt',
    });
    expect(anonErr).not.toBeNull();
  });

  it('cleanup: remove failure-injection trigger', async () => {
    const { execSync } = await import('child_process');
    const { writeFileSync, unlinkSync } = await import('fs');
    const { join } = await import('path');

    const cleanupSQL = `
DROP TRIGGER IF EXISTS trg_test_reject_stripe ON public.payout_accounts;
DROP FUNCTION IF EXISTS public._test_reject_stripe_insert();
`;

    const tmpFile = join('/tmp', `_test_cleanup_${Date.now()}.sql`);
    writeFileSync(tmpFile, cleanupSQL);
    try {
      execSync(`psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f "${tmpFile}"`, {
        encoding: 'utf-8',
        timeout: 15000,
      });
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }

    // Clean up test Stripe connections
    await db.from('payout_accounts').delete()
      .eq('business_id', testBizId).eq('gateway', 'stripe');
  });
});

describe('Payment connections status', () => {
  it(`tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => { expect(true).toBe(true); });
});
