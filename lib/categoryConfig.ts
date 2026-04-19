import { createClient } from '@/lib/supabase/client';
import { CATEGORY_LABELS, BUSINESS_CATEGORIES, type BusinessCategoryKey, type FlowType } from '@/lib/constants';

// ── Types ──

export interface CategoryTemplate {
  id: string;
  key: string;
  label: string;
  icon: string;
  flow_type: FlowType;
  is_active: boolean;
  sort_order: number;
  default_services: Array<{
    name: string;
    price: number;
    price_is_variable: boolean;
    duration_minutes: number | null;
    deposit_amount: number;
  }>;
  default_greeting: string;
  labels: CategoryLabels;
  default_capabilities: string[] | null;
  metadata: Record<string, unknown>;
}

export interface CategoryLabels {
  entityName: string;
  entityNamePlural: string;
  actionVerb: string;
  confirmationEmoji: string;
  receiptTitle: string;
  quantityLabel: string;
  personLabel: string;
  personLabelPlural: string;
  hiddenStatuses: string[];
  serviceName?: string;
  serviceNamePlural?: string;
  namePlaceholder?: string;
  defaultHasPrice?: boolean;
}

// ── In-memory cache (60s TTL, same pattern as lib/countries.ts) ──

let cache: CategoryTemplate[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

function isFresh(): boolean {
  return cache !== null && Date.now() - cacheTime < CACHE_TTL;
}

// ── Public API ──

/** Fetch active categories from DB, populate cache */
export async function loadCategories(): Promise<CategoryTemplate[]> {
  if (isFresh()) return cache!;
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from('category_templates')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    cache = (data ?? []) as CategoryTemplate[];
    cacheTime = Date.now();
    return cache;
  } catch {
    // On error, keep stale cache or return empty
    return cache ?? [];
  }
}

/** Clear cache (call after admin updates) */
export function invalidateCategoryCache(): void {
  cache = null;
  cacheTime = 0;
}

/** Get a single category by key. Reads from cache, falls back to hardcoded. */
export function getCategoryByKey(key: string): CategoryTemplate | null {
  if (cache) {
    const found = cache.find(c => c.key === key);
    if (found) return found;
  }
  return hardcodedFallback(key);
}

/** Get display label for a category key (e.g. 'barber' → 'Barbershop') */
export function getCategoryLabel(key: string): string {
  const cat = getCategoryByKey(key);
  return cat?.label ?? key;
}

/** Get per-category labels (entity names, action verbs, etc.). Falls back to hardcoded CATEGORY_LABELS. */
export function getCategoryLabels(key: string): CategoryLabels {
  const cat = getCategoryByKey(key);
  if (cat?.labels && Object.keys(cat.labels).length > 0) {
    return cat.labels;
  }
  // Fallback to hardcoded constants
  const hardcoded = CATEGORY_LABELS[key as BusinessCategoryKey];
  if (hardcoded) return hardcoded;
  return CATEGORY_LABELS.other;
}

/** Get flow type for a category key */
export function getCategoryFlowType(key: string): FlowType {
  const cat = getCategoryByKey(key);
  return cat?.flow_type ?? 'scheduling';
}

/** Get all active category keys */
export function getAllCategoryKeys(): string[] {
  if (cache && cache.length > 0) {
    return cache.map(c => c.key);
  }
  return BUSINESS_CATEGORIES.map(c => c.key);
}

/** Get all categories as the BUSINESS_CATEGORIES shape (for drop-in replacement) */
export function getCategoryList(): Array<{ key: string; label: string; icon: string; flow: FlowType }> {
  if (cache && cache.length > 0) {
    return cache.map(c => ({ key: c.key, label: c.label, icon: c.icon, flow: c.flow_type }));
  }
  return BUSINESS_CATEGORIES;
}

/** Get default capabilities for a category */
export function getCategoryDefaultCapabilities(key: string): string[] | null {
  const cat = getCategoryByKey(key);
  return cat?.default_capabilities ?? null;
}

// ── Hardcoded fallback (converts constants.ts data to CategoryTemplate shape) ──

function hardcodedFallback(key: string): CategoryTemplate | null {
  const bc = BUSINESS_CATEGORIES.find(c => c.key === key);
  if (!bc) return null;
  const labels = CATEGORY_LABELS[key as BusinessCategoryKey] ?? CATEGORY_LABELS.other;
  return {
    id: '',
    key: bc.key,
    label: bc.label,
    icon: bc.icon,
    flow_type: bc.flow,
    is_active: true,
    sort_order: 0,
    default_services: [],
    default_greeting: '',
    labels,
    default_capabilities: null,
    metadata: {},
  };
}
