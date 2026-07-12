import Anthropic from '@anthropic-ai/sdk';
import { checkRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export interface LLMIntentResult {
  flow: 'booking' | 'ordering' | 'payment' | 'ticketing' | null;
  entities: {
    serviceKeywords: string[];
    date: string | null;
    timePreference: string | null;
    quantity: number | null;
  };
  confidence: number;
  language: string;
}

const EMPTY_RESULT: LLMIntentResult = {
  flow: null,
  entities: { serviceKeywords: [], date: null, timePreference: null, quantity: null },
  confidence: 0,
  language: 'en',
};

// In-memory cache with TTL
const cache = new Map<string, { result: LLMIntentResult; expiry: number }>();
const CACHE_TTL = 5 * 60 * 1000;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const SYSTEM_PROMPT = `You classify WhatsApp messages for businesses in Nigeria and West Africa.

Given a user message and business category, return JSON only:
{"intent":"booking"|"ordering"|"payment"|"ticketing"|null,"entities":{"serviceKeywords":[],"date":null,"timePreference":null,"quantity":null},"confidence":0.0-1.0,"language":"en"|"pcm"|"yo"|"ig"|"ha"|"tw"|"fr"|"es"}

Rules:
- "booking" = appointments, reservations, check-ins, services
- "ordering" = buying products, food orders, delivery
- "payment" = paying bills, tithes, fees, donations, subscriptions
- "ticketing" = event tickets, movie tickets, transport tickets
- serviceKeywords: extract service/product names mentioned
- date: extract as YYYY-MM-DD if mentioned (resolve "tomorrow", "next monday" etc relative to today)
- timePreference: "morning"|"afternoon"|"evening" if mentioned
- quantity: number of people/items if mentioned
- confidence: how sure you are (0.0 to 1.0)
- language: detect the primary language (en=English, pcm=Pidgin, yo=Yoruba, ig=Igbo, ha=Hausa, tw=Twi, fr=French, es=Spanish)
- Return ONLY valid JSON, no explanation`;

export async function classifyWithLLM(
  message: string,
  businessCategory: string | null,
): Promise<LLMIntentResult> {
  const cacheKey = `${message.toLowerCase().trim()}:${businessCategory || ''}`;

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.result;
  }

  try {
    // Rate limit: max 30 LLM calls per minute globally
    const rl = checkRateLimit('llm-intent-global', 30, 60_000);
    if (!rl.allowed) {
      logger.warn('[LLM-INTENT] Rate limited — returning empty result');
      return EMPTY_RESULT;
    }

    const anthropic = getClient();
    const today = new Date().toISOString().split('T')[0];

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Business category: ${businessCategory || 'unknown'}\nToday's date: ${today}\nMessage: "${message}"`,
      }],
    });

    // Log token usage for cost tracking
    const usage = response.usage;
    if (usage) {
      logger.info(`[AI-COST] llm-intent: input=${usage.input_tokens} output=${usage.output_tokens}`);
    }

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const parsed = JSON.parse(text);

    const result: LLMIntentResult = {
      flow: ['booking', 'ordering', 'payment', 'ticketing'].includes(parsed.intent) ? parsed.intent : null,
      entities: {
        serviceKeywords: Array.isArray(parsed.entities?.serviceKeywords) ? parsed.entities.serviceKeywords : [],
        date: parsed.entities?.date || null,
        timePreference: parsed.entities?.timePreference || null,
        quantity: typeof parsed.entities?.quantity === 'number' ? parsed.entities.quantity : null,
      },
      confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0,
      language: parsed.language || 'en',
    };

    // Cache result
    cache.set(cacheKey, { result, expiry: Date.now() + CACHE_TTL });

    // Prune cache if too large
    if (cache.size > 500) {
      const now = Date.now();
      for (const [key, val] of cache) {
        if (val.expiry < now) cache.delete(key);
      }
    }

    return result;
  } catch (err) {
    logger.warn('[LLM-INTENT] Classification failed, returning empty:', err);
    return EMPTY_RESULT;
  }
}
