export const MERCHANT_NOTIFICATION_EVENTS = ['sale', 'payment', 'appointment', 'booking'] as const;
export type MerchantNotificationEvent = typeof MERCHANT_NOTIFICATION_EVENTS[number];
export type MerchantNotificationChannel = 'whatsapp' | 'email';
export const MERCHANT_NOTIFICATION_CONSENT_VERSION = 'merchant-alerts-v1';
export const MERCHANT_NOTIFICATION_TEMPLATE = 'name_waaiio_merchant_alert_v1';
export const MERCHANT_NOTIFICATION_TEMPLATE_LANGUAGE = 'en';
export function isMerchantNotificationsEnabled(): boolean {
  return process.env.MERCHANT_NOTIFICATIONS_ENABLED === 'true';
}
export interface MerchantNotificationRecipient {
  id: string; business_id: string; label: string;
  channel: MerchantNotificationChannel; address: string;
  events: MerchantNotificationEvent[]; enabled: boolean;
  verified_at: string | null; revoked_at: string | null; created_at: string;
  whatsapp_channel_id: string | null; consent_version: string | null; stopped_at?: string | null;
}
export interface MerchantNotificationDelivery {
  id: string; business_id: string; recipient_id: string;
  channel: MerchantNotificationChannel; address: string;
  whatsapp_channel_id: string | null; event: MerchantNotificationEvent;
  source_table: string; source_id: string; claim_token: string;
  payload: { title: string; reference: string; detail: string };
}
