/**
 * Zero-downtime view fallback helpers.
 *
 * During the transition window between application deployment and migration 293
 * execution, the safe views (businesses_public, whatsapp_channels_public) may
 * not yet exist in the database. These helpers query the view first and, ONLY
 * when PostgreSQL explicitly reports the relation does not exist (42P01), fall
 * back to querying the base table with an explicit safe-column list.
 *
 * Fallback does NOT trigger on permission errors, network errors, empty results,
 * or any other failure — only on the exact "relation does not exist" condition.
 *
 * After migration 293 is applied, direct base-table access will be denied by
 * REVOKE and these helpers will always use the view path.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * PostgreSQL error code for "undefined_table" / "relation does not exist".
 * PostgREST surfaces this as error.code = '42P01'.
 */
const RELATION_NOT_FOUND = '42P01';

/**
 * Check if a Supabase error indicates the queried relation does not exist.
 * Returns true ONLY for PostgreSQL error code 42P01.
 */
export function isRelationNotFound(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === RELATION_NOT_FOUND;
}

/** Safe columns exposed by businesses_public view (migration 293). */
export const BUSINESSES_PUBLIC_COLUMNS = [
  'id', 'name', 'slug', 'description', 'address', 'city', 'state',
  'country_code', 'phone', 'email', 'logo_url', 'cover_photo_url',
  'category', 'flow_type', 'operating_hours', 'rating_avg', 'rating_count',
  'total_bookings', 'instagram_handle', 'timezone', 'recurring_enabled',
  'bot_code', 'status', 'created_at', 'updated_at',
] as const;

/** Safe columns exposed by whatsapp_channels_public view (migration 293). */
export const CHANNELS_PUBLIC_COLUMNS = [
  'id', 'country_code', 'phone_number', 'display_name', 'channel_type', 'is_active',
] as const;

type AnyQuery = any;

/**
 * Query businesses_public view with automatic fallback to the base table
 * (safe columns only, status = 'active' filter) when the view does not exist.
 */
export async function queryBusinessesPublic(
  supabase: SupabaseClient,
  columns: string,
  applyFilters?: (query: AnyQuery) => AnyQuery,
): Promise<{ data: any; error: any }> {
  let query: AnyQuery = supabase.from('businesses_public').select(columns);
  if (applyFilters) query = applyFilters(query);

  const result = await query;

  if (isRelationNotFound(result.error)) {
    // View doesn't exist yet — fall back to base table with safe columns + active filter
    let fallback: AnyQuery = supabase
      .from('businesses')
      .select(columns)
      .eq('status', 'active');
    if (applyFilters) fallback = applyFilters(fallback);
    return await fallback;
  }

  return result;
}

/**
 * Query whatsapp_channels_public view with automatic fallback to the base table
 * (safe columns only, shared + active filter) when the view does not exist.
 */
export async function queryChannelsPublic(
  supabase: SupabaseClient,
  columns: string,
  applyFilters?: (query: AnyQuery) => AnyQuery,
): Promise<{ data: any; error: any }> {
  let query: AnyQuery = supabase.from('whatsapp_channels_public').select(columns);
  if (applyFilters) query = applyFilters(query);

  const result = await query;

  if (isRelationNotFound(result.error)) {
    // View doesn't exist yet — fall back to base table with safe columns + shared/active filter
    let fallback: AnyQuery = supabase
      .from('whatsapp_channels')
      .select(columns)
      .eq('channel_type', 'shared')
      .eq('is_active', true);
    if (applyFilters) fallback = applyFilters(fallback);
    return await fallback;
  }

  return result;
}
