import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from './message-sender';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';

interface SendOrEmailOpts {
  supabase: SupabaseClient;
  sender: MessageSender;
  to: string; // phone number
  text: string; // WhatsApp message text
  email?: {
    address: string;
    subject: string;
    html: string;
  } | null;
  /** Business name — used in fallback alert */
  businessName?: string;
  /** If true, send email alongside WhatsApp (not just as fallback) */
  alwaysEmail?: boolean;
}

interface SendOrEmailResult {
  whatsapp: 'sent' | 'failed';
  email: 'sent' | 'skipped' | 'failed' | 'no_address';
}

/**
 * Send a proactive message via WhatsApp with email fallback/dual-delivery.
 *
 * Strategy:
 * 1. Always attempt WhatsApp
 * 2. If `alwaysEmail` is true AND email address exists → send email too (dual delivery)
 * 3. If WhatsApp fails AND email address exists → send email as fallback
 * 4. Returns result so caller can alert business if both fail
 *
 * Use this for ALL proactive/outbound messages (reminders, confirmations,
 * notifications sent outside the bot conversation flow).
 */
export async function sendOrEmail(opts: SendOrEmailOpts): Promise<SendOrEmailResult> {
  const { sender, to, text, email, alwaysEmail } = opts;
  const result: SendOrEmailResult = {
    whatsapp: 'sent',
    email: email?.address ? 'skipped' : 'no_address',
  };

  // 1. Try WhatsApp
  try {
    await sender.sendText({ to, text });
    result.whatsapp = 'sent';
  } catch (err) {
    result.whatsapp = 'failed';
    logger.warn(`[SEND_OR_EMAIL] WhatsApp failed for ${to}:`, err instanceof Error ? err.message : err);
  }

  // 2. Send email if: always-email mode, OR WhatsApp failed (fallback)
  if (email?.address && (alwaysEmail || result.whatsapp === 'failed')) {
    try {
      await sendEmail({
        to: email.address,
        subject: email.subject,
        html: email.html,
      });
      result.email = 'sent';
    } catch (err) {
      result.email = 'failed';
      logger.error(`[SEND_OR_EMAIL] Email also failed for ${email.address}:`, err);
    }
  }

  // 3. Log if both failed
  if (result.whatsapp === 'failed' && (result.email === 'failed' || result.email === 'no_address')) {
    logger.error(`[SEND_OR_EMAIL] Both WhatsApp and email failed for ${to} (${opts.businessName || 'unknown business'}). Message lost.`);
  }

  return result;
}

/**
 * Look up a customer's email from bookings, orders, or customer_profiles.
 * Returns the first email found, or null.
 */
export async function findCustomerEmail(
  supabase: SupabaseClient,
  phone: string,
  businessId: string,
): Promise<string | null> {
  // 1. Check customer_profiles first (most reliable)
  const { data: profile } = await supabase
    .from('customer_profiles')
    .select('email')
    .eq('business_id', businessId)
    .eq('phone', phone)
    .not('email', 'is', null)
    .maybeSingle();

  if (profile?.email) return profile.email;

  // 2. Check recent bookings
  const { data: booking } = await supabase
    .from('bookings')
    .select('guest_email')
    .eq('business_id', businessId)
    .or(`guest_phone.eq.${phone},guest_phone.eq.+${phone}`)
    .not('guest_email', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (booking?.guest_email) return booking.guest_email;

  // 3. Check orders
  const { data: order } = await supabase
    .from('orders')
    .select('customer_email')
    .eq('business_id', businessId)
    .eq('customer_phone', phone)
    .not('customer_email', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (order?.customer_email) return order.customer_email;

  return null;
}
