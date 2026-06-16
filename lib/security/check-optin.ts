import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Check if a phone number has opted in (previously interacted with) a business.
 * A number is considered opted-in if they have:
 * - A bot session with this business
 * - A customer profile for this business
 * - A booking/order with this business
 * - Previously responded to an invite from this business
 *
 * Returns true if the number can receive direct WhatsApp messages.
 */
export async function hasOptedIn(
  supabase: SupabaseClient,
  phone: string,
  businessId: string,
): Promise<boolean> {
  if (!phone || !businessId) return false;

  // Normalize phone variants
  const cleanPhone = phone.replace(/\D/g, '');
  const withPlus = cleanPhone.startsWith('+') ? cleanPhone : `+${cleanPhone}`;
  const withoutPlus = cleanPhone.startsWith('+') ? cleanPhone.slice(1) : cleanPhone;

  // Check bot_sessions — most reliable indicator (they messaged on WhatsApp)
  const { count: sessionCount } = await supabase
    .from('bot_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .or(`user_phone.eq.${withPlus},user_phone.eq.${withoutPlus}`)
    .limit(1);

  if ((sessionCount ?? 0) > 0) return true;

  // Check customer_profiles — they've interacted with the business
  const { count: profileCount } = await supabase
    .from('customer_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .or(`phone.eq.${withPlus},phone.eq.${withoutPlus}`)
    .limit(1);

  if ((profileCount ?? 0) > 0) return true;

  // Check bookings — they've booked with this business
  const { count: bookingCount } = await supabase
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .or(`guest_phone.eq.${withPlus},guest_phone.eq.${withoutPlus}`)
    .limit(1);

  if ((bookingCount ?? 0) > 0) return true;

  // Check event_invites — they've responded to a previous invite
  const { count: inviteCount } = await supabase
    .from('event_invites')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('guest_phone', cleanPhone)
    .neq('status', 'pending')
    .limit(1);

  if ((inviteCount ?? 0) > 0) return true;

  return false;
}

/**
 * Batch check multiple phone numbers for opt-in status.
 * Returns a Map of phone → opted_in boolean.
 */
export async function checkOptInBatch(
  supabase: SupabaseClient,
  phones: string[],
  businessId: string,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (!phones.length || !businessId) return result;

  // Normalize all phones
  const normalized = phones.map(p => {
    const clean = p.replace(/\D/g, '');
    return {
      original: p,
      clean,
      withPlus: clean.startsWith('+') ? clean : `+${clean}`,
      withoutPlus: clean.startsWith('+') ? clean.slice(1) : clean,
    };
  });

  const allVariants = normalized.flatMap(n => [n.withPlus, n.withoutPlus]);

  // Batch check bot_sessions
  const { data: sessions } = await supabase
    .from('bot_sessions')
    .select('user_phone')
    .eq('business_id', businessId)
    .in('user_phone', allVariants);

  const sessionPhones = new Set((sessions || []).map(s => s.user_phone?.replace(/\D/g, '')));

  // Batch check customer_profiles
  const { data: profiles } = await supabase
    .from('customer_profiles')
    .select('phone')
    .eq('business_id', businessId)
    .in('phone', allVariants);

  const profilePhones = new Set((profiles || []).map(p => p.phone?.replace(/\D/g, '')));

  // Batch check bookings
  const { data: bookings } = await supabase
    .from('bookings')
    .select('guest_phone')
    .eq('business_id', businessId)
    .in('guest_phone', allVariants);

  const bookingPhones = new Set((bookings || []).map(b => b.guest_phone?.replace(/\D/g, '')));

  // Combine results
  for (const n of normalized) {
    const optedIn = sessionPhones.has(n.clean) || profilePhones.has(n.clean) || bookingPhones.has(n.clean);
    result.set(n.original, optedIn);
  }

  return result;
}
