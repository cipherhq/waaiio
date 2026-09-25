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

  // Determine signup source from the message suffix
  const lowerText = text.trim().toLowerCase();
  let signupSource: 'qr' | 'button' | 'direct' = 'direct';
  if (lowerText.includes('(qr)')) signupSource = 'qr';
  else if (lowerText.includes('(button)')) signupSource = 'button';

  // Detect market from the receiving Waaiio number
  let market = 'XX'; // fallback
  if (destinationPhone) {
    const { data: channel } = await supabase
      .from('whatsapp_channels')
      .select('country_code')
      .eq('phone_number', destinationPhone)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (channel?.country_code) market = channel.country_code;
  }

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
    // Still send confirmation — don't punish user for our DB issue
  }

  await sendReply(
    from,
    "You're on the list! 🚀\n\nWe'll notify you on WhatsApp when Waaiio launches. Stay tuned!\n\n_Send STOP to unsubscribe._",
  );

  return true;
}

/** Regex exported for testing */
export { LAUNCH_OPTIN_PATTERN };
