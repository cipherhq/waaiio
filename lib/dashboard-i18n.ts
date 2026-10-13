/**
 * Dashboard UI string localization.
 *
 * Keyed dictionaries for en and pcm. Add keys as needed.
 * The dashboard does not yet have a full i18n framework; this module
 * provides a lightweight lookup for strings that need localization.
 */

const strings: Record<string, Record<string, string>> = {
  en: {
    'payouts.setup_password_hint':
      "Enter your Waaiio account password — the one you log in with, not your bank password.",
  },
  pcm: {
    'payouts.setup_password_hint':
      "Put your Waaiio account password — the one wey you dey use log in, no be your bank password.",
  },
};

/**
 * Look up a dashboard UI string by key and locale.
 * Falls back to English if the locale or key is missing.
 */
export function t(key: string, locale = 'en'): string {
  return strings[locale]?.[key] ?? strings.en?.[key] ?? key;
}
