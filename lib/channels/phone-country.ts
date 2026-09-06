/**
 * Phone-Country Resolver (#261)
 *
 * Resolves the ISO 3166-1 alpha-2 country code from an E.164 phone number.
 * Used to populate recipient_country_code on message_send_attempts for
 * financial authorization pricing resolution.
 */

import { parsePhoneNumber } from 'libphonenumber-js';

export function resolveRecipientCountry(e164Phone: string): string | null {
  try {
    const parsed = parsePhoneNumber(e164Phone);
    if (!parsed || !parsed.country) return null;
    if (!parsed.isValid()) return null;
    return parsed.country;
  } catch {
    return null;
  }
}
