/**
 * Payment Idempotency — Real Database Integration Tests
 *
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/payment-idempotency-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testBizId: string;
let testUserId: string;

describeIntegration('Payment idempotency — real database', () => {
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
      email: `pay-idem-${ts}@test.local`, password: 'test-123', email_confirm: true,
    });
    testUserId = user.user!.id;

    const { data: biz } = await db.from('businesses').insert({
      owner_id: testUserId, name: `Pay Idem ${ts}`, slug: `pay-idem-${ts}`,
      address: '123', city: 'T', neighborhood: 'T', phone: '123', status: 'active',
    }).select('id').single();
    testBizId = biz!.id;
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    await db.from('platform_fees').delete().eq('business_id', testBizId);
    await db.from('payments').delete().eq('business_id', testBizId);
    await db.from('invoices').delete().eq('business_id', testBizId);
    await db.from('businesses').delete().eq('id', testBizId);
    await db.auth.admin.deleteUser(testUserId);
  }, 15000);

  it('duplicate fee for same payment_id rejected unconditionally', async () => {
    const { data: p } = await db.from('payments').insert({
      business_id: testBizId, amount: 5000, currency: 'NGN',
      gateway_reference: `dup-${Date.now()}`, gateway: 'paystack', status: 'success',
    }).select('id').single();

    const r1 = await db.from('platform_fees').insert({
      business_id: testBizId, payment_id: p!.id,
      transaction_amount: 5000, fee_total: 125, fee_percentage: 2.5, fee_flat: 0,
    });
    expect(r1.error).toBeNull();

    const r2 = await db.from('platform_fees').insert({
      business_id: testBizId, payment_id: p!.id,
      transaction_amount: 5000, fee_total: 125, fee_percentage: 2.5, fee_flat: 0,
    });
    expect(r2.error).not.toBeNull();
  });

  it('concurrent fee inserts — exactly one succeeds', async () => {
    const { data: p } = await db.from('payments').insert({
      business_id: testBizId, amount: 7000, currency: 'NGN',
      gateway_reference: `conc-${Date.now()}`, gateway: 'paystack', status: 'success',
    }).select('id').single();

    const ins = () => db.from('platform_fees').insert({
      business_id: testBizId, payment_id: p!.id,
      transaction_amount: 7000, fee_total: 175, fee_percentage: 2.5, fee_flat: 0,
    });
    const [r1, r2] = await Promise.all([ins(), ins()]);
    expect([r1.error, r2.error].filter(e => e === null).length).toBe(1);
  });

  it('refund does NOT allow replay for same payment_id', async () => {
    const { data: p } = await db.from('payments').insert({
      business_id: testBizId, amount: 3000, currency: 'NGN',
      gateway_reference: `refund-${Date.now()}`, gateway: 'paystack', status: 'success',
    }).select('id').single();

    const { data: fee } = await db.from('platform_fees').insert({
      business_id: testBizId, payment_id: p!.id,
      transaction_amount: 3000, fee_total: 75, fee_percentage: 2.5, fee_flat: 0,
    }).select('id').single();

    await db.from('platform_fees').update({ refunded_at: new Date().toISOString() }).eq('id', fee!.id);

    const replay = await db.from('platform_fees').insert({
      business_id: testBizId, payment_id: p!.id,
      transaction_amount: 3000, fee_total: 75, fee_percentage: 2.5, fee_flat: 0,
    });
    expect(replay.error).not.toBeNull();
  });

  it('two different payments for same invoice both create fees', async () => {
    const { data: inv } = await db.from('invoices').insert({
      business_id: testBizId, customer_name: 'Partial', total_amount: 10000, status: 'sent',
    }).select('id').single();

    const { data: p1 } = await db.from('payments').insert({
      business_id: testBizId, amount: 5000, currency: 'NGN', invoice_id: inv!.id,
      gateway_reference: `part1-${Date.now()}`, gateway: 'paystack', status: 'success',
    }).select('id').single();
    const { data: p2 } = await db.from('payments').insert({
      business_id: testBizId, amount: 5000, currency: 'NGN', invoice_id: inv!.id,
      gateway_reference: `part2-${Date.now()}`, gateway: 'paystack', status: 'success',
    }).select('id').single();

    const f1 = await db.from('platform_fees').insert({
      business_id: testBizId, invoice_id: inv!.id, payment_id: p1!.id,
      transaction_amount: 5000, fee_total: 125, fee_percentage: 2.5, fee_flat: 0,
    });
    const f2 = await db.from('platform_fees').insert({
      business_id: testBizId, invoice_id: inv!.id, payment_id: p2!.id,
      transaction_amount: 5000, fee_total: 125, fee_percentage: 2.5, fee_flat: 0,
    });
    expect(f1.error).toBeNull();
    expect(f2.error).toBeNull();

    const { data: fees } = await db.from('platform_fees').select('id').eq('invoice_id', inv!.id);
    expect(fees!.length).toBe(2);
  });

  it('apply_invoice_payment RPC: same payment twice → one increment', async () => {
    const { data: inv } = await db.from('invoices').insert({
      business_id: testBizId, customer_name: 'RPC Test',
      total_amount: 10000, amount_paid: 0, status: 'sent',
    }).select('id').single();
    const { data: p } = await db.from('payments').insert({
      business_id: testBizId, amount: 5000, currency: 'NGN', invoice_id: inv!.id,
      gateway_reference: `rpc-${Date.now()}`, gateway: 'paystack', status: 'success',
    }).select('id').single();

    const r1 = await db.rpc('apply_invoice_payment', {
      p_invoice_id: inv!.id, p_payment_id: p!.id, p_payment_amount: 5000, p_business_id: testBizId,
    });
    const r2 = await db.rpc('apply_invoice_payment', {
      p_invoice_id: inv!.id, p_payment_id: p!.id, p_payment_amount: 5000, p_business_id: testBizId,
    });

    expect(r1.data?.success).toBe(true);
    expect(r2.data?.success).toBe(false);
    expect(r2.data?.reason).toBe('already_applied');

    const { data: result } = await db.from('invoices').select('amount_paid').eq('id', inv!.id).single();
    expect(Number(result!.amount_paid)).toBe(5000);
  });

  it('concurrent apply_invoice_payment → one increment', async () => {
    const { data: inv } = await db.from('invoices').insert({
      business_id: testBizId, customer_name: 'Conc RPC',
      total_amount: 10000, amount_paid: 0, status: 'sent',
    }).select('id').single();
    const { data: p } = await db.from('payments').insert({
      business_id: testBizId, amount: 5000, currency: 'NGN', invoice_id: inv!.id,
      gateway_reference: `conc-rpc-${Date.now()}`, gateway: 'paystack', status: 'success',
    }).select('id').single();

    const call = () => db.rpc('apply_invoice_payment', {
      p_invoice_id: inv!.id, p_payment_id: p!.id, p_payment_amount: 5000, p_business_id: testBizId,
    });
    const [r1, r2] = await Promise.all([call(), call()]);

    const successes = [r1.data, r2.data].filter(d => d?.success === true).length;
    expect(successes).toBe(1);

    const { data: result } = await db.from('invoices').select('amount_paid').eq('id', inv!.id).single();
    expect(Number(result!.amount_paid)).toBe(5000);
  });
});

describe('Payment idempotency DB status', () => {
  it(`tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => { expect(true).toBe(true); });
});
