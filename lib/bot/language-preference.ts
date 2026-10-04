import type { LanguageEntitlement } from './language-policy';
import { normalizeInboundCommand } from './inbound-command-normalization';
import {
  isSupportedLanguage,
  normalizeLanguageAlias,
} from './languages';

type PreferencePersistence = 'persistent' | 'session';

export interface LanguagePreferenceIntent {
  language: string;
  persistence: PreferencePersistence;
}

const LANGUAGE_SWITCH_PATTERNS: readonly RegExp[] = [
  // English / code-switched commands
  /^(?:always\s+)?(?:speak|use)\s+(.+?)(?:\s+(?:for now|from now on))?$/,
  /^reply\s+to\s+me\s+in\s+(.+?)(?:\s+from now on)?$/,
  /^switch\s+to\s+(.+?)$/,
  /^(?:change|set)\s+(?:my\s+)?language\s+to\s+(.+?)$/,
  // Nigerian Pidgin
  /^(?:abeg\s+)?(?:speak|use)\s+(.+?)(?:\s+for\s+now)?$/,
  /^reply\s+me\s+(?:for|in)\s+(.+?)$/,
  // Yoruba (normalized ASCII form also covers native orthography)
  /^(?:jowo\s+)?so\s+(?:ede\s+)?(.+?)(?:\s+fun\s+mi)?$/,
  /^dahun\s+si\s+mi\s+ni\s+(.+?)$/,
  // Igbo
  /^(?:biko\s+)?kwuo\s+(.+?)$/,
  /^za\s+m\s+na\s+(.+?)$/,
  // Hausa
  /^(?:don\s+allah\s+)?yi\s+magana\s+da\s+ni\s+da\s+(.+?)$/,
  /^amsa\s+mini\s+da\s+(.+?)$/,
  // Twi
  /^(?:mesre\s+wo\s+)?ka\s+(.+?)\s+kyere\s+me$/,
  /^ma\s+me\s+mmuae\s+wo\s+(.+?)$/,
  // French
  /^(?:s'il\s+vous\s+plait\s+)?parle(?:z)?\s+(?:moi\s+en\s+)?(.+?)$/,
  /^utilise(?:z)?\s+(.+?)$/,
  /^reponds?(?:ez)?\s+moi\s+en\s+(.+?)$/,
  // Spanish
  /^(?:por\s+favor\s+)?habla\s+(?:conmigo\s+en\s+)?(.+?)$/,
  /^usa\s+(.+?)$/,
  /^respondeme\s+en\s+(.+?)$/,
];

const PERSISTENT_MARKERS = [
  /\balways\b/, /\bfrom now on\b/,
  /\btoujours\b/, /\bdesormais\b/,
  /\bsiempre\b/, /\bde ahora en adelante\b/,
  /\bnigbagbogbo\b/, /\blati isisiyi lo\b/,
  /\bmgbe niile\b/, /\bkullum\b/, /\bdaga yanzu\b/,
];

export function parseLanguagePreferenceIntent(
  text: string,
): LanguagePreferenceIntent | null {
  const normalized = normalizeInboundCommand(text);
  let alias: string | undefined;

  for (const pattern of LANGUAGE_SWITCH_PATTERNS) {
    const match = pattern.exec(normalized);
    if (match?.[1]) {
      alias = match[1].trim();
      break;
    }
  }
  if (!alias) return null;

  // Remove persistence suffixes before alias lookup; the marker itself is
  // explicit user intent and is evaluated separately below.
  alias = alias
    .replace(/\s+(?:from now on|toujours|desormais|siempre|de ahora en adelante|nigbagbogbo|lati isisiyi lo|mgbe niile|kullum|daga yanzu)$/i, '')
    .trim();

  const language = normalizeLanguageAlias(alias);
  if (!language) return null;

  const persistent = PERSISTENT_MARKERS.some(pattern => pattern.test(normalized));
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
