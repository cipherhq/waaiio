import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

export type PaymentNotificationResult = 'created' | 'duplicate' | 'failed';

/**
 * Merchant in-app notification for one successful payment.
 *
 * At most one row per payment: a webhook retry, the recovery cron or a saved-card
 * reconcile that re-enters Stage 3 finds the row by metadata.payment_id and inserts
 * nothing. If that lookup fails we skip rather than risk a duplicate.
 *
 * Never throws: a missing notification must not hold a payment confirmation open.
 * type/channel use the notification_type / notification_channel enum values
 * (001_initial_schema.sql); 'whatsapp' is the existing channel for in-app payment rows.
 */
export async function createPaymentNotification(
  supabase: SupabaseClient,
  opts: { businessId: string; paymentId: string; bookingId?: string | null; body: string },
): Promise<PaymentNotificationResult> {
  const log = (label: string, err: unknown) => logger
    .withContext({ op: `payment-notification.${label}`, paymentId: opts.paymentId, ...safeLogErrorContext(err) })
    .error(`[PAYMENT-NOTIFICATION] ${label} failed`);
  try {
    const { data: existing, error: lookupError } = await supabase
      .from('notifications')
      .select('id')
      .eq('business_id', opts.businessId)
      .contains('metadata', { payment_id: opts.paymentId })
      .limit(1);
    if (lookupError) { log('lookup', lookupError); return 'failed'; }
    if (existing && existing.length > 0) return 'duplicate';

    const { error: insertError } = await supabase.from('notifications').insert({
      business_id: opts.businessId,
      booking_id: opts.bookingId || null,
      type: 'payment',
      channel: 'whatsapp',
      body: opts.body,
      metadata: { payment_id: opts.paymentId },
      status: 'delivered',
      delivered_at: new Date().toISOString(),
    });
    if (insertError) { log('insert', insertError); return 'failed'; }
    return 'created';
  } catch (err) {
    log('unexpected', err);
    return 'failed';
  }
}
