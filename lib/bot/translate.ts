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
