/**
 * Directory/Marketplace Search — Real Database Integration Test
 *
 * Proves:
 * 1. Active + discovery_enabled business appears in results
 * 2. Discovery-disabled business does NOT appear
 * 3. Non-active (status!='active') business does NOT appear
 * 4. Results are non-empty when matching business exists
 * 5. Phone numbers and private routing values are NOT exposed
 *
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/directory-search-integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

let db: SupabaseClient;
let testUserId: string;
let activeBizId: string;
let disabledBizId: string;
let pendingBizId: string;

describeIntegration('Directory search — real database', () => {
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
      email: `dir-test-${ts}@test.local`, password: 'test-123', email_confirm: true,
    });
    testUserId = user.user!.id;

    // 1. Active + discovery_enabled business (should appear)
    const { data: b1 } = await db.from('businesses').insert({
      owner_id: testUserId, name: `Dir Active ${ts}`, slug: `dir-active-${ts}`,
      address: '123 Main St', city: 'Lagos', neighborhood: 'VI', phone: '+2341234567890',
      status: 'active', discovery_enabled: true, category: 'restaurant',
      country_code: 'NG',
    }).select('id').single();
    activeBizId = b1!.id;

    // 2. Active but discovery_enabled=false (should NOT appear)
    const { data: b2 } = await db.from('businesses').insert({
      owner_id: testUserId, name: `Dir Hidden ${ts}`, slug: `dir-hidden-${ts}`,
      address: '456 Side St', city: 'Lagos', neighborhood: 'VI', phone: '+2349876543210',
      status: 'active', discovery_enabled: false, category: 'restaurant',
      country_code: 'NG',
    }).select('id').single();
    disabledBizId = b2!.id;

    // 3. Non-active (status='pending') with discovery_enabled=true (should NOT appear)
    const { data: b3 } = await db.from('businesses').insert({
      owner_id: testUserId, name: `Dir Pending ${ts}`, slug: `dir-pending-${ts}`,
      address: '789 Back St', city: 'Lagos', neighborhood: 'VI', phone: '+2340000000000',
      status: 'pending', discovery_enabled: true, category: 'restaurant',
      country_code: 'NG',
    }).select('id').single();
    pendingBizId = b3!.id;
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    await db.from('businesses').delete().eq('id', activeBizId);
    await db.from('businesses').delete().eq('id', disabledBizId);
    await db.from('businesses').delete().eq('id', pendingBizId);
    await db.auth.admin.deleteUser(testUserId);
  }, 15000);

  it('marketplace search returns active + discovery_enabled businesses', async () => {
    // Import the actual search function
    const { searchMarketplace } = await import('@/lib/marketplace/search');
    const results = await searchMarketplace(db, { country: 'NG', category: 'restaurant' });

    // Active + discoverable business appears
    const found = results.find(r => r.businessId === activeBizId);
    expect(found).toBeDefined();
    expect(found!.name).toContain('Dir Active');
  });

  it('discovery-disabled business does NOT appear', async () => {
    const { searchMarketplace } = await import('@/lib/marketplace/search');
    const results = await searchMarketplace(db, { country: 'NG', category: 'restaurant' });

    const hidden = results.find(r => r.businessId === disabledBizId);
    expect(hidden).toBeUndefined();
  });

  it('non-active (pending) business does NOT appear', async () => {
    const { searchMarketplace } = await import('@/lib/marketplace/search');
    const results = await searchMarketplace(db, { country: 'NG', category: 'restaurant' });

    const pending = results.find(r => r.businessId === pendingBizId);
    expect(pending).toBeUndefined();
  });

  it('results are non-empty when matching data exists', async () => {
    const { searchMarketplace } = await import('@/lib/marketplace/search');
    const results = await searchMarketplace(db, { country: 'NG', category: 'restaurant' });

    expect(results.length).toBeGreaterThan(0);
  });

  it('phone numbers and private routing values are NOT exposed in results', async () => {
    const { searchMarketplace } = await import('@/lib/marketplace/search');
    const results = await searchMarketplace(db, { country: 'NG', category: 'restaurant' });

    const found = results.find(r => r.businessId === activeBizId);
    expect(found).toBeDefined();

    // Verify phone number is NOT in public search results
    expect(found!.phone).toBeUndefined();

    // Verify no private credentials/tokens leak
    const resultStr = JSON.stringify(found);
    expect(resultStr).not.toContain('meta_access_token');
    expect(resultStr).not.toContain('service_role');

    // bot_code IS intentionally public (shown on business pages, QR codes)
    // It is a customer-facing identifier, not a routing secret
  });
});

describe('Directory search status', () => {
  it(`tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => { expect(true).toBe(true); });
});
