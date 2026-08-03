/**
 * CAS-004 — ONE canonical understanding function for business messages.
 *
 * Used by BOTH new-session and resumed-session paths.
 * Produces: semanticFamily, requestedAction, confidence, language, entities.
 *
 * Pipeline:
 * 1. Language entitlement check
 * 2. Deterministic regex parse
 * 3. LLM hybrid (if entitled + needed)
 * 4. Canonical result with real confidence
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
}

const EMPTY_RESULT: CanonicalUnderstanding = {
  broadIntent: null,
  semanticFamily: null,
  requestedAction: null,
  confidence: 0,
  language: 'en',
  entities: { serviceKeywords: [], date: null, specificTime: null, timePreference: null, quantity: null, amount: null, variantKeywords: [] },
  source: 'regex',
  languageEntitlement: { allowedLanguages: ['en'], llmAllowed: false, translationAllowed: false },
  languageBlocked: false,
};

/**
 * Produce ONE canonical understanding of a business-scoped customer message.
 *
 * This is the SINGLE entry point for semantic understanding.
 * Both new-session and resumed-session paths must use this.
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

    // 2. Deterministic language detection (no LLM cost)
    const detectedLang = detectLanguageDeterministic(text);

    // 3. Check language entitlement for clearly detected non-English
    if (detectedLang !== 'en' && !langEntitlement.allowedLanguages.includes(detectedLang)) {
      return {
        ...EMPTY_RESULT,
        language: detectedLang,
        languageEntitlement: langEntitlement,
        languageBlocked: true,
      };
    }

    // 4. Deterministic semantic parse (always runs — free for all tiers)
    const { parseSmartIntent } = await import('./smart-intent');
    const regexResult = parseSmartIntent(text, timezone);

    // 5. If regex is confident (intent + service keywords), use it
    if (regexResult.intent && regexResult.serviceKeywords.length > 0) {
      return {
        broadIntent: regexResult.intent,
        semanticFamily: regexResult.semanticFamily || null,
        requestedAction: regexResult.requestedAction || null,
        confidence: 0.90,
        language: detectedLang,
        entities: {
          serviceKeywords: regexResult.serviceKeywords,
          date: regexResult.date,
          specificTime: regexResult.specificTime,
          timePreference: regexResult.timePreference,
          quantity: regexResult.quantity,
          amount: regexResult.amount,
          variantKeywords: regexResult.variantKeywords,
        },
        source: 'regex',
        languageEntitlement: langEntitlement,
        languageBlocked: false,
      };
    }

    // 6. LLM hybrid fallback (only if entitled)
    if (langEntitlement.llmAllowed) {
      const { parseSmartIntentHybrid } = await import('./smart-intent');
      const hybridResult = await parseSmartIntentHybrid(
        text, businessCategory, supabase, businessId, timezone, subscriptionTier,
      );

      const llmConfidence = ('confidence' in hybridResult && typeof hybridResult.confidence === 'number')
        ? hybridResult.confidence : (hybridResult.intent ? 0.70 : 0.30);
      const llmLang = ('language' in hybridResult) ? hybridResult.language as string | null : detectedLang;

      // Validate LLM-detected language against entitlement BEFORE using result
      if (llmLang && llmLang !== 'en' && !langEntitlement.allowedLanguages.includes(llmLang)) {
        return {
          ...EMPTY_RESULT,
          language: llmLang,
          languageEntitlement: langEntitlement,
          languageBlocked: true,
        };
      }

      return {
        broadIntent: hybridResult.intent,
        semanticFamily: hybridResult.semanticFamily || null,
        requestedAction: hybridResult.requestedAction || null,
        confidence: llmConfidence,
        language: llmLang || detectedLang,
        entities: {
          serviceKeywords: hybridResult.serviceKeywords,
          date: hybridResult.date,
          specificTime: hybridResult.specificTime,
          timePreference: hybridResult.timePreference,
          quantity: hybridResult.quantity,
          amount: hybridResult.amount,
          variantKeywords: hybridResult.variantKeywords,
        },
        source: ('llmUsed' in hybridResult && hybridResult.llmUsed) ? 'llm' : 'regex',
        languageEntitlement: langEntitlement,
        languageBlocked: false,
      };
    }

    // 7. Free tier / no LLM — use regex-only result
    return {
      broadIntent: regexResult.intent,
      semanticFamily: regexResult.semanticFamily || null,
      requestedAction: regexResult.requestedAction || null,
      confidence: regexResult.intent ? 0.70 : 0.30,
      language: detectedLang,
      entities: {
        serviceKeywords: regexResult.serviceKeywords,
        date: regexResult.date,
        specificTime: regexResult.specificTime,
        timePreference: regexResult.timePreference,
        quantity: regexResult.quantity,
        amount: regexResult.amount,
        variantKeywords: regexResult.variantKeywords,
      },
      source: 'regex',
      languageEntitlement: langEntitlement,
      languageBlocked: false,
    };
  } catch (err) {
    logger.warn('[CANONICAL] Understanding error (non-fatal):', err);
    return EMPTY_RESULT;
  }
}
