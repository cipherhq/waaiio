/**
 * M466: Payout currency authority — behavioral unit tests.
 *
 * Tests the currency-scoped computePlatformHeldTotals with cross-currency
 * scenarios that were previously impossible to test.
 *
 * Disposable PostgreSQL tests (TEST_DATABASE_URL) are in a separate file
 * for CI environments with real PG. These tests exercise the TS logic directly.
 */
import { describe, it, expect } from 'vitest';
import {
  computePlatformHeldTotals,
  getEligibleCurrencies,
  getUnknownCurrencyFeeRows,
  type PayableFeeRow,
} from '@/lib/payments/payable-fees';

// ── Fixtures ──

function fee(amount: number, feeTotal: number, gatewayFee: number, currency: string | null, opts?: { waived?: boolean; directTransfer?: boolean | null }): PayableFeeRow {
  return {
    transaction_amount: amount,
    fee_total: feeTotal,
    gateway_fee: gatewayFee,
    waived: opts?.waived ?? false,
    is_direct_transfer: opts?.directTransfer !== undefined ? opts.directTransfer : false,
    currency,
  };
}

// ── Core: single-currency payout ──

describe('M466: single-currency payout', () => {
  it('NGN fees produce NGN payout', () => {
    const fees = [fee(10000, 500, 50, 'NGN'), fee(5000, 250, 25, 'NGN')];
    const result = computePlatformHeldTotals(fees, 'NGN');
    expect(result.gross).toBe(15000);
    expect(result.totalFees).toBe(750);
    expect(result.gatewayFees).toBe(75);
    expect(result.netAvailable).toBe(14175);
  });

  it('USD fees produce USD payout', () => {
    const fees = [fee(5000, 125, 30, 'USD')];
    const result = computePlatformHeldTotals(fees, 'USD');
    expect(result.gross).toBe(5000);
    expect(result.netAvailable).toBe(4845);
  });
});

// ── Cross-currency isolation ──

describe('M466: cross-currency isolation', () => {
  it('NGN fees excluded from USD payout', () => {
    const fees = [fee(10000, 500, 50, 'NGN'), fee(5000, 125, 30, 'USD')];
    const usd = computePlatformHeldTotals(fees, 'USD');
    expect(usd.gross).toBe(5000);
    expect(usd.eligible).toHaveLength(1);
  });

  it('USD fees excluded from NGN payout', () => {
    const fees = [fee(10000, 500, 50, 'NGN'), fee(5000, 125, 30, 'USD')];
    const ngn = computePlatformHeldTotals(fees, 'NGN');
    expect(ngn.gross).toBe(10000);
    expect(ngn.eligible).toHaveLength(1);
  });

  it('two currencies for one business → two separate totals', () => {
    const fees = [
      fee(10000, 500, 50, 'NGN'),
      fee(20000, 1000, 100, 'NGN'),
      fee(5000, 125, 30, 'USD'),
    ];
    const ngn = computePlatformHeldTotals(fees, 'NGN');
    const usd = computePlatformHeldTotals(fees, 'USD');
    expect(ngn.gross).toBe(30000);
    expect(usd.gross).toBe(5000);
    // No cross-currency contamination
    expect(ngn.gross + usd.gross).toBe(35000);
  });
});

// ── Adjustments scoped by currency ──

describe('M466: currency-scoped adjustments', () => {
  it('NGN adjustment excluded from USD payout', () => {
    const fees = [fee(5000, 125, 30, 'USD')];
    const ngnAdj = [{ amount: -200, currency: 'NGN' }];
    const result = computePlatformHeldTotals(fees, 'USD', ngnAdj);
    // NGN adjustment should NOT affect USD payout
    expect(result.netAvailable).toBe(4845); // 5000 - 125 - 30 = 4845
  });

  it('USD adjustment included in USD payout', () => {
    const fees = [fee(5000, 125, 30, 'USD')];
    const usdAdj = [{ amount: -200, currency: 'USD' }];
    const result = computePlatformHeldTotals(fees, 'USD', usdAdj);
    expect(result.netAvailable).toBe(4645); // 4845 - 200
  });

  it('NULL-currency adjustment excluded from all payouts', () => {
    const fees = [fee(5000, 125, 30, 'USD')];
    const nullAdj = [{ amount: -200, currency: null }];
    const result = computePlatformHeldTotals(fees, 'USD', nullAdj);
    expect(result.adjustmentSum).toBe(0); // NULL excluded
    expect(result.netAvailable).toBe(4845);
  });
});

// ── Prior payouts scoped by currency ──

