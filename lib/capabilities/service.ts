import type { SupabaseClient } from '@supabase/supabase-js';
import { type CapabilityId, CATEGORY_DEFAULT_CAPABILITIES } from './types';
import { getCategoryDefaultCapabilities } from '@/lib/categoryConfig';

/** Result of reading configured capabilities — distinguishes genuine zero rows from DB errors. */
export type ConfiguredCapabilitiesResult =
  | { ok: true; rows: Array<{ capability: string; is_enabled: boolean; sort_order: number }> }
  | { ok: false; error: string };

/**
 * Get all configured capability rows for a business.
 * Returns a typed result — callers MUST check `ok` before using rows.
 * A DB error must never be treated as zero rows.
 */
export async function getConfiguredCapabilities(
  supabase: SupabaseClient,
  businessId: string,
): Promise<ConfiguredCapabilitiesResult> {
  const { data, error } = await supabase
    .from('business_capabilities')
    .select('capability, is_enabled, sort_order')
    .eq('business_id', businessId)
    .order('sort_order', { ascending: true })
    .order('capability', { ascending: true });

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true, rows: data || [] };
}

/**
 * Get all enabled capabilities for a business, with fallback to category defaults.
 *
 * NOTE: This function preserves zero-row fallback behavior for legacy businesses
 * that were never explicitly configured. New businesses should always have
 * explicit capability rows from onboarding.
 *
 * For the authoritative policy-aware resolver, use getEffectiveCapabilities()
 * from lib/capabilities/policy.ts instead.
 */
export async function getEnabledCapabilities(
  supabase: SupabaseClient,
  businessId: string,
  category?: string,
): Promise<CapabilityId[]> {
  const result = await getConfiguredCapabilities(supabase, businessId);

  // On DB error, fail closed — return empty rather than exposing defaults
  if (!result.ok) return [];

  if (result.rows.length > 0) {
    // Return only explicitly enabled capabilities — do NOT auto-merge new defaults.
    return result.rows
      .filter(row => row.is_enabled)
      .map(row => row.capability as CapabilityId);
  }

  // Zero-row fallback for legacy businesses without explicit configuration.
  if (category) {
    const dbCaps = getCategoryDefaultCapabilities(category);
    return (dbCaps as CapabilityId[]) || CATEGORY_DEFAULT_CAPABILITIES[category] || ['scheduling'];
  }

  return ['scheduling'];
}

/** Get custom labels for enabled capabilities (only returns caps with non-null custom_label) */
export async function getCapabilityCustomLabels(
  supabase: SupabaseClient,
  businessId: string,
): Promise<Record<string, string>> {
  const { data } = await supabase
    .from('business_capabilities')
    .select('capability, custom_label')
    .eq('business_id', businessId)
    .eq('is_enabled', true)
    .not('custom_label', 'is', null);
  const map: Record<string, string> = {};
  for (const row of data || []) {
    if (row.custom_label) map[row.capability] = row.custom_label;
  }
  return map;
}

/** Check if a business has a specific capability enabled */
export async function hasCapability(
  supabase: SupabaseClient,
  businessId: string,
  capability: CapabilityId,
): Promise<boolean> {
  const { data } = await supabase
    .from('business_capabilities')
    .select('id')
    .eq('business_id', businessId)
    .eq('capability', capability)
    .eq('is_enabled', true)
    .maybeSingle();

  return !!data;
}

/** Bulk upsert capabilities for a business */
export async function setCapabilities(
  supabase: SupabaseClient,
  businessId: string,
  capabilities: CapabilityId[],
): Promise<void> {
  // Disable all existing
  await supabase
    .from('business_capabilities')
    .update({ is_enabled: false })
    .eq('business_id', businessId);

  // Upsert each selected capability
  for (const cap of capabilities) {
    await supabase
      .from('business_capabilities')
      .upsert(
        { business_id: businessId, capability: cap, is_enabled: true },
        { onConflict: 'business_id,capability' },
      );
  }
}

/** Get the config JSONB for a specific capability */
export async function getCapabilityConfig(
  supabase: SupabaseClient,
  businessId: string,
  capability: CapabilityId,
): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from('business_capabilities')
    .select('config')
    .eq('business_id', businessId)
    .eq('capability', capability)
    .eq('is_enabled', true)
    .maybeSingle();

  return (data?.config as Record<string, unknown>) || {};
}

/**
 * Initialize capabilities for a new business based on its category.
 * Uses upsert for idempotency (safe to retry on the same business).
 * Throws on Supabase write failure — callers must handle.
 */
export async function initCapabilities(
  supabase: SupabaseClient,
  businessId: string,
  category: string,
  overrides?: CapabilityId[],
): Promise<void> {
  const dbCaps = getCategoryDefaultCapabilities(category);
  const capabilities = overrides || (dbCaps as CapabilityId[]) || CATEGORY_DEFAULT_CAPABILITIES[category] || ['scheduling'];

  const rows = capabilities.map(cap => ({
    business_id: businessId,
    capability: cap,
    is_enabled: true,
  }));

  if (rows.length > 0) {
    const { error } = await supabase
      .from('business_capabilities')
      .upsert(rows, { onConflict: 'business_id,capability' });

    if (error) {
      throw new Error(`Capability initialization failed: ${error.message}`);
    }
  }
}
