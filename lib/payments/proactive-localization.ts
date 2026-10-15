/**
 * Proactive Localization Helper — Slice 5A (#524)
 *
 * Resolves the customer's response language and builds a TranslationContext
 * for proactive/webhook-triggered sends that occur outside the live bot session.
 *
 * Language precedence (via existing resolveEffectiveResponseLanguage):
 *   1. sessionLanguage: _detected_language from an active, non-expired session
 *      matching the EXACT (whatsapp_number, business_id) pair
 *   2. rememberedLanguage: profiles.preferred_response_language
 *   3. Fallback: English (zero LLM calls)
 *
 * Every candidate must pass:
 *   - current business subscription tier entitlement
 *   - configured languages
 *   - CERTIFIED_LANGUAGES
 *
 * Language never selects/disambiguates a business.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { translateBotResponse, type TranslationContext, type TranslateOptions } from '@/lib/bot/translate';
import { getEffectiveLanguages, loadBusinessLanguages, CERTIFIED_LANGUAGES } from '@/lib/bot/language-policy';
import { resolveEffectiveResponseLanguage, readPreferredResponseLanguage } from '@/lib/bot/language-preference';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { logger } from '@/lib/logger';

export interface ProactiveLocalization {
  /** Resolved response language code (e.g. 'en', 'fr', 'pcm') */
  language: string;
  /** Translation context with entitlement — reuse with translateBotResponse */
  translationContext: TranslationContext;
  /**
   * Convenience: translate a string with explicit protected values.
   * Falls back to original text on any failure (fail-closed).
   */
  translate: (text: string, protectedValues?: string[]) => Promise<string>;
}

/**
 * Resolve proactive response language + build TranslationContext for a customer.
 *
 * Safe for webhook/cron/proactive paths where no live bot session exists in memory.
 * All DB lookups are scoped to the exact (customerPhone, businessId) pair.
 */
export async function resolveProactiveLocalization(
  supabase: SupabaseClient,
  customerPhone: string,
  businessId: string,
): Promise<ProactiveLocalization> {
  // 1. Load business tier + configured languages
  let tier = 'free';
  try {
    const { data: biz } = await supabase
      .from('businesses')
      .select('subscription_tier')
      .eq('id', businessId)
      .single();
    tier = biz?.subscription_tier || 'free';
  } catch { /* fail closed to free */ }

  const configuredLangs = await loadBusinessLanguages(supabase, businessId);
  const entitlement = getEffectiveLanguages(tier, configuredLangs);
  const tCtx: TranslationContext = { entitlement, businessId, supabase };

  // 2. Look up session language from EXACT (phone, business_id) active non-expired session
  let sessionLanguage: string | null = null;
  try {
    const phoneP = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
    const phoneN = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
    const now = new Date().toISOString();
    const { data: session } = await supabase
      .from('bot_sessions')
      .select('session_data')
      .or(`whatsapp_number.eq.${sanitizeFilterValue(phoneP)},whatsapp_number.eq.${sanitizeFilterValue(phoneN)}`)
      .eq('business_id', businessId)
      .eq('is_active', true)
      .gte('expires_at', now)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (session?.session_data) {
      sessionLanguage = (session.session_data as Record<string, unknown>)._detected_language as string || null;
    }
  } catch (err) {
    logger.warn('[PROACTIVE-L10N] Session language lookup failed (non-fatal):', err);
  }

  // 3. Look up remembered language from profiles
  let rememberedLanguage: string | null = null;
  try {
    const phoneP = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
    const phoneN = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
      .limit(1)
      .maybeSingle();
    if (profile?.id) {
      rememberedLanguage = await readPreferredResponseLanguage(supabase as never, profile.id);
    }
  } catch (err) {
    logger.warn('[PROACTIVE-L10N] Remembered language lookup failed (non-fatal):', err);
  }

  // 4. Resolve effective language via existing precedence engine
  const resolved = resolveEffectiveResponseLanguage({
    explicitLanguage: null,
    sessionLanguage,
    rememberedLanguage,
    entitlement,
    certifiedLanguages: CERTIFIED_LANGUAGES,
  });

  const language = resolved.language;

  // 5. Build convenience translate function
  const translate = async (text: string, protectedValues?: string[]): Promise<string> => {
    if (!language || language === 'en') return text;
    const opts: TranslateOptions | undefined = protectedValues?.length
      ? { protectedValues }
      : undefined;
    return translateBotResponse(text, language, tCtx, opts);
  };

  return { language, translationContext: tCtx, translate };
}
