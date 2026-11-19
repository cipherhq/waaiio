import { logger } from '@/lib/logger';
import { normalizeError } from '@/lib/errors';
import { isSafeIdentifier } from '@/lib/redact';

/**
 * BulkSMS Nigeria provider client (API v2), NG/GH numbers only.
 * API docs: https://www.bulksmsnigeria.com/api
 *
 * Env vars:
 * - BULKSMS_NG_API_TOKEN: Bearer token.
 * - BULKSMS_SENDER_ID: the sender name registered on the BulkSMS account
 *   (max 11 characters). No default (Owner decision 2026-11-18, #1131): while
 *   it is unset every SMS is refused, so an unregistered name is never used.
 * - BULKSMS_NG_SANDBOX=true: use the sandbox API (simulated, nothing is sent
 *   or charged).
 *
 * Callers do not use this directly: business sends go through
 * lib/sms/send.ts, which charges the merchant's messaging credit.
 */

const PRODUCTION_BASE = 'https://www.bulksmsnigeria.com/api/v2';
const SANDBOX_BASE = 'https://www.bulksmsnigeria.com/api/sandbox/v2';
const SEND_TIMEOUT_MS = 20_000;

interface SendSmsOpts {
  to: string; // E.164 digits, e.g. 2348012345678
  message: string;
  /** Send as Unicode (keeps accents and emoji; 70 characters per page). */
  unicode?: boolean;
  /** Our own reference, echoed in delivery reports. */
  reference?: string;
}

export interface SendSmsResult {
  sent: boolean;
  /**
   * True when the outcome is unknown (timeout, network error, provider 5xx):
   * the message may have gone out, so it must not be retried or released as
   * a definite failure.
   */
  ambiguous?: boolean;
  error?: string;
  messageId?: string;
  /** What BulkSMS reports it charged, in its currency (NGN). */
  cost?: number;
  pages?: number;
}

/** The registered sender name, or null when SMS is switched off. */
export function smsSenderId(): string | null {
  const id = process.env.BULKSMS_SENDER_ID?.trim();
  return id && /^[A-Za-z0-9 .&-]{1,11}$/.test(id) ? id : null;
}

/** True when both the token and a registered sender name are configured. */
export function isSmsConfigured(): boolean {
  return !!process.env.BULKSMS_NG_API_TOKEN && !!smsSenderId();
}

function baseUrl(): string {
  return process.env.BULKSMS_NG_SANDBOX === 'true' ? SANDBOX_BASE : PRODUCTION_BASE;
}

/**
 * Send one SMS via BulkSMS Nigeria. Only Nigerian (234) and Ghanaian (233)
 * numbers in international form are accepted.
 */
export async function sendSms(opts: SendSmsOpts): Promise<SendSmsResult> {
  const token = process.env.BULKSMS_NG_API_TOKEN;
  if (!token) {
    logger.warn('[BULKSMS] BULKSMS_NG_API_TOKEN not set — SMS skipped');
    return { sent: false, error: 'SMS not configured' };
  }
  const sender = smsSenderId();
  if (!sender) {
    logger.warn('[BULKSMS] BULKSMS_SENDER_ID not set — SMS skipped');
    return { sent: false, error: 'SMS sender name not configured' };
  }

  const phone = opts.to.replace(/\D/g, '');
  if (!/^(234|233)\d{8,11}$/.test(phone)) {
    return { sent: false, error: 'SMS only available for NG/GH numbers' };
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: sender,
        to: phone,
        body: opts.message,
        unicode: opts.unicode === true,
        ...(opts.reference ? { customer_reference: opts.reference } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    const norm = normalizeError(err);
    logger.withContext({
      op: 'sms.send', provider: 'bulksms',
      ...(isSafeIdentifier(norm.name) ? { errorName: norm.name } : {}),
      ...(norm.retryable !== undefined ? { retryable: norm.retryable } : {}),
    }).error('[BULKSMS] Send failed');
    return { sent: false, ambiguous: true, error: 'SMS provider did not answer' };
  }

  const payload = await response.json().catch(() => null) as {
    status?: string; code?: string;
    data?: { message_id?: unknown; cost?: unknown; page_count?: unknown };
  } | null;

  if (response.status >= 500) {
    logger.withContext({ op: 'sms.send', provider: 'bulksms', httpStatus: response.status }).error('[BULKSMS] API error');
    return { sent: false, ambiguous: true, error: `SMS API error: ${response.status}` };
  }
  if (!response.ok || payload?.status !== 'success') {
    // BulkSMS: an error response means the message was not sent and not charged.
    const code = typeof payload?.code === 'string' && /^BSNG-\d{4}$/.test(payload.code) ? payload.code : null;
    logger.withContext({ op: 'sms.send', provider: 'bulksms', httpStatus: response.status, ...(code ? { providerCode: code } : {}) })
      .error('[BULKSMS] API refused');
    return { sent: false, error: code ? `SMS refused (${code})` : `SMS API error: ${response.status}` };
  }

  const data = payload.data || {};
  logger.info('[BULKSMS] SMS sent');
  return {
    sent: true,
    messageId: typeof data.message_id === 'string' ? data.message_id.slice(0, 200) : undefined,
    cost: typeof data.cost === 'number' && data.cost >= 0 ? data.cost : undefined,
    pages: typeof data.page_count === 'number' && data.page_count >= 0 ? data.page_count : undefined,
  };
}

/**
 * Check if a phone number is eligible for BulkSMS (NG/GH only).
 */
export function isSmsEligible(phone: string): boolean {
  const clean = phone.replace(/\D/g, '');
  return clean.startsWith('234') || clean.startsWith('233') || clean.startsWith('0');
}
