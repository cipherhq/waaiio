/**
 * Verification limit helper tests.
 *
 * Tests checkVerificationLimit with mocked Supabase client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock constants before importing the module
vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants');
  return {
    ...actual,
    getVerificationTiers: vi.fn().mockReturnValue({
      unverified: { label: 'Unverified', limit: 0, requirements: '' },
      basic: { label: 'Basic', limit: 500_000_00, requirements: '' },       // 500,000 NGN in kobo
      standard: { label: 'Standard', limit: 2_000_000_00, requirements: '' }, // 2M NGN in kobo
      full: { label: 'Full', limit: 999_999_999, requirements: '' },
    }),
  };
});

import { checkVerificationLimit } from '@/lib/payouts/verification-limit';

function mockSupabase(bizData: Record<string, unknown> | null, payouts: Array<{ net_amount: number }> = []) {
  const payoutResult = Promise.resolve({ data: payouts, error: null });
  // The query chain can end at gte() (no excludePayoutId) or neq() (with excludePayoutId)
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

  it('allows payout under the limit', async () => {
    const sb = mockSupabase(
      { verification_level: 'basic', payout_limit_monthly: 50_000_000, country_code: 'NG' },
      [{ net_amount: 1000 }], // 1000 * 100 = 100,000 kobo used
    );
    const result = await checkVerificationLimit(sb, 'biz-1', 100_000); // 1,000 NGN = 100,000 kobo
    expect(result.allowed).toBe(true);
  });

  it('allows payout exactly at the limit', async () => {
    // basic limit = 500,000 NGN = 50,000,000 kobo
    // used: 4990 * 100 = 499,000 kobo
    const sb = mockSupabase(
      { verification_level: 'basic', payout_limit_monthly: 50_000_000, country_code: 'NG' },
      [{ net_amount: 4990 }],
    );
    // Request: (50,000,000 - 499,000) = 49,501,000 kobo remaining
    const result = await checkVerificationLimit(sb, 'biz-1', 49_501_000);
    expect(result.allowed).toBe(true);
  });

  it('rejects payout over the limit', async () => {
    const sb = mockSupabase(
      { verification_level: 'basic', payout_limit_monthly: 50_000_000, country_code: 'NG' },
      [{ net_amount: 4990 }], // 499,000 kobo used
    );
    const result = await checkVerificationLimit(sb, 'biz-1', 49_501_001); // 1 kobo over
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeded');
  });

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
    const result = await checkVerificationLimit(sb, 'biz-1', 999_999_999_99);
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
});
