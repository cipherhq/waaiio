/**
 * Party persistence actions — extracted from dashboard page for testability (#493).
 * The page component calls these same functions.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { generatePartySlug } from '@/lib/parties/slug';

export interface PartyPayload {
  business_id: string;
  name: string;
  description?: string | null;
  date: string;
  [key: string]: unknown;
}

export interface PersistenceResult {
  success: boolean;
  id?: string;
  slug?: string;
  error?: string;
}

export async function createParty(
  supabase: SupabaseClient,
  payload: PartyPayload,
): Promise<PersistenceResult> {
  const slug = generatePartySlug(payload.name);
  const { data, error } = await supabase
    .from('parties')
    .insert({ ...payload, slug })
    .select('id, slug')
    .single();

  if (error) {
    // Retry once with a different slug on uniqueness conflict
    if (error.code === '23505' && error.message?.includes('slug')) {
      const retrySlug = generatePartySlug(payload.name);
      const { data: retryData, error: retryError } = await supabase
        .from('parties')
        .insert({ ...payload, slug: retrySlug })
        .select('id, slug')
        .single();
      if (retryError) {
        return { success: false, error: `Failed to create party: ${retryError.message}` };
      }
      return { success: true, id: retryData?.id, slug: retryData?.slug };
    }
    return { success: false, error: `Failed to create party: ${error.message}` };
  }
  return { success: true, id: data?.id, slug: data?.slug };
}

export async function updateParty(
  supabase: SupabaseClient,
  id: string,
  payload: Partial<PartyPayload>,
): Promise<PersistenceResult> {
  // Never overwrite slug on update — it's immutable once set
  const { slug: _ignored, ...safePayload } = payload;
  const { error } = await supabase.from('parties').update(safePayload).eq('id', id);
  if (error) {
    return { success: false, error: `Failed to update party: ${error.message}` };
  }
  return { success: true };
}
