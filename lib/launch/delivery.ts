/**
 * Launch Alert Delivery Service (#397)
 *
 * Sends WhatsApp template notifications to opted-in launch subscribers.
 * Uses each subscriber's recorded regional Waaiio sender (receiving_number).
 *
 * Safety invariants:
 * - Never sends to opted-out subscribers
 * - Idempotent per (wa_number, campaign_version) — safe against retries
 * - Uses approved WhatsApp templates, not free-form outbound
 * - Template name/language configurable via platform_settings
 * - No changes to payment, fulfillment, or commerce flows
 * - No live Meta sends during tests (MetaCloudService is injected)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

// ── Types ──

export interface LaunchSubscriber {
  id: string;
  wa_number: string;
  market: string;
  receiving_number: string;
  opt_in_status: string;
  notification_status: string;
  campaign_version: string | null;
}

export interface ChannelCredentials {
  phone_number_id: string;
  meta_access_token: string | null;
  waba_id: string | null;
  phone_number: string;
}

export interface DeliveryResult {
  subscriberId: string;
  status: 'sent' | 'failed' | 'skipped';
  messageId?: string;
  error?: string;
}

export interface DeliverySummary {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  results: DeliveryResult[];
}

export interface LaunchDeliveryConfig {
  templateName: string;
  templateLanguage: string;
  templateParams: string[];
  campaignVersion: string;
}

// ── Default config ──

const DEFAULT_TEMPLATE_NAME = 'waaiio_launch_alert';
const DEFAULT_TEMPLATE_LANGUAGE = 'en_US';

// ── Readiness counts ──

export async function getDeliveryReadiness(
  supabase: SupabaseClient,
  campaignVersion: string,
): Promise<{
  eligible: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
  opted_out: number;
}> {
  const { data: all } = await supabase
    .from('launch_subscribers')
    .select('opt_in_status, notification_status, campaign_version');

  const rows = all || [];
  return {
    eligible: rows.filter(r => r.opt_in_status === 'active').length,
    pending: rows.filter(r => r.opt_in_status === 'active' && (r.notification_status === 'pending' || r.notification_status === 'failed') && r.campaign_version !== campaignVersion).length,
    sent: rows.filter(r => r.campaign_version === campaignVersion && r.notification_status === 'sent').length,
    failed: rows.filter(r => r.campaign_version === campaignVersion && r.notification_status === 'failed').length,
    skipped: rows.filter(r => r.notification_status === 'skipped' || r.opt_in_status === 'opted_out').length,
    opted_out: rows.filter(r => r.opt_in_status === 'opted_out').length,
  };
}

// ── Load config from platform_settings ──

export async function loadDeliveryConfig(
  supabase: SupabaseClient,
): Promise<LaunchDeliveryConfig> {
  const { data } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'launch_notification_config')
    .single();

  const config = (data?.value || {}) as Record<string, unknown>;

  return {
    templateName: (config.template_name as string) || DEFAULT_TEMPLATE_NAME,
    templateLanguage: (config.template_language as string) || DEFAULT_TEMPLATE_LANGUAGE,
    templateParams: (config.template_params as string[]) || ['Waaiio'],
    campaignVersion: (config.campaign_version as string) || 'v1',
  };
}

// ── Resolve channel credentials for a receiving number ──

export async function resolveChannelCredentials(
  supabase: SupabaseClient,
  receivingNumber: string,
): Promise<ChannelCredentials | null> {
  const { data } = await supabase
    .from('whatsapp_channels')
    .select('phone_number_id, meta_access_token, waba_id, phone_number')
    .eq('phone_number', receivingNumber)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (!data?.phone_number_id) return null;
  return data as ChannelCredentials;
}

// ── Send to a single subscriber ──

export async function sendToSubscriber(
  supabase: SupabaseClient,
  subscriber: LaunchSubscriber,
  config: LaunchDeliveryConfig,
  sendTemplateFn: (
    credentials: ChannelCredentials,
    to: string,
    templateName: string,
    language: string,
    params: string[],
  ) => Promise<{ messageId: string }>,
): Promise<DeliveryResult> {
  const { id, wa_number, receiving_number, opt_in_status } = subscriber;

  // Guard: never send to opted-out subscribers
  if (opt_in_status !== 'active') {
    await supabase
      .from('launch_subscribers')
      .update({ notification_status: 'skipped', updated_at: new Date().toISOString() })
      .eq('id', id);
    return { subscriberId: id, status: 'skipped', error: 'opted_out' };
  }

  // Guard: idempotent — skip if already sent for this campaign
  if (subscriber.campaign_version === config.campaignVersion && subscriber.notification_status === 'sent') {
    return { subscriberId: id, status: 'skipped', error: 'already_sent' };
  }

  // Resolve channel credentials for the subscriber's regional sender
  const credentials = await resolveChannelCredentials(supabase, receiving_number);
  if (!credentials) {
    logger.warn(`[LAUNCH] No channel found for receiving_number=${receiving_number}, subscriber=${id}`);
    await supabase
      .from('launch_subscribers')
      .update({
        notification_status: 'failed',
        delivery_error: 'no_channel_credentials',
        campaign_version: config.campaignVersion,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    return { subscriberId: id, status: 'failed', error: 'no_channel_credentials' };
  }

  try {
    const result = await sendTemplateFn(
      credentials,
      wa_number,
      config.templateName,
      config.templateLanguage,
      config.templateParams,
    );

    await supabase
      .from('launch_subscribers')
      .update({
        notification_status: 'sent',
        provider_message_id: result.messageId,
        campaign_version: config.campaignVersion,
        delivery_error: null,
        delivered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    return { subscriberId: id, status: 'sent', messageId: result.messageId };
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    logger.error(`[LAUNCH] Send failed for subscriber=${id}:`, errText);

    await supabase
      .from('launch_subscribers')
      .update({
        notification_status: 'failed',
        delivery_error: errText.substring(0, 500),
        campaign_version: config.campaignVersion,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    return { subscriberId: id, status: 'failed', error: errText };
  }
}

// ── Batch delivery ──

export async function deliverLaunchNotifications(
  supabase: SupabaseClient,
  config: LaunchDeliveryConfig,
  sendTemplateFn: (
    credentials: ChannelCredentials,
    to: string,
    templateName: string,
    language: string,
    params: string[],
  ) => Promise<{ messageId: string }>,
  options?: { retryOnly?: boolean; limit?: number },
): Promise<DeliverySummary> {
  const limit = options?.limit || 100;

  // Query eligible subscribers
  let query = supabase
    .from('launch_subscribers')
    .select('id, wa_number, market, receiving_number, opt_in_status, notification_status, campaign_version')
    .eq('opt_in_status', 'active')
    .limit(limit);

  if (options?.retryOnly) {
    // Retry only failed/pending for this campaign version
    query = query
      .eq('campaign_version', config.campaignVersion)
      .in('notification_status', ['failed', 'pending']);
  } else {
    // Send to pending or those not yet sent for this campaign
    query = query.in('notification_status', ['pending', 'failed']);
  }

  const { data: subscribers, error } = await query;

  if (error || !subscribers) {
    logger.error('[LAUNCH] Failed to query subscribers:', error?.message);
    return { total: 0, sent: 0, failed: 0, skipped: 0, results: [] };
  }

  // Filter out already-sent for this campaign version (belt + suspenders for idempotency)
  const eligible = subscribers.filter(
    s => !(s.campaign_version === config.campaignVersion && s.notification_status === 'sent'),
  );

  const results: DeliveryResult[] = [];
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  // Process sequentially to respect rate limits
  for (const sub of eligible) {
    const result = await sendToSubscriber(supabase, sub, config, sendTemplateFn);
    results.push(result);
    if (result.status === 'sent') sent++;
    else if (result.status === 'failed') failed++;
    else skipped++;
  }

  return { total: eligible.length, sent, failed, skipped, results };
}

// ── Production send function (uses MetaCloudService) ──

export async function metaCloudSendTemplate(
  credentials: ChannelCredentials,
  to: string,
  templateName: string,
  language: string,
  params: string[],
): Promise<{ messageId: string }> {
  // Dynamic import to avoid loading Meta SDK in test context
  const { MetaCloudService } = await import('@/lib/channels/meta-cloud');
  const cloud = new MetaCloudService({
    accessToken: credentials.meta_access_token || process.env.META_CLOUD_ACCESS_TOKEN || '',
    phoneNumberId: credentials.phone_number_id,
    wabaId: credentials.waba_id || process.env.META_CLOUD_WABA_ID || '',
  });

  return cloud.sendTemplate({
    to,
    templateName,
    languageCode: language,
    components: params.length > 0
      ? [{ type: 'body' as const, parameters: params.map(p => ({ type: 'text' as const, text: p })) }]
      : [],
  });
}
