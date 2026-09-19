/**
 * Shared currency formatter for ticket + receipt rendering.
 *
 * Covers: NGN (₦), GHS (GH₵), KES (KSh), USD ($), GBP (£), EUR (€), CAD (CA$).
 * Unknown currency codes fall back to "CODE amount" (e.g. "XOF 5,000").
 */

const CURRENCY_MAP: Record<string, { symbol: string; locale: string; code: string }> = {
  NG: { symbol: '₦', locale: 'en-NG', code: 'NGN' },
  GH: { symbol: 'GH₵', locale: 'en-GH', code: 'GHS' },
  KE: { symbol: 'KSh', locale: 'en-KE', code: 'KES' },
  US: { symbol: '$', locale: 'en-US', code: 'USD' },
  GB: { symbol: '£', locale: 'en-GB', code: 'GBP' },
  CA: { symbol: 'CA$', locale: 'en-CA', code: 'CAD' },
  // EUR countries
  DE: { symbol: '€', locale: 'de-DE', code: 'EUR' },
  FR: { symbol: '€', locale: 'fr-FR', code: 'EUR' },
  IE: { symbol: '€', locale: 'en-IE', code: 'EUR' },
  IN: { symbol: '₹', locale: 'en-IN', code: 'INR' },
  ZA: { symbol: 'R', locale: 'en-ZA', code: 'ZAR' },
};

/**
 * Format a currency amount for display in tickets/receipts.
 * Uses Intl.NumberFormat when possible, falls back to "CODE amount".
 */
export function formatTicketCurrency(amount: number, countryCode?: string | null): string {
  const cc = (countryCode || 'NG').toUpperCase();
  const config = CURRENCY_MAP[cc];

  if (config) {
    try {
      const hasCents = amount % 1 !== 0;
      return new Intl.NumberFormat(config.locale, {
        style: 'currency',
        currency: config.code,
        minimumFractionDigits: hasCents ? 2 : 0,
        maximumFractionDigits: hasCents ? 2 : 0,
      }).format(amount);
    } catch {
      // Fallback if Intl fails
      return `${config.symbol}${amount.toLocaleString()}`;
    }
  }

  // Unknown country — safe fallback: "CODE amount"
  return `${cc} ${amount.toLocaleString()}`;
}

/**
 * Get just the currency symbol for a country code.
 */
export function getCurrencySymbol(countryCode?: string | null): string {
  const cc = (countryCode || 'NG').toUpperCase();
  return CURRENCY_MAP[cc]?.symbol || cc;
}
