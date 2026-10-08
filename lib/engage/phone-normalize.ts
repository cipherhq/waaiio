/**
 * Engage phone normalization via libphonenumber-js.
 *
 * Normalizes raw phone strings to E.164 format using the business's
 * country code as default context for local-format numbers.
 *
 * Invalid or unparseable numbers return null, which causes the
 * corresponding identity to be omitted from the audience (fail closed).
 */

import { parsePhoneNumber } from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';

export function normalizeEngagePhone(
  raw: string,
  businessCountryCode?: string,
): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = parsePhoneNumber(
      trimmed,
      businessCountryCode as CountryCode | undefined,
    );
    if (!parsed || !parsed.isValid()) return null;
    return parsed.format('E.164');
  } catch {
    return null;
  }
}
