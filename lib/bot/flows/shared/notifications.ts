import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email/client';
import { bookingConfirmationEmail } from '@/lib/email/templates';

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
