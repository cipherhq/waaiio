import type { SupabaseClient } from '@supabase/supabase-js';

// ── Types ─────────────────────────────────────────────────

interface QuickReply {
  trigger: string;
  label: string;
  response: string;
}

type KeywordScope = 'system' | 'category' | 'business';
type MatchType = 'exact' | 'contains' | 'starts_with' | 'regex';
type ActionType = 'reply' | 'start_flow' | 'start_capability' | 'url' | 'navigate_step' | 'acknowledge' | 'show_menu' | 'campaign_reply';

interface UnifiedKeyword {
  id: string;
  keyword: string;
  match_type: MatchType;
  action_type: ActionType;
  payload: string;
  priority: number;
  scope: KeywordScope;
  category: string | null;
  business_id: string | null;
  campaign_id: string | null;
  description: string | null;
}

/** @deprecated Use UnifiedKeyword instead */
interface BotKeyword {
  id: string;
  keyword: string;
  match_type: 'exact' | 'contains' | 'starts_with';
  action_type: 'reply' | 'start_flow' | 'start_capability' | 'url';
  payload: string;
  priority: number;
}

interface WelcomeButton {
  label: string;
  action: 'start_flow' | 'quick_reply' | 'url';
  payload?: string;
}

interface BotCustomConfig {
  quick_replies: QuickReply[];
  welcome_buttons: WelcomeButton[];
  default_reply: string | null;
}

// ── Cache ─────────────────────────────────────────────────

const SYSTEM_CACHE_TTL = 10 * 60 * 1000; // 10 min for system keywords
const CATEGORY_CACHE_TTL = 5 * 60 * 1000; // 5 min for category keywords
const BUSINESS_CACHE_TTL = 5 * 60 * 1000; // 5 min for business keywords
const CONFIG_CACHE_TTL = 5 * 60 * 1000;

const configCache = new Map<string, { data: BotCustomConfig; ts: number }>();
const systemKeywordCache: { data: UnifiedKeyword[] | null; ts: number } = { data: null, ts: 0 };
const categoryKeywordCache = new Map<string, { data: UnifiedKeyword[]; ts: number }>();
const businessKeywordCache = new Map<string, { data: UnifiedKeyword[]; ts: number }>();

// Compiled regex cache to avoid re-compiling on every match
const regexCache = new Map<string, RegExp>();

function getCompiledRegex(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  try {
    const re = new RegExp(pattern, 'i');
    regexCache.set(pattern, re);
    // Prune if too large
    if (regexCache.size > 200) {
      const entries = Array.from(regexCache.keys());
      for (let i = 0; i < 50; i++) regexCache.delete(entries[i]);
    }
    return re;
  } catch {
    return null;
  }
}

function pruneCache<T>(cache: Map<string, { data: T; ts: number }>, ttl: number) {
  if (cache.size > 500) {
    const cutoff = Date.now() - ttl;
    for (const [k, v] of cache) {
      if (v.ts < cutoff) cache.delete(k);
    }
  }
}

// ── Load Functions ────────────────────────────────────────

/**
 * Load system-scope keywords. Cached for 10 minutes (rarely change).
 */
async function loadSystemKeywords(supabase: SupabaseClient): Promise<UnifiedKeyword[]> {
  if (systemKeywordCache.data && Date.now() - systemKeywordCache.ts < SYSTEM_CACHE_TTL) {
    return systemKeywordCache.data;
  }

  const { data } = await supabase
    .from('bot_keywords')
    .select('id, keyword, match_type, action_type, payload, priority, scope, category, business_id, campaign_id, description')
    .eq('scope', 'system')
    .eq('is_active', true)
    .order('priority', { ascending: false });

  const keywords = (data as UnifiedKeyword[]) || [];
  systemKeywordCache.data = keywords;
  systemKeywordCache.ts = Date.now();
  return keywords;
}

/**
 * Load category-scope keywords for a given category. Cached for 5 minutes.
 */
async function loadCategoryKeywords(supabase: SupabaseClient, category: string): Promise<UnifiedKeyword[]> {
  const cached = categoryKeywordCache.get(category);
  if (cached && Date.now() - cached.ts < CATEGORY_CACHE_TTL) return cached.data;

  const { data } = await supabase
    .from('bot_keywords')
    .select('id, keyword, match_type, action_type, payload, priority, scope, category, business_id, campaign_id, description')
    .eq('scope', 'category')
    .eq('category', category)
    .eq('is_active', true)
    .order('priority', { ascending: false });

  const keywords = (data as UnifiedKeyword[]) || [];
  categoryKeywordCache.set(category, { data: keywords, ts: Date.now() });
  pruneCache(categoryKeywordCache, CATEGORY_CACHE_TTL);
  return keywords;
}

/**
 * Load business-scope keywords for a specific business. Cached for 5 minutes.
 */
async function loadBusinessKeywords(supabase: SupabaseClient, businessId: string): Promise<UnifiedKeyword[]> {
  const cached = businessKeywordCache.get(businessId);
  if (cached && Date.now() - cached.ts < BUSINESS_CACHE_TTL) return cached.data;

  const { data } = await supabase
    .from('bot_keywords')
    .select('id, keyword, match_type, action_type, payload, priority, scope, category, business_id, campaign_id, description')
    .eq('scope', 'business')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .order('priority', { ascending: false });

  const keywords = (data as UnifiedKeyword[]) || [];
  businessKeywordCache.set(businessId, { data: keywords, ts: Date.now() });
  pruneCache(businessKeywordCache, BUSINESS_CACHE_TTL);
  return keywords;
}

