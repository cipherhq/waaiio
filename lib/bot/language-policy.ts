/**
 * CAS-004 — Canonical language entitlement policy.
 * One shared decision for all language-dependent behavior:
 * intent LLM use, translation, language activation, language switching.
 *
 * Feature flags remain additional kill switches — NOT entitlement.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import {
  CERTIFIED_LANGUAGES,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from './languages';

export { CERTIFIED_LANGUAGES, SUPPORTED_LANGUAGES };
export type { SupportedLanguage };

/**
 * Production-certified languages — passed linguistic quality certification.
 * Architecture may support more codes, but only certified languages are
 * selectable in UI and activatable in production.
 * Expand after controlled language-quality acceptance testing.
 */
/**
 * Production-certified = English only until separate linguistic certification.
 * Architecture supports more codes (en, pcm, yo, ig, ha, tw, fr, es) but
 * only certified languages are selectable in UI and activatable in production.
 */

/** Maximum additional languages for Growth tier (beyond English) */
const GROWTH_MAX_ADDITIONAL = 2;

/** Tiers explicitly recognized as eligible for paid LLM fallback */
const RECOGNIZED_LLM_TIERS = ['growth', 'business'];

/**
 * ONE authority for LLM eligibility by subscription tier.
 * Unknown/null/undefined → not eligible (Free behavior).
 * Feature flags are additional kill switches, not entitlement.
 */
export function isTierLLMEligible(tier: string | null | undefined): boolean {
  return !!tier && RECOGNIZED_LLM_TIERS.includes(tier);
}

export interface LanguageEntitlement {
  /**
   * Languages the business is entitled to ACTIVELY RESPOND/translate in.
   * This is not an inbound-comprehension allowlist: supported customer
   * messages may still be understood without enabling translated replies.
   */
  allowedLanguages: string[];
  /** Whether paid LLM services are available */
  llmAllowed: boolean;
  /** Whether translation is available */
  translationAllowed: boolean;
}

/**
 * Determine effective allowed languages for a business.
 * Single canonical function — use everywhere.
 */
export function getEffectiveLanguages(
  subscriptionTier: string,
  configuredLanguages?: string[] | null,
): LanguageEntitlement {
  const tier = subscriptionTier || 'free';

  if (tier === 'free') {
    return {
      allowedLanguages: ['en'],
      llmAllowed: false,
      translationAllowed: false,
    };
  }

  if (tier === 'growth') {
    // Growth: English + up to 2 configured CERTIFIED languages
    const configured = (configuredLanguages || ['en']).filter(
      l => CERTIFIED_LANGUAGES.includes(l)
    );
    // Always include English
    const langs = new Set(['en', ...configured]);
    // Enforce max: en + 2 additional
    const allowed = ['en'];
    for (const l of langs) {
      if (l === 'en') continue;
      if (allowed.length >= 1 + GROWTH_MAX_ADDITIONAL) break;
      allowed.push(l);
    }
    return {
      allowedLanguages: allowed,
      llmAllowed: true,
      translationAllowed: true,
    };
  }

  // Only explicitly recognized Business tier gets all certified languages.
  // Unknown/malformed tiers fail closed to Free.
  if (tier === 'business') {
    return {
      allowedLanguages: [...CERTIFIED_LANGUAGES],
      llmAllowed: true,
      translationAllowed: true,
    };
  }

  // Unknown tier → fail closed to Free
  return {
    allowedLanguages: ['en'],
    llmAllowed: false,
    translationAllowed: false,
  };
}

/**
 * Check if a specific language is allowed for this business.
 */
export function isLanguageEntitled(
  language: string,
  entitlement: LanguageEntitlement,
): boolean {
  return entitlement.allowedLanguages.includes(language);
}

/**
 * Load the business's configured languages from ai_conversation_config.
 * Returns null if no config exists (business uses defaults).
 */
export async function loadBusinessLanguages(
  supabase: SupabaseClient,
  businessId: string,
): Promise<string[] | null> {
  try {
    const { data } = await supabase
      .from('ai_conversation_config')
      .select('enabled_languages')
      .eq('business_id', businessId)
      .maybeSingle();
    return data?.enabled_languages || null;
  } catch (err) {
    logger.warn('[LANGUAGE-POLICY] Failed to load business languages:', err);
    return null;
  }
}

/** Deterministic language markers — no LLM needed */
const LANGUAGE_MARKERS: Record<string, RegExp[]> = {
  pcm: [
    /\b(abeg|wetin|dey|sef|sha|joor|wahala|bros|oga|shey|abi|dis|dat|nor|una|dem|im|e\s+be|no\s+vex|i\s+wan|make\s+i)\b/i,
  ],
  yo: [
    /\b(bawo|eku|ekaaro|ekale|ekasan|pele|jowo|omo)\b/i,
    /\bmo\s+(fe|nilo)\b/i,
    /\be\s+jowo\b/i,
  ],
  ha: [
    /\b(sannu|ina|yaya|barka|nagode|aboki)\b/i,
    /\bina\s+(son|so)\b/i,
  ],
  ig: [
    /\b(kedu|biko|ndewo|nnoo|daalu|nwanne)\b/i,
    /\bachoro\s+m\b/i,
  ],
  tw: [
    /\b(maakye|maaha|meda|wo\s+ho|mepa)\b/i,
    /\bmepe\s+se\b/i,
  ],
  fr: [/\b(bonjour|merci|oui|s'il\s+vous|bonsoir|salut|je\s+veux|comment)\b/i],
  es: [/\b(hola|gracias|por\s+favor|buenos|quiero|necesito|reservar)\b/i],
};

/**
 * Fast deterministic language detection — no LLM cost.
 * Returns detected language code, or null if uncertain.
 * Does NOT default to 'en' — caller must handle uncertainty.
 */
export function detectLanguageDeterministic(text: string): string | null {
  // Normalize diacritics so natural Yoruba/French/Spanish input is detected
  // consistently while preserving the original message for downstream parsing.
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // NFD does not decompose a few common Hausa/Twi letters.
    .replace(/[ƙƘ]/g, 'k')
    .replace(/[ɛƐ]/g, 'e')
    .replace(/[ɔƆ]/g, 'o')
    .toLowerCase();

  // Check distinct non-Pidgin languages before Pidgin. Pidgin deliberately
  // contains English-like/West-African markers such as "una" that can collide
  // with ordinary Spanish words ("una"). A strong language marker wins first.
  const detectionOrder = ['yo', 'ha', 'ig', 'tw', 'fr', 'es', 'pcm'];
  for (const lang of detectionOrder) {
    const patterns = LANGUAGE_MARKERS[lang] || [];
    if (patterns.some(p => p.test(normalized))) return lang;
  }
  // No non-English markers found. Could be English or unrecognized.
  // Do NOT assume ASCII = English. Return null for uncertain.
  // Callers handle uncertainty per tier policy.
  return null;
}
