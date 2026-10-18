/**
 * Behavioral tests for computePlatformHeldTotals and payout custody formula.
 *
 * Validates the canonical formula used by generate, auto-payout, approve,
 * balance, and nudge routes. These tests catch formula drift across callers.
 */

import { describe, it, expect } from 'vitest';
import { computePlatformHeldTotals, getPayableFeeRows, getUnclassifiedFeeRows } from '@/lib/payments/payable-fees';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const platformHeldRow = {
  transaction_amount: 10000,
  fee_total: 500,
  gateway_fee: 50,
  waived: false,
  is_direct_transfer: false,
};

const directTransferRow = {
  transaction_amount: 8000,
  fee_total: 400,
  gateway_fee: 40,
  waived: false,
  is_direct_transfer: true,
};

const nullCustodyRow = {
  transaction_amount: 5000,
  fee_total: 250,
  gateway_fee: 25,
  waived: false,
  is_direct_transfer: null,
};

const waivedRow = {
  transaction_amount: 6000,
  fee_total: 300,
  gateway_fee: 60,
  waived: true,
  is_direct_transfer: false,
};

// ---------------------------------------------------------------------------
// Core formula
// ---------------------------------------------------------------------------

describe('computePlatformHeldTotals — core formula', () => {
  it('returns zero totals for empty input', () => {
    const result = computePlatformHeldTotals([]);
    expect(result.gross).toBe(0);
    expect(result.totalFees).toBe(0);
    expect(result.gatewayFees).toBe(0);
    expect(result.netAvailable).toBe(0);
    expect(result.eligible).toHaveLength(0);
  });

  it('includes only is_direct_transfer === false rows', () => {
    const rows = [platformHeldRow, directTransferRow, nullCustodyRow];
    const { eligible, gross } = computePlatformHeldTotals(rows);
    expect(eligible).toHaveLength(1);
    expect(gross).toBe(10000);
  });

  it('NULL custody rows are excluded (fail-closed)', () => {
    const rows = [nullCustodyRow];
    const { eligible, gross } = computePlatformHeldTotals(rows);
    expect(eligible).toHaveLength(0);
    expect(gross).toBe(0);
  });

  it('excludes fee_total for waived rows but still deducts gateway_fee', () => {
    const rows = [waivedRow];
    const { gross, totalFees, gatewayFees, netAvailable } = computePlatformHeldTotals(rows);
    expect(gross).toBe(6000);
    expect(totalFees).toBe(0);      // waived → fee_total excluded
    expect(gatewayFees).toBe(60);   // gateway_fee still deducted
    expect(netAvailable).toBe(5940); // 6000 - 0 - 60
  });

  it('deducts both fee_total and gateway_fee for non-waived rows', () => {
    const rows = [platformHeldRow];
    const { gross, totalFees, gatewayFees, netAvailable } = computePlatformHeldTotals(rows);
    expect(gross).toBe(10000);
    expect(totalFees).toBe(500);
    expect(gatewayFees).toBe(50);
    expect(netAvailable).toBe(9450); // 10000 - 500 - 50
  });
});

// ---------------------------------------------------------------------------
// Business with direct-transfer AND platform-held revenue
// ---------------------------------------------------------------------------

