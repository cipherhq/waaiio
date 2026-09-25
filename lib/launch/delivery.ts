/**
 * Launch Alert Delivery Service (#397)
 *
 * Sends WhatsApp template notifications to opted-in launch subscribers.
 * Uses each subscriber's recorded regional Waaiio sender (receiving_number).
 *
 * Safety invariants:
 * - Atomic claim/fencing: exactly one worker owns delivery per subscriber+campaign
 * - Losing claims MUST NOT send — claim_token verified before and after Meta call
 * - Never sends to opted-out subscribers (enforced by claim RPC)
 * - Uses approved WhatsApp templates, not free-form outbound
 * - Fails closed when template/config is missing or invalid
 * - No changes to payment, fulfillment, or commerce flows
 * - No live Meta sends during tests (sendTemplateFn is injected)
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

export class LaunchConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchConfigError';
  }
}

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
  confirmToken: string;
}> {
  const { data: all } = await supabase
    .from('launch_subscribers')
    .select('opt_in_status, notification_status, campaign_version');

  const rows = all || [];

  // Generate a confirmation token for the admin to use when triggering send
  const { randomUUID } = await import('crypto');
  const confirmToken = randomUUID();

  return {
    eligible: rows.filter(r => r.opt_in_status === 'active').length,
    pending: rows.filter(r => r.opt_in_status === 'active' && (r.notification_status === 'pending' || r.notification_status === 'failed') && r.campaign_version !== campaignVersion).length,
    sent: rows.filter(r => r.campaign_version === campaignVersion && r.notification_status === 'sent').length,
    failed: rows.filter(r => r.campaign_version === campaignVersion && r.notification_status === 'failed').length,
    skipped: rows.filter(r => r.notification_status === 'skipped' || r.opt_in_status === 'opted_out').length,
    opted_out: rows.filter(r => r.opt_in_status === 'opted_out').length,
    confirmToken,
  };
}

// ── Load config from platform_settings — FAILS CLOSED ──

export async function loadDeliveryConfig(
  supabase: SupabaseClient,
): Promise<LaunchDeliveryConfig> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select('value')
    .eq('key', 'launch_notification_config')
    .single();

  if (error || !data?.value) {
    throw new LaunchConfigError(
      'launch_notification_config not found in platform_settings. Seed it before sending.',
    );
  }

  const config = data.value as Record<string, unknown>;

  const templateName = config.template_name as string | undefined;
  const templateLanguage = config.template_language as string | undefined;
  const campaignVersion = config.campaign_version as string | undefined;

  if (!templateName || templateName.trim().length === 0) {
    throw new LaunchConfigError(
      'launch_notification_config.template_name is missing or empty. Set an approved Meta template name.',
    );
  }
  if (!campaignVersion || campaignVersion.trim().length === 0) {
    throw new LaunchConfigError(
      'launch_notification_config.campaign_version is missing or empty.',
    );
  }

  return {
    templateName: templateName.trim(),
    templateLanguage: (templateLanguage || 'en_US').trim(),
    templateParams: (config.template_params as string[]) || [],
    campaignVersion: campaignVersion.trim(),
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

// ── Atomic claim + send to a single subscriber ──

export async function claimAndSendToSubscriber(
  supabase: SupabaseClient,
  subscriberId: string,
  config: LaunchDeliveryConfig,
  sendTemplateFn: (
    credentials: ChannelCredentials,
    to: string,
    templateName: string,
    language: string,
    params: string[],
  ) => Promise<{ messageId: string }>,
): Promise<DeliveryResult> {
  // Step 1: Atomic claim — only one worker can win
  const { data: claimResult, error: claimError } = await supabase.rpc(
    'claim_launch_delivery',
    { p_subscriber_id: subscriberId, p_campaign_version: config.campaignVersion },
  );

  if (claimError) {
    logger.error(`[LAUNCH] Claim RPC error for subscriber=${subscriberId}:`, claimError.message);
    return { subscriberId, status: 'failed', error: 'claim_rpc_error' };
  }

  const claim = claimResult as { claimed: boolean; claim_token?: string; wa_number?: string; receiving_number?: string; reason?: string; already_sent?: boolean };

  if (!claim?.claimed) {
    if (claim?.already_sent) {
      return { subscriberId, status: 'skipped', error: 'already_sent' };
    }
    if (claim?.reason === 'opted_out') {
      return { subscriberId, status: 'skipped', error: 'opted_out' };
    }
    return { subscriberId, status: 'skipped', error: claim?.reason || 'claim_lost' };
  }

  const claimToken = claim.claim_token!;
  const waNumber = claim.wa_number!;
  const receivingNumber = claim.receiving_number!;

  // Step 2: Resolve channel credentials
  const credentials = await resolveChannelCredentials(supabase, receivingNumber);
  if (!credentials) {
    logger.warn(`[LAUNCH] No channel for receiving_number=${receivingNumber}, subscriber=${subscriberId}`);
    await supabase.rpc('complete_launch_delivery', {
      p_subscriber_id: subscriberId,
      p_claim_token: claimToken,
      p_status: 'failed',
      p_error: 'no_channel_credentials',
    });
    return { subscriberId, status: 'failed', error: 'no_channel_credentials' };
  }

  // Step 3: Send template — ONLY if we hold the claim
  try {
    const result = await sendTemplateFn(
      credentials,
      waNumber,
      config.templateName,
      config.templateLanguage,
      config.templateParams,
    );

    // Step 4: Complete claim with success — claim_token is verified by RPC
    const { data: completeResult } = await supabase.rpc('complete_launch_delivery', {
      p_subscriber_id: subscriberId,
      p_claim_token: claimToken,
      p_status: 'sent',
      p_message_id: result.messageId,
    });

    if (!(completeResult as { completed?: boolean })?.completed) {
      // We sent but lost the claim — log but don't fail (message was delivered)
      logger.warn(`[LAUNCH] Claim lost after send for subscriber=${subscriberId} — message delivered but status may be stale`);
    }

    return { subscriberId, status: 'sent', messageId: result.messageId };
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    logger.error(`[LAUNCH] Send failed for subscriber=${subscriberId}:`, errText);

    await supabase.rpc('complete_launch_delivery', {
      p_subscriber_id: subscriberId,
      p_claim_token: claimToken,
      p_status: 'failed',
      p_error: errText.substring(0, 500),
    });

    return { subscriberId, status: 'failed', error: errText };
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

  // Query candidate subscribers (actual eligibility enforced by claim RPC)
  let query = supabase
    .from('launch_subscribers')
    .select('id')
    .eq('opt_in_status', 'active')
    .limit(limit);

  if (options?.retryOnly) {
    query = query
      .eq('campaign_version', config.campaignVersion)
      .in('notification_status', ['failed', 'pending']);
  } else {
    query = query.in('notification_status', ['pending', 'failed']);
  }

  const { data: candidates, error } = await query;

  if (error || !candidates) {
    logger.error('[LAUNCH] Failed to query subscribers:', error?.message);
    return { total: 0, sent: 0, failed: 0, skipped: 0, results: [] };
  }

  const results: DeliveryResult[] = [];
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  // Process sequentially to respect rate limits + claim ordering
  for (const candidate of candidates) {
    const result = await claimAndSendToSubscriber(supabase, candidate.id, config, sendTemplateFn);
    results.push(result);
    if (result.status === 'sent') sent++;
    else if (result.status === 'failed') failed++;
    else skipped++;
  }

  return { total: candidates.length, sent, failed, skipped, results };
}

// ── Production send function (uses MetaCloudService) ──

export async function metaCloudSendTemplate(
  credentials: ChannelCredentials,
  to: string,
  templateName: string,
  language: string,
  params: string[],
): Promise<{ messageId: string }> {
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
