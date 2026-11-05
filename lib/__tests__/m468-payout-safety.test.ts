import { describe, expect, it } from 'vitest';
import {
  computePlatformHeldTotals, getEligibleCurrencies, getUnknownCurrencyFeeRows,
  hasUnreconciledCurrencyRecords,
} from '@/lib/payments/payable-fees';
const fee = (currency: string | null, amount: number, direct = false) => ({
  currency, transaction_amount: amount, fee_total: 0, gateway_fee: 0,
  waived: false, is_direct_transfer: direct,
});
describe('M468 financial reconciliation gates', () => {
  it('blocks legacy payouts without a currency', () => {
    expect(hasUnreconciledCurrencyRecords([{currency:null}])).toBe(true);
    expect(hasUnreconciledCurrencyRecords([{currency:'USD'}])).toBe(false);
  });
  it('blocks old adjustments even if all payouts have a currency', () => {
    expect(hasUnreconciledCurrencyRecords([{currency:'NGN'}],[{currency:null}])).toBe(true);
  });
  it('rejects invalid non-ISO identifiers', () => {
    expect(hasUnreconciledCurrencyRecords([{currency:'unknown'}])).toBe(true);
    expect(getUnknownCurrencyFeeRows([fee('invalid',10)])).toHaveLength(1);
  });
  it('isolates USD and NGN liabilities and adjustments', () => {
    const totals = computePlatformHeldTotals([fee('USD',100),fee('NGN',50000)], 'USD',
      [{currency:'USD',amount:-5},{currency:'NGN',amount:-2000}],
      [{currency:'USD',net_amount:20},{currency:'NGN',net_amount:10000}]);
    expect(totals.netAvailable).toBe(75);
  });
  it('does not count direct-split funds toward currency payouts', () => {
    expect(getEligibleCurrencies([fee('USD',100,true),fee('NGN',50)])).toEqual(['NGN']);
  });
  it('does not treat unknown-currency fee rows as eligible', () => {
    expect(getEligibleCurrencies([fee(null,100),fee('USD',50)])).toEqual(['USD']);
    expect(getUnknownCurrencyFeeRows([fee(null,100)])).toHaveLength(1);
  });
});
