/**
 * FIN-002: Real PostgreSQL database tests for atomic payout execution.
 *
 * These tests require a running local Supabase instance with migration 292 applied.
 * Run with: npm run test:db
 *
 * Setup:
 *   supabase start
 *   supabase db reset  (applies all migrations including 292)
 *
 * The tests use the local Supabase service_role key to test RPC privilege enforcement.
 * Provider APIs remain mocked — only database behavior is tested against real PostgreSQL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Local Supabase defaults (from `supabase status`)
const SUPABASE_URL = process.env.TEST_SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.TEST_SUPABASE_SERVICE_KEY || '';
const ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY || '';

// Skip all tests if local Supabase is not available
const canRunDbTests = !!SERVICE_ROLE_KEY;

const describeDb = canRunDbTests ? describe : describe.skip;

let service: SupabaseClient;
let anon: SupabaseClient;

// Test data IDs — created fresh each test
let testBusinessId: string;
let testPayoutAccountId: string;
let testPayoutId: string;

describeDb('FIN-002: Real PostgreSQL concurrency tests', () => {
  beforeAll(() => {
    service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    if (ANON_KEY) {
      anon = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
  });

  beforeEach(async () => {
    // Create test business
    const { data: biz } = await service
      .from('businesses')
      .insert({
        name: 'FIN-002 Test Business',
        slug: `fin002-test-${Date.now()}`,
        category: 'other',
        country_code: 'NG',
        status: 'active',
        verification_level: 'verified',
        owner_id: '00000000-0000-0000-0000-000000000000',
        payout_mode: 'platform_managed',
      })
      .select('id')
      .single();
    testBusinessId = biz!.id;

    // Create test payout account
    const { data: acct } = await service
      .from('payout_accounts')
      .insert({
        business_id: testBusinessId,
        gateway: 'paystack',
        bank_name: 'Test Bank',
        account_name: 'Test Account',
        bank_code: '058',
        account_number: '0123456789',
        is_active: true,
        verified_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    testPayoutAccountId = acct!.id;

    // Create test payout in pending status
    const { data: payout } = await service
      .from('business_payouts')
      .insert({
        business_id: testBusinessId,
        payout_account_id: testPayoutAccountId,
        period_start: '2024-01-01',
        period_end: '2024-01-07',
        gross_amount: 10000,
        platform_fee: 500,
        gateway_fee: 100,
        net_amount: 9400,
        status: 'pending',
      })
      .select('id')
      .single();
    testPayoutId = payout!.id;
  });

  afterAll(async () => {
    // Cleanup test data
    if (testBusinessId) {
      await service.from('business_payouts').delete().eq('business_id', testBusinessId);
      await service.from('payout_accounts').delete().eq('business_id', testBusinessId);
      await service.from('businesses').delete().eq('id', testBusinessId);
    }
  });

  // ── Test 1: Two simultaneous claims produce exactly one winner ──
  it('concurrent claims: exactly one wins', async () => {
    const [result1, result2] = await Promise.all([
      service.rpc('claim_payout_for_transfer', {
        p_payout_id: testPayoutId,
        p_transfer_method: 'paystack_transfer',
      }),
      service.rpc('claim_payout_for_transfer', {
        p_payout_id: testPayoutId,
        p_transfer_method: 'paystack_transfer',
      }),
    ]);

    const winners = [
      ...(result1.data || []),
      ...(result2.data || []),
    ];
    expect(winners.length).toBe(1);
    expect(winners[0].claimed_id).toBe(testPayoutId);
  });

  // ── Test 2: PostgreSQL generates the token and provider key ──
  it('claim returns server-generated token and deterministic provider key', async () => {
    const { data } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });

    expect(data).toHaveLength(1);
    expect(data[0].claimed_token).toBeTruthy();
    expect(data[0].idempotency_key).toBe(`payout_${testPayoutId}`);
    // Token should be a UUID
    expect(data[0].claimed_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // ── Test 3: Provider key is deterministic ──
  it('provider key is deterministic: payout_{id}', async () => {
    const { data } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });
    expect(data[0].idempotency_key).toBe(`payout_${testPayoutId}`);
  });

  // ── Test 4: Second claim cannot replace first token ──
  it('second claim returns empty — cannot replace first token', async () => {
    // First claim succeeds
    const { data: first } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });
    expect(first).toHaveLength(1);

    // Second claim returns empty
    const { data: second } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });
    expect(second).toHaveLength(0);

    // Original token is preserved
    const { data: payout } = await service
      .from('business_payouts')
      .select('claim_token')
      .eq('id', testPayoutId)
      .single();
    expect(payout!.claim_token).toBe(first[0].claimed_token);
  });

  // ── Test 5: Stale token cannot mark submitted ──
  it('stale token cannot mark submitted', async () => {
    const { data: claim } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });

    const wrongToken = '00000000-0000-0000-0000-000000000000';
    const { data: result } = await service.rpc('mark_payout_provider_submitted', {
      p_payout_id: testPayoutId,
      p_claim_token: wrongToken,
      p_gateway_transfer_code: 'TRF_fake',
    });
    expect(result).toHaveLength(0);

    // Correct token works
    const { data: correct } = await service.rpc('mark_payout_provider_submitted', {
      p_payout_id: testPayoutId,
      p_claim_token: claim![0].claimed_token,
      p_gateway_transfer_code: 'TRF_real',
    });
    expect(correct).toHaveLength(1);
  });

  // ── Test 6: Stale token cannot mark failed ──
  it('stale token cannot mark failed', async () => {
    await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });

    const { data: result } = await service.rpc('mark_payout_transfer_failed', {
      p_payout_id: testPayoutId,
      p_claim_token: '00000000-0000-0000-0000-000000000000',
    });
    expect(result).toHaveLength(0);
  });

  // ── Test 7: Stale token cannot mark review_required ──
  it('stale token cannot mark review_required', async () => {
    await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });

    const { data: result } = await service.rpc('mark_payout_review_required', {
      p_payout_id: testPayoutId,
      p_claim_token: '00000000-0000-0000-0000-000000000000',
    });
    expect(result).toHaveLength(0);
  });

  // ── Test 8: Claim RPC rejects unsupported methods ──
  it('claim RPC rejects square_transfer', async () => {
    const { error } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'square_transfer',
    });
    expect(error).toBeTruthy();
  });

  it('claim RPC rejects manual_bank', async () => {
    const { error } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'manual_bank',
    });
    expect(error).toBeTruthy();
  });

  // ── Test 9: A claimed payout cannot return to pending/approved/held ──
  it('processing payout cannot be claimed again (no backward transition)', async () => {
    // Claim (pending → processing)
    const { data: claim } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });
    expect(claim).toHaveLength(1);

    // Try to claim again — should fail (status is now processing)
    const { data: second } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });
    expect(second).toHaveLength(0);

    // Verify status is still processing
    const { data: payout } = await service
      .from('business_payouts')
      .select('status')
      .eq('id', testPayoutId)
      .single();
    expect(payout!.status).toBe('processing');
  });

  // ── Test 10: RPC denied to anon ──
  it('anon client cannot execute claim RPC', async () => {
    if (!anon) return; // Skip if anon key not available
    const { error } = await anon.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });
    expect(error).toBeTruthy();
  });

  // ── Test 11: service_role can execute RPCs ──
  it('service_role can execute claim and transition RPCs', async () => {
    const { data, error } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // ── Test 12: review_required blocks further claims (balance-reserving) ──
  it('review_required payout cannot be reclaimed', async () => {
    const { data: claim } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });

    // Mark review_required
    await service.rpc('mark_payout_review_required', {
      p_payout_id: testPayoutId,
      p_claim_token: claim![0].claimed_token,
    });

    // Verify status
    const { data: payout } = await service
      .from('business_payouts')
      .select('status')
      .eq('id', testPayoutId)
      .single();
    expect(payout!.status).toBe('review_required');

    // Cannot reclaim
    const { data: reclaim } = await service.rpc('claim_payout_for_transfer', {
      p_payout_id: testPayoutId,
      p_transfer_method: 'paystack_transfer',
    });
    expect(reclaim).toHaveLength(0);
  });

  // ── Test 15: Migration applies cleanly ──
  it('migration columns exist on business_payouts', async () => {
    const { data } = await service
      .from('business_payouts')
      .select('claim_token, provider_idempotency_key, processing_started_at')
      .eq('id', testPayoutId)
      .single();
    expect(data).toBeTruthy();
    // Initially null
    expect(data!.claim_token).toBeNull();
    expect(data!.provider_idempotency_key).toBeNull();
    expect(data!.processing_started_at).toBeNull();
  });
});
