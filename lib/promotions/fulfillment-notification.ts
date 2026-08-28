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
 * ACC-204 Blocker 2: Uses claim_fulfillment_notification_dispatch RPC with
 * lease/token model. Flow:
 * 1. Claim with token + lease (30s default)
 * 2. Pre-provider work (channel resolve, template check, phone lookup)
 * 3. Mark provider_attempted_at (point of no return)
 * 4. sendTemplate with noRetry
 * 5. Finalize with WAMID or failure
 *
 * States:
 * A. pending, claim_token=NULL, provider_attempted_at=NULL → reclaimable
 * B. pending, claim_token=X, lease active, provider_attempted_at=NULL → claimed, reclaimable after expiry
 * C. pending, provider_attempted_at IS NOT NULL → provider attempted, NOT auto-reclaimable
 * D. sent, provider_message_id=X → success
 * E. failed → definite failure
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { MetaApiError } from '@/lib/channels/meta-api-error';
import { stripPlus } from '@/lib/utils/phone';
import { logger } from '@/lib/logger';

const FULFILLMENT_TEMPLATE_NAME = 'promo_fulfillment_status_v1';
const FULFILLMENT_TEMPLATE_LANGUAGE = 'en_US';

/** Bounded DB-only retry count for finalization after obtaining a WAMID. */
const FINALIZE_MAX_ATTEMPTS = 2;

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

/** Structured result of a WAMID finalization attempt. */
export type FinalizationResult =
  | { status: 'finalized'; wamid: string }
  | { status: 'already_finalized_same_wamid'; wamid: string }
  | { status: 'conflicting_wamid' }
  | { status: 'finalization_unresolved'; wamid: string };

/** Structured result of a dispatch attempt. */
export type DispatchResult =
  | { outcome: 'not_claimed' }
  | { outcome: 'pre_provider_failure'; reason: string }
  | { outcome: 'provider_ambiguous' }
  | { outcome: 'provider_failed' }
  | { outcome: 'sent'; wamid: string }
  | { outcome: 'finalization_unresolved'; wamid: string };

