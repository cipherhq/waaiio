/**
 * Payment Connection Invariants — Real Database Tests
 *
 * Tests deterministic default behavior, atomic default switching,
 * OAuth state security, and resolver fallback rules.
 *
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/payment-connections-invariants.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testUserId: string;
let testBizId: string;
let paystackConnId: string;
let flutterwaveConnId: string;

describeIntegration('Payment connection invariants', () => {
  beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    let key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!key) {
      const { execSync } = await import('child_process');
      const env = execSync('supabase status -o env 2>/dev/null', { encoding: 'utf-8' });
      const keyLine = env.split('\n').find(l => l.startsWith('SERVICE_ROLE_KEY='));
      key = keyLine ? keyLine.split('=')[1].replace(/"/g, '').trim() : '';
    }
    db = createClient(url, key);

    const ts = Date.now();
    const { data: user } = await db.auth.admin.createUser({
      email: `inv-test-${ts}@test.local`, password: 'test-123', email_confirm: true,
    });
    testUserId = user.user!.id;

    const { data: biz } = await db.from('businesses').insert({
      owner_id: testUserId, name: `Inv Test ${ts}`, slug: `inv-test-${ts}`,
      address: '123', city: 'Lagos', neighborhood: 'VI', phone: '123',
      status: 'active', country_code: 'NG',
    }).select('id').single();
    testBizId = biz!.id;

    // Two non-default active connections
    const { data: ps } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'paystack', connection_mode: 'managed',
      connection_status: 'active', is_active: true, is_default: false,
      subaccount_code: 'ACCT_inv_1', verified_at: new Date().toISOString(),
      health_status: 'healthy',
      bank_name: 'GTBank', account_name: 'Test', account_number: '1234567890', bank_code: '058',
    }).select('id').single();
    paystackConnId = ps!.id;

    const { data: flw } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'flutterwave', connection_mode: 'managed',
      connection_status: 'active', is_active: true, is_default: false,
      subaccount_code: 'FLW_inv_1', verified_at: new Date().toISOString(),
      health_status: 'healthy',
      bank_name: 'GTBank', account_name: 'Test', account_number: '1234567890', bank_code: '058',
    }).select('id').single();
    flutterwaveConnId = flw!.id;
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    await db.from('business_connection_secrets').delete().eq('business_id', testBizId);
    await db.from('payout_accounts').delete().eq('business_id', testBizId);
    await db.from('businesses').delete().eq('id', testBizId);
    await db.auth.admin.deleteUser(testUserId);
  }, 15000);

  // ── Item 1: Deterministic default — never select arbitrary connection ──

  it('two non-default connections → resolver returns platform with warning', async () => {
    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    const route = await resolvePaymentRoute(db, testBizId, 5000, 'NG');
    expect(route.mode).toBe('platform');
    expect(route.warning).toContain('No default');
  });

  it('default is unverified → resolver returns platform', async () => {
    // Set paystack as default but unverified
    await db.from('payout_accounts').update({ is_default: true, verified_at: null }).eq('id', paystackConnId);

    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    const route = await resolvePaymentRoute(db, testBizId, 5000, 'NG');
    // Resolver filters by verified_at IS NOT NULL, so unverified default is not found
    expect(route.mode).toBe('platform');

    // Restore
    await db.from('payout_accounts').update({ is_default: false, verified_at: new Date().toISOString() }).eq('id', paystackConnId);
  });

  it('default is unhealthy → resolver returns platform', async () => {
    await db.from('payout_accounts').update({ is_default: true, health_status: 'unhealthy' }).eq('id', paystackConnId);

    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    const route = await resolvePaymentRoute(db, testBizId, 5000, 'NG');
    expect(route.mode).toBe('platform');
    expect(route.warning).toContain('unhealthy');

    await db.from('payout_accounts').update({ is_default: false, health_status: 'healthy' }).eq('id', paystackConnId);
  });

  it('default is unsupported for country → resolver returns platform', async () => {
    await db.from('payout_accounts').update({ is_default: true }).eq('id', paystackConnId);

    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    // Paystack doesn't support US
    const route = await resolvePaymentRoute(db, testBizId, 5000, 'US');
    expect(route.mode).toBe('platform');
    expect(route.warning).toContain('does not support');

    await db.from('payout_accounts').update({ is_default: false }).eq('id', paystackConnId);
  });

  it('default is revoked → resolver returns platform', async () => {
    await db.from('payout_accounts').update({
      is_default: true, connection_status: 'revoked',
    }).eq('id', paystackConnId);

    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    const route = await resolvePaymentRoute(db, testBizId, 5000, 'NG');
    // Resolver filters by connection_status IN ('active') — revoked not found
    expect(route.mode).toBe('platform');

    await db.from('payout_accounts').update({
      is_default: false, connection_status: 'active',
    }).eq('id', paystackConnId);
  });

  // ── Item 2: Atomic default switching via RPC ──

  it('set_default_connection succeeds for active verified healthy connection', async () => {
    const r = await db.rpc('set_default_connection', {
      p_business_id: testBizId,
      p_connection_id: paystackConnId,
      p_country_code: 'NG',
    });
    expect(r.data?.success).toBe(true);

    const { data } = await db.from('payout_accounts').select('is_default').eq('id', paystackConnId).single();
    expect(data!.is_default).toBe(true);
  });

  it('set_default_connection rejects unverified connection', async () => {
    await db.from('payout_accounts').update({ verified_at: null }).eq('id', flutterwaveConnId);

    const r = await db.rpc('set_default_connection', {
      p_business_id: testBizId,
      p_connection_id: flutterwaveConnId,
      p_country_code: 'NG',
    });
    expect(r.data?.success).toBe(false);
    expect(r.data?.reason).toBe('connection_not_verified');

    await db.from('payout_accounts').update({ verified_at: new Date().toISOString() }).eq('id', flutterwaveConnId);
  });

  it('set_default_connection rejects unhealthy connection', async () => {
    await db.from('payout_accounts').update({ health_status: 'unhealthy' }).eq('id', flutterwaveConnId);

    const r = await db.rpc('set_default_connection', {
      p_business_id: testBizId,
      p_connection_id: flutterwaveConnId,
      p_country_code: 'NG',
    });
    expect(r.data?.success).toBe(false);
    expect(r.data?.reason).toBe('connection_unhealthy');

    await db.from('payout_accounts').update({ health_status: 'healthy' }).eq('id', flutterwaveConnId);
  });

  it('set_default_connection rejects wrong country', async () => {
    const r = await db.rpc('set_default_connection', {
      p_business_id: testBizId,
      p_connection_id: flutterwaveConnId,
      p_country_code: 'US', // Flutterwave doesn't support US
    });
    expect(r.data?.success).toBe(false);
    expect(r.data?.reason).toBe('provider_country_mismatch');
  });

  it('switching default atomically clears old and sets new', async () => {
    // Paystack is currently default (from earlier test)
    const r = await db.rpc('set_default_connection', {
      p_business_id: testBizId,
      p_connection_id: flutterwaveConnId,
      p_country_code: 'NG',
    });
    expect(r.data?.success).toBe(true);

    // Verify paystack is no longer default
    const { data: ps } = await db.from('payout_accounts').select('is_default').eq('id', paystackConnId).single();
    expect(ps!.is_default).toBe(false);

    // Verify flutterwave is now default
    const { data: flw } = await db.from('payout_accounts').select('is_default').eq('id', flutterwaveConnId).single();
    expect(flw!.is_default).toBe(true);

    // Clean up — remove default for other tests
    await db.from('payout_accounts').update({ is_default: false }).eq('id', flutterwaveConnId);
  });

  // ── Item 4: OAuth state security ──

  it('generates and verifies OAuth state correctly', async () => {
    const { generateOAuthState, verifyOAuthState } = await import('@/lib/payments/oauth-state');
    const { token } = generateOAuthState(testUserId, testBizId, 'stripe', 'acct_123');
    const result = verifyOAuthState(token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(testUserId);
    expect(result!.businessId).toBe(testBizId);
    expect(result!.provider).toBe('stripe');
    expect(result!.nonce).toHaveLength(32); // 16 bytes hex
  });

  it('rejects expired state', async () => {
    const { verifyOAuthState } = await import('@/lib/payments/oauth-state');
    const { createHmac, randomBytes } = await import('crypto');
    const secret = process.env.OAUTH_STATE_SECRET || 'dev-only-oauth-state-secret-not-for-production';
    const nonce = randomBytes(16).toString('hex');
    const expired = Date.now() - 1000;
    const data = `user|biz|stripe|acct|${nonce}|${expired}`;
    const sig = createHmac('sha256', secret).update(data).digest('hex');
    expect(verifyOAuthState(`${data}|${sig}`)).toBeNull();
  });

  it('rejects tampered state', async () => {
    const { verifyOAuthState } = await import('@/lib/payments/oauth-state');
    const expires = Date.now() + 30 * 60 * 1000;
    expect(verifyOAuthState(`attacker|victim|stripe|evil|fake_nonce|${expires}|bad_sig`)).toBeNull();
  });

  it('nonce can be consumed exactly once (replay prevention)', async () => {
    const { generateOAuthState, persistOAuthState, consumeOAuthState } = await import('@/lib/payments/oauth-state');
    const { token, payload } = generateOAuthState(testUserId, testBizId, 'stripe', 'acct_test');
    await persistOAuthState(db, payload);

    // First consumption succeeds (returns payload)
    const first = await consumeOAuthState(db, payload.nonce);
    expect(first).not.toBeNull();
    expect(first!.userId).toBe(testUserId);

    // Second consumption fails (replay)
    const second = await consumeOAuthState(db, payload.nonce);
    expect(second).toBeNull();

    // Cleanup
    await db.from('oauth_states').delete().eq('nonce', payload.nonce);
  });

  // ── Item 6: Unique secret constraint ──

  it('only one non-revoked secret per connection', async () => {
    const { data: s1 } = await db.from('business_connection_secrets').insert({
      payout_account_id: paystackConnId, business_id: testBizId,
      encrypted_secret_key: 'iv:tag:cipher1', key_identifier: 'sk_****1',
    }).select('id').single();
    expect(s1).not.toBeNull();

    // Second non-revoked secret for same connection should fail
    const { error } = await db.from('business_connection_secrets').insert({
      payout_account_id: paystackConnId, business_id: testBizId,
      encrypted_secret_key: 'iv:tag:cipher2', key_identifier: 'sk_****2',
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('23505');

    // Cleanup
    await db.from('business_connection_secrets').delete().eq('id', s1!.id);
  });
});

describe('Payment connection invariants status', () => {
  it(`tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => { expect(true).toBe(true); });
});
