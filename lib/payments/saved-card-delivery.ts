/**
 * Shared fenced delivery helper for saved-card activation and confirmation messages.
 *
 * Classifies send errors as pre-emission (retryable) vs ambiguous (non-retryable)
 * and uses the appropriate RPC to release or preserve the send_started fence.
 *
 * #370 P0 — phone normalization fix
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

/**
 * Classify whether a send error is proven pre-emission (no message left the provider).
 * Pre-emission errors are safe to retry; ambiguous errors may have emitted a message.
 */
export function isProvenPreEmission(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; isGateBlock?: boolean; isAmbiguous?: boolean };

  // MessagingSuspendedError — send-guard rejected before provider call
  if (e.name === 'MessagingSuspendedError') return true;

  // GateBlockError — attempt-recording gate blocked before provider call
  if (e.name === 'GateBlockError' || e.isGateBlock === true) return true;

  // CircuitBreakerOpenError — circuit breaker blocked before provider call
  if (e.name === 'CircuitBreakerOpenError') return true;

  // Financial auth errors (assertMessagingAllowed) — no emission
  if (e.name === 'FinancialAuthError') return true;

  // Explicit ambiguous flag means it may have emitted
  if (e.isAmbiguous === true) return false;

  return false;
}

export interface FencedDeliveryParams {
  supabase: SupabaseClient;
  offerId: string;
  claimToken: string;
  customerPhone: string;
  businessId: string;
  channelId: string;
  messageText: string;
  /** RPC name for marking send started (before provider call) */
  markStartedRpc: string;
  /** RPC name for completing delivery (after proven send) */
  completeRpc: string;
  /** RPC name for releasing on proven pre-emission failure */
  releasePreEmissionRpc: string;
}

/**
 * Send a message with fenced delivery lifecycle:
 * 1. Resolve channel by ID for business
 * 2. Mark send started (prevents auto-retry)
 * 3. Send message via resolved channel
 * 4. On success: complete delivery
 * 5. On pre-emission failure: release for retry
 * 6. On ambiguous failure: leave send_started set (non-retryable)
 *
 * Returns true if the message was sent and delivery completed.
 */
export async function sendWithFencedDelivery(params: FencedDeliveryParams): Promise<boolean> {
  const {
    supabase, offerId, claimToken, customerPhone, businessId,
    channelId, messageText, markStartedRpc, completeRpc, releasePreEmissionRpc,
  } = params;

  const logPrefix = '[FENCED-DELIVERY]';

  // 1. Resolve channel
  const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
  const resolver = new ChannelResolver(supabase);
  const resolved = await resolver.resolveByChannelIdForBusiness(channelId, businessId);

  if (!resolved) {
    logger.warn(`${logPrefix} Channel resolution failed — releasing`, { offerId, channelId, businessId });
    await supabase.rpc(releasePreEmissionRpc, { p_offer_id: offerId, p_claim_token: claimToken });
    return false;
  }

  // 2. Mark send started
  const { data: started } = await supabase.rpc(markStartedRpc, {
    p_offer_id: offerId, p_claim_token: claimToken,
  });

  if (!started) {
    logger.warn(`${logPrefix} Could not mark send started — claim may be stale`, { offerId });
    return false;
  }

  // 3. Send message
  try {
    const to = customerPhone.replace(/^\+/, '');
    await resolved.sender.sendText({ to, text: messageText });
  } catch (sendErr: unknown) {
    if (isProvenPreEmission(sendErr)) {
      // 5. Pre-emission: safe to retry — clear send_started
      logger.info(`${logPrefix} Pre-emission failure — releasing for retry`, { offerId, err: sendErr });
      await supabase.rpc(releasePreEmissionRpc, { p_offer_id: offerId, p_claim_token: claimToken });
    } else {
      // 6. Ambiguous: may have emitted — leave send_started set
      logger.error(`${logPrefix} Ambiguous send failure — non-retryable`, { offerId, err: sendErr });
    }
    return false;
  }

  // 4. Send succeeded — complete delivery
  const { data: completed } = await supabase.rpc(completeRpc, {
    p_offer_id: offerId, p_claim_token: claimToken, p_customer_phone: customerPhone,
  });

  if (!completed) {
    logger.error(`${logPrefix} AMBIGUOUS: send succeeded but completion write failed`, { offerId });
  }

  return !!completed;
}