/**
 * Load all unified keywords for a context, merged and deduplicated.
 * Priority order: business > category > system.
 * Business keywords with the same keyword text override system/category.
 */
export async function loadUnifiedKeywords(
  supabase: SupabaseClient,
  businessId?: string | null,
  category?: string | null,
): Promise<UnifiedKeyword[]> {
  // Load all scopes in parallel
  const [system, catKws, bizKws] = await Promise.all([
    loadSystemKeywords(supabase),
    category ? loadCategoryKeywords(supabase, category) : Promise.resolve([]),
    businessId ? loadBusinessKeywords(supabase, businessId) : Promise.resolve([]),
  ]);

  // Merge: business first, then category, then system
  // Dedup by keyword text (lowercase) — first seen wins (higher scope priority)
  const seen = new Set<string>();
  const merged: UnifiedKeyword[] = [];

  for (const kw of bizKws) {
    const key = kw.keyword.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(kw);
    }
  }

  for (const kw of catKws) {
    const key = kw.keyword.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(kw);
    }
  }

  for (const kw of system) {
    const key = kw.keyword.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(kw);
    }
  }

  // Sort by priority descending
  merged.sort((a, b) => b.priority - a.priority);
  return merged;
}

// ── Matching ──────────────────────────────────────────────

/**
 * Match user text against unified keywords.
 * Returns first match (by priority) or null.
 */
export function matchUnifiedKeyword(text: string, keywords: UnifiedKeyword[]): UnifiedKeyword | null {
  const lower = text.toLowerCase().trim();
  for (const kw of keywords) {
    switch (kw.match_type) {
      case 'exact':
        if (lower === kw.keyword.toLowerCase()) return kw;
        break;
      case 'starts_with':
        if (lower.startsWith(kw.keyword.toLowerCase())) return kw;
        break;
      case 'contains':
        if (lower.includes(kw.keyword.toLowerCase())) return kw;
        break;
      case 'regex': {
        const re = getCompiledRegex(kw.keyword);
        if (re && re.test(lower)) return kw;
        break;
      }
    }
  }
  return null;
}

/**
 * Parse the payload JSON from a keyword match.
 */
export function parseKeywordPayload(payload: string): Record<string, unknown> {
  try {
    return JSON.parse(payload);
  } catch {
    // Plain text payload — wrap as message
    return { message: payload };
  }
}

// ── Legacy Functions (still used by welcome buttons) ──────

/**
 * Load quick replies, welcome buttons, and default reply from whatsapp_config.
 * Cached for 5 minutes per business.
 */
export async function loadBotCustomConfig(
  supabase: SupabaseClient,
  businessId: string,
): Promise<BotCustomConfig> {
  const cached = configCache.get(businessId);
  if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) return cached.data;

  const { data } = await supabase
    .from('whatsapp_config')
    .select('quick_replies, welcome_buttons, default_reply')
    .eq('business_id', businessId)
    .maybeSingle();

  const config: BotCustomConfig = {
    quick_replies: (data?.quick_replies as QuickReply[]) || [],
    welcome_buttons: (data?.welcome_buttons as WelcomeButton[]) || [],
    default_reply: data?.default_reply || null,
  };

  configCache.set(businessId, { data: config, ts: Date.now() });
  pruneCache(configCache, CONFIG_CACHE_TTL);
  return config;
}

/**
 * Match user text against quick replies.
 * @deprecated Quick replies are now migrated to bot_keywords. Kept for welcome button fallback.
 */
export function matchQuickReply(text: string, replies: QuickReply[]): QuickReply | null {
  const lower = text.toLowerCase();
  return replies.find(r => lower.includes(r.trigger.toLowerCase())) || null;
}

/**
 * @deprecated Use loadUnifiedKeywords instead.
 */
export async function loadKeywords(
  supabase: SupabaseClient,
  businessId: string,
): Promise<BotKeyword[]> {
  const cached = businessKeywordCache.get(businessId);
  if (cached && Date.now() - cached.ts < BUSINESS_CACHE_TTL) {
    return cached.data as unknown as BotKeyword[];
  }

  const { data } = await supabase
    .from('bot_keywords')
    .select('id, keyword, match_type, action_type, payload, priority')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .order('priority', { ascending: false });

  return (data as BotKeyword[]) || [];
}

/**
 * @deprecated Use matchUnifiedKeyword instead.
 */
export function matchKeyword(text: string, keywords: BotKeyword[]): BotKeyword | null {
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    const kwLower = kw.keyword.toLowerCase();
    switch (kw.match_type) {
      case 'exact':
        if (lower === kwLower) return kw;
        break;
      case 'starts_with':
        if (lower.startsWith(kwLower)) return kw;
        break;
      case 'contains':
      default:
        if (lower.includes(kwLower)) return kw;
        break;
    }
  }
  return null;
}

export type { QuickReply, BotKeyword, WelcomeButton, BotCustomConfig, UnifiedKeyword, KeywordScope, MatchType, ActionType };
