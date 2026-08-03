/**
 * CAS-004 — Canonical language entitlement policy.
 * One shared decision for all language-dependent behavior:
 * intent LLM use, translation, language activation, language switching.
 *
 * Feature flags remain additional kill switches — NOT entitlement.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

/** All Waaiio production-certified supported languages */
export const SUPPORTED_LANGUAGES = ['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es'] as const;
export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

/** Maximum additional languages for Growth tier (beyond English) */
const GROWTH_MAX_ADDITIONAL = 2;

export interface LanguageEntitlement {
  /** Languages the business is entitled to use */
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
    // Growth: English + up to 2 configured languages
    const configured = (configuredLanguages || ['en']).filter(
      l => SUPPORTED_LANGUAGES.includes(l as SupportedLanguage)
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

  // Only explicitly recognized Business tier gets all languages.
  // Unknown/malformed tiers fail closed to Free.
  if (tier === 'business') {
    return {
      allowedLanguages: [...SUPPORTED_LANGUAGES],
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
  yo: [/\b(bawo|eku|ekaaro|ekale|ekasan|pele|jowo|omo)\b/i],
  ha: [/\b(sannu|ina|yaya|barka|nagode|aboki)\b/i],
  ig: [/\b(kedu|biko|ndewo|nnoo|daalu|nwanne)\b/i],
  tw: [/\b(maakye|maaha|meda|wo\s+ho|mepa)\b/i],
  fr: [/\b(bonjour|merci|oui|s'il\s+vous|bonsoir|salut|je\s+veux|comment)\b/i],
  es: [/\b(hola|gracias|por\s+favor|buenos|quiero|necesito|reservar)\b/i],
};

/**
 * Fast deterministic language detection — no LLM cost.
 * Returns detected language code, or null if uncertain.
 * Does NOT default to 'en' — caller must handle uncertainty.
 */
export function detectLanguageDeterministic(text: string): string | null {
  for (const [lang, patterns] of Object.entries(LANGUAGE_MARKERS)) {
    if (patterns.some(p => p.test(text))) return lang;
  }
  // No non-English markers found — could be English or unrecognized language
  // Only classify as English if text contains clear English markers
  if (/^[a-zA-Z0-9\s.,!?'"@#$%&*()\-_+=;:<>/\\[\]{}|~`]+$/.test(text) && text.length >= 3) {
    return 'en';
  }
  return null; // uncertain
}
