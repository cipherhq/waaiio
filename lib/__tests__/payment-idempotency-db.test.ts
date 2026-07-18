/**
 * Payment Idempotency — Database Integration Tests
 *
 * Requires local Supabase. Tests actual constraint enforcement.
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/payment-idempotency-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testBizId: string;
let testUserId: string;

describeIntegration('Payment idempotency — database constraints', () => {
  beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!key) {
      const { execSync } = await import('child_process');
      try {
        const env = execSync('supabase status -o env 2>/dev/null', { encoding: 'utf-8' });
        const keyLine = env.split('\n').find(l => l.startsWith('SERVICE_ROLE_KEY='));
        if (keyLine) {
          db = createClient(url, keyLine.split('=')[1].trim());
        }
      } catch { /* */ }
    } else {
      db = createClient(url, key);
    }
    if (!db) throw new Error('Cannot connect to Supabase');

    // Create test fixtures
    const ts = Date.now();
    const { data: user } = await db.auth.admin.createUser({
      email: `idempotency-test-${ts}@test.local`,
      password: 'test-password-123',
      email_confirm: true,
    });
    testUserId = user.user!.id;

    const { data: biz } = await db.from('businesses').insert({
      owner_id: testUserId, name: `Idem Test ${ts}`, slug: `idem-test-${ts}`,
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

  // ── Platform fee: UNIQUE on payment_id ──

  it('duplicate platform fee for same payment_id is rejected', async () => {
    // Create a payment
    const { data: payment } = await db.from('payments').insert({
      business_id: testBizId, amount: 5000, currency: 'NGN',
      gateway_reference: `dup-test-${Date.now()}`, gateway: 'paystack', status: 'success',
    }).select('id').single();

    // First fee insert succeeds
    const { error: err1 } = await db.from('platform_fees').insert({
      business_id: testBizId, payment_id: payment!.id,
      transaction_amount: 5000, fee_total: 125, fee_percentage: 2.5, fee_flat: 0,
    });
    expect(err1).toBeNull();

    // Second fee insert for SAME payment_id fails (unique violation)
    const { error: err2 } = await db.from('platform_fees').insert({
      business_id: testBizId, payment_id: payment!.id,
      transaction_amount: 5000, fee_total: 125, fee_percentage: 2.5, fee_flat: 0,
    });
    expect(err2).not.toBeNull();
    expect(err2!.code).toBe('23505'); // unique_violation
  });

  it('fee for same payment_id after refund IS allowed (refunded_at set)', async () => {
    // Create payment + fee
    const { data: payment } = await db.from('payments').insert({
      business_id: testBizId, amount: 3000, currency: 'NGN',
      gateway_reference: `refund-test-${Date.now()}`, gateway: 'paystack', status: 'success',
    }).select('id').single();

    const { data: fee } = await db.from('platform_fees').insert({
      business_id: testBizId, payment_id: payment!.id,
      transaction_amount: 3000, fee_total: 75, fee_percentage: 2.5, fee_flat: 0,
    }).select('id').single();

    // Mark fee as refunded
    await db.from('platform_fees').update({
      refunded_at: new Date().toISOString(),
    }).eq('id', fee!.id);

    // Now a new fee for the same payment_id should succeed
    // (unique constraint excludes refunded_at IS NOT NULL rows)
    const { error } = await db.from('platform_fees').insert({
      business_id: testBizId, payment_id: payment!.id,
      transaction_amount: 3000, fee_total: 75, fee_percentage: 2.5, fee_flat: 0,
    });
    expect(error).toBeNull();
  });

  // ── Concurrent fee inserts ──

  it('concurrent fee inserts for same payment — only one succeeds', async () => {
    const { data: payment } = await db.from('payments').insert({
      business_id: testBizId, amount: 7000, currency: 'NGN',
      gateway_reference: `concurrent-test-${Date.now()}`, gateway: 'paystack', status: 'success',
    }).select('id').single();

    // Fire two inserts concurrently
    const insert = () => db.from('platform_fees').insert({
      business_id: testBizId, payment_id: payment!.id,
      transaction_amount: 7000, fee_total: 175, fee_percentage: 2.5, fee_flat: 0,
    });

    const [result1, result2] = await Promise.all([insert(), insert()]);

    // Exactly one should succeed, one should fail
    const successes = [result1.error, result2.error].filter(e => e === null).length;
    const failures = [result1.error, result2.error].filter(e => e !== null).length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);
  });

  // ── Invoice partial payment: unique constraint ──

  it('invoice unique constraint blocks second fee for same invoice', async () => {
    // Create invoice
    const { data: invoice } = await db.from('invoices').insert({
      business_id: testBizId, customer_name: 'Test', total_amount: 10000, status: 'sent',
    }).select('id').single();

    // Create two payments
    const { data: pay1 } = await db.from('payments').insert({
      business_id: testBizId, amount: 5000, currency: 'NGN',
      gateway_reference: `inv-pay1-${Date.now()}`, gateway: 'paystack', status: 'success',
      invoice_id: invoice!.id,
    }).select('id').single();

    const { data: pay2 } = await db.from('payments').insert({
      business_id: testBizId, amount: 5000, currency: 'NGN',
      gateway_reference: `inv-pay2-${Date.now()}`, gateway: 'paystack', status: 'success',
      invoice_id: invoice!.id,
    }).select('id').single();

    // First fee succeeds
    const { error: err1 } = await db.from('platform_fees').insert({
      business_id: testBizId, invoice_id: invoice!.id, payment_id: pay1!.id,
      transaction_amount: 5000, fee_total: 125, fee_percentage: 2.5, fee_flat: 0,
    });
    expect(err1).toBeNull();

    // Second fee for SAME invoice (different payment) — blocked by invoice_unique
    const { error: err2 } = await db.from('platform_fees').insert({
      business_id: testBizId, invoice_id: invoice!.id, payment_id: pay2!.id,
      transaction_amount: 5000, fee_total: 125, fee_percentage: 2.5, fee_flat: 0,
    });
    // This WILL fail because idx_platform_fees_invoice_unique is UNIQUE(invoice_id)
    // This is a known constraint: only one fee per invoice (not per payment).
    // For partial payments, the fee should use payment_id uniqueness, not invoice_id.
    expect(err2).not.toBeNull();
  });
});

describe('Payment idempotency status', () => {
  it(`database tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => {
    expect(true).toBe(true);
  });
});
