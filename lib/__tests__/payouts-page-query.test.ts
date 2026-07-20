/**
 * Payouts page payout-account query regression tests.
 *
 * Tests the query pattern used by the payouts dashboard to select
 * the active default connection when multiple providers exist.
 *
 * Integration tests require: SUPABASE_INTEGRATION=true
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testUserId: string;
let testBizId: string;

/** Run the same query the payouts page uses */
async function queryPayoutAccount(supabase: SupabaseClient, businessId: string) {
  return supabase
    .from('payout_accounts')
    .select('id, gateway, subaccount_code, stripe_account_id, bank_name, account_number, account_name, verified_at, is_default')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
}

describeIntegration('Payouts page: payout account query', () => {
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
      email: `payout-q-${ts}@test.local`, password: 'test-123', email_confirm: true,
    });
    testUserId = user.user!.id;

    const { data: biz } = await db.from('businesses').insert({
      owner_id: testUserId, name: `PayoutQ ${ts}`, slug: `payout-q-${ts}`,
      address: '1', city: 'L', neighborhood: 'V', phone: '1',
      status: 'active', country_code: 'US',
    }).select('id').single();
    testBizId = biz!.id;
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    await db.from('payout_accounts').delete().eq('business_id', testBizId);
    await db.from('businesses').delete().eq('id', testBizId);
    await db.auth.admin.deleteUser(testUserId);
  }, 15000);

  it('returns null when zero active rows exist', async () => {
    const { data, error } = await queryPayoutAccount(db, testBizId);
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('returns the single active row when only one exists', async () => {
    await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'stripe', connection_mode: 'connect',
      connection_status: 'active', is_active: true, is_default: true,
      stripe_account_id: 'acct_single', verified_at: new Date().toISOString(),
      health_status: 'healthy',
    });

    const { data, error } = await queryPayoutAccount(db, testBizId);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.gateway).toBe('stripe');
    expect(data!.is_default).toBe(true);

    await db.from('payout_accounts').delete().eq('business_id', testBizId);
  });

  it('returns the default when multiple active rows exist', async () => {
    // Insert non-default first (earlier created_at)
    await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'square', connection_mode: 'connect',
      connection_status: 'active', is_active: true, is_default: false,
      verified_at: new Date().toISOString(), health_status: 'healthy',
      bank_name: 'Square Test',
    });

    // Insert default second (later created_at)
    await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'stripe', connection_mode: 'connect',
      connection_status: 'active', is_active: true, is_default: true,
      stripe_account_id: 'acct_default', verified_at: new Date().toISOString(),
      health_status: 'healthy',
    });

    const { data, error } = await queryPayoutAccount(db, testBizId);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.gateway).toBe('stripe');
    expect(data!.is_default).toBe(true);
    expect(data!.stripe_account_id).toBe('acct_default');

    await db.from('payout_accounts').delete().eq('business_id', testBizId);
  });

  it('selects default regardless of insertion order', async () => {
    // Insert default FIRST (earlier created_at)
    await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'paystack', connection_mode: 'managed',
      connection_status: 'active', is_active: true, is_default: true,
      subaccount_code: 'ACCT_default_first', verified_at: new Date().toISOString(),
      health_status: 'healthy', bank_name: 'Default', account_name: 'T',
      account_number: '000', bank_code: '058',
    });

    // Insert non-default SECOND (later created_at — would sort first by created_at desc)
    await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'stripe', connection_mode: 'connect',
      connection_status: 'active', is_active: true, is_default: false,
      stripe_account_id: 'acct_nondfl', verified_at: new Date().toISOString(),
      health_status: 'healthy',
    });

    const { data, error } = await queryPayoutAccount(db, testBizId);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    // Paystack is default despite being created first
    expect(data!.gateway).toBe('paystack');
    expect(data!.is_default).toBe(true);

    await db.from('payout_accounts').delete().eq('business_id', testBizId);
  });

  it('excludes revoked rows even if they were default', async () => {
    // Revoked row that was once default
    await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'stripe', connection_mode: 'connect',
      connection_status: 'revoked', is_active: false, is_default: false,
      stripe_account_id: 'acct_revoked', verified_at: new Date().toISOString(),
      health_status: 'healthy',
    });

    // Active non-default row
    await db.from('payout_accounts').insert({
      business_id: testBizId, gateway: 'square', connection_mode: 'connect',
      connection_status: 'active', is_active: true, is_default: false,
      verified_at: new Date().toISOString(), health_status: 'healthy',
      bank_name: 'Active Square',
    });

    const { data, error } = await queryPayoutAccount(db, testBizId);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.gateway).toBe('square');
    // Revoked row must not appear
    expect(data!.stripe_account_id).not.toBe('acct_revoked');

    await db.from('payout_accounts').delete().eq('business_id', testBizId);
  });

  it('query error is surfaced, not silently null', async () => {
    // Query a nonexistent table column to force an error
    const { data, error } = await db
      .from('payout_accounts')
      .select('nonexistent_column')
      .eq('business_id', testBizId)
      .limit(1)
      .maybeSingle();

    // Supabase returns error for invalid column
    expect(error).not.toBeNull();
  });
});

describe('Payouts page query status', () => {
  it(`integration tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => {
    expect(true).toBe(true);
  });
});
