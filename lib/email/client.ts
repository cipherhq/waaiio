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
