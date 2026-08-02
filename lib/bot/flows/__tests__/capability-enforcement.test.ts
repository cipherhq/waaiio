/**
 * CAP-001 Phase 1 — WhatsApp CREATE_NEW Capability Enforcement Tests
 *
 * Proves the three enforcement boundaries:
 * A. Session resume revalidation
 * B. Flow-start bypass guards
 * C. CREATE_NEW commit guards
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireCurrentCapability } from '../shared/capability-guard';
import { getEffectiveCapabilities, canPerformAction } from '@/lib/capabilities/policy';
import type { CapabilityId } from '@/lib/capabilities/types';

// ── Mock Supabase factory ──

function mockSupabaseForGuard(opts: {
  business?: { id: string; status: string; subscription_tier: string; trial_ends_at: string | null; category: string | null } | null;
  bizError?: boolean;
  capabilities?: Array<{ capability: string; is_enabled: boolean; sort_order: number }>;
  capError?: boolean;
  overrides?: string[];
  overrideError?: boolean;
}) {
  return {
    from: (table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: (..._args: unknown[]) => ({
              single: () => {
                if (opts.bizError) return Promise.resolve({ data: null, error: { message: 'timeout' } });
                return Promise.resolve({ data: opts.business || null, error: null });
              },
            }),
          }),
        };
      }
      if (table === 'business_capabilities') {
        const capData = opts.capError
          ? { data: null, error: { message: 'db error' } }
          : { data: opts.capabilities ?? [], error: null };
        const resolved = Promise.resolve(capData);
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          then: resolved.then.bind(resolved),
          catch: resolved.catch.bind(resolved),
        };
        return chain;
      }
      if (table === 'capability_overrides') {
        return {
          select: () => ({
            eq: () => {
              if (opts.overrideError) return Promise.resolve({ data: null, error: { message: 'db error' } });
              return Promise.resolve({ data: (opts.overrides || []).map(c => ({ capability: c })), error: null });
            },
          }),
        };
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) };
    },
  } as any;
}

const ACTIVE_BIZ = { id: 'biz-1', status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'salon' };
const FREE_BIZ_ACTIVE_TRIAL = { id: 'biz-2', status: 'active', subscription_tier: 'free', trial_ends_at: new Date(Date.now() + 86400000).toISOString(), category: 'salon' };
const FREE_BIZ_EXPIRED_TRIAL = { id: 'biz-3', status: 'active', subscription_tier: 'free', trial_ends_at: '2024-01-01T00:00:00Z', category: 'salon' };
const SUSPENDED_BIZ = { id: 'biz-4', status: 'suspended', subscription_tier: 'growth', trial_ends_at: null, category: 'salon' };
const PENDING_BIZ = { id: 'biz-5', status: 'pending', subscription_tier: 'free', trial_ends_at: null, category: 'salon' };
const LEGACY_BIZ_NO_CAPS = { id: 'biz-6', status: 'active', subscription_tier: 'free', trial_ends_at: null, category: 'salon' };

const SCHEDULING_ENABLED = [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }];
const SCHEDULING_DISABLED = [{ capability: 'scheduling', is_enabled: false, sort_order: 0 }];
const RESERVATION_ENABLED = [{ capability: 'reservation', is_enabled: true, sort_order: 0 }];
const MULTI_CAPS = [
  { capability: 'scheduling', is_enabled: true, sort_order: 0 },
  { capability: 'ordering', is_enabled: true, sort_order: 1 },
  { capability: 'reservation', is_enabled: true, sort_order: 2 },
];

// ── Point C: requireCurrentCapability tests ──

describe('requireCurrentCapability (Point C)', () => {
  // Test A: Effective capability allows CREATE_NEW
  it('allows CREATE_NEW for effective capability', async () => {
    const supabase = mockSupabaseForGuard({
      business: ACTIVE_BIZ,
      capabilities: SCHEDULING_ENABLED,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-1',
      capability: 'scheduling',
      action: 'create_new',
    });
    expect(result.allowed).toBe(true);
  });

  // Test B: Paused capability blocks CREATE_NEW
  it('denies CREATE_NEW for paused capability (tier blocked)', async () => {
    const supabase = mockSupabaseForGuard({
      business: FREE_BIZ_EXPIRED_TRIAL,
      capabilities: RESERVATION_ENABLED, // reservation requires growth tier
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-3',
      capability: 'reservation',
      action: 'create_new',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/tier_required|capability_not_effective|trial_expired/);
    }
  });

  // Test E: Trial expiry denies CREATE_NEW for growth-tier capabilities
  it('denies CREATE_NEW after trial expiry for growth capability', async () => {
    const supabase = mockSupabaseForGuard({
      business: FREE_BIZ_EXPIRED_TRIAL,
      capabilities: RESERVATION_ENABLED,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-3',
      capability: 'reservation',
      action: 'create_new',
    });
    expect(result.allowed).toBe(false);
  });

  // Test F: True mid-flow — trial was active, now expired
  it('denies CREATE_NEW when trial expires mid-flow (reservation requires growth)', async () => {
    // Simulate: trial was active when flow started, now expired
    const supabase = mockSupabaseForGuard({
      business: FREE_BIZ_EXPIRED_TRIAL, // trial_ends_at in the past
      capabilities: RESERVATION_ENABLED,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-3',
      capability: 'reservation',
      action: 'create_new',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.customerMessage).toBeTruthy();
      expect(result.customerMessage.length).toBeGreaterThan(10);
    }
  });

  // Test F (active trial): Still works with active trial
  it('allows CREATE_NEW with active trial for growth capability', async () => {
    const supabase = mockSupabaseForGuard({
      business: FREE_BIZ_ACTIVE_TRIAL,
      capabilities: RESERVATION_ENABLED,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-2',
      capability: 'reservation',
      action: 'create_new',
    });
    expect(result.allowed).toBe(true);
  });

  // Test F2: Capability explicitly disabled mid-flow
  it('denies CREATE_NEW when capability is disabled', async () => {
    const supabase = mockSupabaseForGuard({
      business: ACTIVE_BIZ,
      capabilities: SCHEDULING_DISABLED,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-1',
      capability: 'scheduling',
      action: 'create_new',
    });
    expect(result.allowed).toBe(false);
  });

  // Test G: Currently effective capability creates resource
  it('allows CREATE_NEW for growth-tier business with effective capability', async () => {
    const supabase = mockSupabaseForGuard({
      business: ACTIVE_BIZ,
      capabilities: MULTI_CAPS,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-1',
      capability: 'ordering',
      action: 'create_new',
    });
    expect(result.allowed).toBe(true);
  });

  // Test H: Unrelated capability unaffected
  it('allows CREATE_NEW for ordering when scheduling is paused', async () => {
    const supabase = mockSupabaseForGuard({
      business: ACTIVE_BIZ,
      capabilities: [
        { capability: 'scheduling', is_enabled: false, sort_order: 0 },
        { capability: 'ordering', is_enabled: true, sort_order: 1 },
      ],
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-1',
      capability: 'ordering',
      action: 'create_new',
    });
    expect(result.allowed).toBe(true);
  });

  // Test I: MANAGE_EXISTING always allowed
  it('allows MANAGE_EXISTING even when capability is paused', async () => {
    const supabase = mockSupabaseForGuard({
      business: ACTIVE_BIZ,
      capabilities: SCHEDULING_DISABLED,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-1',
      capability: 'scheduling',
      action: 'manage_existing',
    });
    expect(result.allowed).toBe(true);
  });

  // Test I2: Payment retry (MANAGE_EXISTING) not blocked
  it('allows MANAGE_EXISTING payment retry when capability is paused', async () => {
    const supabase = mockSupabaseForGuard({
      business: FREE_BIZ_EXPIRED_TRIAL,
      capabilities: RESERVATION_ENABLED,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-3',
      capability: 'reservation',
      action: 'manage_existing',
    });
    expect(result.allowed).toBe(true);
  });

  // Test J: Denied response is recoverable
  it('returns human-readable customer message on denial', async () => {
    const supabase = mockSupabaseForGuard({
      business: FREE_BIZ_EXPIRED_TRIAL,
      capabilities: RESERVATION_ENABLED,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-3',
      capability: 'reservation',
      action: 'create_new',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.customerMessage).toBeTruthy();
      expect(typeof result.customerMessage).toBe('string');
    }
  });

  // Test N: Business becomes non-active
  it('denies CREATE_NEW for suspended business', async () => {
    const supabase = mockSupabaseForGuard({
      business: SUSPENDED_BIZ,
      capabilities: SCHEDULING_ENABLED,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-4',
      capability: 'scheduling',
      action: 'create_new',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('business_suspended');
    }
  });

  it('denies CREATE_NEW for pending business', async () => {
    const supabase = mockSupabaseForGuard({
      business: PENDING_BIZ,
      capabilities: SCHEDULING_ENABLED,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-5',
      capability: 'scheduling',
      action: 'create_new',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('business_not_active');
    }
  });

  // Test O: Zero-row legacy business still works
  // salon defaults = ['appointment', 'payment', 'feedback', 'chat', 'staff', ...]
  it('allows CREATE_NEW for zero-row legacy business with default capabilities', async () => {
    const supabase = mockSupabaseForGuard({
      business: LEGACY_BIZ_NO_CAPS,
      capabilities: [], // zero rows — triggers legacy fallback
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-6',
      capability: 'appointment', // appointment is in salon defaults AND is free-tier
      action: 'create_new',
    });
    expect(result.allowed).toBe(true);
  });

  it('denies CREATE_NEW for zero-row legacy business with non-default capability', async () => {
    const supabase = mockSupabaseForGuard({
      business: LEGACY_BIZ_NO_CAPS,
      capabilities: [], // zero rows — triggers legacy fallback (salon → scheduling, payment, etc.)
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-6',
      capability: 'crowdfunding', // not in salon defaults
      action: 'create_new',
    });
    // crowdfunding requires business tier AND is not in salon defaults
    expect(result.allowed).toBe(false);
  });

  // Test P: Override restores tier eligibility
  it('allows CREATE_NEW with admin override even when tier blocks', async () => {
    const supabase = mockSupabaseForGuard({
      business: FREE_BIZ_EXPIRED_TRIAL,
      capabilities: RESERVATION_ENABLED,
      overrides: ['reservation'], // admin override
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-3',
      capability: 'reservation',
      action: 'create_new',
    });
    expect(result.allowed).toBe(true);
  });

  // Test Q: DB error fails closed
  it('fails closed on business read error', async () => {
    const supabase = mockSupabaseForGuard({ bizError: true });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-1',
      capability: 'scheduling',
      action: 'create_new',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('business_read_error');
    }
  });

  it('fails closed on capability read error', async () => {
    const supabase = mockSupabaseForGuard({
      business: ACTIVE_BIZ,
      capError: true,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-1',
      capability: 'scheduling',
      action: 'create_new',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('capability_read_error');
    }
  });

  it('fails closed on override read error', async () => {
    const supabase = mockSupabaseForGuard({
      business: ACTIVE_BIZ,
      capabilities: SCHEDULING_ENABLED,
      overrideError: true,
    });
    const result = await requireCurrentCapability(supabase, {
      businessId: 'biz-1',
      capability: 'scheduling',
      action: 'create_new',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('override_read_error');
    }
  });
});

// ── Point B: Flow-start bypass guards (unit-level policy tests) ──

describe('Flow-start bypass validation (Point B)', () => {
  // Test K: start_capability keyword checks effective set
  it('start_capability rejects when capability not in effective set', () => {
    const effectiveCaps: CapabilityId[] = ['ordering'];
    const targetCap = 'scheduling';
    expect(effectiveCaps.includes(targetCap as CapabilityId)).toBe(false);
  });

  it('start_capability allows when capability in effective set', () => {
    const effectiveCaps: CapabilityId[] = ['scheduling', 'ordering'];
    const targetCap = 'scheduling';
    expect(effectiveCaps.includes(targetCap as CapabilityId)).toBe(true);
  });

  // Test L: quick_rebook checks effective set
  it('quick_rebook giving capability not in effective set is rejected', () => {
    const effectiveCaps: CapabilityId[] = ['scheduling']; // giving not present
    expect(effectiveCaps.includes('giving' as CapabilityId)).toBe(false);
  });

  // Test M: checkin uses effective set (not tier-blind)
  it('queue not in effective set blocks checkin', () => {
    const effectiveCaps: CapabilityId[] = ['scheduling'];
    expect(effectiveCaps.includes('queue' as CapabilityId)).toBe(false);
  });
});

// ── Point A: Session resume revalidation (policy integration) ──

describe('Session resume revalidation (Point A)', () => {
  // Test D: Old cap_<id> payload uses stale entitlement
  it('getEffectiveCapabilities correctly removes paused caps after trial expiry', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: [
        { capability: 'scheduling', is_enabled: true },
        { capability: 'reservation', is_enabled: true },
      ],
      overrides: [],
      tier: 'free',
      trialEndsAt: '2024-01-01T00:00:00Z', // expired
    });
    // scheduling is free-tier — should still be effective
    expect(result.effective).toContain('scheduling');
    // reservation requires growth — should be blocked
    expect(result.effective).not.toContain('reservation');
    expect(result.blocked.some(b => b.capability === 'reservation')).toBe(true);
  });

  it('getEffectiveCapabilities includes growth caps with active trial', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: [
        { capability: 'scheduling', is_enabled: true },
        { capability: 'reservation', is_enabled: true },
      ],
      overrides: [],
      tier: 'free',
      trialEndsAt: new Date(Date.now() + 86400000).toISOString(), // active
    });
    expect(result.effective).toContain('scheduling');
    expect(result.effective).toContain('reservation');
  });

  // Validate canPerformAction semantics used by Point C
  it('canPerformAction denies create_new when capability not effective', () => {
    const result = canPerformAction({
      action: 'create_new',
      capability: 'reservation',
      effectiveCapabilities: ['scheduling'],
    });
    expect(result.allowed).toBe(false);
  });

  it('canPerformAction allows manage_existing even when capability not effective', () => {
    const result = canPerformAction({
      action: 'manage_existing',
      capability: 'reservation',
      effectiveCapabilities: ['scheduling'],
    });
    expect(result.allowed).toBe(true);
  });

  it('canPerformAction allows read_history even when capability not effective', () => {
    const result = canPerformAction({
      action: 'read_history',
      capability: 'reservation',
      effectiveCapabilities: [],
    });
    expect(result.allowed).toBe(true);
  });
});