describe('M466: currency-scoped prior payouts', () => {
  it('NGN prior payout excluded from USD balance', () => {
    const fees = [fee(5000, 125, 30, 'USD')];
    const ngnPrior = [{ net_amount: 3000, currency: 'NGN' }];
    const result = computePlatformHeldTotals(fees, 'USD', [], ngnPrior);
    // NGN payout should NOT reduce USD balance
    expect(result.netAvailable).toBe(4845);
    expect(result.priorPaidOut).toBe(0);
  });

  it('USD prior payout deducted from USD balance', () => {
    const fees = [fee(5000, 125, 30, 'USD')];
    const usdPrior = [{ net_amount: 2000, currency: 'USD' }];
    const result = computePlatformHeldTotals(fees, 'USD', [], usdPrior);
    expect(result.netAvailable).toBe(2845); // 4845 - 2000
    expect(result.priorPaidOut).toBe(2000);
  });

  it('NULL-currency prior payout excluded (legacy unapprovable)', () => {
    const fees = [fee(5000, 125, 30, 'USD')];
    const legacyPrior = [{ net_amount: 9999, currency: null }];
    const result = computePlatformHeldTotals(fees, 'USD', [], legacyPrior);
    expect(result.priorPaidOut).toBe(0); // Legacy excluded
    expect(result.netAvailable).toBe(4845);
  });
});

// ── Unknown currency handling ──

describe('M466: unknown currency handling', () => {
  it('NULL-currency fee rows detected by getUnknownCurrencyFeeRows', () => {
    const fees = [
      fee(10000, 500, 50, 'NGN'),
      fee(5000, 250, 25, null), // Unknown currency
    ];
    const unknown = getUnknownCurrencyFeeRows(fees);
    expect(unknown).toHaveLength(1);
    expect(unknown[0].transaction_amount).toBe(5000);
  });

  it('getEligibleCurrencies returns only known currencies', () => {
    const fees = [
      fee(10000, 500, 50, 'NGN'),
      fee(5000, 250, 25, null),
      fee(3000, 75, 15, 'USD'),
      fee(8000, 400, 40, 'NGN'),
    ];
    const currencies = getEligibleCurrencies(fees);
    expect(currencies.sort()).toEqual(['NGN', 'USD']);
    expect(currencies).not.toContain(null);
  });

  it('NULL-currency fee excluded from all currency calculations', () => {
    const fees = [
      fee(10000, 500, 50, 'NGN'),
      fee(5000, 250, 25, null), // Unknown — should NOT appear in any payout
    ];
    const ngn = computePlatformHeldTotals(fees, 'NGN');
    expect(ngn.gross).toBe(10000); // Only NGN fee
    expect(ngn.eligible).toHaveLength(1);
  });
});

// ── Direct-split and refund exclusion preserved ──

describe('M466: existing protections preserved', () => {
  it('direct-split excluded regardless of currency', () => {
    const fees = [
      fee(10000, 500, 50, 'NGN'),
      fee(8000, 400, 40, 'NGN', { directTransfer: true }),
    ];
    const result = computePlatformHeldTotals(fees, 'NGN');
    expect(result.gross).toBe(10000); // Direct-split excluded
    expect(result.eligible).toHaveLength(1);
  });

  it('NULL custody excluded regardless of currency', () => {
    const fees = [
      fee(10000, 500, 50, 'NGN'),
      fee(5000, 250, 25, 'NGN', { directTransfer: null }),
    ];
    const result = computePlatformHeldTotals(fees, 'NGN');
    expect(result.eligible).toHaveLength(1);
    expect(result.gross).toBe(10000);
  });

  it('waived fees: fee_total excluded but gateway_fee deducted', () => {
    const fees = [fee(6000, 300, 60, 'NGN', { waived: true })];
    const result = computePlatformHeldTotals(fees, 'NGN');
    expect(result.totalFees).toBe(0);
    expect(result.gatewayFees).toBe(60);
    expect(result.netAvailable).toBe(5940);
  });
});

// ── Backward compatibility ──

describe('M466: backward compatibility', () => {
  it('single-currency behavior identical to pre-M466', () => {
    const fees = [
      fee(10000, 500, 50, 'NGN'),
      fee(20000, 1000, 100, 'NGN'),
    ];
    const adj = [{ amount: -200, currency: 'NGN' }];
    const prior = [{ net_amount: 5000, currency: 'NGN' }];
    const result = computePlatformHeldTotals(fees, 'NGN', adj, prior);
    // gross=30000, fees=1500, gateway=150, adj=-200, prior=5000
    // net = max(0, 30000 - 1500 - 150 - 200 - 5000) = 23150
    expect(result.netAvailable).toBe(23150);
  });
});
