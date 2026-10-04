import type { LanguageEntitlement } from './language-policy';
import {
  isSupportedLanguage,
  normalizeLanguageAlias,
} from './languages';

type PreferencePersistence = 'persistent' | 'session';

export interface LanguagePreferenceIntent {
  language: string;
  persistence: PreferencePersistence;
}

const LANGUAGE_SWITCH = new RegExp(
  '^(?:always\\s+)?(?:speak|use)\\s+(.+?)(?:\\s+(?:for now|from now on))?$'
    + '|^reply\\s+to\\s+me\\s+in\\s+(.+?)(?:\\s+from now on)?$'
    + '|^switch\\s+to\\s+(.+?)$',
  'i',
);

export function parseLanguagePreferenceIntent(
  text: string,
): LanguagePreferenceIntent | null {
  const normalized = text.trim().replace(/\s+/g, ' ');
  const match = LANGUAGE_SWITCH.exec(normalized);
  const alias = match?.slice(1).find(Boolean);
  if (!alias) return null;

  const language = normalizeLanguageAlias(alias);
  if (!language) return null;

  const persistent = /^(?:always\b)|\bfrom now on$/i.test(normalized);
  return {
    language,
    persistence: persistent ? 'persistent' : 'session',
  };
}

export interface EffectiveResponseLanguageInput {
  explicitLanguage?: string | null;
  sessionLanguage?: string | null;
  rememberedLanguage?: string | null;
  strongSignalLanguage?: string | null;
  entitlement: LanguageEntitlement;
  certifiedLanguages: readonly string[];
}

export interface EffectiveResponseLanguage {
  language: string;
  source: 'explicit' | 'session' | 'remembered' | 'fallback';
  shouldOfferRemembered: boolean;
}

function canActivateLanguage(
  language: string | null | undefined,
  entitlement: LanguageEntitlement,
  certifiedLanguages: readonly string[],
): language is string {
  if (!language || !isSupportedLanguage(language)) return false;
  if (!certifiedLanguages.includes(language)) return false;
  if (!entitlement.allowedLanguages.includes(language)) return false;
  return language === 'en'
    || (entitlement.llmAllowed && entitlement.translationAllowed);
}

export function resolveEffectiveResponseLanguage(
  input: EffectiveResponseLanguageInput,
): EffectiveResponseLanguage {
  const candidates = [
    ['explicit', input.explicitLanguage],
    ['session', input.sessionLanguage],
    ['remembered', input.rememberedLanguage],
  ] as const;

  for (const [source, language] of candidates) {
    if (canActivateLanguage(language, input.entitlement, input.certifiedLanguages)) {
      return {
        language,
        source,
        shouldOfferRemembered: source === 'remembered',
      };
    }
  }

  return { language: 'en', source: 'fallback', shouldOfferRemembered: false };
}

interface PreferenceClient {
  from(table: 'profiles'): {
    select(columns: 'preferred_response_language'): {
      eq(column: 'id', value: string): {
        maybeSingle(): PromiseLike<{
          data: { preferred_response_language?: unknown } | null;
          error: unknown;
        }>;
      };
    };
    update(values: { preferred_response_language: string }): {
      eq(column: 'id', value: string): PromiseLike<{ error: unknown }>;
    };
  };
}

export async function readPreferredResponseLanguage(
  client: PreferenceClient,
  profileId: string,
): Promise<string | null> {
  if (!profileId) return null;

  try {
    const { data, error } = await client
      .from('profiles')
      .select('preferred_response_language')
      .eq('id', profileId)
      .maybeSingle();
    if (error) return null;

    const language = data?.preferred_response_language;
    return typeof language === 'string'
      && isSupportedLanguage(language)
      ? language
      : null;
  } catch {
    return null;
  }
}

export async function writePreferredResponseLanguage(
  client: PreferenceClient,
  profileId: string,
  language: string,
): Promise<void> {
  if (!profileId || !isSupportedLanguage(language)) {
    throw new Error('A resolved profile and supported language are required');
  }

  const { error } = await client
    .from('profiles')
    .update({ preferred_response_language: language })
    .eq('id', profileId);
  if (error) throw error;
}
