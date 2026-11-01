import { describe, expect, it } from 'vitest';
import { formatPayoutAmount } from '../payouts/format-amount';
describe('stored payout amount display without currency inference', () => {
  it.each(['USD','NGN'])('uses %s without conversion', currency => {
    expect(formatPayoutAmount(123.45,currency)).toMatch(new RegExp(`^${currency}\\s123\\.45$`));
  });
  it.each([null,undefined,'','ngn','unknown'])('marks missing or malformed %s currency explicitly', currency => {
    expect(formatPayoutAmount(123.45,currency)).toBe('123.45 (currency unclassified)');
  });
});
