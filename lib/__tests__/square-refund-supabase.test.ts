import { describe, it, expect, beforeAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const isIntegration = process.env.SUPABASE_INTEGRATION === 'true';

describe.skipIf(!isIntegration)('Square refund RPCs (real Supabase)', () => {
  let supabase: ReturnType<typeof createClient>;
  let testBusinessId: string;
  let testUserId: string;
  let testPaymentId: string;

  beforeAll(async () => {
    supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    // Create a test user via admin API
    const { data: authUser } = await supabase.auth.admin.createUser({
      email: `square-refund-test-${Date.now()}@test.local`,
      password: 'test-password-123',
      email_confirm: true,
      user_metadata: { full_name: 'Square Refund Test' },
    });
    testUserId = authUser.user!.id;

    // Create a test business
    const { data: biz } = await supabase.from('businesses').insert({
      name: 'Square Refund Test Biz',
      owner_id: testUserId,
      category: 'salon',
      country_code: 'US',
      status: 'active',
    }).select('id').single();
    testBusinessId = biz!.id;

    // Create a test payment (success status)
    const { data: payment } = await supabase.from('payments').insert({
      business_id: testBusinessId,
      user_id: testUserId,
      amount: 100.00,
      currency: 'USD',
      gateway: 'square',
      gateway_reference: `sq-test-${Date.now()}`,
      status: 'success',
      paid_at: new Date().toISOString(),
      waaiio_fee: 2.50,
    }).select('id').single();
    testPaymentId = payment!.id;
  });

  it('claim_refund_balance reserves the correct amount', async () => {
    const idempotencyKey = `test-claim-${Date.now()}`;
    const { data, error } = await supabase.rpc('claim_refund_balance', {
      p_payment_id: testPaymentId,
      p_refund_amount: 50.00,
      p_idempotency_key: idempotencyKey,
      p_currency: 'USD',
      p_waaiio_fee_total: 2.50,
    });

    expect(error).toBeNull();
    expect(data.claimed).toBe(true);
    expect(data.refund_id).toBeTruthy();
    expect(data.remaining_after).toBe(50);
    expect(data.planned_fee_reversal).toBeGreaterThan(0);
  });

  it('claim_refund_balance returns existing on duplicate key', async () => {
    const idempotencyKey = `test-dup-${Date.now()}`;

    // First claim
    const { data: first } = await supabase.rpc('claim_refund_balance', {
      p_payment_id: testPaymentId,
      p_refund_amount: 10.00,
      p_idempotency_key: idempotencyKey,
      p_currency: 'USD',
      p_waaiio_fee_total: 2.50,
    });
    expect(first.claimed).toBe(true);

    // Duplicate claim — same key, same amount
    const { data: second } = await supabase.rpc('claim_refund_balance', {
      p_payment_id: testPaymentId,
      p_refund_amount: 10.00,
      p_idempotency_key: idempotencyKey,
      p_currency: 'USD',
      p_waaiio_fee_total: 2.50,
    });
    expect(second.claimed).toBe(true);
    expect(second.existing).toBe(true);
    expect(second.refund_id).toBe(first.refund_id);
  });

  it('claim_refund_balance rejects parameter mismatch on duplicate key', async () => {
    const idempotencyKey = `test-mismatch-${Date.now()}`;

    // First claim with amount 10
    await supabase.rpc('claim_refund_balance', {
      p_payment_id: testPaymentId,
      p_refund_amount: 10.00,
      p_idempotency_key: idempotencyKey,
      p_currency: 'USD',
      p_waaiio_fee_total: 2.50,
    });

    // Same key, different amount
    const { data } = await supabase.rpc('claim_refund_balance', {
      p_payment_id: testPaymentId,
      p_refund_amount: 20.00,
      p_idempotency_key: idempotencyKey,
      p_currency: 'USD',
      p_waaiio_fee_total: 2.50,
    });
    expect(data.claimed).toBe(false);
    expect(data.reason).toBe('parameter_mismatch');
  });

  it('claim_refund_balance rejects exceeding balance', async () => {
    const { data } = await supabase.rpc('claim_refund_balance', {
      p_payment_id: testPaymentId,
      p_refund_amount: 99999.00,
      p_idempotency_key: `test-exceed-${Date.now()}`,
      p_currency: 'USD',
      p_waaiio_fee_total: 2.50,
    });
    expect(data.claimed).toBe(false);
    expect(data.reason).toBe('exceeds_balance');
  });

  it('finalize_square_refund completes a refund and updates payment', async () => {
    const idempotencyKey = `test-finalize-${Date.now()}`;

    // Claim
    const { data: claim } = await supabase.rpc('claim_refund_balance', {
      p_payment_id: testPaymentId,
      p_refund_amount: 5.00,
      p_idempotency_key: idempotencyKey,
      p_currency: 'USD',
      p_waaiio_fee_total: 2.50,
    });
    expect(claim.claimed).toBe(true);

    // Finalize
    const squareRefundId = `sq-refund-${Date.now()}`;
    const { data: result, error } = await supabase.rpc('finalize_square_refund', {
      p_refund_id: claim.refund_id,
      p_square_refund_id: squareRefundId,
      p_final_status: 'success',
      p_fee_reversed: claim.planned_fee_reversal,
    });

    expect(error).toBeNull();
    expect(result.success).toBe(true);
    expect(result.financial).toBe(true);

    // Verify refund status
    const { data: refund } = await supabase.from('refunds')
      .select('status, gateway_refund_reference')
      .eq('id', claim.refund_id).single();
    expect(refund!.status).toBe('success');
    expect(refund!.gateway_refund_reference).toBe(squareRefundId);
  });

  it('finalize_square_refund rejects already-finalized refunds', async () => {
    const idempotencyKey = `test-double-final-${Date.now()}`;

    // Claim and finalize
    const { data: claim } = await supabase.rpc('claim_refund_balance', {
      p_payment_id: testPaymentId,
      p_refund_amount: 3.00,
      p_idempotency_key: idempotencyKey,
      p_currency: 'USD',
      p_waaiio_fee_total: 2.50,
    });

    const squareRefundId = `sq-double-${Date.now()}`;
    await supabase.rpc('finalize_square_refund', {
      p_refund_id: claim.refund_id,
      p_square_refund_id: squareRefundId,
      p_final_status: 'success',
    });

    // Second finalization should be rejected
    const { data: second } = await supabase.rpc('finalize_square_refund', {
      p_refund_id: claim.refund_id,
      p_square_refund_id: squareRefundId,
      p_final_status: 'success',
    });
    expect(second.success).toBe(false);
    expect(second.reason).toBe('already_finalized');
  });

  it('finalize_square_refund with failed status does not mutate financials', async () => {
    const idempotencyKey = `test-fail-final-${Date.now()}`;

    const { data: claim } = await supabase.rpc('claim_refund_balance', {
      p_payment_id: testPaymentId,
      p_refund_amount: 2.00,
      p_idempotency_key: idempotencyKey,
      p_currency: 'USD',
      p_waaiio_fee_total: 2.50,
    });

    const { data: result } = await supabase.rpc('finalize_square_refund', {
      p_refund_id: claim.refund_id,
      p_square_refund_id: `sq-fail-${Date.now()}`,
      p_final_status: 'failed',
    });

    expect(result.success).toBe(true);
    expect(result.financial).toBe(false);

    // Verify refund is marked failed
    const { data: refund } = await supabase.from('refunds')
      .select('status').eq('id', claim.refund_id).single();
    expect(refund!.status).toBe('failed');
  });
});
