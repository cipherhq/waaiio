/**
 * ACC-204: Fulfillment notification dispatch.
 *
 * Resolves channel, checks template readiness, sends notification to winner,
 * and updates the intent with provider_message_id + delivery status.
 *
 * CONSTRAINT: Notification failure must NEVER roll back fulfillment.
 * This function never throws — all errors are logged and the intent is
 * marked 'failed' so it doesn't block future transitions.
 *
 * ACC-204 Blocker 2: Uses claim_fulfillment_notification_dispatch RPC for
 * single-winner atomic claim before any provider call.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { MetaApiError } from '@/lib/channels/meta-api-error';
import { stripPlus } from '@/lib/utils/phone';
import { logger } from '@/lib/logger';

const FULFILLMENT_TEMPLATE_NAME = 'promo_fulfillment_status_v1';
const FULFILLMENT_TEMPLATE_LANGUAGE = 'en_US';

/** Format fulfillment status for template display. */
function formatStatus(status: string): string {
  switch (status) {
    case 'processing': return 'Processing';
    case 'fulfilled': return 'Fulfilled';
    case 'rejected': return 'Rejected';
    case 'cancelled': return 'Cancelled';
    default: return status;
  }
}

interface NotificationIntent {
  id: string;
  redemption_id: string;
  to_status: string;
  campaign_id: string;
}

export async function dispatchFulfillmentNotification(
  service: SupabaseClient,
  intent: NotificationIntent,
  businessId: string,
): Promise<void> {
  try {
    // ACC-204 Blocker 2: Atomic claim — prevents concurrent dispatchers from
    // both calling the provider. If claim fails, another dispatcher already owns it.
    const { data: claimResult, error: claimError } = await service.rpc(
      'claim_fulfillment_notification_dispatch',
      { p_intent_id: intent.id },
    );

    if (claimError) {
      logger.error('[FULFILLMENT-NOTIF] Claim RPC error:', claimError);
      return; // Non-blocking — don't throw
    }

    if (!claimResult?.claimed) {
      logger.debug('[FULFILLMENT-NOTIF] Claim not available (already claimed or not pending):', claimResult);
      return; // Another dispatcher owns this intent — zero provider call
    }

    // 1. Resolve WhatsApp channel
    const resolver = new ChannelResolver(service);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (!resolved?.sender || !resolved.sender.sendTemplate) {
      logger.warn('[FULFILLMENT-NOTIF] No template-capable channel for business', businessId);
      await finalizeIntent(service, intent.id, 'failed');
      return;
    }

    // 2. Check template readiness
    const meta = resolved.cloud;
    if (!meta) {
      logger.warn('[FULFILLMENT-NOTIF] No cloud service for template check');
      await finalizeIntent(service, intent.id, 'failed');
      return;
    }

    try {
      const existing = await meta.getTemplates();
      const template = (existing.data || []).find(
        (t: { name: string; language: string; status?: string }) =>
          t.name === FULFILLMENT_TEMPLATE_NAME && t.language === FULFILLMENT_TEMPLATE_LANGUAGE,
      );

      if (!template || template.status !== 'APPROVED') {
        logger.warn('[FULFILLMENT-NOTIF] Template not approved:', FULFILLMENT_TEMPLATE_NAME);
        await finalizeIntent(service, intent.id, 'failed');
        return;
      }
    } catch (err) {
      logger.error('[FULFILLMENT-NOTIF] Template status check failed:', err);
      await finalizeIntent(service, intent.id, 'failed');
      return;
    }

    // 3. Fetch winner phone (server-side only)
    const { data: redemption } = await service
      .from('promo_redemptions')
      .select('phone_e164, claim_reference, promo_code_id')
      .eq('id', intent.redemption_id)
      .single();

    if (!redemption?.phone_e164) {
      logger.error('[FULFILLMENT-NOTIF] No phone for redemption', intent.redemption_id);
      await finalizeIntent(service, intent.id, 'failed');
      return;
    }

    // 4. Fetch business name
    const { data: bizRecord } = await service
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .maybeSingle();
    const businessName = bizRecord?.name || 'Business';

    // 5. Fetch campaign name
    const { data: campaign } = await service
      .from('promo_campaigns')
      .select('name')
      .eq('id', intent.campaign_id)
      .maybeSingle();
    const campaignName = campaign?.name || 'Promotion';

    // 6. Fetch prize name
    let prizeName = 'Prize';
    if (redemption.promo_code_id) {
      const { data: codeRow } = await service
        .from('promo_campaign_codes')
        .select('prize_id')
        .eq('id', redemption.promo_code_id)
        .maybeSingle();
      if (codeRow?.prize_id) {
        const { data: prize } = await service
          .from('promo_prizes')
          .select('name')
          .eq('id', codeRow.prize_id)
          .maybeSingle();
        if (prize?.name) prizeName = prize.name;
      }
    }

    const claimReference = redemption.claim_reference || 'N/A';
    const statusLabel = formatStatus(intent.to_status);

    // 7. Send template — noRetry: delivery-critical promo notification
    // NOTE: attempted_at was already set by the claim RPC — no separate update needed
    let messageId: string | undefined;
    try {
      const phone = stripPlus(redemption.phone_e164);
      const result = await resolved.sender.sendTemplate({
        to: phone,
        templateName: FULFILLMENT_TEMPLATE_NAME,
        templateParams: [businessName, campaignName, prizeName, claimReference, statusLabel],
        noRetry: true,
      });
      messageId = result?.messageId;
    } catch (err) {
      const isDefiniteRejection = err instanceof MetaApiError && err.httpStatus >= 400 && err.httpStatus < 500;
      if (isDefiniteRejection) {
        logger.error('[FULFILLMENT-NOTIF] WhatsApp template rejected (4xx):', err);
        await finalizeIntent(service, intent.id, 'failed');
        return;
      }
      // Ambiguous error — leave as pending with attempted_at set (claim RPC already set it)
      logger.error('[FULFILLMENT-NOTIF] Ambiguous provider error — intent stays attempted:', err);
      return;
    }

    if (!messageId) {
      // No WAMID = ambiguous — leave with attempted_at set
      logger.warn('[FULFILLMENT-NOTIF] Send succeeded but no WAMID — intent stays attempted');
      return;
    }

    // 8. Finalize with WAMID
    await finalizeIntent(service, intent.id, 'sent', messageId);
    logger.info(`[FULFILLMENT-NOTIF] Sent ${intent.to_status} notification for redemption ${intent.redemption_id}`);
  } catch (err) {
    // Catch-all: notification must NEVER propagate errors
    logger.error('[FULFILLMENT-NOTIF] Unexpected error (non-blocking):', err);
    try {
      await finalizeIntent(service, intent.id, 'failed');
    } catch { /* truly non-blocking */ }
  }
}

async function finalizeIntent(
  service: SupabaseClient,
  intentId: string,
  status: 'sent' | 'failed',
  providerMessageId?: string,
): Promise<void> {
  const { data: finalizeResult, error: finalizeError } = await service.rpc('finalize_promo_fulfillment_notification', {
    p_intent_id: intentId,
    p_status: status,
    p_provider_message_id: providerMessageId || null,
  });
  // ACC-204 Blocker 2: Check BOTH error AND semantic success
  if (finalizeError || !finalizeResult?.success) {
    logger.error('[FULFILLMENT-NOTIF] Finalization failed:', finalizeError || finalizeResult);
  }
}
