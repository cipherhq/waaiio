import type { SupabaseClient } from '@supabase/supabase-js';
import { getFlowCopy } from '@/lib/bot/flows/flow-localization';
import { logger } from '@/lib/logger';

// Types
export interface TranslationOverrides {
  business: Map<string, string>;  // keyed by "lang.key"
  platform: Map<string, string>;  // keyed by "lang.key"
}

// Platform overrides cache (short-lived, shared across sessions)
let platformOverridesCache: Map<string, string> | null = null;
let platformOverridesCacheTime = 0;
const PLATFORM_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Load platform overrides from the database.
 * Uses a short in-memory cache (60s) to avoid repeated DB hits.
 */
export async function loadPlatformOverrides(
  supabase: SupabaseClient,
): Promise<Map<string, string>> {
  const now = Date.now();
  if (platformOverridesCache && now - platformOverridesCacheTime < PLATFORM_CACHE_TTL_MS) {
    return platformOverridesCache;
  }
  try {
    const { data, error } = await supabase
      .from('bot_translation_platform_overrides')
      .select('lang, key, value');
    if (error) throw error;
    const map = new Map<string, string>();
    for (const row of data || []) {
      map.set(`${row.lang}.${row.key}`, row.value);
    }
    platformOverridesCache = map;
    platformOverridesCacheTime = now;
    return map;
  } catch (err) {
    logger.warn('[TRANSLATIONS] Failed to load platform overrides:', err);
    return platformOverridesCache || new Map();
  }
}

/** Invalidate the platform overrides cache (call after admin save). */
export function invalidatePlatformOverridesCache(): void {
  platformOverridesCache = null;
  platformOverridesCacheTime = 0;
}

/**
 * Load business-specific translation overrides.
 * Called once per session.
 */
export async function loadBusinessOverrides(
  supabase: SupabaseClient,
  businessId: string,
): Promise<Map<string, string>> {
  try {
    const { data, error } = await supabase
      .from('bot_translation_overrides')
      .select('lang, key, value')
      .eq('business_id', businessId);
    if (error) throw error;
    const map = new Map<string, string>();
    for (const row of data || []) {
      map.set(`${row.lang}.${row.key}`, row.value);
    }
    return map;
  } catch (err) {
    logger.warn('[TRANSLATIONS] Failed to load business overrides:', err);
    return new Map();
  }
}

/**
 * 4-layer translation resolution:
 * 1. Business override
 * 2. Platform override
 * 3. Code default (flow-localization.ts)
 * 4. English fallback (handled by getFlowCopy)
 */
export function getTranslation(
  overrides: TranslationOverrides | null,
  lang: string,
  key: string,
): string {
  const lookupKey = `${lang}.${key}`;

  // Layer 1: Business override
  const bizOverride = overrides?.business.get(lookupKey);
  if (bizOverride) return bizOverride;

  // Layer 2: Platform override
  const platformOverride = overrides?.platform.get(lookupKey);
  if (platformOverride) return platformOverride;

  // Layer 3+4: Code default with English fallback
  return getFlowCopy(lang, key);
}

/**
 * 4-layer translation with placeholder interpolation.
 */
export function fillTranslation(
  overrides: TranslationOverrides | null,
  lang: string,
  key: string,
  values: Record<string, string | number>,
): string {
  let text = getTranslation(overrides, lang, key);
  for (const [k, v] of Object.entries(values)) {
    text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return text;
}
