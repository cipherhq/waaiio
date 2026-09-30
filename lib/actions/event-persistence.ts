/**
 * Event persistence actions — extracted from dashboard page for testability (#493).
 * The page component calls these same functions.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface EventPayload {
  business_id: string;
  name: string;
  date: string;
  [key: string]: unknown;
}

export interface EventCreateResult {
  success: boolean;
  eventId?: string;
  error?: string;
}

export async function createEvent(
  supabase: SupabaseClient,
  payload: EventPayload,
): Promise<EventCreateResult> {
  const { data, error } = await supabase
    .from('events')
    .insert(payload)
    .select('id')
    .single();

  if (error) {
    return { success: false, error: `Failed to create event: ${error.message}` };
  }

  return { success: true, eventId: data?.id };
}
