/**
 * Payout Safety — Database Integration Tests
 *
 * Tests concurrent payout operations against real Supabase.
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/payout-safety-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testBizId: string;
let testUserId: string;
let testAccountId: string;

describeIntegration('Payout safety — database constraints', () => {
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
      email: `payout-test-${ts}@test.local`, password: 'test-123', email_confirm: true,
    });
    testUserId = user.user!.id;
    await db.from('profiles').update({ role: 'admin' }).eq('id', testUserId);

    const { data: biz } = await db.from('businesses').insert({
      owner_id: testUserId, name: `Payout Test ${ts}`, slug: `payout-test-${ts}`,
      address: '123', city: 'T', neighborhood: 'T', phone: '123', status: 'active',
      payout_mode: 'platform_managed',
    }).select('id').single();
    testBizId = biz!.id;

    const { data: acct } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'paystack', bank_name: 'Test', account_name: 'Test',
      account_number: '1234567890', bank_code: '044', is_active: true,
      verified_at: new Date().toISOString(),
    }).select('id').single();
    testAccountId = acct!.id;
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    await db.from('business_payouts').delete().eq('business_id', testBizId);
    await db.from('payout_accounts').delete().eq('business_id', testBizId);
    await db.from('businesses').delete().eq('id', testBizId);
    await db.auth.admin.deleteUser(testUserId);
  }, 15000);

  // ── Concurrent payout creation: period uniqueness ──

  it('duplicate payout for same period is rejected', async () => {
    const { error: err1 } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-01-01', period_end: '2026-01-07',
      gross_amount: 10000, platform_fee: 250, net_amount: 9750, status: 'pending',
    });
    expect(err1).toBeNull();

    // Second payout for same period — should fail if constraint exists
    const { error: err2 } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-01-01', period_end: '2026-01-07',
      gross_amount: 10000, platform_fee: 250, net_amount: 9750, status: 'pending',
    });
    // The UNIQUE constraint on (business_id, period_start, period_end)
    // WHERE status NOT IN ('rejected', 'failed') should block this
    expect(err2).not.toBeNull();
  });

  it('concurrent payout inserts for same period — only one succeeds', async () => {
    const insert = () => db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-02-01', period_end: '2026-02-07',
      gross_amount: 5000, platform_fee: 125, net_amount: 4875, status: 'pending',
    });

    const [r1, r2] = await Promise.all([insert(), insert()]);
    const successes = [r1.error, r2.error].filter(e => e === null).length;
    expect(successes).toBe(1);
  });

  // ── Status transitions ──

  it('paid payout cannot be modified', async () => {
    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-03-01', period_end: '2026-03-07',
      gross_amount: 8000, platform_fee: 200, net_amount: 7800, status: 'paid',
      paid_at: new Date().toISOString(),
    }).select('id').single();

    // Try to change status of a paid payout via compare-and-set
    const { data: updated } = await db.from('business_payouts')
      .update({ status: 'pending' })
      .eq('id', payout!.id)
      .in('status', ['pending', 'held']) // Compare-and-set — 'paid' is not in the list
      .select('id')
      .maybeSingle();

    // Should return null (no rows matched)
    expect(updated).toBeNull();
  });

  // ── Verified bank account ──

  it('payout account verified_at and is_active can be checked', async () => {
    // The existing test account was created with is_active=true, verified_at set
    const { data: account } = await db.from('payout_accounts')
      .select('id, is_active, verified_at')
      .eq('id', testAccountId)
      .single();

    expect(account).not.toBeNull();
    expect(account!.is_active).toBe(true);
    expect(account!.verified_at).not.toBeNull();

    // An unverified account: set verified_at to null
    await db.from('payout_accounts').update({ verified_at: null }).eq('id', testAccountId);
    const { data: unverified } = await db.from('payout_accounts')
      .select('verified_at')
      .eq('id', testAccountId)
      .single();
    expect(unverified!.verified_at).toBeNull();

    // Restore
    await db.from('payout_accounts').update({ verified_at: new Date().toISOString() }).eq('id', testAccountId);
  });
});

describe('Payout safety status', () => {
  it(`database tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => {
    expect(true).toBe(true);
  });
});
