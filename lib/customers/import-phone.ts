import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/** Import-only normalization: international input, never infer a local country. */
export function normalizeImportPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  // Reject extensions, scientific notation and text before parsing: the parser
  // may otherwise extract a phone from a larger string or silently drop an extension.
  if (!/^\+?[\d\s()-]+$/.test(input)) return null;
  const digits = input.replace(/[\s()-]/g, '').replace(/^\+/, '');
  if (!/^[1-9]\d{1,14}$/.test(digits)) return null;
  const parsed = parsePhoneNumberFromString(`+${digits}`, { extract: false });
  return parsed?.isValid() && !parsed.ext ? parsed.number : null;
}
