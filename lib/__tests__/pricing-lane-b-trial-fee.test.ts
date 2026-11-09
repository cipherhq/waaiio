/**
 * Owner pricing decisions 2026-11-08 — lane B behavior tests.
 *
 * 1. The Waaiio fee (Starter 3% / Pro 1.5% / Premium 1%) applies from sign-up;
 *    the free trial never waives it (calculateFee, getPlatformFees,
 *    calculatePlatformFee, recordPlatformFee).
 * 2. The Pro/Premium feature trial is read from businesses.feature_trial_ends_at
 *    and does not depend on the messaging credit.
 * 3. During the trial a Starter business uses Premium limits; the fee stays at
 *    the Starter rate.
 */
import { describe, expect, it, vi } from 'vitest';

const PRICING_TIERS_FIXTURE = {
  free: { feePercentage: 3, feeFlat: 0 },
  growth: { feePercentage: 1.5, feeFlat: 0 },
  business: { feePercentage: 1, feeFlat: 0 },
};

vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn(async () => ({
    pricing_tiers: PRICING_TIERS_FIXTURE,
    conversation_limits: { free: 200, growth: 1000, business: 5000 },
    broadcast_limits: {
      free: { maxBroadcasts: 0, maxRecipients: 0 },
      growth: { maxBroadcasts: 10, maxRecipients: 500 },
      business: { maxBroadcasts: Infinity, maxRecipients: Infinity },
    },
  })),
}));

import { calculateFee, type FeeBasis } from '@/lib/payments/calculateFee';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { calculatePlatformFee, TIER_TRANSACTION_LIMITS } from '@/lib/constants';
import { canModifyCapability, getEffectiveCapabilities, getLimitTier, isTrialActive } from '@/lib/capabilities/policy';
import { resolveFeatureTrialEndsAt, resolveLimitTier, resolveTrialStatus } from '@/lib/trial-status';
import { checkTierLimit } from '@/lib/tier-limits';
import { checkConversationLimit } from '@/lib/bot/conversation-guard';
import { recordPlatformFee } from '@/lib/bot/flows/shared/payment';

const DAY = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 10 * DAY).toISOString();
const past = () => new Date(Date.now() - DAY).toISOString();
const SNAPSHOT = { pricing_tiers: PRICING_TIERS_FIXTURE };
const TIERS = [['free', 3], ['growth', 1.5], ['business', 1]] as const;

/** Minimal Supabase stub: businesses row + per-table counts, records inserts. */
function stubSupabase(opts: {
  business?: Record<string, unknown> | null;
  businessError?: boolean;
  count?: number;
  conversationCount?: number;
  inserts?: Array<{ table: string; row: Record<string, unknown> }>;
}) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self, gte: self, is: self, gt: self, limit: self,
        insert: async (row: Record<string, unknown>) => { opts.inserts?.push({ table, row }); return { error: null }; },
        maybeSingle: async () => {
          if (table === 'businesses') return opts.businessError ? { data: null, error: { message: 'boom' } } : { data: opts.business ?? null, error: null };
          if (table === 'conversation_usage') return { data: { conversation_count: opts.conversationCount ?? 0 }, error: null };
          return { data: null, error: null };
        },
        single: async () => (table === 'businesses' ? { data: opts.business ?? null, error: null } : { data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ count: opts.count ?? 0, data: null, error: null }),
      });
      return chain;
    },
  } as never;
}

