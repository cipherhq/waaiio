import type { SupabaseClient } from '@supabase/supabase-js';

/** Null means this is not a native registration; false means its binding failed. */
export async function nativeRegistrationEvent(db: SupabaseClient, input: {
  registrationId: unknown; businessId: string; sessionId: string; phone: string;
}): Promise<string | null | false> {
  if (input.registrationId === undefined) return null;
  if (typeof input.registrationId !== 'string') return false;
  const { data, error } = await db.from('native_form_registrations').select('event_id')
    .eq('id', input.registrationId).eq('business_id', input.businessId)
    .eq('session_id', input.sessionId).eq('phone', input.phone.replace(/^\+/, '')).maybeSingle();
  return !error && data?.event_id ? String(data.event_id) : false;
}
