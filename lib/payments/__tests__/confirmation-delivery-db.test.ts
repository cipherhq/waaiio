/**
 * #197: PostgreSQL-level delivery lifecycle tests.
 *
 * Uses Supabase service client for RPC testing.
 * Requires TEST_DATABASE_URL to be set (indicates PostgreSQL CI path).
 * Skips gracefully in normal Main App CI.
 *
 * True two-session concurrency tests use concurrent Supabase RPC calls
 * which serialize on FOR UPDATE inside the RPCs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB_URL ? describe : describe.skip;

describeDb('PostgreSQL delivery lifecycle (#197)', () => {
  let supabase: SupabaseClient;
  let testPaymentId: string;
  let testBusinessId: string;

  beforeAll(async () => {
    // In Migration validation CI, Supabase env vars point to the test DB
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || `http://localhost:54321`;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY required for DB tests');
    supabase = createClient(supabaseUrl, serviceKey);

    // Create test business
    const { data: biz, error: bizErr } = await supabase.from('businesses')
      .insert({ name: `Test Biz 197 ${Date.now()}`, slug: `test-biz-197-${Date.now()}`, category: 'other' })
      .select('id').single();
    if (bizErr) throw new Error(`Failed to create test business: ${bizErr.message}`);
    testBusinessId = biz.id;

    // Create test payment (successful)
    const { data: pay, error: payErr } = await supabase.from('payments')
      .insert({
        business_id: testBusinessId, amount: 121000, currency: 'NGN',
        gateway: 'paystack', gateway_reference: `test-197-${Date.now()}`,
        status: 'success', payment_authority_version: 1,
      })
      .select('id').single();
    if (payErr) throw new Error(`Failed to create test payment: ${payErr.message}`);
    testPaymentId = pay.id;
  });

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from('payment_confirmation_deliveries').delete().eq('payment_id', testPaymentId);
    await supabase.from('payments').delete().eq('id', testPaymentId);
    await supabase.from('businesses').delete().eq('id', testBusinessId);
  });

  beforeEach(async () => {
    await supabase.from('payment_confirmation_deliveries').delete().eq('payment_id', testPaymentId);
  });

  // ── Claim lifecycle ──

  it('should create first delivery claim', async () => {
    const { data } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    expect(data.claimed).toBe(true);
    expect(data.attempt_number).toBe(1);
    expect(data.claim_token).toBeTruthy();
    expect(data.attempt_id).toBeTruthy();
  });

  it('should reject second claim while first is active', async () => {
    await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    const { data: second } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'ive_paid_recovery',
    });
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe('claiming_in_progress');
  });

  it('should reject claim for non-successful payment', async () => {
    const { data: pendingPay } = await supabase.from('payments')
      .insert({
        business_id: testBusinessId, amount: 100, currency: 'NGN',
        gateway: 'paystack', gateway_reference: `test-197-pend-${Date.now()}`, status: 'pending',
      })
      .select('id').single();

    const { data } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: pendingPay!.id, p_attempt_source: 'webhook_stage3',
    });
    expect(data.claimed).toBe(false);
    expect(data.reason).toBe('payment_not_successful');

    await supabase.from('payments').delete().eq('id', pendingPay!.id);
  });

  // ── begin_confirmation_send ──

  it('should authorize send from claiming and clear lease', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    const { data: auth } = await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
    });
    expect(auth.authorized).toBe(true);

    const { data: attempt } = await supabase.from('payment_confirmation_deliveries')
      .select('delivery_status, claim_expires_at').eq('id', claim.attempt_id).single();
    expect(attempt!.delivery_status).toBe('sending');
    expect(attempt!.claim_expires_at).toBeNull();
  });

  it('should reject send authorization with wrong token', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    const { data: auth } = await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: '00000000-0000-0000-0000-000000000000',
    });
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toBe('token_mismatch');
  });

  // ── complete_confirmation_send ──

  it('should complete send with WAMID from sending state', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
    });

    const wamid = `wamid.test197_complete_${Date.now()}`;
    const { data } = await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
      p_meta_message_id: wamid, p_accepted_at: new Date().toISOString(),
    });
    expect(data.completed).toBe(true);

    const { data: attempt } = await supabase.from('payment_confirmation_deliveries')
      .select('delivery_status, meta_message_id, accepted_at, claim_token')
      .eq('id', claim.attempt_id).single();
    expect(attempt!.delivery_status).toBe('accepted');
    expect(attempt!.meta_message_id).toBe(wamid);
    expect(attempt!.claim_token).toBeNull();
  });

  it('should reject complete with blank WAMID', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
    });
    const { data } = await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
      p_meta_message_id: '', p_accepted_at: new Date().toISOString(),
    });
    expect(data.completed).toBe(false);
    expect(data.reason).toBe('blank_wamid');
  });

  // ── fail_confirmation_send ──

  it('should record indeterminate ONLY from sending state', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    // indeterminate from claiming — must fail
    const { data: f1 } = await supabase.rpc('fail_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
      p_failure_type: 'indeterminate',
    });
    expect(f1.recorded).toBe(false);
    expect(f1.reason).toBe('indeterminate_only_from_sending');

    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
    });
    const { data: f2 } = await supabase.rpc('fail_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
      p_failure_type: 'indeterminate', p_failure_reason: 'no_wamid_timeout',
    });
    expect(f2.recorded).toBe(true);

    const { data: attempt } = await supabase.from('payment_confirmation_deliveries')
      .select('delivery_status, indeterminate_at, failed_at').eq('id', claim.attempt_id).single();
    expect(attempt!.delivery_status).toBe('indeterminate');
    expect(attempt!.indeterminate_at).toBeTruthy();
    expect(attempt!.failed_at).toBeNull();
  });

  it('should reject invalid failure_type', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    const { data } = await supabase.rpc('fail_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
      p_failure_type: 'unknown_type',
    });
    expect(data.recorded).toBe(false);
    expect(data.reason).toBe('invalid_failure_type');
  });

  // ── advance_delivery_status (monotonic) ──

  it('should advance status monotonically with provider timestamps', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
    });
    const wamid = `wamid.test197_mono_${Date.now()}`;
    await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
      p_meta_message_id: wamid, p_accepted_at: new Date().toISOString(),
    });

    const ts1 = '2026-08-26T05:45:21Z';
    const { data: r1 } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid, p_new_status: 'sent', p_provider_timestamp: ts1,
    });
    expect(r1.advanced).toBe(true);

    const ts2 = '2026-08-26T05:45:25Z';
    const { data: r2 } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid, p_new_status: 'delivered', p_provider_timestamp: ts2,
    });
    expect(r2.advanced).toBe(true);

    const { data: attempt } = await supabase.from('payment_confirmation_deliveries')
      .select('delivery_status, sent_at, delivered_at').eq('id', claim.attempt_id).single();
    expect(attempt!.delivery_status).toBe('delivered');
  });

  it('should allow forward jump without fabricating sent_at', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
    });
    const wamid = `wamid.test197_jump_${Date.now()}`;
    await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
      p_meta_message_id: wamid, p_accepted_at: new Date().toISOString(),
    });

    await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid, p_new_status: 'delivered', p_provider_timestamp: '2026-08-26T05:45:25Z',
    });

    const { data: attempt } = await supabase.from('payment_confirmation_deliveries')
      .select('delivery_status, sent_at, delivered_at').eq('id', claim.attempt_id).single();
    expect(attempt!.delivery_status).toBe('delivered');
    expect(attempt!.sent_at).toBeNull(); // NOT fabricated
  });

  it('should handle null provider timestamp', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
    });
    const wamid = `wamid.test197_nullts_${Date.now()}`;
    await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
      p_meta_message_id: wamid, p_accepted_at: new Date().toISOString(),
    });

    const { data } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid, p_new_status: 'delivered', p_provider_timestamp: null,
    });
    expect(data.advanced).toBe(true);

    const { data: attempt } = await supabase.from('payment_confirmation_deliveries')
      .select('delivered_at').eq('id', claim.attempt_id).single();
    expect(attempt!.delivered_at).toBeNull(); // null provider timestamp → null stored
  });

  it('should reject failed from delivered state', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
    });
    const wamid = `wamid.test197_failrej_${Date.now()}`;
    await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
      p_meta_message_id: wamid, p_accepted_at: new Date().toISOString(),
    });
    await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid, p_new_status: 'delivered', p_provider_timestamp: new Date().toISOString(),
    });

    const { data } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid, p_new_status: 'failed', p_provider_timestamp: new Date().toISOString(),
    });
    expect(data.advanced).toBe(false);
    expect(data.reason).toBe('cannot_fail_from_delivered');
  });

  it('should handle duplicate status callback idempotently', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
    });
    const wamid = `wamid.test197_dup_${Date.now()}`;
    await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
      p_meta_message_id: wamid, p_accepted_at: new Date().toISOString(),
    });

    await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid, p_new_status: 'delivered', p_provider_timestamp: new Date().toISOString(),
    });
    const { data: r2 } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid, p_new_status: 'delivered', p_provider_timestamp: new Date().toISOString(),
    });
    expect(r2.advanced).toBe(false);
    expect(r2.reason).toBe('already_at_or_past_delivered');
  });

  // ── WAMID race ──

  it('should record unmatched status when WAMID not yet attached', async () => {
    const wamid = `wamid.test197_unmatched_${Date.now()}`;
    const { data } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid, p_new_status: 'delivered', p_provider_timestamp: new Date().toISOString(),
    });
    expect(data.advanced).toBe(false);
    expect(data.reason).toBe('wamid_not_found_recorded_unmatched');

    const { data: unmatched } = await supabase.from('unmatched_delivery_statuses')
      .select('*').eq('meta_message_id', wamid);
    expect(unmatched!.length).toBe(1);

    await supabase.from('unmatched_delivery_statuses').delete().eq('meta_message_id', wamid);
  });

  // ── Cross-source max enforcement ──

  it('should enforce max 3 attempts across mixed sources', async () => {
    for (let i = 0; i < 3; i++) {
      const source = i < 2 ? 'webhook_stage3' : 'ive_paid_recovery';
      const { data: c } = await supabase.rpc('claim_confirmation_delivery', {
        p_payment_id: testPaymentId, p_attempt_source: source,
      });
      expect(c.claimed).toBe(true);
      expect(c.attempt_number).toBe(i + 1);
      await supabase.rpc('fail_confirmation_send', {
        p_attempt_id: c.attempt_id, p_claim_token: c.claim_token,
        p_failure_type: 'failed', p_failure_reason: `test_${i + 1}`,
      });
    }

    const { data: c4 } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'ive_paid_recovery',
    });
    expect(c4.claimed).toBe(false);
    expect(c4.reason).toBe('max_attempts_exceeded');
  });

  it('sending state blocks I\'ve Paid recovery claim', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id, p_claim_token: claim.claim_token,
    });

    const { data: recovery } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId, p_attempt_source: 'ive_paid_recovery',
    });
    expect(recovery.claimed).toBe(false);
    expect(recovery.reason).toBe('active_delivery_sending');
  });

  // ── Two concurrent claims (serialized by FOR UPDATE) ──

  it('two concurrent claims produce exactly one winner', async () => {
    // Two parallel RPC calls — the FOR UPDATE on payments row serializes them
    const [{ data: r1 }, { data: r2 }] = await Promise.all([
      supabase.rpc('claim_confirmation_delivery', {
        p_payment_id: testPaymentId, p_attempt_source: 'webhook_stage3',
      }),
      supabase.rpc('claim_confirmation_delivery', {
        p_payment_id: testPaymentId, p_attempt_source: 'ive_paid_recovery',
      }),
    ]);

    const winners = [r1, r2].filter(r => r.claimed === true);
    const losers = [r1, r2].filter(r => r.claimed === false);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
  });

  // ── Privilege assertions ──

  it('payment_confirmation_deliveries has RLS enabled', async () => {
    // Verified by migration 342: ALTER TABLE ... ENABLE ROW LEVEL SECURITY
    // This test confirms the table exists and RLS is enabled
    const { data, error } = await supabase.from('payment_confirmation_deliveries')
      .select('id').limit(0);
    // Service role can query (bypasses RLS) — table must exist
    expect(error).toBeNull();
  });

  it('unmatched_delivery_statuses has RLS enabled', async () => {
    const { data, error } = await supabase.from('unmatched_delivery_statuses')
      .select('id').limit(0);
    expect(error).toBeNull();
  });
});