describe('fee applies from sign-up — the trial never waives it', () => {
  for (const [tier, pct] of TIERS) {
    it(`calculateFee charges ${pct}% for ${tier} in and out of trial`, () => {
      const basis = (is_in_trial: boolean): FeeBasis => ({
        payment_routing: 'platform', tier, is_in_trial, custom_fee_percentage: null, custom_fee_flat: null,
      });
      const inTrial = calculateFee(1000, basis(true), null, SNAPSHOT);
      const notInTrial = calculateFee(1000, basis(false), null, SNAPSHOT);
      expect(inTrial).toEqual({ feePercentage: pct, feeFlat: 0, feeTotal: 10 * pct });
      expect(inTrial).toEqual(notInTrial);
    });

    it(`getPlatformFees charges ${pct}% for ${tier} in and out of trial`, async () => {
      expect(await getPlatformFees(1000, tier, true)).toEqual(await getPlatformFees(1000, tier, false));
      expect((await getPlatformFees(1000, tier, true)).feeTotal).toBe(Math.round(10 * pct));
    });
  }

  it('calculateFee: connect routing in trial still charges the plan fee', () => {
    const fee = calculateFee(500, { payment_routing: 'connect', tier: 'free', is_in_trial: true, custom_fee_percentage: null, custom_fee_flat: null }, null, SNAPSHOT);
    expect(fee.feeTotal).toBe(15);
  });

  it('calculateFee: custom per-business rate still wins during the trial', () => {
    const fee = calculateFee(1000, { payment_routing: 'platform', tier: 'free', is_in_trial: true, custom_fee_percentage: 2, custom_fee_flat: null }, null, SNAPSHOT);
    expect(fee.feeTotal).toBe(20);
  });

  it('calculateFee: BYO in trial pays the plan fee too (lane C removed the BYO 0% rule)', () => {
    const fee = calculateFee(1000, { payment_routing: 'byo', tier: 'free', is_in_trial: true, custom_fee_percentage: null, custom_fee_flat: null }, null, SNAPSHOT);
    expect(fee.feeTotal).toBe(30);
  });

  it('deprecated calculatePlatformFee no longer waives in trial', () => {
    expect(calculatePlatformFee(1000, 'free', true)).toEqual(calculatePlatformFee(1000, 'free', false));
    expect(calculatePlatformFee(1000, 'free', true).feeTotal).toBeGreaterThan(0);
  });

  it('recordPlatformFee records a non-waived, charged fee for a business in trial', async () => {
    const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
    const sb = stubSupabase({ business: { payout_mode: 'platform', custom_fee_percentage: null, custom_fee_flat: null }, inserts });
    await recordPlatformFee(sb, { businessId: 'b1', transactionAmount: 1000, tier: 'free', isInTrial: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('platform_fees');
    expect(inserts[0].row).toMatchObject({ waived: false, fee_percentage: 3, fee_total: 30 });
  });
});

describe('feature trial from sign-up, independent of the messaging credit', () => {
  it('isTrialActive needs only a Starter tier and a future clock', () => {
    expect(isTrialActive('free', future())).toBe(true);
    expect(isTrialActive('free', past())).toBe(false);
    expect(isTrialActive('free', null)).toBe(false);
    expect(isTrialActive('growth', future())).toBe(false);
  });

  it('Pro and Premium capabilities are effective during the trial and paused after it', () => {
    const rows = [
      { capability: 'scheduling', is_enabled: true },
      { capability: 'broadcast', is_enabled: true },
      { capability: 'membership', is_enabled: true },
    ];
    const during = getEffectiveCapabilities({ configuredCapabilities: rows, overrides: [], tier: 'free', trialEndsAt: future() });
    expect(during.effective).toEqual(['scheduling', 'broadcast', 'membership']);
    const after = getEffectiveCapabilities({ configuredCapabilities: rows, overrides: [], tier: 'free', trialEndsAt: past() });
    expect(after.effective).toEqual(['scheduling']);
    expect(after.blocked.map(b => b.reason)).toEqual(['trial_expired', 'trial_expired']);
  });

  it('a Starter business can switch on a Premium capability only during the trial', () => {
    expect(canModifyCapability({ capabilityId: 'membership', requestedState: true, tier: 'free', trialEndsAt: future(), overrides: [] }).allowed).toBe(true);
    expect(canModifyCapability({ capabilityId: 'membership', requestedState: true, tier: 'free', trialEndsAt: past(), overrides: [] }).allowed).toBe(false);
  });

  it('resolveFeatureTrialEndsAt reads feature_trial_ends_at and fails closed', async () => {
    const endsAt = future();
    expect(await resolveFeatureTrialEndsAt(stubSupabase({ business: { feature_trial_ends_at: endsAt, trial_ends_at: null } }), 'b1')).toBe(endsAt);
    expect(await resolveFeatureTrialEndsAt(stubSupabase({ businessError: true }), 'b1')).toBeNull();
    // The messaging-credit clock is ignored.
    expect(await resolveFeatureTrialEndsAt(stubSupabase({ business: { feature_trial_ends_at: null, trial_ends_at: future() } }), 'b1')).toBeNull();
  });

  it('resolveTrialStatus is true only for a Starter business with a future feature clock', async () => {
    expect(await resolveTrialStatus(stubSupabase({ business: { feature_trial_ends_at: future() } }), 'b1', 'free')).toBe(true);
    expect(await resolveTrialStatus(stubSupabase({ business: { feature_trial_ends_at: future() } }), 'b1', 'growth')).toBe(false);
    expect(await resolveTrialStatus(stubSupabase({ business: { feature_trial_ends_at: past() } }), 'b1', 'free')).toBe(false);
  });
});

describe('Premium limits during the trial', () => {
  it('getLimitTier: Starter in trial uses Premium; otherwise its own tier', () => {
    expect(getLimitTier('free', future())).toBe('business');
    expect(getLimitTier('free', past())).toBe('free');
    expect(getLimitTier('growth', future())).toBe('growth');
    expect(getLimitTier(null, null)).toBe('free');
  });

  it('resolveLimitTier fails closed to the own tier on a DB error', async () => {
    expect(await resolveLimitTier(stubSupabase({ businessError: true }), 'b1', 'free')).toBe('free');
    expect(await resolveLimitTier(stubSupabase({ business: { feature_trial_ends_at: future() } }), 'b1', 'free')).toBe('business');
  });

  it('checkTierLimit: bookings are unlimited during the trial and capped after it', async () => {
    const over = TIER_TRANSACTION_LIMITS.free.bookings * 2;
    const during = await checkTierLimit(stubSupabase({ business: { feature_trial_ends_at: future() }, count: over }), 'b1', 'bookings', 'free');
    expect(during).toEqual({ allowed: true, current: 0, limit: -1, softBlock: false });
    const after = await checkTierLimit(stubSupabase({ business: { feature_trial_ends_at: past() }, count: over }), 'b1', 'bookings', 'free');
    expect(after.allowed).toBe(false);
    expect(after.limit).toBe(TIER_TRANSACTION_LIMITS.free.bookings);
  });

  it('checkConversationLimit uses the Premium limit during the trial', async () => {
    const during = await checkConversationLimit(stubSupabase({ business: { feature_trial_ends_at: future() }, conversationCount: 300 }), 'b1', 'free');
    expect(during).toMatchObject({ allowed: true, limit: 5000 });
    const after = await checkConversationLimit(stubSupabase({ business: { feature_trial_ends_at: past() }, conversationCount: 300 }), 'b1', 'free');
    expect(after).toMatchObject({ allowed: false, limit: 200 });
  });
});

