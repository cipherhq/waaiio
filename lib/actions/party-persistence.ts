/**
 * Party persistence actions — extracted from dashboard page for testability (#493).
 * The page component calls these same functions.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PartyPayload {
  business_id: string;
  name: string;
  description?: string | null;
  date: string;
  [key: string]: unknown;
}

export interface PersistenceResult {
  success: boolean;
  error?: string;
}

export async function createParty(
  supabase: SupabaseClient,
  payload: PartyPayload,
): Promise<PersistenceResult> {
  const { error } = await supabase.from('parties').insert(payload);
  if (error) {
    return { success: false, error: `Failed to create party: ${error.message}` };
  }
  return { success: true };
}

export async function updateParty(
  supabase: SupabaseClient,
  id: string,
  payload: Partial<PartyPayload>,
): Promise<PersistenceResult> {
  const { error } = await supabase.from('parties').update(payload).eq('id', id);
  if (error) {
    return { success: false, error: `Failed to update party: ${error.message}` };
  }
  return { success: true };
}
