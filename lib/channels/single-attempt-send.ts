/**
 * Single-attempt WhatsApp send for durable intent dispatches.
 *
 * Unlike `sendOrEmail` (which uses `withRetry` for up to 3 provider calls),
 * this function makes exactly ONE provider API call and returns a structured
 * outcome. This prevents ambiguous duplicate delivery when used with the
 * durable intent dispatch barrier.
 *
 * Outcomes:
 * - `sent`: Provider accepted the message and returned a message ID
 * - `failed`: Provider returned a definitive client error (4xx) — safe to retry via intent
 * - `unknown`: Network/timeout/server error — message may or may not have been sent
 */
import type { MetaCloudService } from './meta-cloud';
import { MetaApiError } from './meta-api-error';
import { logger } from '@/lib/logger';

export type SingleAttemptOutcome = 'sent' | 'failed' | 'unknown';

export interface SingleAttemptResult {
  outcome: SingleAttemptOutcome;
  providerMessageId: string | null;
  error: string | null;
}

/**
 * Send a WhatsApp text message with exactly ONE provider API call.
 * No retries. No fallback. Returns structured outcome for the durable intent system.
 */
export async function singleAttemptWhatsAppSend(
  cloud: MetaCloudService,
  to: string,
  text: string,
): Promise<SingleAttemptResult> {
  try {
    const result = await cloud.sendText({ to, text });
    return {
      outcome: 'sent',
      providerMessageId: result.messageId || null,
      error: null,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Use typed MetaApiError with httpStatus — not error-message regex.
    // 4xx = definitive provider rejection (message was NOT sent).
    // 5xx/network/timeout = ambiguous (message may or may not have been sent).
    if (err instanceof MetaApiError && err.httpStatus >= 400 && err.httpStatus < 500) {
      logger.warn('[SINGLE_ATTEMPT] WhatsApp 4xx (definitive failure):', errMsg);
      return {
        outcome: 'failed',
        providerMessageId: null,
        error: errMsg,
      };
    }

    // 5xx, network errors, timeouts, non-MetaApiError exceptions —
    // we don't know if the message was sent.
    logger.error('[SINGLE_ATTEMPT] WhatsApp ambiguous error (unknown outcome):', errMsg);
    return {
      outcome: 'unknown',
      providerMessageId: null,
      error: errMsg,
    };
  }
}
