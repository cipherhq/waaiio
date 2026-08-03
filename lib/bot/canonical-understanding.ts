/**
 * CAS-004 — ONE canonical understanding function for business messages.
 *
 * Used by BOTH new-session and resumed-session paths.
 * Produces: semanticFamily, requestedAction, confidence, language, entities.
 *
 * Pipeline:
 * 1. Language entitlement check (deterministic detection first)
 * 2. Deterministic regex parse
 * 3. LLM hybrid (if entitled + regex not confident)
 * 4. LLM language validation (invalid → discard LLM semantic result)
 * 5. Canonical result with real confidence
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SemanticFamily, RequestedAction } from './semantic-types';
import { getEffectiveLanguages, loadBusinessLanguages, detectLanguageDeterministic } from './language-policy';
import type { LanguageEntitlement } from './language-policy';
import { logger } from '@/lib/logger';

export interface CanonicalUnderstanding {
  broadIntent: string | null;
  semanticFamily: SemanticFamily;
  requestedAction: RequestedAction;
  confidence: number;
  language: string | null;
  entities: {
    serviceKeywords: string[];
    date: string | null;
    specificTime: string | null;
    timePreference: string | null;
    quantity: number | null;
    amount: number | null;
    variantKeywords: string[];
  };
  source: 'regex' | 'llm' | 'hybrid';
  languageEntitlement: LanguageEntitlement;
  /** If true, the detected language is not entitled — caller must recover */
  languageBlocked: boolean;
  /** Actual allowed languages for the business (for recovery messages) */
  allowedLanguageNames?: string[];
}

const EMPTY_ENTITIES = { serviceKeywords: [] as string[], date: null, specificTime: null, timePreference: null, quantity: null, amount: null, variantKeywords: [] as string[] };
const FREE_ENTITLEMENT: LanguageEntitlement = { allowedLanguages: ['en'], llmAllowed: false, translationAllowed: false };

const EMPTY_RESULT: CanonicalUnderstanding = {
  broadIntent: null, semanticFamily: null, requestedAction: null,
  confidence: 0, language: null, entities: EMPTY_ENTITIES, source: 'regex',
  languageEntitlement: FREE_ENTITLEMENT, languageBlocked: false,
};

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', pcm: 'Nigerian Pidgin', yo: 'Yoruba', ig: 'Igbo',
  ha: 'Hausa', tw: 'Twi', fr: 'French', es: 'Spanish',
};

/**
 * Produce ONE canonical understanding of a business-scoped customer message.
 */
export async function understandCanonicalMessage(params: {
  text: string;
  businessId: string;
  businessCategory: string | null;
  subscriptionTier: string;
  supabase: SupabaseClient;
  timezone?: string;
}): Promise<CanonicalUnderstanding> {
  const { text, businessId, businessCategory, subscriptionTier, supabase, timezone } = params;

  if (!text || text.length < 2) return EMPTY_RESULT;

  try {
    // 1. Language entitlement
    const configuredLangs = await loadBusinessLanguages(supabase, businessId);
    const langEntitlement = getEffectiveLanguages(subscriptionTier, configuredLangs);
    const allowedNames = langEntitlement.allowedLanguages.map(c => LANGUAGE_NAMES[c] || c);

    // 2. Deterministic language detection (no LLM cost)
    const detectedLang = detectLanguageDeterministic(text);

    // 3. Language entitlement for clearly detected non-English
    if (detectedLang && detectedLang !== 'en' && !langEntitlement.allowedLanguages.includes(detectedLang)) {
      return {
        ...EMPTY_RESULT, language: detectedLang,
        languageEntitlement: langEntitlement, languageBlocked: true,
        allowedLanguageNames: allowedNames,
      };
    }

    // 4. Deterministic semantic parse (always runs — free for all tiers)
    const { parseSmartIntent } = await import('./smart-intent');
    const regexResult = parseSmartIntent(text, timezone);

    // Build entity object from regex
    const regexEntities = {
      serviceKeywords: regexResult.serviceKeywords,
      date: regexResult.date, specificTime: regexResult.specificTime,
      timePreference: regexResult.timePreference, quantity: regexResult.quantity,
      amount: regexResult.amount, variantKeywords: regexResult.variantKeywords,
    };

    // 5. If regex is confident (intent + service keywords), use it
    if (regexResult.intent && regexResult.serviceKeywords.length > 0) {
      return {
        broadIntent: regexResult.intent,
        semanticFamily: regexResult.semanticFamily || null,
        requestedAction: regexResult.requestedAction || null,
        confidence: 0.90,
        language: detectedLang || 'en',
        entities: regexEntities, source: 'regex',
        languageEntitlement: langEntitlement, languageBlocked: false,
        allowedLanguageNames: allowedNames,
      };
    }

    // 6. If regex found some intent (without keywords) for Free tier, return it
    if (!langEntitlement.llmAllowed) {
      return {
        broadIntent: regexResult.intent,
        semanticFamily: regexResult.semanticFamily || null,
        requestedAction: regexResult.requestedAction || null,
        confidence: regexResult.intent ? 0.70 : 0.30,
        language: detectedLang || 'en',
        entities: regexEntities, source: 'regex',
        languageEntitlement: langEntitlement, languageBlocked: false,
        allowedLanguageNames: allowedNames,
      };
    }

    // 7. LLM hybrid fallback (Growth/Business only)
    const { parseSmartIntentHybrid } = await import('./smart-intent');
    const hybridResult = await parseSmartIntentHybrid(
      text, businessCategory, supabase, businessId, timezone, subscriptionTier,
    );

    const llmConfidence = ('confidence' in hybridResult && typeof hybridResult.confidence === 'number')
      ? hybridResult.confidence : (hybridResult.intent ? 0.70 : 0.30);
    const llmLang = ('language' in hybridResult) ? hybridResult.language as string | null : detectedLang;

    // 8. CRITICAL: If LLM language is invalid/null, DO NOT use LLM semantics
    if (llmLang === null) {
      // LLM returned invalid language — discard its semantic result
      return {
        ...EMPTY_RESULT,
        language: null,
        confidence: 0.20, // very low — unknown language means unknown meaning
        languageEntitlement: langEntitlement, languageBlocked: false,
        allowedLanguageNames: allowedNames,
      };
    }

    // 9. Validate LLM-detected language against entitlement
    if (llmLang !== 'en' && !langEntitlement.allowedLanguages.includes(llmLang)) {
      return {
        ...EMPTY_RESULT, language: llmLang,
        languageEntitlement: langEntitlement, languageBlocked: true,
        allowedLanguageNames: allowedNames,
      };
    }

    // 10. LLM result is valid and entitled — use it
    return {
      broadIntent: hybridResult.intent,
      semanticFamily: hybridResult.semanticFamily || null,
      requestedAction: hybridResult.requestedAction || null,
      confidence: llmConfidence,
      language: llmLang,
      entities: {
        serviceKeywords: hybridResult.serviceKeywords,
        date: hybridResult.date, specificTime: hybridResult.specificTime,
        timePreference: hybridResult.timePreference, quantity: hybridResult.quantity,
        amount: hybridResult.amount, variantKeywords: hybridResult.variantKeywords,
      },
      source: ('llmUsed' in hybridResult && hybridResult.llmUsed) ? 'llm' : 'regex',
      languageEntitlement: langEntitlement, languageBlocked: false,
      allowedLanguageNames: allowedNames,
    };
  } catch (err) {
    logger.warn('[CANONICAL] Understanding error (non-fatal):', err);
    return EMPTY_RESULT;
  }
}
