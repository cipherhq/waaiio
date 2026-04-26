import Anthropic from '@anthropic-ai/sdk';
import { isFeatureEnabledServer, FLAGS } from '@/lib/posthog/flags';

const SUPPORTED_LANGUAGES: Record<string, string> = {
  en: 'English',
  pcm: 'Nigerian Pidgin',
  yo: 'Yoruba',
  ig: 'Igbo',
  ha: 'Hausa',
  tw: 'Twi',
  fr: 'French',
};

// Cache translations to avoid repeat API calls
const cache = new Map<string, { text: string; expiry: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Translate a bot response to the user's detected language.
 * Returns the original text if language is English or unsupported.
 * Falls back to original text on any error.
 */
export async function translateBotResponse(
  text: string,
  language: string,
): Promise<string> {
  // No translation needed for English or unknown languages
  if (!language || language === 'en' || !SUPPORTED_LANGUAGES[language]) {
    return text;
  }

  // Check feature flag (defaults to true if PostHog not configured)
  const enabled = await isFeatureEnabledServer(FLAGS.BOT_TRANSLATION_ENABLED, language).catch(() => true);
  if (!enabled) return text;

  // Skip very short messages or messages that are mostly formatting/emoji
  if (text.length < 5) return text;

  const cacheKey = `${language}:${text}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.text;
  }

  try {
    const anthropic = getClient();
    const langName = SUPPORTED_LANGUAGES[language];

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `You translate WhatsApp bot messages from English to ${langName}. Keep it natural and conversational. Preserve any *bold* or _italic_ WhatsApp formatting. Preserve emojis. Return ONLY the translation, nothing else.`,
      messages: [{ role: 'user', content: text }],
    });

    const translated = response.content[0].type === 'text' ? response.content[0].text.trim() : text;

    // Cache result
    cache.set(cacheKey, { text: translated, expiry: Date.now() + CACHE_TTL });

    // Prune cache
    if (cache.size > 300) {
      const now = Date.now();
      for (const [key, val] of cache) {
        if (val.expiry < now) cache.delete(key);
      }
    }

    return translated;
  } catch {
    return text;
  }
}

/**
 * Detect the language of a user's message.
 * Uses keyword-based detection first (fast, free), falls back to LLM for ambiguous cases.
 */
export async function detectLanguage(text: string): Promise<string> {
  const lower = text.toLowerCase().trim();

  // Quick keyword-based detection (free, instant)
  const pidginMarkers = /\b(abeg|wetin|dey|na|sef|sha|joor|wahala|bros|oga|shey|abi|dis|dat|wan|don|nor|una|dem|im|e be|make|no vex)\b/i;
  const yorubaMarkers = /\b(bawo|se|ojo|eku|ekaaro|ekale|ekasan|pele|jowo|owo|omo|oga mi|baba|iya)\b/i;
  const igboMarkers = /\b(kedu|biko|ndewo|nnoo|daalu|nwanne|onye|obi|ulo|nke|oge)\b/i;
  const hausaMarkers = /\b(sannu|ina|yaya|barka|nagode|aboki|dan|kai|wane|mun|zan)\b/i;
  const twiMarkers = /\b(maakye|maaha|meda|wo ho|me din|mepa|yoo|wo|me|anka|na)\b/i;
  const frenchMarkers = /\b(bonjour|merci|oui|non|comment|je|vous|est-ce|s'il vous|bonsoir|salut)\b/i;

  if (pidginMarkers.test(lower)) return 'pcm';
  if (yorubaMarkers.test(lower)) return 'yo';
  if (igboMarkers.test(lower)) return 'ig';
  if (hausaMarkers.test(lower)) return 'ha';
  if (twiMarkers.test(lower)) return 'tw';
  if (frenchMarkers.test(lower)) return 'fr';

  // If text is short or clearly English, skip LLM
  if (lower.length < 10 || /^[a-z0-9\s.,!?'"-]+$/i.test(lower)) return 'en';

  // LLM fallback for ambiguous text
  try {
    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system: `Detect the language of this text. Reply with ONLY the language code: en, pcm (Nigerian Pidgin), yo (Yoruba), ig (Igbo), ha (Hausa), tw (Twi), fr (French). If unsure, reply "en".`,
      messages: [{ role: 'user', content: text }],
    });
    const code = response.content[0].type === 'text' ? response.content[0].text.trim().toLowerCase() : 'en';
    return SUPPORTED_LANGUAGES[code] ? code : 'en';
  } catch {
    return 'en';
  }
}

/**
 * Check if a language code is supported for translation.
 */
export function isSupportedLanguage(lang: string): boolean {
  return lang in SUPPORTED_LANGUAGES;
}

/**
 * Get the display name for a language code.
 */
export function getLanguageName(lang: string): string {
  return SUPPORTED_LANGUAGES[lang] || 'English';
}
