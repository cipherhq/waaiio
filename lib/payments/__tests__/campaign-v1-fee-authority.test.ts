/**
 * Campaign V1 Fee-Authority Propagation Tests
 *
 * Proves that processCampaignDonation correctly threads V1 fee-policy fields
 * through to recordPlatformFee, using the REAL calculateFee and validateV1Snapshot
 * functions (not mocked) with a valid production-shaped config snapshot.
 *
 * Test scenarios:
 *   1. V1 campaign: pinned config → exact fee_percentage/fee_total/is_direct_transfer
 *   2. V1 incomplete authority (missing configVersionId) → fail closed
 *   3. Legacy v0 campaign (no feePolicy) → legacy path with getPlatformFees
 *   4. Two-call replay: second invocation attempts fee insert (DB UNIQUE handles dedup)
 *   5. Legacy caller: backward-compatible 4-arg call
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only mock external dependencies — NOT calculateFee or validateV1Snapshot
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));
// Mock getPlatformFees for the legacy path only
vi.mock('@/lib/getPlatformFees', () => ({
  getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 3.5, feeFlat: 0, feeTotal: 105 }),
}));

import { processCampaignDonation } from '../process-success';

// ── Valid production-shaped config snapshot ──
// Uses pricing_tiers and category_fee_rates (the real keys, not tiers/categories)
const VALID_V1_SNAPSHOT = {
  pricing_tiers: {
    free: { feePercentage: 5.0, feeFlat: 0 },
    growth: { feePercentage: 3.5, feeFlat: 0 },
    business: { feePercentage: 2.0, feeFlat: 0 },
  },
  category_fee_rates: {
    giving: { feePercentage: 2.0 },
    booking: { feePercentage: 3.0 },
  },
};

type RpcResult = {
  applied?: boolean;
  already_applied?: boolean;
  is_legacy?: boolean;
  reason?: string;
  amount?: number;
};

function mockSupabase(opts: {
  rpcResult?: RpcResult;
  rpcError?: { message: string } | null;
  campaignBusinessId?: string;
  tier?: string;
  payoutMode?: string;
  resellerId?: string | null;
  configSnapshot?: Record<string, unknown> | null;
} = {}) {
  const rpcResult = opts.rpcResult ?? { applied: true, is_legacy: false, amount: 2500 };
  const rpcError = opts.rpcError ?? null;
  const campaignBusinessId = opts.campaignBusinessId ?? 'biz1';
  const tier = opts.tier ?? 'growth';
  const payoutMode = opts.payoutMode ?? 'platform_managed';
  const resellerId = opts.resellerId ?? null;
  const configSnapshot = opts.configSnapshot !== undefined ? opts.configSnapshot : VALID_V1_SNAPSHOT;

  const insertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];
  let currentTable = '';

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      currentTable = table;
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: table === 'campaigns'
                ? { business_id: campaignBusinessId }
                : table === 'businesses'
                ? { subscription_tier: tier, trial_ends_at: null, payout_mode: payoutMode, reseller_id: resellerId }
                : table === 'platform_config_versions'
                ? { config_snapshot: configSnapshot }
                : null,
            }),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
        insert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
          insertCalls.push({ table: currentTable, row });
          return Promise.resolve({ data: null, error: null });
        }),
      };
    }),
    rpc: vi.fn().mockResolvedValue({ data: rpcResult, error: rpcError }),
    _insertCalls: insertCalls,
  };

  return supabase;
}

describe('processCampaignDonation — V1 fee-policy propagation (real calculator)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('V1 campaign: pinned config produces exact fee_percentage, fee_total, is_direct_transfer', async () => {
    const supabase = mockSupabase({
      rpcResult: { applied: true, is_legacy: false, amount: 2500 },
    });

    const feePolicy = {
      feePolicyVersion: 1,
      configVersionId: 'cfg-v1-abc',
      transactionCategory: 'giving',
      feeBasis: {
        payment_routing: 'platform' as const,
        tier: 'growth' as const,
        is_in_trial: false,
        custom_fee_percentage: null,
        custom_fee_flat: null,
      },
      paymentRouting: 'platform' as const,
    };

    await processCampaignDonation(supabase as any, 'pay-v1', 'camp-v1', 2500, 75, feePolicy);

    const feeInserts = supabase._insertCalls.filter(
      (c: { table: string }) => c.table === 'platform_fees'
    );
    expect(feeInserts).toHaveLength(1);

    const row = feeInserts[0].row;
    // Real calculateFee with giving category rate (2.0%) on 2500:
    //   pctComponent = Math.round(2500 * 2.0 * 100) / 10000 = 50
    //   feeTotal = Math.round(50 * 100) / 100 = 50
    expect(row.fee_percentage).toBe(2.0);
    expect(row.fee_total).toBe(50);
    expect(row.transaction_amount).toBe(2500);
    expect(row.is_direct_transfer).toBe(false);
    expect(row.campaign_id).toBe('camp-v1');
    expect(row.payment_id).toBe('pay-v1');
    expect(row.business_id).toBe('biz1');
    expect(row.gateway_fee).toBe(75);
    // V1 path should NOT set fee_policy_version or config_version_id on the platform_fees row
    // (those are on the payments row — recordPlatformFee just records the computed fee)
  });

  it('V1 campaign with connect routing produces is_direct_transfer=true', async () => {
    const supabase = mockSupabase({
      rpcResult: { applied: true, is_legacy: false, amount: 1000 },
    });

    const feePolicy = {
      feePolicyVersion: 1,
      configVersionId: 'cfg-v1-abc',
      transactionCategory: 'giving',
      feeBasis: {
        payment_routing: 'connect' as const,
        tier: 'growth' as const,
        is_in_trial: false,
        custom_fee_percentage: null,
        custom_fee_flat: null,
      },
      paymentRouting: 'connect' as const,
    };

    await processCampaignDonation(supabase as any, 'pay-connect', 'camp-connect', 1000, 30, feePolicy);

    // direct_split businesses return early before insert — but connect routing
    // only sets is_direct_transfer=true, it doesn't mean payout_mode=direct_split
    // The mock has payout_mode=platform_managed, so the fee IS recorded.
    const feeInserts = supabase._insertCalls.filter(
      (c: { table: string }) => c.table === 'platform_fees'
    );
    expect(feeInserts).toHaveLength(1);
    expect(feeInserts[0].row.is_direct_transfer).toBe(true);
  });

  it('V1 incomplete authority (missing configVersionId) → fail closed, no fee', async () => {
    const supabase = mockSupabase({
      rpcResult: { applied: true, is_legacy: false, amount: 1000 },
    });

    const feePolicy = {
      feePolicyVersion: 1,
      configVersionId: undefined,
      transactionCategory: 'giving',
      feeBasis: {
        payment_routing: 'platform' as const,
        tier: 'growth' as const,
        is_in_trial: false,
        custom_fee_percentage: null,
        custom_fee_flat: null,
      },
      paymentRouting: 'platform' as const,
    };

    await expect(
      processCampaignDonation(supabase as any, 'pay-bad', 'camp-bad', 1000, 30, feePolicy),
    ).rejects.toThrow('V1 fee policy: missing authority fields');

    const feeInserts = supabase._insertCalls.filter(
      (c: { table: string }) => c.table === 'platform_fees'
    );
    expect(feeInserts).toHaveLength(0);
  });

  it('legacy v0 campaign (no feePolicy) uses legacy path', async () => {
    const supabase = mockSupabase({
      rpcResult: { applied: true, is_legacy: false, amount: 3000 },
    });

    // No feePolicy → legacy v0 path uses getPlatformFees mock
    await processCampaignDonation(supabase as any, 'pay-leg', 'camp-leg', 3000, 90);

    expect(supabase.from).toHaveBeenCalledWith('businesses');

    const feeInserts = supabase._insertCalls.filter(
      (c: { table: string }) => c.table === 'platform_fees'
    );
    expect(feeInserts).toHaveLength(1);
    // Legacy path uses getPlatformFees mock result (feePercentage: 3.5, feeTotal: 105)
    expect(feeInserts[0].row.fee_percentage).toBe(3.5);
    expect(feeInserts[0].row.fee_total).toBe(105);
    expect(feeInserts[0].row.transaction_amount).toBe(3000);
  });

  it('two-call replay: second invocation still attempts insert (DB UNIQUE handles dedup)', async () => {
    const supabase = mockSupabase({
      rpcResult: { applied: true, is_legacy: false, amount: 500 },
    });

    // First call
    await processCampaignDonation(supabase as any, 'pay-dup', 'camp-dup', 500, 15, {
      feePolicyVersion: 1,
      configVersionId: 'cfg-v1-abc',
      transactionCategory: 'giving',
      feeBasis: {
        payment_routing: 'platform' as const,
        tier: 'growth' as const,
        is_in_trial: false,
        custom_fee_percentage: null,
        custom_fee_flat: null,
      },
      paymentRouting: 'platform' as const,
    });

    const firstCallInserts = supabase._insertCalls.filter(
      (c: { table: string }) => c.table === 'platform_fees'
    ).length;
    expect(firstCallInserts).toBe(1);

    // Simulate replay: RPC returns already_applied
    supabase.rpc.mockResolvedValueOnce({
      data: { applied: false, already_applied: true, is_legacy: false, amount: 500 },
      error: null,
    });

    // Second call
    await processCampaignDonation(supabase as any, 'pay-dup', 'camp-dup', 500, 15, {
      feePolicyVersion: 1,
      configVersionId: 'cfg-v1-abc',
      transactionCategory: 'giving',
      feeBasis: {
        payment_routing: 'platform' as const,
        tier: 'growth' as const,
        is_in_trial: false,
        custom_fee_percentage: null,
        custom_fee_flat: null,
      },
      paymentRouting: 'platform' as const,
    });

    // Both calls should attempt insert; the DB UNIQUE constraint prevents actual duplicates
    const allFeeInserts = supabase._insertCalls.filter(
      (c: { table: string }) => c.table === 'platform_fees'
    );
    expect(allFeeInserts).toHaveLength(2);
    // Both inserts use the same payment_id — DB UNIQUE on payment_id prevents duplication
    expect(allFeeInserts[0].row.payment_id).toBe('pay-dup');
    expect(allFeeInserts[1].row.payment_id).toBe('pay-dup');
  });

  it('replay with is_legacy=true skips fee recording', async () => {
    const supabase = mockSupabase({
      rpcResult: { applied: false, already_applied: true, is_legacy: true, amount: 500 },
    });

    await processCampaignDonation(supabase as any, 'pay-leg-replay', 'camp-leg-replay', 500, 15);

    // shouldEnsureFee = result && !result.reason && !result.is_legacy → false
    const feeInserts = supabase._insertCalls.filter(
      (c: { table: string }) => c.table === 'platform_fees'
    );
    expect(feeInserts).toHaveLength(0);
  });

  it('backward-compatible 4-arg call (legacy callers without gatewayFee or feePolicy)', async () => {
    const supabase = mockSupabase({
      rpcResult: { applied: true, is_legacy: false, amount: 1000 },
    });

    // 4-arg call — no gatewayFee, no feePolicy
    await processCampaignDonation(supabase as any, 'pay-4arg', 'camp-4arg', 1000);

    expect(supabase.rpc).toHaveBeenCalledWith('apply_campaign_donation', {
      p_campaign_id: 'camp-4arg',
      p_payment_id: 'pay-4arg',
    });

    const feeInserts = supabase._insertCalls.filter(
      (c: { table: string }) => c.table === 'platform_fees'
    );
    expect(feeInserts).toHaveLength(1);
    expect(feeInserts[0].row.transaction_amount).toBe(1000);
  });
});
