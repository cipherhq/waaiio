/**
 * Verification limit helper tests.
 *
 * Tests checkVerificationLimit with mocked Supabase client.
 * Tier limits use REAL values from countries.verification_tiers:
 *   NG basic = 500,000 (₦500,000), standard = 5,000,000 (₦5M)
 * These are MAJOR currency units; the helper must convert to minor (kobo).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock countries module for loadCountries
vi.mock('@/lib/countries', () => ({
  loadCountries: vi.fn().mockResolvedValue([]),
  getCountry: vi.fn().mockReturnValue(null),
}));

// Mock constants — return REAL tier values in MAJOR units (as stored in DB)
vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants');
  return {
    ...actual,
    getVerificationTiers: vi.fn().mockReturnValue({
      unverified: { label: 'Unverified', limit: 0, requirements: '' },
      basic: { label: 'Basic', limit: 500_000, requirements: '' },        // ₦500,000
      standard: { label: 'Standard', limit: 5_000_000, requirements: '' }, // ₦5,000,000
      full: { label: 'Full', limit: 999_999_999, requirements: '' },
    }),
  };
});

import { checkVerificationLimit } from '@/lib/payouts/verification-limit';

function mockSupabase(bizData: Record<string, unknown> | null, payouts: Array<{ net_amount: number }> = []) {
  const payoutResult = Promise.resolve({ data: payouts, error: null });
  const gteStep = { ...payoutResult, neq: () => payoutResult, then: payoutResult.then.bind(payoutResult) };
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: bizData, error: null }),
            }),
          }),
        };
      }
      if (table === 'business_payouts') {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                gte: () => gteStep,
              }),
            }),
          }),
        };
      }
      return {};
    }),
  } as any;
}

describe('checkVerificationLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Real NG basic tier: limit = ₦500,000 = 50,000,000 kobo ──

  it('NG basic: ₦400,000 used + ₦100,000 payout → allowed (exactly at limit)', async () => {
    // used: ₦400,000 major → net_amount = 400000
    // payout: ₦100,000 = 10,000,000 kobo
    // total: 40,000,000 + 10,000,000 = 50,000,000 kobo = ₦500,000 limit → exactly at limit
    const sb = mockSupabase(
      { verification_level: 'basic', payout_limit_monthly: 500_000, country_code: 'NG' },
      [{ net_amount: 400_000 }],
    );
    const result = await checkVerificationLimit(sb, 'biz-1', 10_000_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('NG basic: ₦400,000 used + ₦100,001 payout → refused (1 kobo over)', async () => {
    const sb = mockSupabase(
      { verification_level: 'basic', payout_limit_monthly: 500_000, country_code: 'NG' },
      [{ net_amount: 400_000 }],
    );
    const result = await checkVerificationLimit(sb, 'biz-1', 10_000_100); // ₦100,001
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeded');
  });

  it('NG standard: ₦4,999,999 used + ₦1 payout → allowed', async () => {
    // standard limit = ₦5,000,000 = 500,000,000 kobo
    // used: ₦4,999,999 = 499,999,900 kobo
    // payout: ₦1 = 100 kobo
    // total: 500,000,000 = exactly at limit
    const sb = mockSupabase(
      { verification_level: 'standard', payout_limit_monthly: 5_000_000, country_code: 'NG' },
      [{ net_amount: 4_999_999 }],
    );
    const result = await checkVerificationLimit(sb, 'biz-1', 100);
    expect(result.allowed).toBe(true);
  });

  it('NG standard: ₦5,000,000 used + ₦1 payout → refused', async () => {
    const sb = mockSupabase(
      { verification_level: 'standard', payout_limit_monthly: 5_000_000, country_code: 'NG' },
      [{ net_amount: 5_000_000 }],
    );
    const result = await checkVerificationLimit(sb, 'biz-1', 100);
    expect(result.allowed).toBe(false);
  });

  // ── Edge cases ──

  it('holds when limit is 0 (unverified)', async () => {
    const sb = mockSupabase(
      { verification_level: 'unverified', payout_limit_monthly: 0, country_code: 'NG' },
    );
    const result = await checkVerificationLimit(sb, 'biz-1', 100);
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(0);
    expect(result.reason).toContain('does not allow');
  });

  it('holds when business not found', async () => {
    const sb = mockSupabase(null);
    const result = await checkVerificationLimit(sb, 'biz-missing', 100);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('allows unlimited (full tier)', async () => {
    const sb = mockSupabase(
      { verification_level: 'full', payout_limit_monthly: 999_999_999, country_code: 'NG' },
    );
    const result = await checkVerificationLimit(sb, 'biz-1', 99_999_999_900);
    expect(result.allowed).toBe(true);
  });

  it('holds when level has no tier entry', async () => {
    const sb = mockSupabase(
      { verification_level: 'nonexistent', payout_limit_monthly: 0, country_code: 'NG' },
    );
    const result = await checkVerificationLimit(sb, 'biz-1', 100);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No verification tier');
  });

  it('no payouts this month → full limit available', async () => {
    const sb = mockSupabase(
      { verification_level: 'basic', payout_limit_monthly: 500_000, country_code: 'NG' },
      [], // no payouts
    );
    const result = await checkVerificationLimit(sb, 'biz-1', 49_999_900); // ₦499,999
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
  });

  it('returns limit and used in minor units', async () => {
    const sb = mockSupabase(
      { verification_level: 'basic', payout_limit_monthly: 500_000, country_code: 'NG' },
      [{ net_amount: 100_000 }], // ₦100,000 used
    );
    const result = await checkVerificationLimit(sb, 'biz-1', 100); // tiny payout
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(50_000_000); // ₦500,000 in kobo
    expect(result.used).toBe(10_000_000);  // ₦100,000 in kobo
    expect(result.remaining).toBe(50_000_000 - 10_000_000 - 100); // 39,999,900
  });
});
