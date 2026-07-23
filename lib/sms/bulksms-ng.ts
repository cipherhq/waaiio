import { logger } from '@/lib/logger';
import { normalizeError } from '@/lib/errors';
import { isSafeIdentifier } from '@/lib/redact';

/**
 * BulkSMS Nigeria — SMS fallback for NG/GH event invites.
 * API docs: https://www.bulksmsnigeria.com/api
 *
 * Env var: BULKSMS_NG_API_TOKEN (Bearer token)
 * Only used for party/event invites when WhatsApp + email fail.
 */

const BULKSMS_API_URL = 'https://www.bulksmsnigeria.com/api/v1/sms/create';

interface SendSmsOpts {
  to: string; // phone number (e.g., 2348012345678)
  message: string;
  from?: string; // sender ID (max 11 chars, default 'Waaiio')
}

interface SendSmsResult {
  sent: boolean;
  error?: string;
}

/**
 * Send SMS via BulkSMS Nigeria.
 * Only works for Nigerian (+234) and Ghanaian (+233) numbers.
 * Returns { sent: true } on success, { sent: false, error } on failure.
 */
export async function sendSms(opts: SendSmsOpts): Promise<SendSmsResult> {
  const token = process.env.BULKSMS_NG_API_TOKEN;
  if (!token) {
    logger.warn('[BULKSMS] BULKSMS_NG_API_TOKEN not set — SMS skipped');
    return { sent: false, error: 'SMS not configured' };
  }

  // Normalize phone number — ensure it starts with country code
  let phone = opts.to.replace(/\D/g, '');
  if (phone.startsWith('0')) {
    phone = '234' + phone.slice(1); // Nigerian local to international
  }
  if (!phone.startsWith('234') && !phone.startsWith('233')) {
    return { sent: false, error: 'SMS only available for NG/GH numbers' };
  }

  const sender = (opts.from || 'Waaiio').slice(0, 11);

  try {
    const response = await fetch(BULKSMS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: sender,
        to: phone,
        body: opts.message,
        api_token: token,
      }),
    });

    if (!response.ok) {
      logger.withContext({ op: 'sms.send', provider: 'bulksms', httpStatus: response.status }).error('[BULKSMS] API error');
      return { sent: false, error: `SMS API error: ${response.status}` };
    }

    await response.json().catch(() => null);
    logger.info('[BULKSMS] SMS sent');
    return { sent: true };
  } catch (err) {
    const norm = normalizeError(err);
    logger.withContext({
      op: 'sms.send', provider: 'bulksms',
      ...(isSafeIdentifier(norm.name) ? { errorName: norm.name } : {}),
      ...(norm.retryable !== undefined ? { retryable: norm.retryable } : {}),
    }).error('[BULKSMS] Send failed');
    return { sent: false, error: err instanceof Error ? err.message : 'SMS send failed' };
  }
}

/**
 * Check if a phone number is eligible for BulkSMS (NG/GH only).
 */
export function isSmsEligible(phone: string): boolean {
  const clean = phone.replace(/\D/g, '');
  return clean.startsWith('234') || clean.startsWith('233') || clean.startsWith('0');
}
