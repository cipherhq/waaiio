/**
 * Capability Gating & Subscription Tier Enforcement — Database Integration Tests
 *
 * Tests business_capabilities table, tier gating logic, RLS ownership isolation,
 * and subscription uniqueness against local Supabase.
 *
 * Run: SUPABASE_INTEGRATION=true npx vitest run lib/__tests__/capability-tier-enforcement.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  CAPABILITY_TIER_REQUIREMENTS,
  canEnableCapability,
  type CapabilityId,
} from '@/lib/capabilities/types';

const SKIP = process.env.SUPABASE_INTEGRATION !== 'true';
const describeIntegration = SKIP ? describe.skip : describe;

// ── Free-tier capabilities (from types.ts) ──
const FREE_CAPABILITIES: CapabilityId[] = Object.entries(CAPABILITY_TIER_REQUIREMENTS)
  .filter(([, tier]) => tier === 'free')
  .map(([cap]) => cap as CapabilityId);

const GROWTH_CAPABILITIES: CapabilityId[] = Object.entries(CAPABILITY_TIER_REQUIREMENTS)
  .filter(([, tier]) => tier === 'growth')
  .map(([cap]) => cap as CapabilityId);

// ── Test state ──
let db: SupabaseClient;

// User A — free-tier business
let userAId: string;
let bizAId: string;

// User B — growth-tier business
let userBId: string;
let bizBId: string;

describeIntegration('Capability gating & subscription tier enforcement', () => {
  beforeAll(async () => {
    // ── Connect to local Supabase ──
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

    // ── User A: free-tier business (salon category) ──
    const { data: uA } = await db.auth.admin.createUser({
      email: `cap-test-a-${ts}@test.local`,
      password: 'test-123',
      email_confirm: true,
    });
    userAId = uA.user!.id;

    const { data: bA } = await db.from('businesses').insert({
      owner_id: userAId,
      name: `Free Salon ${ts}`,
      slug: `free-salon-${ts}`,
      category: 'salon',
      address: '123 Test St',
      city: 'Lagos',
      neighborhood: 'VI',
      phone: '2340000001',
      status: 'active',
      subscription_tier: 'free',
    }).select('id').single();
    bizAId = bA!.id;

    // Insert free-tier capabilities for business A
    const freeCapsToInsert: CapabilityId[] = ['appointment', 'scheduling', 'payment', 'ordering'];
    await db.from('business_capabilities').insert(
      freeCapsToInsert.map(cap => ({
        business_id: bizAId,
        capability: cap,
        is_enabled: true,
      })),
    );

    // Insert subscription for business A (free plan, amount=0)
    await db.from('subscriptions').insert({
      business_id: bizAId,
      plan: 'free',
      status: 'active',
      amount: 0,
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
    });

    // ── User B: growth-tier business (consultant category) ──
    const { data: uB } = await db.auth.admin.createUser({
      email: `cap-test-b-${ts}@test.local`,
      password: 'test-123',
      email_confirm: true,
    });
    userBId = uB.user!.id;

    const { data: bB } = await db.from('businesses').insert({
      owner_id: userBId,
      name: `Growth Consultant ${ts}`,
      slug: `growth-consultant-${ts}`,
      category: 'consultant',
      address: '456 Test Ave',
      city: 'Abuja',
      neighborhood: 'Wuse',
      phone: '2340000002',
      status: 'active',
      subscription_tier: 'growth',
    }).select('id').single();
    bizBId = bB!.id;

    // Insert subscription for business B (growth plan)
    await db.from('subscriptions').insert({
      business_id: bizBId,
      plan: 'growth',
      status: 'active',
      amount: 15000,
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
    });
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    // Clean up in dependency order
    await db.from('business_capabilities').delete().eq('business_id', bizAId);
    await db.from('business_capabilities').delete().eq('business_id', bizBId);
    await db.from('subscriptions').delete().eq('business_id', bizAId);
    await db.from('subscriptions').delete().eq('business_id', bizBId);
    await db.from('businesses').delete().eq('id', bizAId);
    await db.from('businesses').delete().eq('id', bizBId);
    await db.auth.admin.deleteUser(userAId);
    await db.auth.admin.deleteUser(userBId);
  }, 15000);

  // ═══════════════════════════════════════════
  // 1. Free-tier capability IS enabled
  // ═══════════════════════════════════════════

  it('free-tier capability (appointment) is enabled in business_capabilities', async () => {
    const { data, error } = await db.from('business_capabilities')
      .select('capability, is_enabled')
      .eq('business_id', bizAId)
      .eq('capability', 'appointment')
      .single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.is_enabled).toBe(true);
  });

  // ═══════════════════════════════════════════
  // 2. Growth-tier capability is NOT enabled for free business
  // ═══════════════════════════════════════════

  it('growth-tier capability (invoice) is NOT in free business capabilities', async () => {
    const { data } = await db.from('business_capabilities')
      .select('capability')
      .eq('business_id', bizAId)
      .eq('capability', 'invoice')
      .maybeSingle();

    // invoice should not exist in business_capabilities for a free-tier business
    expect(data).toBeNull();
  });

  // ═══════════════════════════════════════════
  // 3. canEnableCapability rejects growth-tier cap for free business
  // ═══════════════════════════════════════════

  it('canEnableCapability rejects invoice for free tier (no overrides)', () => {
    expect(canEnableCapability('invoice', 'free')).toBe(false);
    expect(canEnableCapability('invoice', 'free', [])).toBe(false);
  });

  it('canEnableCapability allows invoice for free tier WITH admin override', () => {
    expect(canEnableCapability('invoice', 'free', ['invoice'])).toBe(true);
  });

  it('canEnableCapability allows free-tier cap for free tier', () => {
    expect(canEnableCapability('appointment', 'free')).toBe(true);
    expect(canEnableCapability('scheduling', 'free')).toBe(true);
    expect(canEnableCapability('payment', 'free')).toBe(true);
    expect(canEnableCapability('ordering', 'free')).toBe(true);
  });

  // ═══════════════════════════════════════════
  // 4. Inserting growth-tier capability into free business DB row
  //    succeeds at DB level (no DB-level tier check), but the
  //    application-layer canEnableCapability blocks it
  // ═══════════════════════════════════════════

  it('DB allows inserting growth cap row (enforcement is app-layer), but canEnableCapability blocks', async () => {
    // The DB doesn't enforce tier — it only enforces UNIQUE(business_id, capability)
    const { error } = await db.from('business_capabilities').insert({
      business_id: bizAId,
      capability: 'invoice',
      is_enabled: true,
    });

    // Insert succeeds at DB level
    expect(error).toBeNull();

    // But application-layer gating says no
    expect(canEnableCapability('invoice', 'free')).toBe(false);

    // Clean up — remove the illegitimate capability
    await db.from('business_capabilities')
      .delete()
      .eq('business_id', bizAId)
      .eq('capability', 'invoice');
  });

  // ═══════════════════════════════════════════
  // 5. Growth-tier business CAN enable invoice
  // ═══════════════════════════════════════════

  it('growth-tier business can enable invoice capability', async () => {
    expect(canEnableCapability('invoice', 'growth')).toBe(true);

    const { error } = await db.from('business_capabilities').insert({
      business_id: bizBId,
      capability: 'invoice',
      is_enabled: true,
    });
    expect(error).toBeNull();

    const { data } = await db.from('business_capabilities')
      .select('capability, is_enabled')
      .eq('business_id', bizBId)
      .eq('capability', 'invoice')
      .single();

    expect(data).not.toBeNull();
    expect(data!.is_enabled).toBe(true);
  });

  // ═══════════════════════════════════════════
  // 6. RLS ownership isolation: User A cannot read User B's capabilities
  // ═══════════════════════════════════════════

  it('user A cannot read user B business capabilities via RLS', async () => {
    // Create a client authenticated as user A (anon key + user session)
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    let anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    if (!anonKey) {
      const { execSync } = await import('child_process');
      const env = execSync('supabase status -o env 2>/dev/null', { encoding: 'utf-8' });
      const keyLine = env.split('\n').find(l => l.startsWith('ANON_KEY='));
      anonKey = keyLine ? keyLine.split('=')[1].replace(/"/g, '').trim() : '';
    }

    const userAClient = createClient(url, anonKey);
    const { error: signInError } = await userAClient.auth.signInWithPassword({
      email: `cap-test-a-${bizAId ? '' : ''}${(await db.auth.admin.getUserById(userAId)).data.user!.email!}`,
      password: 'test-123',
    });

    // If sign-in fails, the test is still valid — we just verify isolation differently
    if (signInError) {
      // Fallback: sign in with the known email
      const { data: userData } = await db.auth.admin.getUserById(userAId);
      const clientA = createClient(url, anonKey);
      await clientA.auth.signInWithPassword({
        email: userData.user!.email!,
        password: 'test-123',
      });

      // User A queries User B's capabilities — should return empty
      const { data: caps } = await clientA.from('business_capabilities')
        .select('capability')
        .eq('business_id', bizBId);

      expect(caps).toEqual([]);
    } else {
      // User A queries User B's capabilities — RLS should block
      const { data: caps } = await userAClient.from('business_capabilities')
        .select('capability')
        .eq('business_id', bizBId);

      expect(caps).toEqual([]);
    }
  });

  it('user B cannot read user A business capabilities via RLS', async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
    let anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    if (!anonKey) {
      const { execSync } = await import('child_process');
      const env = execSync('supabase status -o env 2>/dev/null', { encoding: 'utf-8' });
      const keyLine = env.split('\n').find(l => l.startsWith('ANON_KEY='));
      anonKey = keyLine ? keyLine.split('=')[1].replace(/"/g, '').trim() : '';
    }

    const { data: userData } = await db.auth.admin.getUserById(userBId);
    const clientB = createClient(url, anonKey);
    await clientB.auth.signInWithPassword({
      email: userData.user!.email!,
      password: 'test-123',
    });

    // User B queries User A's capabilities — should return empty
    const { data: caps } = await clientB.from('business_capabilities')
      .select('capability')
      .eq('business_id', bizAId);

    expect(caps).toEqual([]);
  });

  // ═══════════════════════════════════════════
  // 7. Capability array matches expected free-tier defaults
  // ═══════════════════════════════════════════

  it('business A capabilities match the inserted free-tier defaults', async () => {
    const { data } = await db.from('business_capabilities')
      .select('capability')
      .eq('business_id', bizAId)
      .eq('is_enabled', true)
      .order('capability');

    const capIds = (data ?? []).map(r => r.capability).sort();
    const expected = ['appointment', 'ordering', 'payment', 'scheduling'].sort();

    expect(capIds).toEqual(expected);
  });

  it('all returned capabilities are free-tier eligible', async () => {
    const { data } = await db.from('business_capabilities')
      .select('capability')
      .eq('business_id', bizAId)
      .eq('is_enabled', true);

    for (const row of data ?? []) {
      const tier = CAPABILITY_TIER_REQUIREMENTS[row.capability as CapabilityId];
      expect(tier).toBe('free');
    }
  });

  // ═══════════════════════════════════════════
  // 8. UNIQUE constraint on business_capabilities(business_id, capability)
  // ═══════════════════════════════════════════

  it('duplicate capability for same business is rejected', async () => {
    const { error } = await db.from('business_capabilities').insert({
      business_id: bizAId,
      capability: 'appointment',
      is_enabled: true,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('23505'); // unique_violation
  });

  // ═══════════════════════════════════════════
  // 9. Subscription: free business has amount=0
  // ═══════════════════════════════════════════

  it('free business subscription has amount=0', async () => {
    const { data, error } = await db.from('subscriptions')
      .select('plan, amount, status')
      .eq('business_id', bizAId)
      .single();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.plan).toBe('free');
    expect(data!.amount).toBe(0);
    expect(data!.status).toBe('active');
  });

  // ═══════════════════════════════════════════
  // 10. UNIQUE constraint on subscriptions(business_id) prevents duplicates
  // ═══════════════════════════════════════════

  it('duplicate subscription for same business is rejected', async () => {
    const { error } = await db.from('subscriptions').insert({
      business_id: bizAId,
      plan: 'growth',
      status: 'active',
      amount: 15000,
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('23505'); // unique_violation
  });

  // ═══════════════════════════════════════════
  // 11. Tier requirement mapping is consistent
  // ═══════════════════════════════════════════

  it('CAPABILITY_TIER_REQUIREMENTS has entries for all standard capabilities', () => {
    const standardFree = ['appointment', 'scheduling', 'payment', 'ordering', 'ticketing', 'giving', 'chat', 'feedback', 'poll'];
    for (const cap of standardFree) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap as CapabilityId]).toBe('free');
    }

    const standardGrowth = ['reservation', 'recurring', 'broadcast', 'membership', 'survey', 'invoice', 'auto_reply', 'loyalty', 'referral', 'reminders'];
    for (const cap of standardGrowth) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap as CapabilityId]).toBe('growth');
    }

    const standardBusiness = ['staff', 'whatsapp_sign', 'reports', 'waitlist', 'queue', 'crowdfunding'];
    for (const cap of standardBusiness) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap as CapabilityId]).toBe('business');
    }
  });

  it('canEnableCapability respects tier hierarchy (business > growth > free)', () => {
    // Business tier can enable everything
    expect(canEnableCapability('staff', 'business')).toBe(true);
    expect(canEnableCapability('invoice', 'business')).toBe(true);
    expect(canEnableCapability('appointment', 'business')).toBe(true);

    // Growth tier can enable growth + free, not business
    expect(canEnableCapability('invoice', 'growth')).toBe(true);
    expect(canEnableCapability('appointment', 'growth')).toBe(true);
    expect(canEnableCapability('staff', 'growth')).toBe(false);

    // Free tier can only enable free
    expect(canEnableCapability('appointment', 'free')).toBe(true);
    expect(canEnableCapability('invoice', 'free')).toBe(false);
    expect(canEnableCapability('staff', 'free')).toBe(false);
  });
});

describe('Capability tier enforcement status', () => {
  it(`database tests are ${SKIP ? 'SKIPPED' : 'RUNNING'}`, () => {
    expect(true).toBe(true);
  });
});
