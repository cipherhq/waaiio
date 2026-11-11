/** Explicit boundary between existing major-unit payment amounts and tax minor units.
 * Deliberately limited to the approved initial markets. Never assume a currency's
 * exponent from its three-letter shape, and never round a malformed charge.
 */
const TAX_CURRENCY_EXPONENTS: Record<string, number> = { NGN: 2, USD: 2, GBP: 2, CAD: 2 };
function exponent(currency: string): number {
  if (!Object.prototype.hasOwnProperty.call(TAX_CURRENCY_EXPONENTS, currency)) {
    throw new Error('Unsupported merchant tax currency');
  }
  return TAX_CURRENCY_EXPONENTS[currency];
}

export function majorToTaxMinor(amount: number | string, currency: string): number {
  const digits = exponent(currency);
  const text = String(amount);
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(text)) throw new Error('Invalid major-unit amount');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.slice(digits).replace(/0/g, '')) throw new Error('Amount has fractional minor units');
  const value = BigInt(whole) * BigInt(10 ** digits) + BigInt(fraction.slice(0, digits).padEnd(digits, '0'));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount exceeds safe minor-unit range');
  return Number(value);
}

/** Return the numeric major-unit value expected by existing provider adapters.
 * Reject amounts that cannot round-trip through that adapter boundary exactly.
 */
export function taxMinorToMajor(amount: number, currency: string): number {
  const digits = exponent(currency);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid minor-unit amount');
  const scale = BigInt(10 ** digits);
  const minor = BigInt(amount);
  const result = Number(`${minor / scale}.${String(minor % scale).padStart(digits, '0')}`);
  if (majorToTaxMinor(result, currency) !== amount) throw new Error('Amount loses precision at payment boundary');
  return result;
}
