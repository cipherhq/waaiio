import { Resend } from 'resend';
import { logger } from '@/lib/logger';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const DEFAULT_FROM = process.env.EMAIL_FROM || 'Waaiio <noreply@waaiio.com>';

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
  /** Disable application retries for durably claimed delivery attempts. */
  noRetry?: boolean;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

export async function sendEmail({ to, subject, html, from, replyTo, noRetry = false }: SendEmailOptions) {
  if (!resend) {
    logger.debug(`[EMAIL-DEV] To: ${to} | Subject: ${subject}`);
    return { success: true, dev: true };
  }

  let lastError: unknown = null;
  const maxAttempts = noRetry ? 1 : MAX_RETRIES;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { data, error } = await resend.emails.send({
        from: from || DEFAULT_FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      });

      if (error) {
        lastError = error;
        // Don't retry on 4xx client errors (bad request, unauthorized, etc.)
        const status = (error as { statusCode?: number }).statusCode;
        if (status && status >= 400 && status < 500) {
          logger.error('[EMAIL] Client error (no retry):', error);
          return { success: false, error };
        }
        logger.warn(`[EMAIL] Attempt ${attempt + 1}/${maxAttempts} failed:`, error);
      } else {
        return { success: true, id: data?.id };
      }
    } catch (err) {
      lastError = err;
      logger.warn(`[EMAIL] Attempt ${attempt + 1}/${maxAttempts} exception:`, (err as Error).message);
    }

    // Exponential backoff before retry
    if (attempt < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, BASE_DELAY_MS * Math.pow(2, attempt)));
    }
  }

  logger.error('[EMAIL] All retries exhausted:', lastError);
  return { success: false, error: lastError instanceof Error ? lastError.message : lastError };
}

const BATCH_SIZE = 100; // Resend batch API limit per request

export interface SendToEachResult {
  accepted: number;
  failed: number;
}

/**
 * Send the same message as a separate email to each recipient, so no
 * recipient ever sees another's address (#1108). Uses the provider batch API,
 * up to 100 emails per request. A batch is never retried, so an unclear
 * provider failure cannot send anyone the message twice; its recipients are
 * counted as failed.
 */
export async function sendEmailToEach(
  { to, subject, html, from, replyTo }: { to: string[]; subject: string; html: string; from?: string; replyTo?: string },
): Promise<SendToEachResult> {
  if (!resend) {
    logger.debug(`[EMAIL-DEV] ${to.length} separate emails | Subject: ${subject}`);
    return { accepted: to.length, failed: 0 };
  }
  let accepted = 0;
  let failed = 0;
  for (let i = 0; i < to.length; i += BATCH_SIZE) {
    const chunk = to.slice(i, i + BATCH_SIZE);
    try {
      const { data, error } = await resend.batch.send(
        chunk.map(address => ({
          from: from || DEFAULT_FROM, to: [address], subject, html,
          ...(replyTo ? { reply_to: replyTo } : {}),
        })),
        { batchValidation: 'permissive' },
      );
      if (error || !data) {
        logger.error('[EMAIL] Batch send failed:', error);
        failed += chunk.length;
        continue;
      }
      const sent = Array.isArray(data.data) ? data.data.length : 0;
      accepted += sent;
      failed += chunk.length - sent;
    } catch (err) {
      logger.error('[EMAIL] Batch send exception:', (err as Error).message);
      failed += chunk.length;
    }
  }
  return { accepted, failed };
}
