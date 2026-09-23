/**
 * Shared fenced delivery helper for saved-card activation and confirmation messages.
 *
 * Classifies send errors as pre-emission (retryable) vs ambiguous (non-retryable)
 * and uses the appropriate RPC to release or preserve the send_started fence.
 *
 * Also exports processSavedCardConfirmationRecovery — the production confirmation
 * recovery loop extracted from the cron route for testability.
 *
 * #370 P0 — phone normalization fix
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { canonicalSavedCardPhone } from '@/lib/payments/saved-card-compat';

/**
 * Classify whether a send error is proven pre-emission (no message left the provider).
 * Pre-emission errors are safe to retry; ambiguous errors may have emitted a message.
 */
export function isProvenPreEmission(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; isGateBlock?: boolean; isAmbiguous?: boolean; message?: string };

  // MessagingSuspendedError — send-guard rejected before provider call
  if (e.name === 'MessagingSuspendedError') return true;

  // GateBlockError — attempt-recording gate blocked before provider call
  if (e.name === 'GateBlockError' || e.isGateBlock === true) return true;

  // CircuitBreakerOpenError — circuit breaker blocked before provider call
  if (e.name === 'CircuitBreakerOpenError') return true;

  // Financial authorization errors from message-sender.ts assertMessagingAllowed —
  // thrown as generic Error with message prefix, never reaches the provider
  if (err instanceof Error && err.message.startsWith('Financial authorization')) return true;

  // Explicit ambiguous flag means it may have emitted
  if (e.isAmbiguous === true) return false;

  return false;
}

/** Classified delivery outcomes */
export type DeliveryOutcome = 'delivered' | 'channel_failed' | 'claim_stale' | 'pre_emission_failure' | 'ambiguous' | 'no_wamid' | 'completion_failed' | 'release_failed';

/** RPC result shape — compatible with both Promise and PostgrestFilterBuilder (thenable) */
type RpcResult = PromiseLike<{ data: unknown; error: unknown }>;

export interface FencedDeliveryParams {
  supabase: SupabaseClient;
  offerId: string;
  claimToken: string;
  customerPhone: string;
  businessId: string;
  channelId: string;
  messageText: string;
  /** Typed callback: mark send started (before provider call) */
  markStarted: (offerId: string, claimToken: string) => RpcResult;
  /** Typed callback: complete delivery (after proven send with WAMID) */
  complete: (offerId: string, claimToken: string) => RpcResult;
  /** Typed callback: release on proven pre-emission failure */
  releasePreEmission: (offerId: string, claimToken: string) => RpcResult;
}

/**
 * Send a message with fenced delivery lifecycle:
 * 1. Resolve channel by ID for business
 * 2. Mark send started (prevents auto-retry)
 * 3. Send message via resolved channel
 * 4. On success: complete delivery (requires messageId proof)
 * 5. On pre-emission failure: release for retry
 * 6. On ambiguous failure: leave send_started set (non-retryable)
 *
 * Returns a DeliveryOutcome classifying what happened.
 */
export async function sendWithFencedDelivery(params: FencedDeliveryParams): Promise<DeliveryOutcome> {
  const {
    supabase, offerId, claimToken, customerPhone, businessId,
    channelId, messageText, markStarted, complete, releasePreEmission,
  } = params;

  const logPrefix = '[FENCED-DELIVERY]';

  // 1. Resolve channel
  const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
  const resolver = new ChannelResolver(supabase);
  const resolved = await resolver.resolveByChannelIdForBusiness(channelId, businessId);

  if (!resolved) {
    logger.warn(`${logPrefix} Channel resolution failed — releasing`, { offerId, channelId, businessId });
    const { data: released, error: relErr } = await releasePreEmission(offerId, claimToken);
    if (relErr || !released) {
      logger.error(`${logPrefix} Channel-failed release unsuccessful`, { relErr, released, offerId });
      return 'release_failed';
    }
    return 'channel_failed';
  }

  // 2. Mark send started
  const { data: started, error: startErr } = await markStarted(offerId, claimToken);

  if (startErr) {
    logger.error(`${logPrefix} Mark-started RPC error`, { offerId, startErr });
    return 'claim_stale';
  }
  if (!started) {
    logger.warn(`${logPrefix} Could not mark send started — claim may be stale`, { offerId });
    return 'claim_stale';
  }

  // 3. Send message — require messageId (WAMID) as positive delivery evidence
  let messageId: string | undefined;
  try {
    const to = customerPhone.replace(/^\+/, '');
    const result = await resolved.sender.sendText({ to, text: messageText });
    messageId = (result as { messageId?: string })?.messageId;
  } catch (sendErr: unknown) {
    if (isProvenPreEmission(sendErr)) {
      // 5. Pre-emission: safe to retry — clear send_started
      logger.info(`${logPrefix} Pre-emission failure — releasing for retry`, { offerId, err: sendErr });
      const { data: released, error: relErr } = await releasePreEmission(offerId, claimToken);
      if (relErr || !released) {
        logger.error(`${logPrefix} Pre-emission release failed`, { relErr, released, offerId });
        // send-started remains set — offer is stuck non-auto-retryable
        return 'release_failed';
      }
      return 'pre_emission_failure'; // Successfully released, retryable
    } else {
      // 6. Ambiguous: may have emitted — leave send_started set
      logger.error(`${logPrefix} Ambiguous send failure — non-retryable`, { offerId, err: sendErr });
    }
    return 'ambiguous';
  }

  if (!messageId) {
    // Provider accepted but no WAMID — ambiguous, leave send_started set
    logger.error(`${logPrefix} Send returned without messageId — ambiguous`, { offerId });
    return 'no_wamid';
  }

  // 4. Send succeeded with WAMID — complete delivery
  const { data: completed, error: completeErr } = await complete(offerId, claimToken);

  if (completeErr) {
    logger.error(`${logPrefix} AMBIGUOUS: send succeeded (${messageId}) but completion RPC error`, { offerId, completeErr });
    return 'completion_failed';
  }
  if (!completed) {
    logger.error(`${logPrefix} AMBIGUOUS: send succeeded (${messageId}) but completion returned false`, { offerId });
    return 'completion_failed';
  }

  return 'delivered';
}


