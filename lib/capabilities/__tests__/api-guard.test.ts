/**
 * Unit tests for the capability action API guard.
 *
 * Proves the behavior matrix:
 * 1. create_new + effective → allowed
 * 2. create_new + paused (trial expired) → denied
 * 3. create_new + paused (tier blocked) → denied
 * 4. create_new + admin override → allowed
 * 5. create_new + explicitly disabled → denied
 * 6. unrelated effective cap does not authorize route
 * 7. business ownership failure → denied
 * 8. DB error fails closed
 * 9. manage_existing + effective → allowed
 * 10. manage_existing + paused → allowed
 * 11. manage_existing + other business resource → denied (at route level)
 * 12. read_history + paused → allowed
 * 13. zero-row legacy with category defaults → create_new allowed if in defaults
 * 14. zero-row legacy without matching cap → denied
 * 15. trial expiry is immediate (no grace)
 * 16. suspended business → denied
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireCapability } from '../api-guard';
import type { CapabilityId } from '../types';

// ── Mock factories ──

function mockSupabase(opts: {
  business?: { id: string; status: string; subscription_tier: string; trial_ends_at: string | null; category: string | null } | null;
  bizError?: boolean;
}) {
  return {
    from: (table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => {
                  if (opts.bizError) return Promise.resolve({ data: null, error: { message: 'timeout' } });
                  return Promise.resolve({ data: opts.business || null, error: null });
                },
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    },
  } as any;
}

function mockService(opts: {
  capabilities?: Array<{ capability: string; is_enabled: boolean; sort_order: number }>;
  capError?: boolean;
  overrides?: string[];
  overrideError?: boolean;
}) {
  return {
    from: (table: string) => {
      if (table === 'business_capabilities') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: () => {
                  if (opts.capError) return Promise.resolve({ data: null, error: { message: 'db error' } });
                  return Promise.resolve({ data: opts.capabilities || [], error: null });
                },
              }),
            }),
          }),
        };
      }
      if (table === 'capability_overrides') {
        return {
          select: () => ({
            eq: () => {
              if (opts.overrideError) return Promise.resolve({ data: null, error: { message: 'db error' } });
              return Promise.resolve({
                data: (opts.overrides || []).map(c => ({ capability: c })),
                error: null,
              });
            },
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    },
  } as any;
}

const ACTIVE_BIZ = { id: 'biz-1', status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'salon' };
const FREE_BIZ_EXPIRED_TRIAL = { id: 'biz-1', status: 'active', subscription_tier: 'free', trial_ends_at: '2020-01-01T00:00:00Z', category: 'salon' };
const FREE_BIZ_ACTIVE_TRIAL = { id: 'biz-1', status: 'active', subscription_tier: 'free', trial_ends_at: '2099-01-01T00:00:00Z', category: 'salon' };
const SUSPENDED_BIZ = { id: 'biz-1', status: 'suspended', subscription_tier: 'growth', trial_ends_at: null, category: 'salon' };
const PENDING_BIZ = { id: 'biz-1', status: 'pending', subscription_tier: 'free', trial_ends_at: '2099-01-01T00:00:00Z', category: 'salon' };

describe('requireCapability — create_new', () => {
  it('effective capability → allowed', async () => {
    const result = await requireCapability(
      mockSupabase({ business: ACTIVE_BIZ }),
      mockService({ capabilities: [{ capability: 'broadcast', is_enabled: true, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(true);
  });

  it('paused by expired trial → denied with trial_expired detail', async () => {
    const result = await requireCapability(
      mockSupabase({ business: FREE_BIZ_EXPIRED_TRIAL }),
      mockService({ capabilities: [{ capability: 'broadcast', is_enabled: true, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(403);
      expect(result.denial.reason).toBe('capability_not_effective');
      expect(result.denial.detail).toBe('trial_expired');
    }
  });

  it('paused by tier → denied with tier_required detail', async () => {
    // broadcast requires 'growth' tier, business is on 'free' with no trial
    const result = await requireCapability(
      mockSupabase({ business: { ...FREE_BIZ_EXPIRED_TRIAL, trial_ends_at: null } }),
      mockService({ capabilities: [{ capability: 'broadcast', is_enabled: true, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denial.detail).toBe('tier_required');
    }
  });

  it('admin override → allowed despite tier block', async () => {
    const result = await requireCapability(
      mockSupabase({ business: { ...FREE_BIZ_EXPIRED_TRIAL, trial_ends_at: null } }),
      mockService({
        capabilities: [{ capability: 'broadcast', is_enabled: true, sort_order: 0 }],
        overrides: ['broadcast'],
      }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(true);
  });

  it('explicitly disabled capability → denied', async () => {
    const result = await requireCapability(
      mockSupabase({ business: ACTIVE_BIZ }),
      mockService({ capabilities: [{ capability: 'broadcast', is_enabled: false, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denial.detail).toBe('capability_not_configured');
    }
  });

  it('unrelated effective capability does not authorize route', async () => {
    // scheduling is effective, but we need broadcast
    const result = await requireCapability(
      mockSupabase({ business: ACTIVE_BIZ }),
      mockService({ capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(false);
  });

  it('business ownership failure → 403', async () => {
    const result = await requireCapability(
      mockSupabase({ business: null }),
      mockService({ capabilities: [] }),
      { businessId: 'biz-1', userId: 'attacker', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(403);
      expect(result.denial.reason).toBe('business_not_found');
    }
  });

  it('business DB error fails closed', async () => {
    const result = await requireCapability(
      mockSupabase({ bizError: true }),
      mockService({ capabilities: [] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(500);
    }
  });

  it('capability DB error fails closed', async () => {
    const result = await requireCapability(
      mockSupabase({ business: ACTIVE_BIZ }),
      mockService({ capError: true }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(500);
      expect(result.denial.reason).toBe('capability_read_error');
    }
  });

  it('override DB error fails closed', async () => {
    const result = await requireCapability(
      mockSupabase({ business: ACTIVE_BIZ }),
      mockService({ capabilities: [{ capability: 'broadcast', is_enabled: true, sort_order: 0 }], overrideError: true }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(500);
    }
  });

  it('suspended business → denied before capability check', async () => {
    const result = await requireCapability(
      mockSupabase({ business: SUSPENDED_BIZ }),
      mockService({ capabilities: [{ capability: 'broadcast', is_enabled: true, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denial.reason).toBe('business_suspended');
    }
  });

  it('pending (setup-incomplete) business → denied for create_new', async () => {
    const result = await requireCapability(
      mockSupabase({ business: PENDING_BIZ }),
      mockService({ capabilities: [{ capability: 'broadcast', is_enabled: true, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denial.reason).toBe('business_setup_incomplete');
    }
  });

  it('pending business + manage_existing → allowed (can manage existing)', async () => {
    const result = await requireCapability(
      mockSupabase({ business: PENDING_BIZ }),
      mockService({ capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'scheduling', action: 'manage_existing' },
    );
    expect(result.allowed).toBe(true);
  });

  it('active trial on free tier → allowed', async () => {
    const result = await requireCapability(
      mockSupabase({ business: FREE_BIZ_ACTIVE_TRIAL }),
      mockService({ capabilities: [{ capability: 'broadcast', is_enabled: true, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'broadcast', action: 'create_new' },
    );
    expect(result.allowed).toBe(true);
  });
});

describe('requireCapability — manage_existing', () => {
  it('effective → allowed', async () => {
    const result = await requireCapability(
      mockSupabase({ business: ACTIVE_BIZ }),
      mockService({ capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'scheduling', action: 'manage_existing' },
    );
    expect(result.allowed).toBe(true);
  });

  it('paused capability → still allowed (existing obligations)', async () => {
    const result = await requireCapability(
      mockSupabase({ business: FREE_BIZ_EXPIRED_TRIAL }),
      mockService({ capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'scheduling', action: 'manage_existing' },
    );
    // manage_existing always returns allowed regardless of pause
    expect(result.allowed).toBe(true);
  });
});

describe('requireCapability — read_history', () => {
  it('paused capability → still readable', async () => {
    const result = await requireCapability(
      mockSupabase({ business: FREE_BIZ_EXPIRED_TRIAL }),
      mockService({ capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'scheduling', action: 'read_history' },
    );
    expect(result.allowed).toBe(true);
  });
});

describe('requireCapability — zero-row legacy', () => {
  it('zero rows + category with matching default → create_new allowed', async () => {
    // salon category defaults include 'appointment' (in _BEAUTY array)
    const result = await requireCapability(
      mockSupabase({ business: ACTIVE_BIZ }), // growth tier salon
      mockService({ capabilities: [] }), // zero rows
      { businessId: 'biz-1', userId: 'user-1', capability: 'appointment', action: 'create_new' },
    );
    expect(result.allowed).toBe(true);
  });

  it('zero rows + category without matching cap → denied', async () => {
    // salon defaults don't include 'invoice'
    const result = await requireCapability(
      mockSupabase({ business: ACTIVE_BIZ }),
      mockService({ capabilities: [] }),
      { businessId: 'biz-1', userId: 'user-1', capability: 'invoice', action: 'create_new' },
    );
    expect(result.allowed).toBe(false);
  });
});
