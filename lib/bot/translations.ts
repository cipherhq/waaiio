/**
 * 4-layer translation resolution via AsyncLocalStorage.
 *
 * Layers (checked in order by getFlowCopy/fillFlowCopy):
 *   1. Business override   (bot_translation_overrides)
 *   2. Platform override    (bot_translation_platform_overrides)
 *   3. Code default         (FLOW_COPY in flow-localization.ts)
 *   4. English fallback     (FLOW_COPY.en)
 *
 * Usage:
 *   const overrides = { business: await loadBusinessOverrides(...), platform: await loadPlatformOverrides(...) };
 *   await runWithTranslationOverrides(overrides, async () => {
 *     // All getFlowCopy/fillFlowCopy calls inside here check the store first.
 *   });
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { _setOverrideResolver } from '@/lib/bot/flows/flow-localization';

// ── Types ───────────────────────────────────────────────────────

export interface TranslationOverrides {
  business: Map<string, string>;  // keyed by "lang.key"
  platform: Map<string, string>;  // keyed by "lang.key"
}

// ── AsyncLocalStorage store ─────────────────────────────────────

const translationStore = new AsyncLocalStorage<TranslationOverrides>();

// Register the ALS resolver with flow-localization.ts (server-only).
// This avoids flow-localization.ts importing node:async_hooks.
_setOverrideResolver(() => translationStore.getStore() ?? null);

/**
 * Read the current request's translation overrides from the ALS store.
 * Returns null when called outside runWithTranslationOverrides.
 */
export function getTranslationOverrides(): TranslationOverrides | null {
  return translationStore.getStore() ?? null;
}

/**
 * Execute `fn` with translation overrides available to every
 * getFlowCopy / fillFlowCopy call within the async scope.
 */
export function runWithTranslationOverrides<T>(
  overrides: TranslationOverrides,
  fn: () => T,
): T {
  return translationStore.run(overrides, fn);
}

// ── Platform overrides cache ────────────────────────────────────

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

// ── Business-editable key allowlist ─────────────────────────────

/**
 * Prefixes of flow-copy keys a business may override.
 * Everything not matching is platform-only.
 *
 * Allowed: greetings (except branding), menu/capability labels, language picker.
 * Platform-only: payment.*, bank-transfer.*, refund.*, error.*, docs.*,
 * notification.*, handoff.*, savedcard.*, chat.*, confirm.*, post.*,
 * booking.*, ordering.*, ticketing.*, reservation.*, recurring.*,
 * invoice.*, survey.*, poll.*, queue.*, waitlist.*, crowdfunding.*,
 * loyalty.*, rsvp.*, feedback.*, tips.*, orders.*, order_status.*,
 * rating.*, nav.*, account.*, greeting.powered_by (branding).
 */
export const BUSINESS_EDITABLE_PREFIXES = [
  'cap.',           // capability/menu option labels
  'greeting.',      // bot greetings (except platform-only keys below)
  'lang.picker_',   // language picker strings
  'menu.',          // menu title
] as const;

const BUSINESS_EDITABLE_EXACT: string[] = [];

/**
 * Keys that match an editable prefix but are platform-only.
 * This deny list wins over BUSINESS_EDITABLE_PREFIXES.
 */
export const PLATFORM_ONLY_KEYS: readonly string[] = [
  'greeting.powered_by',  // Branding — Owner rule: never business-editable
];

/** Check if a key is editable by businesses. */
export function isBusinessEditableKey(key: string): boolean {
  if (PLATFORM_ONLY_KEYS.includes(key)) return false;
  if (BUSINESS_EDITABLE_EXACT.includes(key)) return true;
  return BUSINESS_EDITABLE_PREFIXES.some(prefix => key.startsWith(prefix));
}
