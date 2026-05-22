import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { logger } from '@/lib/logger';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Notify waitlisted customers when a slot opens up (cancellation, no-show, or reschedule).
 * Sends WhatsApp messages to the first 3 waiting customers and marks them as notified.
 */
export async function notifyWaitlistOnSlotOpen({
  supabase,
  businessId,
  businessName,
  date,
  serviceId,
}: {
  supabase: SupabaseClient;
  businessId: string;
  businessName: string;
  date: string;
  serviceId?: string | null;
}): Promise<number> {
  try {
    let query = supabase
      .from('waitlist_entries')
      .select('id, customer_phone, customer_name, service_id')
      .eq('business_id', businessId)
      .eq('status', 'waiting')
      .order('created_at', { ascending: true })
      .limit(3);

    // If we know the service, prefer matching waitlist entries
    // but still notify any waiting entries if none match
    if (serviceId) {
      const { data: serviceMatches } = await supabase
        .from('waitlist_entries')
        .select('id, customer_phone, customer_name, service_id')
        .eq('business_id', businessId)
        .eq('status', 'waiting')
        .eq('service_id', serviceId)
        .order('created_at', { ascending: true })
        .limit(3);

      if (serviceMatches && serviceMatches.length > 0) {
        // Use service-specific waitlist entries
        return await sendNotifications({ supabase, entries: serviceMatches, businessId, businessName, date });
      }
    }

    const { data: waitlisted } = await query;
    if (!waitlisted || waitlisted.length === 0) return 0;

    return await sendNotifications({ supabase, entries: waitlisted, businessId, businessName, date });
  } catch (err) {
    logger.error('[WAITLIST-AUTO-NOTIFY] Error:', err);
    return 0;
  }
}

async function sendNotifications({
  supabase,
  entries,
  businessId,
  businessName,
  date,
}: {
  supabase: SupabaseClient;
  entries: { id: string; customer_phone: string; customer_name: string | null; service_id: string | null }[];
  businessId: string;
  businessName: string;
  date: string;
}): Promise<number> {
  const resolver = new ChannelResolver(supabase);
  const resolved = await resolver.resolveByBusinessId(businessId);
  if (!resolved) return 0;

  const displayDate = new Date(date + 'T00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  let notifiedCount = 0;

  for (const entry of entries) {
    try {
      const phone = entry.customer_phone.startsWith('+')
        ? entry.customer_phone.slice(1)
        : entry.customer_phone;
      const name = entry.customer_name || 'there';
      const msg = `Hi ${name}! A slot just opened up at *${businessName}* on *${displayDate}*. Would you like to book? Reply *Hi* to get started.`;

      await resolved.sender.sendText({ to: phone, text: msg });
      await supabase
        .from('waitlist_entries')
        .update({ status: 'notified', notified_at: new Date().toISOString() })
        .eq('id', entry.id);

      notifiedCount++;
    } catch (err) {
      logger.error('[WAITLIST-AUTO-NOTIFY] Notify error for entry:', entry.id, err);
    }
  }

  return notifiedCount;
}

/**
 * Mark a waitlist entry as converted when a booking is created by a previously-notified customer.
 */
export async function markWaitlistConverted({
  supabase,
  businessId,
  customerPhone,
  serviceId,
  bookingId,
}: {
  supabase: SupabaseClient;
  businessId: string;
  customerPhone: string;
  serviceId?: string | null;
  bookingId: string;
}): Promise<boolean> {
  try {
    // Normalize phone for matching
    const phoneVariants = [
      customerPhone,
      customerPhone.startsWith('+') ? customerPhone.slice(1) : `+${customerPhone}`,
    ];

    let query = supabase
      .from('waitlist_entries')
      .select('id')
      .eq('business_id', businessId)
      .eq('status', 'notified')
      .in('customer_phone', phoneVariants)
      .order('notified_at', { ascending: false })
      .limit(1);

    if (serviceId) {
      query = query.eq('service_id', serviceId);
    }

    const { data } = await query;
    if (!data || data.length === 0) return false;

    await supabase
      .from('waitlist_entries')
      .update({
        status: 'converted',
        booking_id: bookingId,
        converted_at: new Date().toISOString(),
      })
      .eq('id', data[0].id);

    return true;
  } catch (err) {
    logger.error('[WAITLIST-CONVERSION] Error:', err);
    return false;
  }
}
