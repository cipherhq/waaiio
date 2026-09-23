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
 * Returns true if the message was sent and delivery completed.
 */
export async function sendWithFencedDelivery(params: FencedDeliveryParams): Promise<boolean> {
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
    const { error: relErr } = await releasePreEmission(offerId, claimToken);
    if (relErr) logger.error(`${logPrefix} Release RPC error after channel failure`, { offerId, relErr });
    return false;
  }

  // 2. Mark send started
  const { data: started, error: startErr } = await markStarted(offerId, claimToken);

  if (startErr) {
    logger.error(`${logPrefix} Mark-started RPC error`, { offerId, startErr });
    return false;
  }
  if (!started) {
    logger.warn(`${logPrefix} Could not mark send started — claim may be stale`, { offerId });
    return false;
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
      const { error: relErr } = await releasePreEmission(offerId, claimToken);
      if (relErr) logger.error(`${logPrefix} Release RPC error after pre-emission`, { offerId, relErr });
    } else {
      // 6. Ambiguous: may have emitted — leave send_started set
      logger.error(`${logPrefix} Ambiguous send failure — non-retryable`, { offerId, err: sendErr });
    }
    return false;
  }

  if (!messageId) {
    // Provider accepted but no WAMID — ambiguous, leave send_started set
    logger.error(`${logPrefix} Send returned without messageId — ambiguous`, { offerId });
    return false;
  }

  // 4. Send succeeded with WAMID — complete delivery
  const { data: completed, error: completeErr } = await complete(offerId, claimToken);

  if (completeErr) {
    logger.error(`${logPrefix} AMBIGUOUS: send succeeded (${messageId}) but completion RPC error`, { offerId, completeErr });
    return false;
  }
  if (!completed) {
    logger.error(`${logPrefix} AMBIGUOUS: send succeeded (${messageId}) but completion returned false`, { offerId });
    return false;
  }

  return true;
}
