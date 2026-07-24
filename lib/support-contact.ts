/**
 * Centralized support contact numbers.
 *
 * Reads from NEXT_PUBLIC_WHATSAPP_NUMBER_{country} env vars.
 * Falls back to empty string — callers must handle the missing case
 * by hiding the WhatsApp link rather than linking to a wrong number.
 */

const SUPPORT_NUMBERS: Record<string, string> = {
  NG: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_NG || '',
  US: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_US || '',
  GB: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_GB || '',
  CA: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_CA || '',
  GH: process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_GH || '',
};

/** Get the support WhatsApp number for a country. Returns empty string if not configured. */
export function getSupportWhatsAppNumber(countryCode?: string): string {
  if (countryCode && SUPPORT_NUMBERS[countryCode]) return SUPPORT_NUMBERS[countryCode];
  // Try US first, then any configured number
  return SUPPORT_NUMBERS.US || Object.values(SUPPORT_NUMBERS).find(n => n) || '';
}

/** Get the wa.me link for support. Returns empty string if no number configured. */
export function getSupportWhatsAppLink(countryCode?: string, message?: string): string {
  const number = getSupportWhatsAppNumber(countryCode);
  if (!number) return '';
  const base = `https://wa.me/${number}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}
