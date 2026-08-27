/**
 * ACC-204: Fulfillment notification dispatch.
 *
 * Resolves channel, checks template readiness, sends notification to winner,
 * and updates the intent with provider_message_id + delivery status.
 *
 * CONSTRAINT: Notification failure must NEVER roll back fulfillment.
 * This function never throws — all errors are logged and the intent is
 * marked 'failed' so it doesn't block future transitions.
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

    // 7. Mark attempted BEFORE provider call — crash-safe idempotency
    // If process crashes after this but before provider responds, the intent has
    // attempted_at set (ambiguous — do NOT auto-retry immediately).
    await service
      .from('promo_fulfillment_notification_intents')
      .update({ attempted_at: new Date().toISOString() })
      .eq('id', intent.id)
      .eq('delivery_status', 'pending');

    // 8. Send template — noRetry: delivery-critical promo notification
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
      // Ambiguous error — leave as pending (Meta may have accepted)
      logger.error('[FULFILLMENT-NOTIF] Ambiguous provider error — intent stays pending:', err);
      return;
    }

    if (!messageId) {
      // No WAMID = ambiguous — leave pending
      logger.warn('[FULFILLMENT-NOTIF] Send succeeded but no WAMID — intent stays pending');
      return;
    }

    // 9. Finalize with WAMID
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
  const { error } = await service.rpc('finalize_promo_fulfillment_notification', {
    p_intent_id: intentId,
    p_status: status,
    p_provider_message_id: providerMessageId || null,
  });
  if (error) {
    logger.error('[FULFILLMENT-NOTIF] Finalize RPC error:', error);
  }
}
