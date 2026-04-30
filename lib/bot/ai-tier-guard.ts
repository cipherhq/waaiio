import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

/**
 * AI Feature Tier Limits
 *
 * Controls access to AI-powered features based on subscription tier.
 * Tracks monthly usage via ai_usage table.
 *
 * Features gated:
 * - voice_transcription: Whisper transcription of voice messages
 * - translation: Multi-language bot responses
 * - ai_fallback: LLM fallback when bot doesn't understand
 * - ace_setup: AI-powered business setup assistant
 */

interface TierLimits {
  voice_transcription: number; // 0 = disabled, -1 = unlimited
  translation: boolean;        // true/false
  max_languages: number;       // 1 = English only, 3 = English + 2, -1 = all
  ai_fallback: number;         // 0 = disabled, -1 = unlimited
  ace_setup: number;           // total lifetime calls (not monthly)
}

const TIER_LIMITS: Record<string, TierLimits> = {
  free: {
    voice_transcription: 0,
    translation: false,
    max_languages: 1,
    ai_fallback: 0,
    ace_setup: 3,
  },
  growth: {
    voice_transcription: 50,
    translation: true,
    max_languages: 3,
    ai_fallback: 30,
    ace_setup: 20,  // per month
  },
  business: {
    voice_transcription: -1,
    translation: true,
    max_languages: -1,
    ai_fallback: 200,
    ace_setup: -1,
  },
};

function getLimits(tier: string): TierLimits {
  return TIER_LIMITS[tier] || TIER_LIMITS.free;
}

/**
 * Check if a specific AI feature is allowed for this business's tier.
 * Returns { allowed: boolean, reason?: string }
 */
export async function checkAIFeature(
  supabase: SupabaseClient,
  businessId: string,
  tier: string,
  feature: 'voice_transcription' | 'translation' | 'ai_fallback' | 'ace_setup',
): Promise<{ allowed: boolean; reason?: string }> {
  const limits = getLimits(tier);

  // Quick check: is feature disabled for this tier?
  if (feature === 'voice_transcription' && limits.voice_transcription === 0) {
    return { allowed: false, reason: 'Voice messages require a Growth or Premium plan.' };
  }
  if (feature === 'translation' && !limits.translation) {
    return { allowed: false, reason: 'Multi-language responses require a Growth or Premium plan.' };
  }
  if (feature === 'ai_fallback' && limits.ai_fallback === 0) {
    return { allowed: false, reason: 'AI responses require a Growth or Premium plan.' };
  }

  // Unlimited? Allow immediately.
  const limit = feature === 'voice_transcription' ? limits.voice_transcription
    : feature === 'ai_fallback' ? limits.ai_fallback
    : feature === 'ace_setup' ? limits.ace_setup
    : -1;

  if (limit === -1) return { allowed: true };

  // Check usage
  const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
  const { data: usage } = await supabase
    .from('ai_usage')
    .select('voice_transcription_count, translation_count, ai_fallback_count, ace_setup_count')
    .eq('business_id', businessId)
    .eq('month_key', monthKey)
    .maybeSingle();

  const currentUsage = feature === 'voice_transcription' ? (usage?.voice_transcription_count || 0)
    : feature === 'ai_fallback' ? (usage?.ai_fallback_count || 0)
    : feature === 'ace_setup' ? (usage?.ace_setup_count || 0)
    : 0;

  if (currentUsage >= limit) {
    return { allowed: false, reason: `Monthly ${feature.replace('_', ' ')} limit reached (${limit}). Upgrade for more.` };
  }

  return { allowed: true };
}

/**
 * Increment usage counter for an AI feature.
 */
export async function incrementAIUsage(
  supabase: SupabaseClient,
  businessId: string,
  feature: 'voice_transcription' | 'translation' | 'ai_fallback' | 'ace_setup',
): Promise<void> {
  const monthKey = new Date().toISOString().slice(0, 7);
  const field = `${feature}_count`;

  try {
    // Upsert: create row if it doesn't exist, increment if it does
    const { data: existing } = await supabase
      .from('ai_usage')
      .select('id')
      .eq('business_id', businessId)
      .eq('month_key', monthKey)
      .maybeSingle();

    if (existing) {
      await supabase.rpc('increment_ai_usage', {
        p_business_id: businessId,
        p_month_key: monthKey,
        p_field: field,
      });
    } else {
      await supabase.from('ai_usage').insert({
        business_id: businessId,
        month_key: monthKey,
        [field]: 1,
      });
    }
  } catch (err) {
    // Non-blocking — don't fail the request if usage tracking fails
    logger.error('[AI-TIER] Usage increment error:', (err as Error).message);
  }
}

/**
 * Check if a language is allowed for this tier.
 * Free = English only. Growth = 3 languages. Premium = all.
 */
export function isLanguageAllowed(tier: string, langCode: string): boolean {
  if (langCode === 'en') return true; // English always allowed
  const limits = getLimits(tier);
  if (limits.max_languages === -1) return true; // Unlimited
  if (!limits.translation) return false; // No translation at all
  return true; // Growth allows translation (3 languages enforced elsewhere)
}

/**
 * Get the voice-not-supported message for free tier.
 */
export function getVoiceNotSupportedMessage(): string {
  return 'I can\'t process voice messages on your current plan. Please type your message instead, or ask the business to upgrade for voice support.';
}
