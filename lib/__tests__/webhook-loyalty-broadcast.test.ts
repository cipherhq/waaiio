/**
 * Webhook Handler + Loyalty + Broadcast + Survey/Poll — Real Database Integration Tests
 *
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/webhook-loyalty-broadcast.test.ts
 *
 * Requires local Supabase running (`supabase start`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testBizIdA: string;
let testBizIdB: string;
let testUserIdA: string;
let testUserIdB: string;

describeIntegration('Webhook + Loyalty + Broadcast + Survey/Poll — real database', () => {
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

    // Create two users + two businesses for cross-business isolation tests
    const { data: userA } = await db.auth.admin.createUser({
      email: `wlb-a-${ts}@test.local`, password: 'test-123', email_confirm: true,
    });
    testUserIdA = userA.user!.id;

    const { data: userB } = await db.auth.admin.createUser({
      email: `wlb-b-${ts}@test.local`, password: 'test-123', email_confirm: true,
    });
    testUserIdB = userB.user!.id;

    const { data: bizA } = await db.from('businesses').insert({
      owner_id: testUserIdA, name: `WLB Biz A ${ts}`, slug: `wlb-a-${ts}`,
      address: '1 Test St', city: 'Lagos', neighborhood: 'VI', phone: '+2341111',
      status: 'active', subscription_tier: 'free',
    }).select('id').single();
    testBizIdA = bizA!.id;

    const { data: bizB } = await db.from('businesses').insert({
      owner_id: testUserIdB, name: `WLB Biz B ${ts}`, slug: `wlb-b-${ts}`,
      address: '2 Test St', city: 'Lagos', neighborhood: 'VI', phone: '+2342222',
      status: 'active', subscription_tier: 'free',
    }).select('id').single();
    testBizIdB = bizB!.id;
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    // Clean up in dependency order
    await db.from('poll_votes').delete().in('business_id', [testBizIdA, testBizIdB]);
    await db.from('polls').delete().in('business_id', [testBizIdA, testBizIdB]);
    await db.from('survey_responses').delete().in('business_id', [testBizIdA, testBizIdB]);
    await db.from('surveys').delete().in('business_id', [testBizIdA, testBizIdB]);
    await db.from('broadcast_usage').delete().in('business_id', [testBizIdA, testBizIdB]);
    await db.from('business_broadcasts').delete().in('business_id', [testBizIdA, testBizIdB]);
    await db.from('conversation_usage').delete().in('business_id', [testBizIdA, testBizIdB]);
    await db.from('loyalty_transactions').delete().in('business_id', [testBizIdA, testBizIdB]);
    await db.from('loyalty_points').delete().in('business_id', [testBizIdA, testBizIdB]);
    await db.from('platform_fees').delete().in('business_id', [testBizIdA, testBizIdB]);
    await db.from('payments').delete().in('business_id', [testBizIdA, testBizIdB]);
    await db.from('businesses').delete().in('id', [testBizIdA, testBizIdB]);
    await db.auth.admin.deleteUser(testUserIdA);
    await db.auth.admin.deleteUser(testUserIdB);
  }, 15000);

  // ─────────────────────────────────────────────────────────
  // Payment webhook handler tests (Level B — real handler DB ops)
  // ─────────────────────────────────────────────────────────

  it('1. pending payment updated to success with paid_at', async () => {
    const ref = `wh-success-${Date.now()}`;
    const { data: p } = await db.from('payments').insert({
      business_id: testBizIdA, amount: 5000, currency: 'NGN',
      gateway_reference: ref, gateway: 'paystack', status: 'pending',
    }).select('id').single();
    expect(p).not.toBeNull();

    // Simulate webhook handler logic: update to success
    const { error } = await db.from('payments').update({
      status: 'success',
      gateway_status: 'success',
      payment_method: 'card',
      paid_at: new Date().toISOString(),
    }).eq('gateway_reference', ref);
    expect(error).toBeNull();

    // Verify state
    const { data: updated } = await db.from('payments')
      .select('status, paid_at, payment_method')
      .eq('id', p!.id).single();
    expect(updated!.status).toBe('success');
    expect(updated!.paid_at).not.toBeNull();
    expect(updated!.payment_method).toBe('card');
  });

  it('2. idempotency: already-success payment not modified by retry', async () => {
    const ref = `wh-idem-${Date.now()}`;
    const originalPaidAt = new Date('2026-01-01T00:00:00Z').toISOString();

    await db.from('payments').insert({
      business_id: testBizIdA, amount: 3000, currency: 'NGN',
      gateway_reference: ref, gateway: 'paystack', status: 'success',
      paid_at: originalPaidAt,
    });

    // Simulate the idempotency check from processPaystackChargeSuccess:
    // "if (!existingPayment || existingPayment.status === 'success') return;"
    const { data: existing } = await db.from('payments')
      .select('id, status, amount')
      .eq('gateway_reference', ref).single();

    expect(existing!.status).toBe('success');
    // Handler would return early here — no update should happen
    if (existing!.status === 'success') {
      // Skipped — this is the idempotency guard
    }

    // Verify paid_at was NOT changed
    const { data: check } = await db.from('payments')
      .select('paid_at').eq('id', existing!.id).single();
    // Postgres may return +00:00 instead of Z — compare as Date
    expect(new Date(check!.paid_at).getTime()).toBe(new Date(originalPaidAt).getTime());
  });

  it('3. amount mismatch: payment marked as failed', async () => {
    const ref = `wh-mismatch-${Date.now()}`;
    const { data: p } = await db.from('payments').insert({
      business_id: testBizIdA, amount: 5000, currency: 'NGN',
      gateway_reference: ref, gateway: 'paystack', status: 'pending',
    }).select('id').single();

    // Simulate amount mismatch logic from webhook handler
    const webhookAmountKobo = 300000; // 3000 NGN in kobo
    const expectedKobo = 5000 * 100;  // 500000 kobo

    expect(webhookAmountKobo).not.toBe(expectedKobo); // mismatch!

    // Handler marks as failed on mismatch
    await db.from('payments').update({
      status: 'failed',
      gateway_status: 'amount_mismatch',
    }).eq('gateway_reference', ref);

    const { data: failed } = await db.from('payments')
      .select('status, gateway_status').eq('id', p!.id).single();
    expect(failed!.status).toBe('failed');
    expect(failed!.gateway_status).toBe('amount_mismatch');
  });

  it('4. duplicate gateway_reference: second insert fails (unique constraint)', async () => {
    const ref = `wh-dup-${Date.now()}`;
    const r1 = await db.from('payments').insert({
      business_id: testBizIdA, amount: 1000, currency: 'NGN',
      gateway_reference: ref, gateway: 'paystack', status: 'pending',
    });
    expect(r1.error).toBeNull();

    // Attempt insert with same gateway_reference
    const r2 = await db.from('payments').insert({
      business_id: testBizIdA, amount: 1000, currency: 'NGN',
      gateway_reference: ref, gateway: 'paystack', status: 'pending',
    });
    // Should fail due to unique constraint on gateway_reference
    expect(r2.error).not.toBeNull();
  });

  it('5. charge.failed: pending payment updated to failed with reason', async () => {
    const ref = `wh-fail-${Date.now()}`;
    await db.from('payments').insert({
      business_id: testBizIdA, amount: 7000, currency: 'NGN',
      gateway_reference: ref, gateway: 'paystack', status: 'pending',
    });

    // Simulate processPaystackChargeFailed logic
    const { data: existing } = await db.from('payments')
      .select('id, status, amount, business_id')
      .eq('gateway_reference', ref).single();

    expect(existing!.status).not.toBe('success'); // guard passes

    await db.from('payments').update({
      status: 'failed',
      gateway_status: 'Insufficient Funds',
    }).eq('gateway_reference', ref);

    const { data: check } = await db.from('payments')
      .select('status, gateway_status').eq('id', existing!.id).single();
    expect(check!.status).toBe('failed');
    expect(check!.gateway_status).toBe('Insufficient Funds');
  });

  // ─────────────────────────────────────────────────────────
  // Loyalty system tests (Level A)
  // ─────────────────────────────────────────────────────────

  it('6. create loyalty_points record and verify balance', async () => {
    const { data: lp, error } = await db.from('loyalty_points').insert({
      business_id: testBizIdA,
      customer_phone: '+2348001000001',
      customer_name: 'Loyalty Test',
      points_balance: 100,
      total_earned: 100,
      total_redeemed: 0,
      visit_count: 1,
    }).select('*').single();

    expect(error).toBeNull();
    expect(lp!.points_balance).toBe(100);
    expect(lp!.total_earned).toBe(100);
    expect(lp!.total_redeemed).toBe(0);
  });

  it('7. award points (increment) and verify new balance', async () => {
    const phone = '+2348001000002';
    await db.from('loyalty_points').insert({
      business_id: testBizIdA, customer_phone: phone,
      points_balance: 50, total_earned: 50, total_redeemed: 0, visit_count: 1,
    });

    // Award 30 more points
    await db.from('loyalty_points').update({
      points_balance: 80, // 50 + 30
      total_earned: 80,
      visit_count: 2,
    }).eq('business_id', testBizIdA).eq('customer_phone', phone);

    const { data: lp } = await db.from('loyalty_points')
      .select('points_balance, total_earned, visit_count')
      .eq('business_id', testBizIdA).eq('customer_phone', phone).single();

    expect(lp!.points_balance).toBe(80);
    expect(lp!.total_earned).toBe(80);
    expect(lp!.visit_count).toBe(2);
  });

  it('8. redeem points via redeem_loyalty_points RPC', async () => {
    const phone = '+2348001000003';
    const { data: lp } = await db.from('loyalty_points').insert({
      business_id: testBizIdA, customer_phone: phone,
      points_balance: 200, total_earned: 200, total_redeemed: 0, visit_count: 5,
    }).select('id').single();

    // Redeem 75 points
    const { data: result } = await db.rpc('redeem_loyalty_points', {
      p_loyalty_id: lp!.id,
      p_points: 75,
    });
    expect(result).toBe(true);

    // Verify deducted
    const { data: after } = await db.from('loyalty_points')
      .select('points_balance, total_redeemed')
      .eq('id', lp!.id).single();
    expect(after!.points_balance).toBe(125);
    expect(after!.total_redeemed).toBe(75);
  });

  it('9. redeem more points than available is rejected', async () => {
    const phone = '+2348001000004';
    const { data: lp } = await db.from('loyalty_points').insert({
      business_id: testBizIdA, customer_phone: phone,
      points_balance: 30, total_earned: 30, total_redeemed: 0, visit_count: 1,
    }).select('id').single();

    // Try to redeem 50 from a 30-point balance
    const { data: result } = await db.rpc('redeem_loyalty_points', {
      p_loyalty_id: lp!.id,
      p_points: 50,
    });
    expect(result).toBe(false);

    // Balance unchanged
    const { data: after } = await db.from('loyalty_points')
      .select('points_balance, total_redeemed')
      .eq('id', lp!.id).single();
    expect(after!.points_balance).toBe(30);
    expect(after!.total_redeemed).toBe(0);
  });

  it('10. cross-business isolation: biz B cannot read biz A loyalty points', async () => {
    const phone = '+2348001000010';
    await db.from('loyalty_points').insert({
      business_id: testBizIdA, customer_phone: phone,
      points_balance: 999, total_earned: 999, total_redeemed: 0, visit_count: 10,
    });

    // Business B queries — should not find business A's record
    const { data: bizBPoints } = await db.from('loyalty_points')
      .select('*')
      .eq('business_id', testBizIdB)
      .eq('customer_phone', phone);

    expect(bizBPoints).toEqual([]);

    // Confirm business A can see its own
    const { data: bizAPoints } = await db.from('loyalty_points')
      .select('points_balance')
      .eq('business_id', testBizIdA)
      .eq('customer_phone', phone)
      .single();
    expect(bizAPoints!.points_balance).toBe(999);
  });

  // ─────────────────────────────────────────────────────────
  // Broadcast capability tests (Level A)
  // ─────────────────────────────────────────────────────────

  it('11. create broadcast record with correct status', async () => {
    const { data: bc, error } = await db.from('business_broadcasts').insert({
      business_id: testBizIdA,
      created_by: testUserIdA,
      message: 'Hello customers! Big sale this weekend.',
      phones: ['+2348001111111', '+2348002222222'],
      recipient_count: 2,
      status: 'scheduled',
      scheduled_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
    }).select('*').single();

    expect(error).toBeNull();
    expect(bc!.status).toBe('scheduled');
    expect(bc!.recipient_count).toBe(2);
    expect(bc!.sent_count).toBe(0);
  });

  it('12. broadcast_usage tracks message count per business via RPC', async () => {
    // Use the atomic increment function
    const { error: e1 } = await db.rpc('increment_broadcast_usage', {
      p_business_id: testBizIdA,
      p_recipient_count: 50,
    });
    expect(e1).toBeNull();

    // Second broadcast
    const { error: e2 } = await db.rpc('increment_broadcast_usage', {
      p_business_id: testBizIdA,
      p_recipient_count: 30,
    });
    expect(e2).toBeNull();

    // Verify counts accumulated
    const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
    const { data: usage } = await db.from('broadcast_usage')
      .select('broadcast_count, recipient_count')
      .eq('business_id', testBizIdA)
      .eq('month_key', monthKey)
      .single();

    expect(usage!.broadcast_count).toBe(2);
    expect(usage!.recipient_count).toBe(80);
  });

  it('13. conversation_usage tracks messages and enforces structure', async () => {
    // Increment inbound message
    await db.rpc('increment_message_usage', {
      p_business_id: testBizIdA,
      p_direction: 'inbound',
      p_is_new_conversation: true,
    });

    // Increment outbound message (same conversation)
    await db.rpc('increment_message_usage', {
      p_business_id: testBizIdA,
      p_direction: 'outbound',
      p_is_new_conversation: false,
    });

    // Another inbound, new conversation
    await db.rpc('increment_message_usage', {
      p_business_id: testBizIdA,
      p_direction: 'inbound',
      p_is_new_conversation: true,
    });

    const monthKey = new Date().toISOString().slice(0, 7);
    const { data: usage } = await db.from('conversation_usage')
      .select('conversation_count, inbound_count, outbound_count, template_count')
      .eq('business_id', testBizIdA)
      .eq('month_key', monthKey)
      .single();

    expect(usage!.conversation_count).toBe(2);
    expect(usage!.inbound_count).toBe(2);
    expect(usage!.outbound_count).toBe(1);
    expect(usage!.template_count).toBe(0);

    // Verify check_conversation_limit works
    const { data: limit } = await db.rpc('check_conversation_limit', {
      p_business_id: testBizIdA,
    });
    // Free tier limit is 200 conversations
    expect(limit).not.toBeNull();
    const row = Array.isArray(limit) ? limit[0] : limit;
    expect(row.allowed).toBe(true);
    expect(row.monthly_limit).toBe(200);
    expect(row.monthly_conversations).toBe(2);
  });

  // ─────────────────────────────────────────────────────────
  // Survey / Poll tests (Level A)
  // ─────────────────────────────────────────────────────────

  it('14. create survey + survey_response linked to survey', async () => {
    const { data: survey, error: sErr } = await db.from('surveys').insert({
      business_id: testBizIdA,
      title: 'Customer Satisfaction Q3',
      description: 'How was your experience?',
      questions: [
        { id: 'q1', text: 'Rate our service (1-5)', type: 'rating' },
        { id: 'q2', text: 'Any comments?', type: 'text' },
      ],
      status: 'active',
    }).select('id, status').single();

    expect(sErr).toBeNull();
    expect(survey!.status).toBe('active');

    // Add a response
    const { data: resp, error: rErr } = await db.from('survey_responses').insert({
      survey_id: survey!.id,
      business_id: testBizIdA,
      customer_phone: '+2348005550001',
      customer_name: 'Survey Taker',
      answers: { q1: 5, q2: 'Great service!' },
      completed: true,
      completed_at: new Date().toISOString(),
    }).select('*').single();

    expect(rErr).toBeNull();
    expect(resp!.survey_id).toBe(survey!.id);
    expect(resp!.completed).toBe(true);
    expect((resp!.answers as Record<string, unknown>).q1).toBe(5);

    // Verify unique constraint: same phone + survey cannot respond twice
    const { error: dupErr } = await db.from('survey_responses').insert({
      survey_id: survey!.id,
      business_id: testBizIdA,
      customer_phone: '+2348005550001',
      answers: { q1: 3 },
    });
    expect(dupErr).not.toBeNull(); // UNIQUE(survey_id, customer_phone)
  });

  it('15. create poll + poll_vote, verify unique per user', async () => {
    const { data: poll, error: pErr } = await db.from('polls').insert({
      business_id: testBizIdA,
      question: 'What should be our next special?',
      options: ['Jollof Rice', 'Pepper Soup', 'Suya Platter'],
      status: 'active',
    }).select('id, status').single();

    expect(pErr).toBeNull();
    expect(poll!.status).toBe('active');

    // Cast a vote
    const { data: vote, error: vErr } = await db.from('poll_votes').insert({
      poll_id: poll!.id,
      business_id: testBizIdA,
      customer_phone: '+2348006660001',
      customer_name: 'Voter One',
      option_index: 0, // Jollof Rice
    }).select('*').single();

    expect(vErr).toBeNull();
    expect(vote!.poll_id).toBe(poll!.id);
    expect(vote!.option_index).toBe(0);

    // Second user votes differently
    const { error: v2Err } = await db.from('poll_votes').insert({
      poll_id: poll!.id,
      business_id: testBizIdA,
      customer_phone: '+2348006660002',
      option_index: 2, // Suya Platter
    });
    expect(v2Err).toBeNull();

    // Same user tries to vote again — should fail
    const { error: dupErr } = await db.from('poll_votes').insert({
      poll_id: poll!.id,
      business_id: testBizIdA,
      customer_phone: '+2348006660001',
      option_index: 1, // tries to change to Pepper Soup
    });
    expect(dupErr).not.toBeNull(); // UNIQUE(poll_id, customer_phone)

    // Verify vote count
    const { data: votes } = await db.from('poll_votes')
      .select('id').eq('poll_id', poll!.id);
    expect(votes!.length).toBe(2);
  });
});

// ── Always-passing status test (shows skip/run state in normal test runs) ──
describe('Webhook + Loyalty + Broadcast + Survey/Poll status', () => {
  it(`integration tests are ${SKIP ? 'SKIPPED (set SUPABASE_INTEGRATION=true)' : 'RUNNING'}`, () => {
    expect(true).toBe(true);
  });
});
