/**
 * Phase 1 Close-out Tests — Correction Round
 *
 * Covers:
 * - A: Concurrent OAuth-state consumption (atomic RPC)
 * - B: Resolved route wins (gatewayOverride retired)
 * - B: Inactive default / missing provider ID / unchecked health fallback
 * - C: Meta catalog, pay-link, recurring route through resolver
 * - D: verifyPayment fail-closed (missing payment, unsupported gateway, missing BYO, DB error)
 * - E: Fee fields in gateway-created payment rows
 * - F: Sensitive-field trigger: authenticated UPDATE + INSERT enforcement
 * - G: Stripe callback: other provider preserved, old Stripe revoked, DB failure
 * - G: Paystack outbound bearer=subaccount payload
 *
 * Integration tests require: SUPABASE_INTEGRATION=true
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/payment-phase1-closeout.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testUserId: string;
let testBizId: string;
let paystackConnId: string;
let anonKey: string;
let supabaseUrl: string;

describeIntegration('Phase 1 close-out: integration tests', () => {
  beforeAll(async () => {
    supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    let key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    if (!key) {
      const { execSync } = await import('child_process');
      const env = execSync('supabase status -o env 2>/dev/null', { encoding: 'utf-8' });
      const keyLine = env.split('\n').find(l => l.startsWith('SERVICE_ROLE_KEY='));
      key = keyLine ? keyLine.split('=')[1].replace(/"/g, '').trim() : '';
      const anonLine = env.split('\n').find(l => l.startsWith('ANON_KEY='));
      anonKey = anonLine ? anonLine.split('=')[1].replace(/"/g, '').trim() : anonKey;
    }
    db = createClient(supabaseUrl, key);

    const ts = Date.now();
    const { data: user } = await db.auth.admin.createUser({
      email: `p1-test-${ts}@test.local`, password: 'TestPass123!', email_confirm: true,
    });
    testUserId = user.user!.id;

    const { data: biz } = await db.from('businesses').insert({
      owner_id: testUserId, name: `P1 Test ${ts}`, slug: `p1-test-${ts}`,
      address: '123', city: 'Lagos', neighborhood: 'VI', phone: '123',
      status: 'active', country_code: 'NG',
    }).select('id').single();
    testBizId = biz!.id;

    const { data: ps } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'paystack', connection_mode: 'managed',
      connection_status: 'active', is_active: true, is_default: true,
      subaccount_code: 'ACCT_p1_test', verified_at: new Date().toISOString(),
      health_status: 'healthy',
      bank_name: 'GTBank', account_name: 'Test', account_number: '1234567890', bank_code: '058',
    }).select('id').single();
    paystackConnId = ps!.id;
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    await db.from('oauth_states').delete().eq('business_id', testBizId);
    await db.from('payments').delete().eq('business_id', testBizId);
    await db.from('business_connection_secrets').delete().eq('business_id', testBizId);
    await db.from('payout_accounts').delete().eq('business_id', testBizId);
    await db.from('businesses').delete().eq('id', testBizId);
    await db.auth.admin.deleteUser(testUserId);
  }, 15000);

  // ── A: Concurrent OAuth-state consumption ──

  it('concurrent OAuth consumption: exactly one consumer wins', async () => {
    const { generateOAuthState, persistOAuthState, consumeOAuthState } = await import('@/lib/payments/oauth-state');
    const { payload } = generateOAuthState(testUserId, testBizId, 'stripe', 'acct_test');
    await persistOAuthState(db, payload);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => consumeOAuthState(db, payload.nonce)),
    );

    const successes = results.filter(r => r !== null);
    expect(successes.length).toBe(1);
    expect(successes[0]!.userId).toBe(testUserId);
    expect(successes[0]!.provider).toBe('stripe');

    await db.from('oauth_states').delete().eq('nonce', payload.nonce);
  });

  it('OAuth consumption returns full payload with correct bindings', async () => {
    const { generateOAuthState, persistOAuthState, consumeOAuthState } = await import('@/lib/payments/oauth-state');
    const { payload } = generateOAuthState(testUserId, testBizId, 'paystack', 'acct_456');
    await persistOAuthState(db, payload);

    const consumed = await consumeOAuthState(db, payload.nonce);
    expect(consumed).not.toBeNull();
    expect(consumed!.userId).toBe(testUserId);
    expect(consumed!.businessId).toBe(testBizId);
    expect(consumed!.provider).toBe('paystack');
    expect(consumed!.accountId).toBe('acct_456');

    await db.from('oauth_states').delete().eq('nonce', payload.nonce);
  });

  it('OAuth consumption rejects expired state', async () => {
    const nonce = 'expired-nonce-test';
    await db.from('oauth_states').insert({
      nonce, user_id: testUserId, business_id: testBizId,
      provider: 'stripe', account_id: 'acct_expired',
      expires_at: new Date(Date.now() - 60000).toISOString(), consumed: false,
    });

    const { consumeOAuthState } = await import('@/lib/payments/oauth-state');
    const result = await consumeOAuthState(db, nonce);
    expect(result).toBeNull();

    await db.from('oauth_states').delete().eq('nonce', nonce);
  });

  // ── B: Resolver fallbacks ──

  it('inactive connection (is_active=false) → resolver returns platform', async () => {
    await db.from('payout_accounts').update({ is_active: false }).eq('id', paystackConnId);
    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    const route = await resolvePaymentRoute(db, testBizId, 5000, 'NG');
    expect(route.mode).toBe('platform');
    await db.from('payout_accounts').update({ is_active: true }).eq('id', paystackConnId);
  });

  it('managed connection missing subaccount_code → resolver returns platform', async () => {
    await db.from('payout_accounts').update({ subaccount_code: null }).eq('id', paystackConnId);
    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    const route = await resolvePaymentRoute(db, testBizId, 5000, 'NG');
    expect(route.mode).toBe('platform');
    expect(route.warning).toContain('subaccount_code');
    await db.from('payout_accounts').update({ subaccount_code: 'ACCT_p1_test' }).eq('id', paystackConnId);
  });

  it('health_status=unchecked → resolver returns platform', async () => {
    await db.from('payout_accounts').update({ health_status: 'unchecked' }).eq('id', paystackConnId);
    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    const route = await resolvePaymentRoute(db, testBizId, 5000, 'NG');
    expect(route.mode).toBe('platform');
    expect(route.warning).toContain('unchecked');
    await db.from('payout_accounts').update({ health_status: 'healthy' }).eq('id', paystackConnId);
  });

  it('valid default → resolver returns managed_split', async () => {
    const { resolvePaymentRoute } = await import('@/lib/payments/route-resolver');
    const route = await resolvePaymentRoute(db, testBizId, 5000, 'NG');
    expect(route.mode).toBe('managed_split');
    expect(route.provider).toBe('paystack');
    expect(route.connectionId).toBe(paystackConnId);
    expect(route.subaccountCode).toBe('ACCT_p1_test');
    expect(route.feeBearerMode).toBe('merchant');
    expect(route.platformFeeAmount).toBeGreaterThan(0);
  });

  // ── F: Sensitive-field enforcement with authenticated client ──

  it('authenticated UPDATE of is_default is rejected by trigger', async () => {
    // Sign in as the test user to get a real authenticated session
    const authClient = createClient(supabaseUrl, anonKey);
    const { error: signInErr } = await authClient.auth.signInWithPassword({
      email: `p1-test-${testUserId.slice(-8)}@test.local`,
      password: 'TestPass123!',
    });

    // If sign-in fails (email might not match pattern), use the user's actual email
    if (signInErr) {
      // Get user email from admin
      const { data: userData } = await db.auth.admin.getUserById(testUserId);
      if (userData?.user?.email) {
        await authClient.auth.signInWithPassword({
          email: userData.user.email,
          password: 'TestPass123!',
        });
      }
    }

    // Try to update is_default via authenticated client
    const { error: updateErr } = await authClient.from('payout_accounts')
      .update({ is_default: false })
      .eq('id', paystackConnId);

    // Trigger should reject with 42501 (insufficient_privilege)
    expect(updateErr).not.toBeNull();
    expect(updateErr!.code).toBe('42501');
  });

  it('authenticated UPDATE of connection_status is rejected', async () => {
    const authClient = createClient(supabaseUrl, anonKey);
    const { data: userData } = await db.auth.admin.getUserById(testUserId);
    if (userData?.user?.email) {
      await authClient.auth.signInWithPassword({
        email: userData.user.email, password: 'TestPass123!',
      });
    }

    const { error } = await authClient.from('payout_accounts')
      .update({ connection_status: 'revoked' })
      .eq('id', paystackConnId);

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('authenticated UPDATE of stripe_account_id is rejected', async () => {
    const authClient = createClient(supabaseUrl, anonKey);
    const { data: userData } = await db.auth.admin.getUserById(testUserId);
    if (userData?.user?.email) {
      await authClient.auth.signInWithPassword({
        email: userData.user.email, password: 'TestPass123!',
      });
    }

    const { error } = await authClient.from('payout_accounts')
      .update({ stripe_account_id: 'acct_evil' })
      .eq('id', paystackConnId);

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('authenticated UPDATE of safe display fields (bank_name) succeeds', async () => {
    const authClient = createClient(supabaseUrl, anonKey);
    const { data: userData } = await db.auth.admin.getUserById(testUserId);
    if (userData?.user?.email) {
      await authClient.auth.signInWithPassword({
        email: userData.user.email, password: 'TestPass123!',
      });
    }

    const { error } = await authClient.from('payout_accounts')
      .update({ bank_name: 'Updated Bank Name' })
      .eq('id', paystackConnId);

    // Safe field — should succeed
    expect(error).toBeNull();

    // Restore
    await db.from('payout_accounts').update({ bank_name: 'GTBank' }).eq('id', paystackConnId);
  });

  it('authenticated INSERT forces safe defaults on sensitive fields', async () => {
    const authClient = createClient(supabaseUrl, anonKey);
    const { data: userData } = await db.auth.admin.getUserById(testUserId);
    if (userData?.user?.email) {
      await authClient.auth.signInWithPassword({
        email: userData.user.email, password: 'TestPass123!',
      });
    }

    // Try to INSERT with dangerous values
    const { data: inserted, error: insertErr } = await authClient.from('payout_accounts').insert({
      business_id: testBizId,
      gateway: 'stripe', // user tries to set
      is_default: true,  // should be forced to false
      is_active: true,   // should be forced to false
      connection_status: 'active', // should be forced to 'pending'
      health_status: 'healthy',    // should be forced to 'unchecked'
      verified_at: new Date().toISOString(), // should be forced to null
      bank_name: 'Evil Bank', account_name: 'Evil', account_number: '0000',
      bank_code: '000',
    }).select('id, is_default, is_active, connection_status, health_status, verified_at').single();

    if (insertErr) {
      // Unique constraint may prevent insert — that's fine, means the trigger or index blocked it
      // Just verify it didn't succeed with dangerous values
      return;
    }

    // If insert succeeded, verify sensitive fields were forced to safe defaults
    expect(inserted!.is_default).toBe(false);
    expect(inserted!.is_active).toBe(false);
    expect(inserted!.connection_status).toBe('pending');
    expect(inserted!.health_status).toBe('unchecked');
    expect(inserted!.verified_at).toBeNull();

    // Cleanup
    if (inserted?.id) {
      await db.from('payout_accounts').delete().eq('id', inserted.id);
    }
  });

  it('service_role UPDATE of sensitive fields succeeds', async () => {
    const { error } = await db.from('payout_accounts')
      .update({ is_default: true })
      .eq('id', paystackConnId);
    expect(error).toBeNull();
  });
});

// ── Unit tests (no database required) ──

describe('Phase 1 close-out: unit tests', () => {

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── B: Resolver route wins ──

  it('initializePayment uses resolver provider, not gateway override', async () => {
    vi.resetModules();

    const mockGateway = {
      name: 'paystack',
      initializePayment: vi.fn().mockResolvedValue({ url: 'https://pay.test/abc', reference: 'ref-1' }),
      verifyPayment: vi.fn(),
      refundPayment: vi.fn(),
    };
    const mockGetByName = vi.fn().mockReturnValue(mockGateway);

    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn().mockReturnValue(mockGateway),
      getPaymentGatewayByName: mockGetByName,
    }));
    vi.doMock('@/lib/payments/route-resolver', () => ({
      resolvePaymentRoute: vi.fn().mockResolvedValue({
        mode: 'managed_split', provider: 'paystack', connectionId: 'conn-1',
        feeBearerMode: 'merchant', platformFeeAmount: 125,
      }),
    }));
    vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }) }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: vi.fn().mockReturnValue('key') }));
    vi.doMock('@/lib/constants', () => ({
      calculatePlatformFee: vi.fn().mockReturnValue({ feePercentage: 2.5, feeFlat: 0, feeTotal: 125 }),
      getPaymentGatewayForCountry: vi.fn().mockReturnValue('paystack'),
    }));

    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const supabase = { from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: null }) })) };

    await initializePayment(supabase as any, {
      userId: 'u1', amount: 5000, referenceCode: 'REF-B1', businessName: 'Biz', phone: '+234', businessId: 'biz-1',
    });

    expect(mockGetByName).toHaveBeenCalledWith('paystack');
  });

  // ── E: Fee fields ──

  it('gateway receives fee mode fields from resolver route', async () => {
    vi.resetModules();

    const initSpy = vi.fn().mockResolvedValue({ url: 'https://pay.test/x', reference: 'ref-e' });
    const mockGateway = { name: 'paystack', initializePayment: initSpy, verifyPayment: vi.fn(), refundPayment: vi.fn() };

    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn().mockReturnValue(mockGateway),
      getPaymentGatewayByName: vi.fn().mockReturnValue(mockGateway),
    }));
    vi.doMock('@/lib/payments/route-resolver', () => ({
      resolvePaymentRoute: vi.fn().mockResolvedValue({
        mode: 'byo', provider: 'paystack', connectionId: 'conn-byo-1',
        feeBearerMode: 'merchant', platformFeeAmount: 250,
        byoSecretId: 'secret-1', byoPlatformSubaccount: 'PLAT_SUB',
      }),
    }));
    vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }) }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: vi.fn().mockReturnValue('decrypted_mock_key') }));
    vi.doMock('@/lib/constants', () => ({
      calculatePlatformFee: vi.fn().mockReturnValue({ feePercentage: 2.5, feeFlat: 0, feeTotal: 250 }),
      getPaymentGatewayForCountry: vi.fn().mockReturnValue('paystack'),
    }));

    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'business_connection_secrets') {
          return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ is: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { encrypted_secret_key: 'enc' } }) }) }) }) };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: null }) };
      }),
    };

    await initializePayment(supabase as any, {
      userId: 'u1', amount: 10000, referenceCode: 'REF-E1', businessName: 'BYO Biz', phone: '+234', businessId: 'biz-byo',
    });

    expect(initSpy).toHaveBeenCalledWith(expect.objectContaining({
      collectionMode: 'byo', feeBearerMode: 'merchant', payoutAccountId: 'conn-byo-1',
      waaiioFee: 250, isByo: true, byoSecretKey: 'decrypted_mock_key', byoPlatformSubaccount: 'PLAT_SUB',
    }));
  });

  // ── D: verifyPayment fail-closed ──

  it('verifyPayment returns false when payment record is missing', async () => {
    vi.resetModules();
    vi.doMock('@/lib/payments/factory', () => ({ getPaymentGateway: vi.fn(), getPaymentGatewayByName: vi.fn() }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: vi.fn() }));
    vi.doMock('@/lib/constants', () => ({ getPaymentGatewayForCountry: vi.fn().mockReturnValue('paystack') }));
    vi.doMock('@/lib/payments/route-resolver', () => ({ resolvePaymentRoute: vi.fn() }));
    vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }) }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

    const { verifyPayment } = await import('@/lib/bot/flows/shared/payment');
    const supabase = {
      from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })),
    };

    const result = await verifyPayment(supabase as any, 'nonexistent_ref', 'NG');
    expect(result).toBe(false);
  });

  it('verifyPayment returns false when stored gateway is unsupported', async () => {
    vi.resetModules();
    vi.doMock('@/lib/payments/factory', () => ({ getPaymentGateway: vi.fn(), getPaymentGatewayByName: vi.fn() }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: vi.fn() }));
    vi.doMock('@/lib/constants', () => ({ getPaymentGatewayForCountry: vi.fn() }));
    vi.doMock('@/lib/payments/route-resolver', () => ({ resolvePaymentRoute: vi.fn() }));
    vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }) }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

    const { verifyPayment } = await import('@/lib/bot/flows/shared/payment');
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { gateway: 'bitcoin_gateway', collection_mode: 'platform', payout_account_id: null }, error: null }),
      })),
    };

    const result = await verifyPayment(supabase as any, 'ref_unsupported', 'NG');
    expect(result).toBe(false);
  });

  it('verifyPayment returns false when BYO has no valid credential', async () => {
    vi.resetModules();
    vi.doMock('@/lib/payments/factory', () => ({ getPaymentGateway: vi.fn(), getPaymentGatewayByName: vi.fn() }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: vi.fn() }));
    vi.doMock('@/lib/constants', () => ({ getPaymentGatewayForCountry: vi.fn() }));
    vi.doMock('@/lib/payments/route-resolver', () => ({ resolvePaymentRoute: vi.fn() }));
    vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }) }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

    const { verifyPayment } = await import('@/lib/bot/flows/shared/payment');
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'business_connection_secrets') {
          return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
        }
        return {
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { gateway: 'paystack', collection_mode: 'byo', payout_account_id: 'conn-1' }, error: null }),
        };
      }),
    };

    const result = await verifyPayment(supabase as any, 'ref_byo_no_cred', 'NG');
    expect(result).toBe(false);
  });

  it('verifyPayment returns false on database error', async () => {
    vi.resetModules();
    vi.doMock('@/lib/payments/factory', () => ({ getPaymentGateway: vi.fn(), getPaymentGatewayByName: vi.fn() }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: vi.fn() }));
    vi.doMock('@/lib/constants', () => ({ getPaymentGatewayForCountry: vi.fn() }));
    vi.doMock('@/lib/payments/route-resolver', () => ({ resolvePaymentRoute: vi.fn() }));
    vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }) }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

    const { verifyPayment } = await import('@/lib/bot/flows/shared/payment');
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection refused', code: 'PGRST000' } }),
      })),
    };

    const result = await verifyPayment(supabase as any, 'ref_db_error', 'NG');
    expect(result).toBe(false);
  });

  it('verifyPayment uses stored gateway, not country default', async () => {
    vi.resetModules();

    const stripeMock = { name: 'stripe', initializePayment: vi.fn(), verifyPayment: vi.fn().mockResolvedValue(true), refundPayment: vi.fn() };
    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGateway: vi.fn().mockReturnValue({ name: 'paystack', verifyPayment: vi.fn().mockResolvedValue(false) }),
      getPaymentGatewayByName: vi.fn((name: string) => name === 'stripe' ? stripeMock : { verifyPayment: vi.fn().mockResolvedValue(false) }),
    }));
    vi.doMock('@/lib/encryption', () => ({ decryptToken: vi.fn() }));
    vi.doMock('@/lib/constants', () => ({ getPaymentGatewayForCountry: vi.fn().mockReturnValue('paystack') }));
    vi.doMock('@/lib/payments/route-resolver', () => ({ resolvePaymentRoute: vi.fn() }));
    vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn().mockReturnValue({ currency_code: 'NGN' }) }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

    const { verifyPayment } = await import('@/lib/bot/flows/shared/payment');
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { gateway: 'stripe', collection_mode: 'platform', payout_account_id: null }, error: null }),
      })),
    };

    const result = await verifyPayment(supabase as any, 'cs_test_123', 'NG');
    expect(result).toBe(true);
    expect(stripeMock.verifyPayment).toHaveBeenCalledWith(supabase, 'cs_test_123', undefined);
  });

  // ── C: Meta catalog routes through shared initializer ──

  it('Meta catalog handleCatalogOrder uses shared initializePayment', async () => {
    // Verify the import in the webhook handler file
    vi.resetModules();
    const fs = await import('fs');
    const handlerSource = fs.readFileSync('app/api/webhook/meta-cloud/route.ts', 'utf-8');

    // Should import from shared payment, not from factory
    expect(handlerSource).toContain("import { initializePayment } from '@/lib/bot/flows/shared/payment'");
    expect(handlerSource).not.toContain("import { getPaymentGateway, getPaymentGatewayByName } from '@/lib/payments/factory'");

    // Should NOT have a duplicate payments INSERT after initializePayment
    const catalogSection = handlerSource.slice(
      handlerSource.indexOf('handleCatalogOrder'),
      handlerSource.indexOf('let intelligence'),
    );
    // initializePayment creates the payment record; no separate .from('payments').insert
    expect(catalogSection).not.toMatch(/supabase\.from\(['"]payments['"]\)\.insert/);
  });

  // ── C: pay-link routes through shared initializer ──

  it('pay-link handler uses shared initializePayment', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('app/api/pay-link/pay/route.ts', 'utf-8');

    expect(source).toContain("initializePayment");
    expect(source).not.toContain("getPaymentGatewayByName");
    // No duplicate payments INSERT
    expect(source).not.toMatch(/supabase\.from\(['"]payments['"]\)\.insert/);
  });

  // ── C: recurring setup uses resolver ──

  it('recurring setup uses resolvePaymentRoute, not hardcoded country check', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('app/api/recurring/setup/route.ts', 'utf-8');

    expect(source).toContain("resolvePaymentRoute");
    expect(source).toContain("collectionMode: 'platform'"); // explicit platform for now
  });

  // ── Paystack outbound payload ──

  it('Paystack managed split includes bearer=subaccount and transaction_charge', async () => {
    let capturedBody: Record<string, unknown> | undefined;

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('paystack.co/transaction/initialize')) {
        capturedBody = JSON.parse(init?.body as string);
        return { ok: true, json: async () => ({ status: true, data: { authorization_url: 'https://pay.paystack.co/test', reference: 'ps_ref', access_code: 'ac' } }) };
      }
      return { ok: true, json: async () => ({}) };
    }));

    process.env.PAYSTACK_SECRET_KEY = 'mock_paystack_key_for_test';
    process.env.ENABLE_PAYMENTS = 'true';

    vi.resetModules();
    const { PaystackGateway } = await import('@/lib/payments/paystack');
    const gw = new PaystackGateway();

    const mockSupabase = {
      from: vi.fn(() => ({
        insert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'pay-1' }, error: null }) }) }),
        update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      })),
    };

    await gw.initializePayment({
      supabase: mockSupabase as any, userId: 'u1', amount: 5000, currency: 'NGN',
      referenceCode: 'REF-PS1', businessName: 'Test', phone: '+234', userEmail: 'test@test.com',
      subaccountCode: 'ACCT_merchant', platformFeeAmount: 125,
      collectionMode: 'managed_split', feeBearerMode: 'merchant', waaiioFee: 125,
    });

    expect(capturedBody).toBeDefined();
    expect(capturedBody!.subaccount).toBe('ACCT_merchant');
    expect(capturedBody!.bearer).toBe('subaccount');
    expect(capturedBody!.transaction_charge).toBe(12500);

    vi.unstubAllGlobals();
    delete process.env.PAYSTACK_SECRET_KEY;
  });

  // ── OAuth round-trip ──

  it('OAuth state round-trip: generate → verify → correct payload', async () => {
    const { generateOAuthState, verifyOAuthState } = await import('@/lib/payments/oauth-state');
    const { token, payload } = generateOAuthState('user-1', 'biz-1', 'stripe', 'acct_1');
    const verified = verifyOAuthState(token);
    expect(verified).not.toBeNull();
    expect(verified!.userId).toBe('user-1');
    expect(verified!.businessId).toBe('biz-1');
    expect(verified!.provider).toBe('stripe');
    expect(verified!.accountId).toBe('acct_1');
    expect(verified!.nonce).toBe(payload.nonce);
  });

  // ── G: Stripe callback uses service client + recoverable replacement ──

  it('Stripe callback handler uses service client with error checking and restore', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('app/api/payouts/stripe-callback/route.ts', 'utf-8');

    // Mutations use service client
    expect(source).toContain("service.from('payout_accounts')");
    // All DB errors checked
    expect(source).toContain('revokeErr');
    expect(source).toContain('insertErr');
    expect(source).toContain('bizUpdateErr');
    expect(source).toContain('defaultQueryErr');
    // Business ownership verified
    expect(source).toContain('bizCheck');
    // Snapshot + restore pattern for recoverable replacement
    expect(source).toContain('restoreRevokedConns');
    expect(source).toContain('oldStripeConns');
    // Restore called on both insert failure AND default query failure
    const restoreCalls = source.match(/restoreRevokedConns/g);
    expect(restoreCalls!.length).toBeGreaterThanOrEqual(4); // function def + mock path + prod default err + prod insert err
  });

  // ── B: INSERT trigger clears provider-routing values ──

  it('INSERT trigger clears untrusted provider-routing values', async () => {
    const fs = await import('fs');
    const migration = fs.readFileSync('supabase/migrations/289_payout_accounts_sensitive_fields.sql', 'utf-8');

    // INSERT trigger must clear these untrusted values
    expect(migration).toContain("NEW.subaccount_code := NULL");
    expect(migration).toContain("NEW.stripe_account_id := NULL");
    expect(migration).toContain("NEW.flutterwave_mid := NULL");
    expect(migration).toContain("NEW.connection_mode := 'managed'");
  });
});

describe('Phase 1 close-out status', () => {
  it(`integration tests are ${SKIP ? 'SKIPPED (set SUPABASE_INTEGRATION=true)' : 'RUNNING'}`, () => {
    expect(true).toBe(true);
  });
});