describe('computePlatformHeldTotals — mixed custody', () => {
  it('direct-transfer rows never inflate platform-held gross', () => {
    const rows = [platformHeldRow, directTransferRow];
    const { gross, netAvailable } = computePlatformHeldTotals(rows);
    // directTransferRow is excluded — only platformHeldRow counts
    expect(gross).toBe(10000);
    expect(netAvailable).toBe(9450);
  });

  it('NULL custody rows never inflate platform-held gross', () => {
    const rows = [platformHeldRow, nullCustodyRow];
    const { gross, netAvailable } = computePlatformHeldTotals(rows);
    expect(gross).toBe(10000);
    expect(netAvailable).toBe(9450);
  });

  it('all three custody types together — only platform-held counts', () => {
    const rows = [platformHeldRow, directTransferRow, nullCustodyRow];
    const { eligible, gross } = computePlatformHeldTotals(rows);
    expect(eligible).toHaveLength(1);
    expect(gross).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

describe('computePlatformHeldTotals — adjustments', () => {
  it('negative adjustment (deduction) reduces netAvailable', () => {
    const rows = [platformHeldRow]; // net before adj = 9450
    const adjustments = [{ amount: -200 }];
    const { netAvailable } = computePlatformHeldTotals(rows, adjustments);
    expect(netAvailable).toBe(9250); // 9450 - 200
  });

  it('positive adjustment (credit) increases netAvailable', () => {
    const rows = [platformHeldRow];
    const adjustments = [{ amount: 100 }];
    const { netAvailable } = computePlatformHeldTotals(rows, adjustments);
    expect(netAvailable).toBe(9550); // 9450 + 100
  });

  it('adjustments alone cannot exceed gross — floor is 0', () => {
    const rows = [platformHeldRow];
    const adjustments = [{ amount: -99999 }];
    const { netAvailable } = computePlatformHeldTotals(rows, adjustments);
    expect(netAvailable).toBe(0);
  });

  it('empty adjustments array is equivalent to omitting it', () => {
    const rows = [platformHeldRow];
    const withEmpty = computePlatformHeldTotals(rows, []);
    const withOmitted = computePlatformHeldTotals(rows);
    expect(withEmpty.netAvailable).toBe(withOmitted.netAvailable);
  });

  it('applied adjustment must be included in lifetime balance (P1-2 regression)', () => {
    const fees = [
      { transaction_amount: 10000, fee_total: 500, gateway_fee: 50, waived: false, is_direct_transfer: false as const },
    ];

    // Step 1: Generate — uses only unapplied adjustments, no priorPayouts
    const unappliedAdj = [{ amount: -200 }];
    const { netAvailable: generatedNet } = computePlatformHeldTotals(fees, unappliedAdj);
    expect(generatedNet).toBe(9250);

    // Step 2: After generate, the adjustment is applied (linked to the payout).
    // Balance/approve must include ALL adjustments (applied + unapplied) to reconcile.
    const allAdjustments = [{ amount: -200 }];
    const priorPayouts = [{ net_amount: 9250 }];

    const { netAvailable: balanceWithAll } = computePlatformHeldTotals(fees, allAdjustments, priorPayouts);
    expect(balanceWithAll).toBe(0);

    // BUG scenario: if balance accidentally uses only unapplied adjustments (empty after linking)
    const noAdjustments: { amount: number }[] = [];
    const { netAvailable: balanceWithBug } = computePlatformHeldTotals(fees, noAdjustments, priorPayouts);
    expect(balanceWithBug).toBe(200); // documents the bug — phantom positive balance
  });

  it('multiple adjustments: mix of applied and unapplied in lifetime balance', () => {
    const fees = [
      { transaction_amount: 20000, fee_total: 1000, gateway_fee: 100, waived: false, is_direct_transfer: false as const },
    ];

    // Both adjustments must be included for the lifetime balance
    const allAdjustments = [{ amount: -500 }, { amount: 300 }];
    // Payout was generated with these adjustments: net = 20000-1000-100+(-500+300) = 18700
    const priorPayouts = [{ net_amount: 18700 }];

    const { netAvailable } = computePlatformHeldTotals(fees, allAdjustments, priorPayouts);
    expect(netAvailable).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prior payouts (approve and balance callers)
// ---------------------------------------------------------------------------

describe('computePlatformHeldTotals — priorPayouts', () => {
  it('prior payouts reduce netAvailable', () => {
    const rows = [platformHeldRow]; // gross=10000, net before prior=9450
    const priorPayouts = [{ net_amount: 5000 }];
    const { netAvailable } = computePlatformHeldTotals(rows, [], priorPayouts);
    expect(netAvailable).toBe(4450); // 9450 - 5000
  });

  it('prior payouts exceeding net clamp to 0', () => {
    const rows = [platformHeldRow];
    const priorPayouts = [{ net_amount: 99999 }];
    const { netAvailable } = computePlatformHeldTotals(rows, [], priorPayouts);
    expect(netAvailable).toBe(0);
  });

  it('generate and auto-payout callers (no priorPayouts) return period net', () => {
    const rows = [platformHeldRow];
    const adj = [{ amount: -200 }];
    const { netAvailable } = computePlatformHeldTotals(rows, adj);
    // 10000 - 500 - 50 + (-200) = 9250
    expect(netAvailable).toBe(9250);
  });

  it('generate then approve with nonzero gateway_fee, waived fees, and prior payout reconciles', () => {
    const fees = [
      { transaction_amount: 20000, fee_total: 1000, gateway_fee: 100, waived: false, is_direct_transfer: false as const },
      { transaction_amount: 5000, fee_total: 250, gateway_fee: 25, waived: true, is_direct_transfer: false as const },
    ];
    const adjustments = [{ amount: -300 }];

    // Generate: period net (no prior payouts)
    const { netAvailable: generatedNet } = computePlatformHeldTotals(fees, adjustments);
    // gross=25000, totalFees=1000 (waived row excluded), gatewayFees=125, adj=-300
    // net = 25000 - 1000 - 125 + (-300) = 23575
    expect(generatedNet).toBe(23575);

    // Approve: balance check with the generated payout as prior
    const priorPayouts = [{ net_amount: generatedNet }];
    const { netAvailable: remaining } = computePlatformHeldTotals(fees, adjustments, priorPayouts);
    // After paying out the full generated net, remaining should be 0
    expect(remaining).toBe(0);
  });

  it('balance matches generate when no prior payouts', () => {
    const fees = [platformHeldRow];
    const adj = [{ amount: -100 }];
    const generateNet = computePlatformHeldTotals(fees, adj).netAvailable;
    // Balance with no prior payouts should equal generate net
    const balanceNet = computePlatformHeldTotals(fees, adj, []).netAvailable;
    expect(balanceNet).toBe(generateNet);
  });
});

// ---------------------------------------------------------------------------
// BYO webhook: finalized payment — getPayableFeeRows and classification helpers
// ---------------------------------------------------------------------------

describe('custody classification helpers', () => {
  it('getPayableFeeRows returns only explicit false rows', () => {
    const rows = [platformHeldRow, directTransferRow, nullCustodyRow];
    const payable = getPayableFeeRows(rows);
    expect(payable).toHaveLength(1);
    expect(payable[0].is_direct_transfer).toBe(false);
  });

  it('getUnclassifiedFeeRows returns only null/undefined rows', () => {
    const rows = [platformHeldRow, directTransferRow, nullCustodyRow];
    const unclassified = getUnclassifiedFeeRows(rows);
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0].is_direct_transfer).toBeNull();
  });
});
