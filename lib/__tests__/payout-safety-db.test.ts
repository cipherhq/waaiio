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

  // ── Concurrent approval: compare-and-set ──

  it('concurrent approvals — only one claim succeeds', async () => {
    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-04-01', period_end: '2026-04-07',
      gross_amount: 6000, platform_fee: 150, net_amount: 5850, status: 'pending',
    }).select('id').single();

    // Simulate two concurrent claim attempts via compare-and-set
    const claim = () => db.from('business_payouts')
      .update({
        status: 'processing',
        approved_by: testUserId,
        approved_at: new Date().toISOString(),
        transfer_method: 'manual_bank',
        updated_at: new Date().toISOString(),
      })
      .eq('id', payout!.id)
      .in('status', ['pending', 'held'])
      .select('id')
      .maybeSingle();

    const [r1, r2] = await Promise.all([claim(), claim()]);
    const claimed = [r1.data, r2.data].filter(d => d !== null).length;
    expect(claimed).toBe(1);
  });

  // ── review_required persists and blocks re-approval ──

  it('review_required status persists and blocks re-approval', async () => {
    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-05-01', period_end: '2026-05-07',
      gross_amount: 4000, platform_fee: 100, net_amount: 3900, status: 'review_required',
      notes: 'UNCERTAIN: Provider error — check provider before retrying',
    }).select('id').single();

    // Attempt to claim a review_required payout — should fail
    const { data: claimed } = await db.from('business_payouts')
      .update({ status: 'processing' })
      .eq('id', payout!.id)
      .in('status', ['pending', 'held'])
      .select('id')
      .maybeSingle();

    expect(claimed).toBeNull();

    // Verify the payout is still review_required
    const { data: check } = await db.from('business_payouts')
      .select('status, notes')
      .eq('id', payout!.id)
      .single();
    expect(check!.status).toBe('review_required');
    expect(check!.notes).toContain('UNCERTAIN');
  });

  // ── Audit failure: claim is reverted ──

  it('claim revert restores original status', async () => {
    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-06-01', period_end: '2026-06-07',
      gross_amount: 7000, platform_fee: 175, net_amount: 6825, status: 'pending',
    }).select('id').single();

    // Simulate: claim succeeds
    await db.from('business_payouts')
      .update({ status: 'processing', approved_by: testUserId, approved_at: new Date().toISOString() })
      .eq('id', payout!.id)
      .in('status', ['pending', 'held']);

    // Simulate: audit fails → revert
    await db.from('business_payouts')
      .update({ status: 'pending', approved_by: null, approved_at: null, transfer_reference: null, paid_at: null })
      .eq('id', payout!.id);

    const { data: reverted } = await db.from('business_payouts')
      .select('status, approved_by')
      .eq('id', payout!.id)
      .single();
    expect(reverted!.status).toBe('pending');
    expect(reverted!.approved_by).toBeNull();
  });

  // ── Paid payout is immutable via compare-and-set ──

  it('paid payout cannot be re-claimed', async () => {
    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-07-01', period_end: '2026-07-07',
      gross_amount: 9000, platform_fee: 225, net_amount: 8775, status: 'paid',
      paid_at: new Date().toISOString(),
      gateway_transfer_code: 'TRF_abc123',
    }).select('id').single();

    const { data: claimed } = await db.from('business_payouts')
      .update({ status: 'processing' })
      .eq('id', payout!.id)
      .in('status', ['pending', 'held'])
      .select('id')
      .maybeSingle();

    expect(claimed).toBeNull();
  });

  // ── Rejected/failed payout allows new period entry ──

  // ── Destination snapshot ──

  it('destination snapshot columns can be stored', async () => {
    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-09-01', period_end: '2026-09-07',
      gross_amount: 5000, platform_fee: 125, net_amount: 4875, status: 'pending',
    }).select('id').single();

    await db.from('business_payouts').update({
      status: 'approved',
      destination_bank_name: 'GTBank',
      destination_account_number_masked: '****6789',
      destination_bank_code: '058',
      destination_account_name: 'Test Business',
    }).eq('id', payout!.id);

    const { data: check } = await db.from('business_payouts')
      .select('destination_bank_name, destination_account_number_masked, destination_bank_code, destination_account_name')
      .eq('id', payout!.id).single();
    expect(check!.destination_bank_name).toBe('GTBank');
    expect(check!.destination_account_number_masked).toBe('****6789');
    expect(check!.destination_bank_code).toBe('058');
    expect(check!.destination_account_name).toBe('Test Business');
  });

  // ── Account deactivation auto-holds pending payouts ──

  it('deactivating payout account auto-holds pending payouts', async () => {
    // Deactivate the main account first (unique index: one active per business)
    await db.from('payout_accounts').update({ is_active: false }).eq('id', testAccountId);

    // Create and activate a second account
    const { data: acct2 } = await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'stripe', bank_name: 'Trigger Test',
      account_name: 'Trigger', account_number: '5555555555', bank_code: '999',
      is_active: true, verified_at: new Date().toISOString(),
    }).select('id').single();

    // Create a pending payout referencing this account
    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: acct2!.id,
      period_start: '2026-10-01', period_end: '2026-10-07',
      gross_amount: 4000, platform_fee: 100, net_amount: 3900, status: 'pending',
    }).select('id').single();

    // Deactivate the account → trigger fires, auto-holds pending payouts
    await db.from('payout_accounts').update({ is_active: false }).eq('id', acct2!.id);

    // Verify the pending payout was auto-held
    const { data: check } = await db.from('business_payouts')
      .select('status, notes')
      .eq('id', payout!.id).single();
    expect(check!.status).toBe('held');
    expect(check!.notes).toContain('AUTO-HELD');

    // Cleanup: restore original account, delete test account
    await db.from('payout_accounts').delete().eq('id', acct2!.id);
    await db.from('payout_accounts').update({ is_active: true }).eq('id', testAccountId);
  });

  // ── Manual payout two-step: completion ──

  it('cannot complete a pending payout (must be approved first)', async () => {
    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-11-01', period_end: '2026-11-07',
      gross_amount: 3000, platform_fee: 75, net_amount: 2925, status: 'pending',
    }).select('id').single();

    // Try to complete a pending payout (compare-and-set should fail)
    const { data: claimed } = await db.from('business_payouts')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', payout!.id)
      .in('status', ['approved'])
      .select('id')
      .maybeSingle();

    expect(claimed).toBeNull();

    const { data: check } = await db.from('business_payouts').select('status').eq('id', payout!.id).single();
    expect(check!.status).toBe('pending');
  });

  it('completing an already-paid payout returns no match', async () => {
    const { data: payout } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-12-01', period_end: '2026-12-07',
      gross_amount: 2000, platform_fee: 50, net_amount: 1950, status: 'paid',
      paid_at: new Date().toISOString(),
    }).select('id').single();

    const { data: claimed } = await db.from('business_payouts')
      .update({ status: 'paid', paid_at: new Date().toISOString(), transfer_reference: 'REF-123' })
      .eq('id', payout!.id)
      .in('status', ['approved'])
      .select('id')
      .maybeSingle();

    expect(claimed).toBeNull();
  });

  // ── Rejected/failed payout allows new period entry ──

  it('rejected payout allows new payout for same period', async () => {
    // Insert a rejected payout
    await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-08-01', period_end: '2026-08-07',
      gross_amount: 3000, platform_fee: 75, net_amount: 2925, status: 'rejected',
    });

    // A new payout for the same period should succeed (unique index excludes rejected/failed)
    const { error } = await db.from('business_payouts').insert({
      business_id: testBizId, payout_account_id: testAccountId,
      period_start: '2026-08-01', period_end: '2026-08-07',
      gross_amount: 3000, platform_fee: 75, net_amount: 2925, status: 'pending',
    });
    expect(error).toBeNull();
  });
});

describe('Payout safety status', () => {
  it(`database tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => {
    expect(true).toBe(true);
  });
});
