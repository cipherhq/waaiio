import Anthropic from '@anthropic-ai/sdk';
import { isFeatureEnabledServer, FLAGS } from '@/lib/posthog/flags';
import { checkRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

const SUPPORTED_LANGUAGES: Record<string, string> = {
  en: 'English',
  pcm: 'Nigerian Pidgin',
  yo: 'Yoruba',
  ig: 'Igbo',
  ha: 'Hausa',
  tw: 'Twi',
  fr: 'French',
  es: 'Spanish',
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
// Track translation calls per business (set by the bot before calling translate)
let _currentBusinessId: string | null = null;
let _currentSupabase: unknown = null;

/** Set the business context for AI usage tracking. Call before translateBotResponse. */
export function setTranslationContext(businessId: string | null, supabase: unknown): void {
  _currentBusinessId = businessId;
  _currentSupabase = supabase;
}

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

  // Template-aware caching: replace dynamic values (dates, times, amounts, names, ref codes)
  // with placeholders so the same template structure only gets translated once
  const replacements: string[] = [];
  const templateText = text
    .replace(/\b\d{1,2}:\d{2}\s*(AM|PM|am|pm)\b/g, (m) => { replacements.push(m); return `__V${replacements.length}__`; })
    .replace(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Tomorrow|Today)\b/gi, (m) => { replacements.push(m); return `__V${replacements.length}__`; })
    .replace(/\b\d{1,2}(st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*,?\s*\d{0,4}\b/gi, (m) => { replacements.push(m); return `__V${replacements.length}__`; })
    .replace(/[₦$£€¢]\s?[\d,]+(\.\d{2})?/g, (m) => { replacements.push(m); return `__V${replacements.length}__`; })
    .replace(/\b[A-Z]{2,4}-\d{3,5}\b/g, (m) => { replacements.push(m); return `__V${replacements.length}__`; });

  const cacheKey = `${language}:${templateText}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    // Re-insert original values
    let result = cached.text;
    replacements.forEach((val, i) => { result = result.replace(`__V${i + 1}__`, val); });
    return result;
  }

  try {
    // Rate limit: max 50 translation calls per minute globally
    const rl = checkRateLimit('translate-global', 50, 60_000);
    if (!rl.allowed) {
      logger.warn('[TRANSLATE] Rate limited — returning original text');
      return text;
    }

    const anthropic = getClient();
    const langName = SUPPORTED_LANGUAGES[language];

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `You translate WhatsApp bot messages from English to ${langName}. Keep it natural and conversational. Preserve any *bold* or _italic_ WhatsApp formatting. Preserve emojis. Return ONLY the translation, nothing else.`,
      messages: [{ role: 'user', content: templateText }],
    });

    // Log token usage for cost tracking
    const usage = response.usage;
    if (usage) {
      logger.info(`[AI-COST] translate(${language}): input=${usage.input_tokens} output=${usage.output_tokens}`);
    }

    const translatedTemplate = response.content[0].type === 'text' ? response.content[0].text.trim() : templateText;

    // Cache the translated template (with placeholders)
    cache.set(cacheKey, { text: translatedTemplate, expiry: Date.now() + CACHE_TTL });

    // Track AI usage for this business (non-blocking)
    if (_currentBusinessId && _currentSupabase) {
      const { incrementAIUsage } = await import('@/lib/bot/ai-tier-guard');
      incrementAIUsage(_currentSupabase as any, _currentBusinessId, 'translation').catch(() => {});
    }

    // Re-insert original values into translated text
    let translated = translatedTemplate;
    replacements.forEach((val, i) => { translated = translated.replace(`__V${i + 1}__`, val); });

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
  const spanishMarkers = /\b(hola|gracias|por favor|buenos|buenas|quiero|necesito|donde|cuando|como|tiene|puede|cita|reservar|cuanto|precio)\b/i;

  if (pidginMarkers.test(lower)) return 'pcm';
  if (yorubaMarkers.test(lower)) return 'yo';
  if (igboMarkers.test(lower)) return 'ig';
  if (hausaMarkers.test(lower)) return 'ha';
  if (twiMarkers.test(lower)) return 'tw';
  if (frenchMarkers.test(lower)) return 'fr';
  if (spanishMarkers.test(lower)) return 'es';

  // If text is short or clearly English, skip LLM
  if (lower.length < 10 || /^[a-z0-9\s.,!?'"-]+$/i.test(lower)) return 'en';

  // LLM fallback for ambiguous text
  try {
    // Rate limit: max 30 language detection calls per minute
    const rl = checkRateLimit('detect-lang-global', 30, 60_000);
    if (!rl.allowed) return 'en';

    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system: `Detect the language of this text. Reply with ONLY the language code: en, pcm (Nigerian Pidgin), yo (Yoruba), ig (Igbo), ha (Hausa), tw (Twi), fr (French), es (Spanish). If unsure, reply "en".`,
      messages: [{ role: 'user', content: text }],
    });

    // Log token usage for cost tracking
    if (response.usage) {
      logger.info(`[AI-COST] detect-lang: input=${response.usage.input_tokens} output=${response.usage.output_tokens}`);
    }

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
