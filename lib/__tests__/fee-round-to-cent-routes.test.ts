/**
 * Owner decision 2026-11-18: the legacy (v0) Waaiio fee is rounded to the
 * cent/kobo, not to whole units. Rates are unchanged.
 *
 * Runs both recordPlatformFee versions with the real getPlatformFees and checks
 * both custody routes, duplicates, cross-business attribution and the payout
 * formula. Provider split integers are covered in getPlatformFees.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn(async () => ({
    pricing_tiers: {
      free: { feePercentage: 3, feeFlat: 0 },
      growth: { feePercentage: 1.5, feeFlat: 0 },
      business: { feePercentage: 1, feeFlat: 0 },
    },
  })),
}));
vi.mock('@/lib/trial-status', async (orig) => ({
  ...(await orig<typeof import('@/lib/trial-status')>()),
  resolveTrialStatus: vi.fn(async () => true),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { recordPlatformFee } from '@/lib/payments/process-success';
import { recordPlatformFee as recordPlatformFeeShared } from '@/lib/bot/flows/shared/payment';
import { computePlatformHeldTotals } from '@/lib/payments/payable-fees';

type Row = Record<string, unknown>;

/** Supabase stub: per-table single() rows, records inserts, optional insert error. */
function stub(opts: { rows: Record<string, Row | null>; insertError?: { message: string; code?: string } }) {
  const inserts: Array<{ table: string; row: Row }> = [];
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self, is: self, limit: self,
        single: async () => ({ data: opts.rows[table] ?? null, error: null }),
        maybeSingle: async () => ({ data: opts.rows[table] ?? null, error: null }),
        insert: async (row: Row) => {
          inserts.push({ table, row });
          return { error: opts.insertError ?? null };
        },
      });
      return chain;
    },
  };
  return { client: client as never, inserts };
}

const BIZ = {
  subscription_tier: 'free', trial_ends_at: null, payout_mode: 'platform_managed',
  custom_fee_percentage: null, custom_fee_flat: null, reseller_id: null,
};

describe('process-success recordPlatformFee (v0) rounds to the cent', () => {
  it('Waaiio-owned route: $50 at 3% records 1.50, payout-eligible', async () => {
    const { client, inserts } = stub({ rows: { businesses: BIZ } });
    await recordPlatformFee(client, { businessId: 'biz-a', paymentAmount: 50, paymentRouting: 'platform', gatewayFee: 1.75 });

    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('platform_fees');
    expect(inserts[0].row).toMatchObject({
      business_id: 'biz-a', transaction_amount: 50, fee_percentage: 3, fee_total: 1.5,
      gateway_fee: 1.75, tier: 'free', is_direct_transfer: false,
    });
  });

  it('merchant-connected (BYO) route: same rate, kobo precision, not payout-eligible', async () => {
    const { client, inserts } = stub({ rows: { businesses: { ...BIZ, subscription_tier: 'business' } } });
    await recordPlatformFee(client, { businessId: 'biz-a', paymentAmount: 2020, paymentRouting: 'byo' });

    expect(inserts[0].row).toMatchObject({ fee_percentage: 1, fee_total: 20.2, is_direct_transfer: true });
  });

  it('trial does not waive the fee (unchanged)', async () => {
    const { client, inserts } = stub({ rows: { businesses: BIZ } });
    await recordPlatformFee(client, { businessId: 'biz-a', paymentAmount: 50, paymentRouting: 'platform' });
    expect(inserts[0].row.fee_total).toBe(1.5);
  });

  it('direct_split business: no fee row (gateway took the fee)', async () => {
    const { client, inserts } = stub({ rows: { businesses: { ...BIZ, payout_mode: 'direct_split' } } });
    await recordPlatformFee(client, { businessId: 'biz-a', paymentAmount: 50, paymentRouting: 'platform' });
    expect(inserts).toHaveLength(0);
  });

  it('duplicate insert (webhook + "I\'ve Paid" race) stays idempotent', async () => {
    const { client, inserts } = stub({
      rows: { businesses: BIZ },
      insertError: { message: 'duplicate key value violates unique constraint', code: '23505' },
    });
    await expect(recordPlatformFee(client, { businessId: 'biz-a', paymentAmount: 50, paymentRouting: 'platform' })).resolves.toBeUndefined();
    expect(inserts).toHaveLength(1);
  });

  it('non-duplicate insert error still throws', async () => {
    const { client } = stub({ rows: { businesses: BIZ }, insertError: { message: 'boom' } });
    await expect(recordPlatformFee(client, { businessId: 'biz-a', paymentAmount: 50, paymentRouting: 'platform' })).rejects.toThrow('Platform fee insert failed');
  });

  it('cross-business: the fee is attributed to the booking\'s business only', async () => {
    const { client, inserts } = stub({ rows: { bookings: { business_id: 'biz-b' }, businesses: BIZ } });
    await recordPlatformFee(client, { bookingId: 'bk-1', paymentAmount: 50, paymentRouting: 'platform' });
    expect(inserts[0].row).toMatchObject({ business_id: 'biz-b', booking_id: 'bk-1', fee_total: 1.5 });
  });

  it('unknown booking: no fee row', async () => {
    const { client, inserts } = stub({ rows: { bookings: null, businesses: BIZ } });
    await recordPlatformFee(client, { bookingId: 'bk-x', paymentAmount: 50, paymentRouting: 'platform' });
    expect(inserts).toHaveLength(0);
  });
});

describe('shared/payment recordPlatformFee rounds to the cent', () => {
  it('records 1.50 on $50 at 3%', async () => {
    const { client, inserts } = stub({ rows: { businesses: { payout_mode: 'platform_managed', custom_fee_percentage: null, custom_fee_flat: null } } });
    await recordPlatformFeeShared(client, { businessId: 'biz-a', transactionAmount: 50, tier: 'free', isInTrial: true });
    expect(inserts[0].row).toMatchObject({ business_id: 'biz-a', fee_total: 1.5, waived: false });
  });
});

describe('payout formula with cent-precise fees', () => {
  it('Waaiio-owned rows reduce the merchant net by exactly the fee; BYO rows are excluded', () => {
    const fees = [
      { transaction_amount: 50, fee_total: 1.5, gateway_fee: 1.75, waived: false, is_direct_transfer: false, currency: 'USD' },
      { transaction_amount: 50, fee_total: 1.5, gateway_fee: 1.75, waived: false, is_direct_transfer: false, currency: 'USD' },
      { transaction_amount: 2020, fee_total: 20.2, gateway_fee: 0, waived: false, is_direct_transfer: true, currency: 'USD' },
    ];
    const t = computePlatformHeldTotals(fees, 'USD');
    expect(t.eligible).toHaveLength(2);
    expect(t.totalFees).toBe(3);
    expect(t.netAvailable).toBeCloseTo(100 - 3 - 3.5, 2);
  });
});