/**
 * Production confirmation recovery loop.
 *
 * Retries Card Saved confirmation messages for offers stuck in 'committed' state.
 * Uses discover_pending_confirmation (global oldest-first claim with SKIP LOCKED).
 *
 * Extracted from the cron route for direct unit testability.
 */
export async function processSavedCardConfirmationRecovery(
  supabase: SupabaseClient,
  limit: number = 10,
): Promise<{ recovered: number; errors: number }> {
  let recovered = 0;
  let errors = 0;

  for (let i = 0; i < limit; i++) {
    const { data: pending, error: discoverErr } = await supabase.rpc('discover_pending_confirmation', {
      p_lease_seconds: 120,
    });

    if (discoverErr || !pending) break;

    const claim = pending as Record<string, unknown>;
    const offerId = claim.offer_id as string;
    const claimToken = claim.claim_token as string;
    const channelId = claim.channel_id as string | null;
    const customerPhone = claim.customer_phone as string;
    const businessId = claim.business_id as string;

    try {
      if (!channelId) {
        logger.warn('[CONFIRMATION-RECOVERY] No exact channel_id on offer — fail closed', { offerId });
        const { data: released, error: relErr } = await supabase.rpc('release_confirmation_pre_emission', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
        if (relErr || !released) {
          logger.error('[CONFIRMATION-RECOVERY] Channel-missing release unsuccessful', { relErr, released, offerId });
        }
        errors++;
        continue;
      }

      // R8-B3: Reject offers with missing committed_card_display — they need investigation, not a generic send
      if (!claim.committed_card_display || (claim.committed_card_display as string).trim() === '') {
        logger.error('[SAVED-CARD-CRON] Confirmation claim missing committed_card_display — skipping', { offerId });
        // Release the claim — this offer needs investigation, not a generic send
        await supabase.rpc('release_confirmation_pre_emission', { p_offer_id: offerId, p_claim_token: claimToken });
        errors++;
        continue;
      }
      const cardDisplay = claim.committed_card_display as string;

      const canonPhone = canonicalSavedCardPhone(customerPhone);
      if (!canonPhone) {
        logger.warn('[CONFIRMATION-RECOVERY] Invalid phone — fail closed', { offerId, customerPhone });
        const { data: released2, error: relErr2 } = await supabase.rpc('release_confirmation_pre_emission', {
          p_offer_id: offerId, p_claim_token: claimToken,
        });
        if (relErr2 || !released2) {
          logger.error('[CONFIRMATION-RECOVERY] Phone-invalid release unsuccessful', { relErr: relErr2, released: released2, offerId });
        }
        errors++;
        continue;
      }

      const confirmMsg = `💳 Card saved! *${cardDisplay}*\n\n🔒 Waaiio PIN set successfully. You'll need this Waaiio PIN when using your saved card.\n\nFor privacy, you can delete your PIN message from this chat. Type *remove card* anytime to delete this card.`;

      const confirmOutcome = await sendWithFencedDelivery({
        supabase,
        offerId,
        claimToken,
        customerPhone: canonPhone,
        businessId,
        channelId,
        messageText: confirmMsg,
        markStarted: (id, token) => supabase.rpc('mark_confirmation_send_started', { p_offer_id: id, p_claim_token: token }),
        complete: (id, token) => supabase.rpc('complete_confirmation_delivery', { p_offer_id: id, p_claim_token: token, p_customer_phone: canonPhone }),
        releasePreEmission: (id, token) => supabase.rpc('release_confirmation_pre_emission', { p_offer_id: id, p_claim_token: token }),
      });

      if (confirmOutcome === 'delivered') {
        recovered++;
        logger.info('[CONFIRMATION-RECOVERY] Confirmation delivered', { offerId, customerPhone });
      } else {
        errors++;
      }
    } catch (unexpectedErr) {
      // R6-B4: Do NOT release the fence on unknown exceptions — may be post-emission.
      logger.error('[CONFIRMATION-RECOVERY] Unexpected error in confirmation delivery — fence remains intact', { offerId, unexpectedErr });
      errors++;
    }
  }

  return { recovered, errors };
}
