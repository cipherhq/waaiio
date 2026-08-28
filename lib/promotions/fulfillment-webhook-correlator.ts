/**
 * ACC-204 Blocker 3: Fulfillment notification webhook delivery status correlator.
 *
 * Extracted from the inline webhook handler to enable executable testing.
 * Called when Meta sends a delivery status callback (delivered/read/failed)
 * for a message we sent. Looks up the WAMID in fulfillment notification intents
 * and advances the monotonic state machine.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

interface CorrelationResult {
  matched: boolean;
  advanced: boolean;
  newStatus?: string;
  reason?: string;
}

/**
 * Correlate a delivery status callback with a fulfillment notification intent.
 *
 * @param supabase - Service client (bypasses RLS)
 * @param wamid - WhatsApp message ID from the callback
 * @param newStatus - The delivery status (delivered, read, failed)
 * @param timestamp - ISO timestamp from the callback
 * @returns Whether the WAMID was matched and whether the status was advanced
 */
export async function correlateFulfillmentNotificationStatus(
  supabase: SupabaseClient,
  wamid: string,
  newStatus: string,
  timestamp: string | null,
): Promise<CorrelationResult> {
  // Look up the WAMID in fulfillment notification intents
  const { data: fulfillmentNotif } = await supabase
    .from('promo_fulfillment_notification_intents')
    .select('id')
    .eq('provider_message_id', wamid)
    .maybeSingle();

  if (!fulfillmentNotif) {
    return { matched: false, advanced: false, reason: 'unknown_wamid' };
  }

  // Advance the monotonic state machine
  const { data: fnResult } = await supabase.rpc('advance_promo_fulfillment_notification_status', {
    p_provider_message_id: wamid,
    p_status: newStatus,
    p_timestamp: timestamp,
  });

  if (fnResult?.advanced) {
    logger.debug(`[FULFILLMENT-NOTIF] Delivery advanced -> ${newStatus}`);
    return { matched: true, advanced: true, newStatus: fnResult.new_status };
  }

  return { matched: true, advanced: false, reason: fnResult?.reason || 'not_advanced' };
}