export async function dispatchFulfillmentNotification(
  service: SupabaseClient,
  intent: NotificationIntent,
  businessId: string,
): Promise<DispatchResult> {
  try {
    // Step 1: Atomic claim with lease — prevents concurrent dispatchers from
    // both calling the provider. If claim fails, another dispatcher already owns it.
    const { data: claimResult, error: claimError } = await service.rpc(
      'claim_fulfillment_notification_dispatch',
      { p_intent_id: intent.id },
    );

    if (claimError) {
      logger.error('[FULFILLMENT-NOTIF] Claim RPC error:', claimError);
      return { outcome: 'not_claimed' };
    }

    if (!claimResult?.claimed) {
      logger.debug('[FULFILLMENT-NOTIF] Claim not available (already claimed or not pending):', claimResult);
      return { outcome: 'not_claimed' };
    }

    const claimToken: string = claimResult.claim_token;

    // Step 2: Pre-provider work — channel resolve, template check, phone lookup
    // If any of these fail, the intent stays in state B (claimed, pre-provider)
    // and can be reclaimed after lease expiry.

    // 2a. Resolve WhatsApp channel
    const resolver = new ChannelResolver(service);
    const resolved = await resolver.resolveByBusinessId(businessId);

    if (!resolved?.sender || !resolved.sender.sendTemplate) {
      logger.warn('[FULFILLMENT-NOTIF] No template-capable channel for business', businessId);
      await finalizeIntent(service, intent.id, 'failed', undefined, claimToken);
      return { outcome: 'pre_provider_failure', reason: 'no_channel' };
    }

    // 2b. Check template readiness
    const meta = resolved.cloud;
    if (!meta) {
      logger.warn('[FULFILLMENT-NOTIF] No cloud service for template check');
      await finalizeIntent(service, intent.id, 'failed', undefined, claimToken);
      return { outcome: 'pre_provider_failure', reason: 'no_cloud' };
    }

    try {
      const existing = await meta.getTemplates();
      const template = (existing.data || []).find(
        (t: { name: string; language: string; status?: string }) =>
          t.name === FULFILLMENT_TEMPLATE_NAME && t.language === FULFILLMENT_TEMPLATE_LANGUAGE,
      );

      if (!template || template.status !== 'APPROVED') {
        logger.warn('[FULFILLMENT-NOTIF] Template not approved:', FULFILLMENT_TEMPLATE_NAME);
        await finalizeIntent(service, intent.id, 'failed', undefined, claimToken);
        return { outcome: 'pre_provider_failure', reason: 'template_not_approved' };
      }
    } catch (err) {
      logger.error('[FULFILLMENT-NOTIF] Template status check failed:', err);
      await finalizeIntent(service, intent.id, 'failed', undefined, claimToken);
      return { outcome: 'pre_provider_failure', reason: 'template_check_error' };
    }

    // 2c. Fetch winner phone (server-side only)
    const { data: redemption } = await service
      .from('promo_redemptions')
      .select('phone_e164, claim_reference, promo_code_id')
      .eq('id', intent.redemption_id)
      .single();

    if (!redemption?.phone_e164) {
      logger.error('[FULFILLMENT-NOTIF] No phone for redemption', intent.redemption_id);
      await finalizeIntent(service, intent.id, 'failed', undefined, claimToken);
      return { outcome: 'pre_provider_failure', reason: 'no_phone' };
    }

    // 2d. Fetch business name
    const { data: bizRecord } = await service
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .maybeSingle();
    const businessName = bizRecord?.name || 'Business';

    // 2e. Fetch campaign name
    const { data: campaign } = await service
      .from('promo_campaigns')
      .select('name')
      .eq('id', intent.campaign_id)
      .maybeSingle();
    const campaignName = campaign?.name || 'Promotion';

    // 2f. Fetch prize name
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

    // Step 3: Mark provider_attempted_at — POINT OF NO RETURN
    // After this, the intent is in state C (provider attempted, NOT auto-reclaimable).
    const { data: markResult, error: markError } = await service.rpc(
      'mark_fulfillment_notification_attempted',
      { p_intent_id: intent.id, p_claim_token: claimToken },
    );

    if (markError || !markResult?.success) {
      logger.error('[FULFILLMENT-NOTIF] Mark attempted failed — lease may have expired:', markError || markResult);
      // Lease expired and someone else reclaimed it, or state changed. Do NOT send.
      return { outcome: 'not_claimed' };
    }

    // Step 4: Send template — noRetry: delivery-critical promo notification
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
        return { outcome: 'provider_failed' };
      }
      // Ambiguous error (5xx/network) — provider_attempted_at is set (state C).
      // NOT auto-reclaimable. Manual recovery needed.
      logger.error('[FULFILLMENT-NOTIF] Ambiguous provider error — intent in state C (provider attempted):', err);
      return { outcome: 'provider_ambiguous' };
    }

    if (!messageId) {
      // No WAMID = ambiguous — state C (provider_attempted_at set, NOT reclaimable)
      logger.warn('[FULFILLMENT-NOTIF] Send succeeded but no WAMID — intent in state C');
      return { outcome: 'provider_ambiguous' };
    }

    // ── Cross-process WAMID durability: ACCEPTED RESIDUAL RISK ──
    // If Supabase (PostgreSQL) is unavailable after Meta accepts the message:
    // - The WAMID exists only in-process memory
    // - Sentry captures the error + WAMID as structured context (see CRITICAL logs below)
    // - But Sentry is NOT a durable transactional store — no cross-process reconciliation
    // - Meta has already accepted the message — resending would duplicate
    // - No outbox/dead-letter/reconciliation pattern exists in this codebase
    // - The only safe action: log WAMID via Sentry + console, accept residual risk
    // Decision: owner reviewed, accepted. Manual DB update if needed.

    // Step 5: Finalize with WAMID → bounded DB-only retry (ZERO additional Meta POSTs)
    const finResult = await finalizeIntentWithRetry(service, intent.id, messageId);

    if (finResult.status === 'finalized' || finResult.status === 'already_finalized_same_wamid') {
      logger.info(`[FULFILLMENT-NOTIF] Sent ${intent.to_status} notification for redemption ${intent.redemption_id}`);
      return { outcome: 'sent', wamid: messageId };
    }

    if (finResult.status === 'conflicting_wamid') {
      // Another WAMID was already finalized — should not happen in normal flow.
      // Do NOT log "Sent". Do NOT retry Meta.
      logger.error(`[FULFILLMENT-NOTIF] CRITICAL: Conflicting WAMID for intent ${intent.id}`);
      return { outcome: 'finalization_unresolved', wamid: messageId };
    }

    // finalization_unresolved: DB write failed persistently but we have a valid WAMID
    logger.error(`[FULFILLMENT-NOTIF] CRITICAL: Finalization unresolved for intent ${intent.id}, WAMID=${messageId}. Manual DB update required.`);
    return { outcome: 'finalization_unresolved', wamid: messageId };
  } catch (err) {
    // Catch-all: notification must NEVER propagate errors
    logger.error('[FULFILLMENT-NOTIF] Unexpected error (non-blocking):', err);
    try {
      await finalizeIntent(service, intent.id, 'failed');
    } catch { /* truly non-blocking */ }
    return { outcome: 'pre_provider_failure', reason: 'unexpected_error' };
  }
}

