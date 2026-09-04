/**
 * Direct-route attempt recording (#257)
 *
 * Unified attempt boundary for API routes that make direct Meta calls
 * (payout-nudge, admin-otp, recurring-verify, auth-otp).
 *
 * Handles Gate OFF/ON, ambiguity, WAMID persistence, missing credentials.
 * Composes with #256 suspension check where applicable.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createAttempt,
  markSending,
  markAccepted,
  markFailed,
  markAmbiguous,
  GateBlockError,
  isAmbiguousTransportError,
  isSendAttemptGateOn,
  type AttemptParams,
} from '@/lib/channels/attempt-recording';
import { logger } from '@/lib/logger';

interface DirectSendResult {
  ok: boolean;
  wamid?: string;
  attemptId: string | null;
  ambiguous?: boolean;
}

/**
 * Execute a direct-route Meta send with proper attempt lifecycle.
 *
 * Lifecycle: attempt INSERT → authorization (if provided) → durable sending → provider call.
 * Gate OFF: recording failure does not block send.
 * Gate ON: recording/persistence failure throws GateBlockError (zero Meta call).
 */
export async function withDirectRouteAttempt(
  supabase: SupabaseClient,
  params: Omit<AttemptParams, 'businessId' | 'attemptScope'> & {
    businessId: string | null;
    attemptScope: 'business' | 'platform';
    recipientPhone: string;
  },
  providerCall: () => Promise<Response>,
  /** Optional #256 authorization check — runs after attempt creation, before emission */
  authorizationCheck?: () => Promise<void>,
): Promise<DirectSendResult> {
  // 1. Create attempt
  let attemptId: string | null = null;
  try {
    attemptId = await createAttempt(supabase, params);
  } catch (err) {
    // Gate ON throws GateBlockError — propagate to block entire logical send
    if (err instanceof GateBlockError) throw err;
    if (isSendAttemptGateOn()) throw err;
    logger.warn('[DIRECT-ATTEMPT] Gate OFF: attempt creation failed, send proceeds');
  }

  // 2. Authorization check (#256 suspension, if provided)
  if (authorizationCheck) {
    try {
      await authorizationCheck();
    } catch (guardErr) {
      // Attempt stays pending_authorization — no Meta emission
      throw guardErr;
    }
  }

  // 3. Mark sending (durable pre-emission)
  if (attemptId) {
    try {
      await markSending(supabase, attemptId);
    } catch (err) {
      // Gate ON throws here — propagate
      if (isSendAttemptGateOn()) throw err;
      logger.warn('[DIRECT-ATTEMPT] Gate OFF: markSending failed, send proceeds');
    }
  }

  // 3. Provider call
  let response: Response;
  try {
    response = await providerCall();
  } catch (err) {
    // Classify transport error
    if (attemptId) {
      if (err instanceof Error && isAmbiguousTransportError(err)) {
        await markAmbiguous(supabase, attemptId);
        return { ok: false, attemptId, ambiguous: true };
      }
      await markFailed(supabase, attemptId);
    }
    throw err;
  }

  // 4. Process response
  if (!response.ok) {
    if (attemptId) await markFailed(supabase, attemptId);
    return { ok: false, attemptId };
  }

  // 5. Extract WAMID
  let wamid: string | undefined;
  try {
    const body = await response.json();
    wamid = body?.messages?.[0]?.id;
  } catch {
    // Parse failure after 2xx — message may have been sent
  }

  // 6. Link WAMID or mark for reconciliation
  if (attemptId) {
    if (wamid) {
      try {
        await markAccepted(supabase, attemptId, wamid);
      } catch {
        // WAMID persistence failure — attempt stays sending + needs_reconciliation
        // Do NOT resend. The message was delivered.
        logger.error(`[DIRECT-ATTEMPT] WAMID persistence failed: attempt=${attemptId} wamid=${wamid}`);
      }
    } else {
      // 2xx but no WAMID — conservative reconciliation, not accepted with empty string
      try {
        await supabase.from('message_send_attempts')
          .update({ needs_reconciliation: true })
          .eq('id', attemptId);
      } catch { /* best-effort */ }
    }
  }

  return { ok: true, wamid, attemptId };
}
