/** Display a stored payout denomination without inferring it from a country. */
export function formatPayoutAmount(amount: number, currency: unknown): string {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return `${amount.toLocaleString('en-US')} (currency unclassified)`;
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code' }).format(amount);
}
