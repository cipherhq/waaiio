import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from './message-sender';
import { sendEmail } from '@/lib/email/client';
import { logger } from '@/lib/logger';
import { sendSms, isSmsEligible } from '@/lib/sms/bulksms-ng';

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
  /** If true, attempt SMS as final fallback when both WhatsApp and email fail (NG/GH only) */
  smsFallback?: boolean;
}

interface SendOrEmailResult {
  whatsapp: 'sent' | 'failed';
  email: 'sent' | 'skipped' | 'failed' | 'no_address';
  sms?: 'sent' | 'failed' | 'skipped' | 'not_eligible';
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

  // 3. SMS fallback — attempt when both WhatsApp and email failed (NG/GH only)
  if (opts.smsFallback && result.whatsapp === 'failed' && (result.email === 'failed' || result.email === 'no_address')) {
    if (isSmsEligible(to)) {
      // Truncate to SMS limit (160 chars) and strip WhatsApp formatting
      const smsText = text.replace(/\*/g, '').replace(/_/g, '').slice(0, 160);
      const smsResult = await sendSms({ to, message: smsText });
      result.sms = smsResult.sent ? 'sent' : 'failed';
      if (smsResult.sent) {
        logger.info(`[SEND_OR_EMAIL] SMS fallback succeeded for ${to}`);
      } else {
        logger.error(`[SEND_OR_EMAIL] All channels failed for ${to}: WA, email, SMS`);
      }
    } else {
      result.sms = 'not_eligible';
      logger.error(`[SEND_OR_EMAIL] Both WhatsApp and email failed for ${to} (${opts.businessName || 'unknown business'}). SMS not eligible (non-NG/GH).`);
    }
  } else if (result.whatsapp === 'failed' && (result.email === 'failed' || result.email === 'no_address')) {
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