/**
 * Finalize intent with bounded DB-only retry. ZERO additional Meta POSTs.
 * Attempts up to FINALIZE_MAX_ATTEMPTS times to write the WAMID to DB.
 */
async function finalizeIntentWithRetry(
  service: SupabaseClient,
  intentId: string,
  wamid: string,
): Promise<FinalizationResult> {
  for (let attempt = 1; attempt <= FINALIZE_MAX_ATTEMPTS; attempt++) {
    const result = await finalizeIntent(service, intentId, 'sent', wamid);

    if (result.status === 'finalized' || result.status === 'already_finalized_same_wamid') {
      return result;
    }

    if (result.status === 'conflicting_wamid') {
      return result; // Not retryable — different WAMID already committed
    }

    // finalization_unresolved — DB transport error, retry
    if (attempt < FINALIZE_MAX_ATTEMPTS) {
      logger.warn(`[FULFILLMENT-NOTIF] Finalize attempt ${attempt} failed, retrying...`);
    }
  }

  return { status: 'finalization_unresolved', wamid };
}

async function finalizeIntent(
  service: SupabaseClient,
  intentId: string,
  status: 'sent' | 'failed',
  providerMessageId?: string,
  claimToken?: string,
): Promise<FinalizationResult> {
  const { data: finalizeResult, error: finalizeError } = await service.rpc('finalize_promo_fulfillment_notification', {
    p_intent_id: intentId,
    p_status: status,
    p_provider_message_id: providerMessageId || null,
    p_claim_token: claimToken || null,
  });

  if (finalizeError) {
    logger.error('[FULFILLMENT-NOTIF] Finalization transport error:', finalizeError);
    return { status: 'finalization_unresolved', wamid: providerMessageId || '' };
  }

  if (finalizeResult?.success) {
    if (finalizeResult.reason === 'idempotent') {
      return { status: 'already_finalized_same_wamid', wamid: providerMessageId || '' };
    }
    return { status: 'finalized', wamid: providerMessageId || '' };
  }

  // success=false: check if it's a conflicting WAMID or something else
  if (finalizeResult?.reason === 'not_pending') {
    // Intent is already finalized — could be same WAMID (idempotent) or different (conflicting)
    return { status: 'conflicting_wamid' };
  }

  if (finalizeResult?.reason === 'invalid_claim_for_failure') {
    // Stale worker tried to finalize as failed but lease expired or was reclaimed.
    // This is expected behavior — a new claimant now owns the intent.
    logger.warn('[FULFILLMENT-NOTIF] Pre-provider failure rejected: stale claim token');
    return { status: 'finalization_unresolved', wamid: '' };
  }

  logger.error('[FULFILLMENT-NOTIF] Finalization failed:', finalizeResult);
  return { status: 'finalization_unresolved', wamid: providerMessageId || '' };
}
