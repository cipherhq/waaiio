import type { SupabaseClient } from '@supabase/supabase-js';
import { isMerchantNotificationsEnabled, type MerchantNotificationChannel, type MerchantNotificationEvent } from './types';

/** Explicit STOP survives rollout changes and recipient removal until fresh proof clears it. */
export async function hasStoppedMerchantNotifications(
  db: SupabaseClient, businessId: string, destination: string,
): Promise<boolean> {
  const address = `+${destination.replace(/\D/g, '')}`;
  try {
    const { data, error } = await db.from('merchant_notification_recipients')
      .select('id').eq('business_id', businessId).eq('channel', 'whatsapp')
      .eq('address', address).not('stopped_at', 'is', null).limit(1);
    // Before the recipient/STOP schema exists, retain the prior notification behavior.
    // Other failures must not allow an opted-out destination to receive another alert.
    if (error) return !['42P01', '42703', 'PGRST205', 'PGRST204'].includes(error.code || '');
    return Boolean(data?.length);
  } catch { return true; }
}

/** Only replace a legacy send when its exact destination and source already have a durable intent. */
export async function hasMerchantNotificationIntent(db: SupabaseClient, input: {
  businessId: string; channel: MerchantNotificationChannel; address: string;
  event: MerchantNotificationEvent; sourceTable?: 'orders'|'bookings'|'reservations'|'payments'; sourceId?: string; reference?: string;
}): Promise<boolean> {
  if (!isMerchantNotificationsEnabled() || (!input.sourceId && !input.reference)) return false;
  try {
  const address = input.channel==='email' ? input.address.trim().toLowerCase() : `+${input.address.replace(/\D/g,'')}`;
  let query = db.from('merchant_notification_deliveries').select('id').eq('business_id',input.businessId).eq('channel',input.channel).eq('address',address).eq('event',input.event);
  if (input.sourceTable) query=query.eq('source_table',input.sourceTable);
  if (input.sourceId) query=query.eq('source_id',input.sourceId);
  else query=query.eq('payload->>reference',input.reference!);
  const result=await query.limit(1);
  // Unavailable feature schema must preserve legacy behavior during staged rollout.
  return !result.error && Boolean(result.data?.length);
  } catch { return false; }
}
