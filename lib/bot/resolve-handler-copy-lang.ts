/**
 * Canonical copy-language resolver for handlers (#561-C).
 *
 * Extracted from BotService so the production authority seam is testable.
 * BotService.resolveHandlerCopyLang delegates directly to this function.
 *
 * Uses the same resolveEffectiveResponseLanguage authority as the executor.
 */
import { getEffectiveLanguages, loadBusinessLanguages } from './language-policy';
import {
  resolveEffectiveResponseLanguage,
  readPreferredResponseLanguage,
} from './language-preference';
import { CERTIFIED_LANGUAGES } from './languages';

interface HandlerCopyLangInput {
  /** Supabase client for DB lookups */
  supabase: unknown;
  /** Session business ID (null = English fallback) */
  businessId: string | null;
  /** Session user ID for remembered preference lookup */
  userId: string | null;
  /** The canonical activated session response language (_detected_language) */
  sessionLanguage: string | null;
}

/**
 * Resolve the deterministic copy language for handler functions.
 *
 * Reads:
 * - Business tier + configured languages → entitlement
 * - Remembered preference from profiles.preferred_response_language
 * - Session language (_detected_language — canonical activated, not raw detection)
 *
 * Passes all through resolveEffectiveResponseLanguage with CERTIFIED_LANGUAGES.
 * Fails closed to English on any error.
 */
export async function resolveHandlerCopyLang(input: HandlerCopyLangInput): Promise<string> {
  if (!input.businessId) return 'en';
  try {
    const supabase = input.supabase as import('@supabase/supabase-js').SupabaseClient;
    const configuredLangs = await loadBusinessLanguages(supabase, input.businessId);

    // Read business tier
    let tier = 'free';
    try {
      const { data } = await supabase
        .from('businesses')
        .select('subscription_tier')
        .eq('id', input.businessId)
        .single();
      tier = (data?.subscription_tier as string) || 'free';
    } catch { /* fall through to free */ }

    const entitlement = getEffectiveLanguages(tier, configuredLangs);

    // Read remembered preference
    let rememberedLang: string | null = null;
    if (input.userId) {
      rememberedLang = await readPreferredResponseLanguage(
        supabase as never,
        input.userId,
      );
    }

    return resolveEffectiveResponseLanguage({
      explicitLanguage: null,
      sessionLanguage: input.sessionLanguage,
      rememberedLanguage: rememberedLang,
      entitlement,
      certifiedLanguages: CERTIFIED_LANGUAGES,
    }).language;
  } catch {
    return 'en';
  }
}
