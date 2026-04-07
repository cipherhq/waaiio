import type { SupabaseClient } from '@supabase/supabase-js';
import { type CapabilityId, CATEGORY_DEFAULT_CAPABILITIES } from './types';

/** Get all enabled capabilities for a business, with fallback to category defaults */
export async function getEnabledCapabilities(
  supabase: SupabaseClient,
  businessId: string,
  category?: string,
): Promise<CapabilityId[]> {
  const { data } = await supabase
    .from('business_capabilities')
    .select('capability')
    .eq('business_id', businessId)
    .eq('is_enabled', true);

  if (data && data.length > 0) {
    return data.map(row => row.capability as CapabilityId);
  }

  // Fallback: derive from category
  if (category) {
    return CATEGORY_DEFAULT_CAPABILITIES[category] || ['scheduling'];
  }

  return ['scheduling'];
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
  const capabilities = overrides || CATEGORY_DEFAULT_CAPABILITIES[category] || ['scheduling'];

  const rows = capabilities.map(cap => ({
    business_id: businessId,
    capability: cap,
    is_enabled: true,
  }));

  if (rows.length > 0) {
    await supabase.from('business_capabilities').insert(rows);
  }
}
