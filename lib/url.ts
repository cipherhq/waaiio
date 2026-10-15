/**
 * Canonical public origin for customer-facing short URLs.
 *
 * Normalizes the known production apex `https://waaiio.com` to
 * `https://www.waaiio.com` so that newly generated short payment
 * links skip the Vercel apex→www redirect hop.
 *
 * Preserves non-production / custom origins unchanged.
 */
export function canonicalPublicOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  if (raw === 'https://waaiio.com') return 'https://www.waaiio.com';
  return raw;
}
