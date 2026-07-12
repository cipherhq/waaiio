import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email/client';
import { bookingConfirmationEmail } from '@/lib/email/templates';

// ── Notification Preference Types ──

export type NotificationType =
  | 'new_booking'
  | 'payment_received'
  | 'booking_cancelled'
  | 'low_stock'
  | 'new_order'
  | 'refund_request'
  | 'new_inquiry'
  | 'new_ticket_sale'
  | 'new_donation'
  | 'new_invoice_payment'
  | 'new_queue_checkin';

export type NotificationChannel = 'whatsapp' | 'email';

export interface NotificationPreferences {
  new_booking?: { whatsapp?: boolean; email?: boolean };
  payment_received?: { whatsapp?: boolean; email?: boolean };
  booking_cancelled?: { whatsapp?: boolean; email?: boolean };
  low_stock?: { whatsapp?: boolean; email?: boolean };
  new_order?: { whatsapp?: boolean; email?: boolean };
  refund_request?: { whatsapp?: boolean; email?: boolean };
  new_inquiry?: { whatsapp?: boolean; email?: boolean };
  new_ticket_sale?: { whatsapp?: boolean; email?: boolean };
  new_donation?: { whatsapp?: boolean; email?: boolean };
  new_invoice_payment?: { whatsapp?: boolean; email?: boolean };
  new_queue_checkin?: { whatsapp?: boolean; email?: boolean };
}

/**
 * Check if a business should receive a notification of a given type on a given channel.
 * Reads from businesses.metadata.notification_preferences.
 * Defaults to true (backward compatible) if no preferences are set.
 */
export function shouldNotify(
  businessMetadata: Record<string, unknown> | null | undefined,
  type: NotificationType,
  channel: NotificationChannel,
): boolean {
  if (!businessMetadata) return true;
  const prefs = businessMetadata.notification_preferences as NotificationPreferences | undefined;
  if (!prefs) return true;
  const typePref = prefs[type];
  if (!typePref) return true;
  const channelValue = typePref[channel];
  // Only suppress if explicitly set to false
  return channelValue !== false;
}

/**
 * Fetch notification preferences for a business by ID.
 * Returns the preferences object or null if none set.
 */
export async function fetchNotificationPreferences(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ metadata: Record<string, unknown> | null }> {
  const { data } = await supabase
    .from('businesses')
    .select('metadata')
    .eq('id', businessId)
    .single();
  return { metadata: (data?.metadata as Record<string, unknown>) || null };
}

export async function createNotification(
  supabase: SupabaseClient,
  opts: {
    businessId: string;
    bookingId?: string;
    recipientPhone?: string;
    recipientEmail?: string;
    type: string;
    channel: string;
    subject?: string;
    body: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await supabase.from('notifications').insert({
    business_id: opts.businessId,
    booking_id: opts.bookingId || null,
    recipient_phone: opts.recipientPhone || null,
    recipient_email: opts.recipientEmail || null,
    type: opts.type,
    channel: opts.channel,
    subject: opts.subject || null,
    body: opts.body,
    metadata: opts.metadata || {},
    status: 'delivered',
    delivered_at: new Date().toISOString(),
  });
}

export async function sendBookingEmail(
  to: string,
  details: {
    firstName: string;
    businessName: string;
    date: string;
    time: string;
    quantity: number;
    referenceCode: string;
    amount: number;
    quantityLabel: string;
    confirmationEmoji: string;
  },
): Promise<void> {
  const { subject, html, from } = bookingConfirmationEmail(details);
  await sendEmail({ to, subject, html, from });
}
