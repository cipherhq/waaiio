/**
 * #197: PostgreSQL-level delivery lifecycle tests.
 *
 * These tests require TEST_DATABASE_URL and run in the dedicated
 * PostgreSQL CI path. They verify the actual RPC behavior including
 * concurrency, state machine invariants, and WAMID race resolution.
 *
 * Skip gracefully when TEST_DATABASE_URL is not set (normal Main App CI).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const SKIP_REASON = 'TEST_DATABASE_URL not set — skipping PostgreSQL delivery tests';

// Conditionally skip the entire suite
const describeDb = TEST_DB_URL ? describe : describe.skip;

describeDb('PostgreSQL delivery lifecycle (#197)', () => {
  let supabase: SupabaseClient;
  let testPaymentId: string;
  let testBusinessId: string;

  beforeAll(async () => {
    if (!TEST_DB_URL) return;

    // Use service role client for RPC access
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    supabase = createClient(supabaseUrl, serviceKey);

    // Create a test business and payment for all tests
    const { data: biz } = await supabase.from('businesses').insert({
      name: 'Test Biz 197',
      slug: `test-biz-197-${Date.now()}`,
      category: 'other',
    }).select('id').single();
    testBusinessId = biz!.id;

    const { data: pay } = await supabase.from('payments').insert({
      business_id: testBusinessId,
      amount: 121000,
      currency: 'NGN',
      gateway: 'paystack',
      gateway_reference: `test-197-${Date.now()}`,
      status: 'success',
      payment_authority_version: 1,
    }).select('id').single();
    testPaymentId = pay!.id;
  });

  afterAll(async () => {
    if (!supabase) return;
    // Cleanup test data
    await supabase.from('payment_confirmation_deliveries').delete().eq('payment_id', testPaymentId);
    await supabase.from('payments').delete().eq('id', testPaymentId);
    await supabase.from('businesses').delete().eq('id', testBusinessId);
  });

  beforeEach(async () => {
    if (!supabase) return;
    // Clean delivery attempts between tests
    await supabase.from('payment_confirmation_deliveries').delete().eq('payment_id', testPaymentId);
    await supabase.from('unmatched_delivery_statuses').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  // ── Claim lifecycle tests ──

  it('should create first delivery claim', async () => {
    const { data, error } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });

    expect(error).toBeNull();
    expect(data.claimed).toBe(true);
    expect(data.attempt_number).toBe(1);
    expect(data.claim_token).toBeTruthy();
    expect(data.attempt_id).toBeTruthy();
  });

  it('should reject second claim while first is active (claiming_in_progress)', async () => {
    // First claim
    const { data: first } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });
    expect(first.claimed).toBe(true);

    // Second claim — should be blocked
    const { data: second } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'ive_paid_recovery', // different source, same payment-wide authority
    });
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe('claiming_in_progress');
  });

  it('should reject claim for non-successful payment', async () => {
    // Create a pending payment
    const { data: pendingPay } = await supabase.from('payments').insert({
      business_id: testBusinessId,
      amount: 100,
      currency: 'NGN',
      gateway: 'paystack',
      gateway_reference: `test-197-pending-${Date.now()}`,
      status: 'pending',
    }).select('id').single();

    const { data } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: pendingPay!.id,
      p_attempt_source: 'webhook_stage3',
    });

    expect(data.claimed).toBe(false);
    expect(data.reason).toBe('payment_not_successful');

    await supabase.from('payments').delete().eq('id', pendingPay!.id);
  });

  // ── begin_confirmation_send tests ──

  it('should authorize send from claiming state', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });

    const { data: auth } = await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    });

    expect(auth.authorized).toBe(true);

    // Verify state is now 'sending'
    const { data: attempt } = await supabase
      .from('payment_confirmation_deliveries')
      .select('delivery_status, claim_expires_at')
      .eq('id', claim.attempt_id)
      .single();

    expect(attempt!.delivery_status).toBe('sending');
    expect(attempt!.claim_expires_at).toBeNull(); // lease cleared
  });

  it('should reject send authorization with wrong token', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });

    const { data: auth } = await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: '00000000-0000-0000-0000-000000000000', // wrong token
    });

    expect(auth.authorized).toBe(false);
    expect(auth.reason).toBe('token_mismatch');
  });

  // ── complete_confirmation_send tests ──

  it('should complete send with WAMID from sending state', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });

    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    });

    const wamid = `wamid.test197_${Date.now()}`;
    const { data: complete } = await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_meta_message_id: wamid,
      p_accepted_at: new Date().toISOString(),
    });

    expect(complete.completed).toBe(true);

    // Verify state
    const { data: attempt } = await supabase
      .from('payment_confirmation_deliveries')
      .select('delivery_status, meta_message_id, accepted_at, claim_token')
      .eq('id', claim.attempt_id)
      .single();

    expect(attempt!.delivery_status).toBe('accepted');
    expect(attempt!.meta_message_id).toBe(wamid);
    expect(attempt!.accepted_at).toBeTruthy();
    expect(attempt!.claim_token).toBeNull(); // cleared after completion
  });

  it('should reject complete_confirmation_send with blank WAMID', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });

    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    });

    const { data: complete } = await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_meta_message_id: '',
      p_accepted_at: new Date().toISOString(),
    });

    expect(complete.completed).toBe(false);
    expect(complete.reason).toBe('blank_wamid');
  });

  // ── fail_confirmation_send tests ──

  it('should record indeterminate only from sending state', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });

    // Try indeterminate from claiming — should fail
    const { data: failClaiming } = await supabase.rpc('fail_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_failure_type: 'indeterminate',
    });
    expect(failClaiming.recorded).toBe(false);
    expect(failClaiming.reason).toBe('indeterminate_only_from_sending');

    // Move to sending first
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    });

    // Now indeterminate should work
    const { data: failSending } = await supabase.rpc('fail_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_failure_type: 'indeterminate',
      p_failure_reason: 'no_wamid_timeout',
    });
    expect(failSending.recorded).toBe(true);

    // Verify indeterminate_at is set but failed_at is NULL
    const { data: attempt } = await supabase
      .from('payment_confirmation_deliveries')
      .select('delivery_status, indeterminate_at, failed_at')
      .eq('id', claim.attempt_id)
      .single();

    expect(attempt!.delivery_status).toBe('indeterminate');
    expect(attempt!.indeterminate_at).toBeTruthy();
    expect(attempt!.failed_at).toBeNull();
  });

  it('should reject invalid failure_type', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });

    const { data } = await supabase.rpc('fail_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_failure_type: 'unknown_type',
    });

    expect(data.recorded).toBe(false);
    expect(data.reason).toBe('invalid_failure_type');
  });

  // ── advance_delivery_status tests ──

  it('should advance status monotonically', async () => {
    // Set up: claim → send → complete with WAMID
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    });
    const wamid = `wamid.mono_${Date.now()}`;
    await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_meta_message_id: wamid,
      p_accepted_at: new Date().toISOString(),
    });

    // Advance: sent
    const ts1 = new Date('2026-08-26T05:45:21Z').toISOString();
    const { data: r1 } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid,
      p_new_status: 'sent',
      p_provider_timestamp: ts1,
    });
    expect(r1.advanced).toBe(true);

    // Advance: delivered
    const ts2 = new Date('2026-08-26T05:45:25Z').toISOString();
    const { data: r2 } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid,
      p_new_status: 'delivered',
      p_provider_timestamp: ts2,
    });
    expect(r2.advanced).toBe(true);

    // Advance: read
    const ts3 = new Date('2026-08-26T05:46:00Z').toISOString();
    const { data: r3 } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid,
      p_new_status: 'read',
      p_provider_timestamp: ts3,
    });
    expect(r3.advanced).toBe(true);

    // Verify timestamps
    const { data: attempt } = await supabase
      .from('payment_confirmation_deliveries')
      .select('delivery_status, sent_at, delivered_at, read_at')
      .eq('id', claim.attempt_id)
      .single();

    expect(attempt!.delivery_status).toBe('read');
    expect(attempt!.sent_at).toBe(ts1);
    expect(attempt!.delivered_at).toBe(ts2);
    expect(attempt!.read_at).toBe(ts3);
  });

  it('should allow forward jumps (accepted → delivered) without fabricating sent_at', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    });
    const wamid = `wamid.jump_${Date.now()}`;
    await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_meta_message_id: wamid,
      p_accepted_at: new Date().toISOString(),
    });

    // Jump directly from accepted → delivered (skip sent)
    const ts = new Date('2026-08-26T05:45:25Z').toISOString();
    const { data } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid,
      p_new_status: 'delivered',
      p_provider_timestamp: ts,
    });

    expect(data.advanced).toBe(true);

    const { data: attempt } = await supabase
      .from('payment_confirmation_deliveries')
      .select('delivery_status, sent_at, delivered_at')
      .eq('id', claim.attempt_id)
      .single();

    expect(attempt!.delivery_status).toBe('delivered');
    expect(attempt!.sent_at).toBeNull(); // NOT fabricated
    expect(attempt!.delivered_at).toBe(ts);
  });

  it('should reject failed from delivered state', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    });
    const wamid = `wamid.failrej_${Date.now()}`;
    await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_meta_message_id: wamid,
      p_accepted_at: new Date().toISOString(),
    });

    // Advance to delivered
    await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid,
      p_new_status: 'delivered',
      p_provider_timestamp: new Date().toISOString(),
    });

    // Try to fail from delivered — should be rejected
    const { data } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid,
      p_new_status: 'failed',
      p_provider_timestamp: new Date().toISOString(),
    });

    expect(data.advanced).toBe(false);
    expect(data.reason).toBe('cannot_fail_from_delivered');
  });

  it('should reject duplicate status callback (idempotent)', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    });
    const wamid = `wamid.dup_${Date.now()}`;
    await supabase.rpc('complete_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
      p_meta_message_id: wamid,
      p_accepted_at: new Date().toISOString(),
    });

    // First delivered
    const { data: r1 } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid,
      p_new_status: 'delivered',
      p_provider_timestamp: new Date().toISOString(),
    });
    expect(r1.advanced).toBe(true);

    // Duplicate delivered — idempotent
    const { data: r2 } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid,
      p_new_status: 'delivered',
      p_provider_timestamp: new Date().toISOString(),
    });
    expect(r2.advanced).toBe(false);
    expect(r2.reason).toBe('already_at_or_past_delivered');
  });

  // ── WAMID race tests ──

  it('should record unmatched status when WAMID not yet attached', async () => {
    const wamid = `wamid.unmatched_${Date.now()}`;

    // Status callback arrives before WAMID is attached to any attempt
    const { data } = await supabase.rpc('advance_delivery_status', {
      p_meta_message_id: wamid,
      p_new_status: 'delivered',
      p_provider_timestamp: new Date().toISOString(),
    });

    expect(data.advanced).toBe(false);
    expect(data.reason).toBe('wamid_not_found_recorded_unmatched');

    // Verify unmatched entry exists
    const { data: unmatched } = await supabase
      .from('unmatched_delivery_statuses')
      .select('*')
      .eq('meta_message_id', wamid);

    expect(unmatched).toHaveLength(1);
    expect(unmatched![0].status).toBe('delivered');

    // Cleanup
    await supabase.from('unmatched_delivery_statuses').delete().eq('meta_message_id', wamid);
  });

  // ── Cross-source payment-wide max enforcement ──

  it('should enforce max 3 attempts across mixed sources', async () => {
    // Attempt 1: webhook_stage3 (failed)
    const { data: c1 } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });
    expect(c1.claimed).toBe(true);
    await supabase.rpc('fail_confirmation_send', {
      p_attempt_id: c1.attempt_id,
      p_claim_token: c1.claim_token,
      p_failure_type: 'failed',
      p_failure_reason: 'test_failure_1',
    });

    // Attempt 2: webhook_stage3 (failed)
    const { data: c2 } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });
    expect(c2.claimed).toBe(true);
    expect(c2.attempt_number).toBe(2);
    await supabase.rpc('fail_confirmation_send', {
      p_attempt_id: c2.attempt_id,
      p_claim_token: c2.claim_token,
      p_failure_type: 'failed',
      p_failure_reason: 'test_failure_2',
    });

    // Attempt 3: ive_paid_recovery (failed)
    const { data: c3 } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'ive_paid_recovery',
    });
    expect(c3.claimed).toBe(true);
    expect(c3.attempt_number).toBe(3);
    await supabase.rpc('fail_confirmation_send', {
      p_attempt_id: c3.attempt_id,
      p_claim_token: c3.claim_token,
      p_failure_type: 'failed',
      p_failure_reason: 'test_failure_3',
    });

    // Attempt 4: any source — should be rejected
    const { data: c4 } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'ive_paid_recovery',
    });
    expect(c4.claimed).toBe(false);
    expect(c4.reason).toBe('max_attempts_exceeded');
  });

  // ── Sending state blocks new claims ──

  it('sending state blocks I\'ve Paid recovery claim', async () => {
    const { data: claim } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'webhook_stage3',
    });
    await supabase.rpc('begin_confirmation_send', {
      p_attempt_id: claim.attempt_id,
      p_claim_token: claim.claim_token,
    });

    // I've Paid recovery attempt — should be blocked by sending
    const { data: recovery } = await supabase.rpc('claim_confirmation_delivery', {
      p_payment_id: testPaymentId,
      p_attempt_source: 'ive_paid_recovery',
    });

    expect(recovery.claimed).toBe(false);
    expect(recovery.reason).toBe('active_delivery_sending');
  });
});
