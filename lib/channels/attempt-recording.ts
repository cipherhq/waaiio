/**
 * Message Send Attempt Recording (#257)
 *
 * Records every outbound Meta message attempt with a pre-WAMID UUID.
 * Feature-gated: gate OFF = best-effort; gate ON = fail-closed.
 *
 * Each actual network emission gets its own attempt UUID.
 * Retries create fresh attempts; ambiguous outcomes stop retry.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

export interface AttemptParams {
  businessId: string | null;
  attemptScope: 'business' | 'platform';
  recipientPhone: string;
  recipientCountryCode?: string;
  phoneNumberId?: string;
  channelId?: string;
  flowType?: string;
  sessionId?: string;
  transactionRef?: string;
  messageCategory?: string;
  templateName?: string;
  isFreeEntryPoint?: boolean;
  configVersionId?: string;
}

export type AttemptStatus = 'pending_authorization' | 'sending' | 'accepted' | 'failed_send' | 'ambiguous' | 'review_required';

/** Sentinel error thrown when a transport outcome is ambiguous (may have emitted). */
export class AmbiguousSendError extends Error {
  readonly isAmbiguous = true as const;
  constructor(message: string, public readonly attemptId: string) {
    super(message);
    this.name = 'AmbiguousSendError';
  }
}

/** Feature gate: OFF = best-effort recording; ON = fail-closed. */
let sendAttemptGateEnabled = false;

export function setSendAttemptGate(enabled: boolean): void {
  sendAttemptGateEnabled = enabled;
}

export function isSendAttemptGateOn(): boolean {
  return sendAttemptGateEnabled;
}

/**
 * Create a pending attempt row BEFORE Meta emission.
 * Gate OFF: returns null on failure (send proceeds).
 * Gate ON: throws on failure (zero Meta emission).
 */
export async function createAttempt(
  supabase: SupabaseClient,
  params: AttemptParams,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('message_send_attempts')
      .insert({
        business_id: params.businessId || null,
        attempt_scope: params.attemptScope,
        recipient_phone: params.recipientPhone,
        recipient_country_code: params.recipientCountryCode || null,
        phone_number_id: params.phoneNumberId || null,
        channel_id: params.channelId || null,
        flow_type: params.flowType || null,
        session_id: params.sessionId || null,
        transaction_ref: params.transactionRef || null,
        message_category: params.messageCategory || null,
        template_name: params.templateName || null,
        is_free_entry_point: params.isFreeEntryPoint || false,
        config_version_id: params.configVersionId || null,
        status: 'pending_authorization',
        financial_disposition: 'pending_authorization',
      })
      .select('id')
      .single();

    if (error) throw error;
    return data.id;
  } catch (err) {
    if (sendAttemptGateEnabled) {
      throw new Error(`[ATTEMPT] Gate ON: failed to create attempt record — zero Meta emission: ${(err as Error).message}`);
    }
    logger.warn('[ATTEMPT] Gate OFF: failed to create attempt record, send proceeds:', (err as Error).message);
    return null;
  }
}

/**
 * Transition attempt to 'sending' immediately before network emission.
 * This is the durable pre-emission marker.
 * Gate ON: failure throws (zero Meta emission).
 * Gate OFF: failure logs and returns (best-effort).
 */
export async function markSending(
  supabase: SupabaseClient,
  attemptId: string,
): Promise<void> {
  const { error } = await supabase
    .from('message_send_attempts')
    .update({ status: 'sending', sent_at: new Date().toISOString() })
    .eq('id', attemptId);

  if (error) {
    if (sendAttemptGateEnabled) {
      throw new Error(`[ATTEMPT] Gate ON: failed to persist pre-emission state — zero Meta emission: ${error.message}`);
    }
    logger.error('[ATTEMPT] Failed to mark sending:', error.message);
  }
}

/** Thrown when WAMID persistence fails after successful provider emission. */
export class WamidPersistenceError extends Error {
  readonly attemptId: string;
  readonly wamid: string;
  constructor(attemptId: string, wamid: string, cause: string) {
    super(`[ATTEMPT] WAMID persistence failed for attempt ${attemptId} (wamid=${wamid}): ${cause}`);
    this.name = 'WamidPersistenceError';
    this.attemptId = attemptId;
    this.wamid = wamid;
  }
}

/**
 * Link the WAMID and mark accepted after successful Meta response.
 * On DB failure: marks attempt for reconciliation and throws
 * WamidPersistenceError — caller must NOT retry (message was sent).
 */
export async function markAccepted(
  supabase: SupabaseClient,
  attemptId: string,
  wamid: string,
): Promise<void> {
  const { error } = await supabase
    .from('message_send_attempts')
    .update({
      status: 'accepted',
      meta_message_id: wamid,
      meta_accepted_at: new Date().toISOString(),
    })
    .eq('id', attemptId);

  if (error) {
    // Best-effort: try to mark for reconciliation
    try {
      await supabase
        .from('message_send_attempts')
        .update({ needs_reconciliation: true })
        .eq('id', attemptId);
    } catch {
      // Ignore — best-effort reconciliation flag
    }

    logger.error(`[ATTEMPT] WAMID persistence failed: attempt=${attemptId} wamid=${wamid} err=${error.message}`);
    throw new WamidPersistenceError(attemptId, wamid, error.message);
  }
}

/**
 * Mark attempt as failed (non-ambiguous provider error).
 */
export async function markFailed(
  supabase: SupabaseClient,
  attemptId: string,
): Promise<void> {
  const { error } = await supabase
    .from('message_send_attempts')
    .update({ status: 'failed_send' })
    .eq('id', attemptId);

  if (error) {
    logger.error('[ATTEMPT] Failed to mark failed_send:', error.message);
  }
}

/**
 * Mark attempt as ambiguous (transport outcome unknown).
 * Caller MUST stop retrying after this.
 */
export async function markAmbiguous(
  supabase: SupabaseClient,
  attemptId: string,
): Promise<void> {
  const { error } = await supabase
    .from('message_send_attempts')
    .update({ status: 'ambiguous', needs_reconciliation: true })
    .eq('id', attemptId);

  if (error) {
    logger.error('[ATTEMPT] Failed to mark ambiguous:', error.message);
  }
}

/**
 * Classify a Meta API / transport error for retry decisions.
 * Returns true if the error is ambiguous (may have emitted, must NOT retry).
 */
export function isAmbiguousTransportError(err: Error): boolean {
  const text = err.message.toLowerCase();
  // AbortSignal timeout — request may have been received by Meta
  if (/abort|timed.out|timeout/.test(text)) return true;
  // Connection reset after potential emission
  if (/econnreset|socket hang up/.test(text)) return true;
  // Fetch failed after potential partial send (but not DNS failures which never emitted)
  if (/fetch failed/.test(text) && !/dns|enotfound/.test(text)) return true;
  return false;
}

/**
 * Returns true if the error is a 4xx client error (never retry).
 */
export function is4xxError(err: Error): boolean {
  return /\b4\d{2}\b/.test(err.message);
}
