export const LANGUAGE_CATALOG = [
  { code: 'en', displayName: 'English', nativeName: 'English', certified: true },
  { code: 'pcm', displayName: 'Nigerian Pidgin', nativeName: 'Naijá', certified: false },
  { code: 'yo', displayName: 'Yoruba', nativeName: 'Yorùbá', certified: false },
  { code: 'ig', displayName: 'Igbo', nativeName: 'Igbo', certified: false },
  { code: 'ha', displayName: 'Hausa', nativeName: 'Hausa', certified: false },
  { code: 'tw', displayName: 'Twi', nativeName: 'Twi', certified: false },
  { code: 'fr', displayName: 'French', nativeName: 'Français', certified: false },
  { code: 'es', displayName: 'Spanish', nativeName: 'Español', certified: false },
] as const;

export type SupportedLanguage = typeof LANGUAGE_CATALOG[number]['code'];

export const SUPPORTED_LANGUAGES = LANGUAGE_CATALOG.map(
  language => language.code,
) as SupportedLanguage[];

// Keep the public policy list string-compatible for callers filtering values
// received from storage, while deriving its contents from the typed catalog.
export const CERTIFIED_LANGUAGES: readonly string[] = LANGUAGE_CATALOG
  .filter(language => language.certified)
  .map(language => language.code);

export const CERTIFIED_LANGUAGE_OPTIONS = LANGUAGE_CATALOG.filter(
  language => language.certified,
);

const LANGUAGE_NAMES: Record<SupportedLanguage, string> = Object.fromEntries(
  LANGUAGE_CATALOG.map(language => [language.code, language.displayName]),
) as Record<SupportedLanguage, string>;

const ALIASES: Record<string, SupportedLanguage> = {
  en: 'en',
  english: 'en',
  pcm: 'pcm',
  pidgin: 'pcm',
  'nigerian pidgin': 'pcm',
  naija: 'pcm',
  yo: 'yo',
  yoruba: 'yo',
  ig: 'ig',
  igbo: 'ig',
  ha: 'ha',
  hausa: 'ha',
  tw: 'tw',
  twi: 'tw',
  akan: 'tw',
  fr: 'fr',
  francais: 'fr',
  french: 'fr',
  es: 'es',
  espanol: 'es',
  spanish: 'es',
};

export function normalizeLanguageAlias(value: string): SupportedLanguage | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  return ALIASES[normalized] ?? null;
}

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return SUPPORTED_LANGUAGES.includes(value as SupportedLanguage);
}

export function getLanguageName(language: string): string {
  return isSupportedLanguage(language) ? LANGUAGE_NAMES[language] : 'English';
}
