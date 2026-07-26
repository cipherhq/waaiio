/**
 * FIN-002: Shared provider response classification for payout transfers.
 *
 * Used by both Admin approve route and cron auto-payout to ensure
 * consistent classification of provider HTTP responses.
 *
 * Principle: only mark a payout "failed" when we can definitively prove
 * the provider did NOT accept the transfer. All uncertain outcomes
 * become "review_required" to prevent releasing reserved balance.
 */

export type PayoutClassification = 'conclusive_rejection' | 'review_required';

/**
 * Classify a Paystack HTTP error response.
 *
 * Conclusive rejection requires ALL of:
 * - HTTP 400, 401, 403, or 422
 * - Valid JSON body
 * - body.status === false
 * - Non-empty body.message or body.data?.message
 *
 * Everything else is review_required:
 * - 408, 409, 429, 5xx
 * - Malformed/empty JSON
 * - Valid JSON without expected rejection shape
 * - Unknown 4xx
 */
export async function classifyPaystackError(
  res: Response,
): Promise<PayoutClassification> {
  const s = res.status;

  // Always ambiguous statuses
  if (s === 408 || s === 409 || s === 429 || s >= 500) {
    return 'review_required';
  }

  // Only 400/401/403/422 MAY be conclusive
  if (s !== 400 && s !== 401 && s !== 403 && s !== 422) {
    return 'review_required';
  }

  // Must have valid JSON with Paystack rejection shape
  let body: Record<string, unknown>;
  try {
    body = await res.json();
  } catch {
    return 'review_required';
  }

  if (body.status !== false) {
    return 'review_required';
  }

  // Must have a non-empty rejection message
  const message = body.message
    || (body.data && typeof body.data === 'object' && (body.data as Record<string, unknown>).message);
  if (!message || (typeof message === 'string' && message.trim() === '')) {
    return 'review_required';
  }

  return 'conclusive_rejection';
}

/**
 * Classify a Stripe HTTP error response.
 *
 * Conclusive rejection requires ALL of:
 * - HTTP 400, 401, 403, or 422
 * - Valid JSON body
 * - body.error is an object
 * - Non-empty body.error.type, body.error.code, or body.error.message
 *
 * Everything else is review_required.
 */
export async function classifyStripeError(
  res: Response,
): Promise<PayoutClassification> {
  const s = res.status;

  if (s === 408 || s === 409 || s === 429 || s >= 500) {
    return 'review_required';
  }

  if (s !== 400 && s !== 401 && s !== 403 && s !== 422) {
    return 'review_required';
  }

  let body: Record<string, unknown>;
  try {
    body = await res.json();
  } catch {
    return 'review_required';
  }

  if (!body.error || typeof body.error !== 'object') {
    return 'review_required';
  }

  const err = body.error as Record<string, unknown>;
  const hasIdentifier = (err.type && typeof err.type === 'string' && err.type.trim() !== '')
    || (err.code && typeof err.code === 'string' && err.code.trim() !== '')
    || (err.message && typeof err.message === 'string' && err.message.trim() !== '');

  if (!hasIdentifier) {
    return 'review_required';
  }

  return 'conclusive_rejection';
}

/**
 * Check whether a Paystack payout account has all required fields
 * for an automated Paystack transfer.
 */
export interface PayoutAccountRow {
  id: string;
  business_id: string;
  gateway: string | null;
  bank_code: string | null;
  account_number: string | null;
  account_name: string | null;
  verified_at: string | null;
  is_active: boolean;
}

export function isEligiblePaystackAccount(acct: PayoutAccountRow): boolean {
  return (
    acct.is_active === true
    && acct.gateway === 'paystack'
    && acct.verified_at != null
    && acct.bank_code != null && acct.bank_code !== ''
    && acct.account_number != null && acct.account_number !== ''
    && acct.account_name != null && acct.account_name !== ''
  );
}
