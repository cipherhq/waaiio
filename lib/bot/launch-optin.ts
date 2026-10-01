/**
 * Launch opt-in handler (#395)
 *
 * Intercepts launch notification opt-in messages and records subscribers.
 * Isolated from commerce/payment/bot flows — purely launch marketing.
 *
 * Returns true if the message was a launch opt-in (handled), false otherwise.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

/** Matches the prefilled launch opt-in message from QR/button */
const LAUNCH_OPTIN_PATTERN = /^notify me when waaiio launches/i;

/**
 * Check if a message is a launch opt-in. If so, record the subscriber
 * and return true (message handled). Otherwise return false.
 *
 * Idempotent: duplicate/replayed messages update existing records
 * without creating duplicates (UNIQUE constraint on wa_number).
 */
export async function handleLaunchOptIn(
  supabase: SupabaseClient,
  from: string,
  text: string,
  destinationPhone: string | undefined,
  sendReply: (phone: string, msg: string) => Promise<void>,
): Promise<boolean> {
  if (!LAUNCH_OPTIN_PATTERN.test(text.trim())) {
    return false;
  }

  // Source attribution: always 'direct' — customer-visible message no longer
  // contains (qr)/(button) suffixes per #460.
  const signupSource = 'direct';

  // Detect market from the receiving Waaiio number.
  // Meta webhooks pass phone_number_id (numeric API identifier, e.g. '469075'),
  // NOT the human-readable phone_number (e.g. '+12029226251').
  // Primary lookup: phone_number_id (correct for all webhook traffic).
  // Bounded fallback: phone_number (handles any historical rows using the
  // human-readable format). Fallback is restricted to shared+active channels.
  let market = 'XX'; // fallback
  if (destinationPhone) {
    // Primary: match by Meta phone_number_id (shared channels only —
    // dedicated business channels must not be accepted for launch opt-in)
    const { data: channel } = await supabase
      .from('whatsapp_channels')
      .select('country_code')
      .eq('phone_number_id', destinationPhone)
      .eq('channel_type', 'shared')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (channel?.country_code) {
      market = channel.country_code;
    } else {
      // Bounded fallback: match by human-readable phone_number
      // (shared + active only — do not match dedicated/unrelated channels)
      const { data: fallbackChannel } = await supabase
        .from('whatsapp_channels')
        .select('country_code')
        .eq('phone_number', destinationPhone)
        .eq('channel_type', 'shared')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      if (fallbackChannel?.country_code) market = fallbackChannel.country_code;
    }
  }

  // Check existing subscriber state BEFORE upsert to determine the right message
  const { data: existing } = await supabase
    .from('launch_subscribers')
    .select('id, opt_in_status')
    .eq('wa_number', from)
    .maybeSingle();

  // Upsert subscriber (idempotent on wa_number)
  const { error } = await supabase
    .from('launch_subscribers')
    .upsert(
      {
        wa_number: from,
        market,
        receiving_number: destinationPhone || 'unknown',
        signup_source: signupSource,
        opt_in_status: 'active',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'wa_number' },
    );

  if (error) {
    logger.error('[LAUNCH] Failed to record subscriber:', error.message);
    await sendReply(
      from,
      "We couldn't save your launch notification request right now. Please try again in a moment.",
    );
    return true;
  }

  // State-aware confirmation messages
  let message: string;
  if (!existing) {
    // New subscriber — first opt-in
    message =
      "🎉 You're in!\n\nWaaiio is launching soon and we'll message you right here when it's time.\n\nSoon you'll be able to book, order, pay, sell tickets, and get things done — all through WhatsApp.\n\nSee you at launch 🚀\n\n_Send STOP to unsubscribe._";
  } else if (existing.opt_in_status === 'active') {
    // Already-active subscriber — duplicate signup
    message =
      "You're already on our launch list! We'll let you know when we're ready. 🙌\n\n_Send STOP to unsubscribe._";
  } else {
    // Reactivated subscriber (was opted_out, now re-opted in)
    message =
      "Welcome back! 🎉 You're subscribed again. We'll keep you posted on our launch.\n\n_Send STOP to unsubscribe._";
  }

  await sendReply(from, message);

  return true;
}

/** Regex exported for testing */
export { LAUNCH_OPTIN_PATTERN };
