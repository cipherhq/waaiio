import type { SupabaseClient } from '@supabase/supabase-js';
import { type CapabilityId, CATEGORY_DEFAULT_CAPABILITIES } from './types';
import { getCategoryDefaultCapabilities } from '@/lib/categoryConfig';

/** Get all enabled capabilities for a business, with fallback to category defaults.
 *  Also merges in any NEW category defaults that the business doesn't have rows for yet
 *  (i.e. defaults added after the business was created). */
export async function getEnabledCapabilities(
  supabase: SupabaseClient,
  businessId: string,
  category?: string,
): Promise<CapabilityId[]> {
  // Fetch ALL rows (enabled + disabled) so we know what the business explicitly configured
  // Order by sort_order ASC, capability ASC for consistent bot menu ordering
  const { data } = await supabase
    .from('business_capabilities')
    .select('capability, is_enabled, sort_order')
    .eq('business_id', businessId)
    .order('sort_order', { ascending: true })
    .order('capability', { ascending: true });

  if (data && data.length > 0) {
    // Preserve sort_order: enabled caps come back in DB order (sort_order ASC, capability ASC)
    const enabledOrdered = data
      .filter(row => row.is_enabled)
      .map(row => row.capability as CapabilityId);
    // Capabilities the business has ANY row for (including disabled = explicitly turned off)
    const known = new Set(data.map(row => row.capability as CapabilityId));

    // Merge newly-added category defaults that the business has never seen
    if (category) {
      const defaults = (getCategoryDefaultCapabilities(category) as CapabilityId[] | null)
        ?? CATEGORY_DEFAULT_CAPABILITIES[category]
        ?? [];
      for (const cap of defaults) {
        if (!known.has(cap)) {
          enabledOrdered.push(cap); // new default → append at end
        }
      }
    }

    return enabledOrdered;
  }

  // Fallback: derive from category (DB-backed → hardcoded fallback)
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

/** Initialize capabilities for a new business based on its category */
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
    await supabase.from('business_capabilities').insert(rows);
  }
}
