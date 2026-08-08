import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptToken } from '@/lib/encryption';
import { logger } from '@/lib/logger';

export type GatewayVerifyResult = 'paid' | 'pending' | 'failed' | 'expired';

interface PaystackReconciliationPayment {
  id: string;
  gateway: string;
  gateway_reference: string;
  business_id: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Messages from Paystack 400 responses that indicate the transaction reference
 * is permanently invalid / does not exist for this integration.
 * Normalized to lowercase for case-insensitive matching.
 */
const TERMINAL_400_PATTERNS = [
  'transaction reference not found',
  'transaction not found',
  'transaction reference is invalid',
  'invalid transaction reference',
];

function isTerminal400(responseBody: string): boolean {
  const lower = responseBody.toLowerCase();
  return TERMINAL_400_PATTERNS.some(pattern => lower.includes(pattern));
}

/**
 * Resolve the correct Paystack secret key for a payment.
 *
 * - BYO payments: look up the business's encrypted key from business_payment_credentials
 * - Platform payments: use PAYSTACK_SECRET_KEY env var
 *
 * Returns { key, skip } where:
 * - key: the resolved secret key (or undefined if can't resolve)
 * - skip: true if this payment should be skipped (BYO with unresolvable key)
 */
export async function resolvePaystackKey(
  supabase: SupabaseClient,
  payment: PaystackReconciliationPayment,
): Promise<{ key: string | undefined; skip: boolean }> {
  const metadata = payment.metadata;
  const isByo = metadata?.byo === true;

  if (!isByo) {
    // Platform payment — use platform key
    return { key: process.env.PAYSTACK_SECRET_KEY || undefined, skip: false };
  }

  // BYO payment — resolve business's own key
  if (!payment.business_id) {
    logger.warn(`[PAYMENT-RECONCILIATION] BYO payment ${payment.id} has no business_id`);
    return { key: undefined, skip: true };
  }

  const { data: creds, error: credError } = await supabase
    .from('business_payment_credentials')
    .select('secret_key')
    .eq('business_id', payment.business_id)
    .eq('is_active', true)
    .not('verified_at', 'is', null)
    .maybeSingle();

  if (credError) {
    logger.error(`[PAYMENT-RECONCILIATION] Credential lookup failed for business ${payment.business_id}:`, credError.message);
    return { key: undefined, skip: true };
  }

  if (!creds?.secret_key) {
    logger.info(`[PAYMENT-RECONCILIATION] No active BYO credential for business ${payment.business_id}`);
    return { key: undefined, skip: true };
  }

  try {
    const decrypted = decryptToken(creds.secret_key);
    return { key: decrypted, skip: false };
  } catch {
    logger.warn(`[PAYMENT-RECONCILIATION] Failed to decrypt BYO key for business ${payment.business_id}`);
    return { key: undefined, skip: true };
  }
}

/**
 * Verify a Paystack payment against the Paystack API.
 *
 * Uses the provided secret key (already resolved for BYO vs platform).
 *
 * Returns a GatewayVerifyResult:
 * - 'paid': transaction confirmed successful
 * - 'failed': transaction permanently failed/abandoned/reversed
 * - 'expired': (not used by Paystack, but included for interface compat)
 * - 'pending': still processing or cannot determine
 *
 * HTTP status handling:
 * - 200: parse transaction status
 * - 404: reference not found → 'failed'
 * - 400 + terminal message: reference invalid → 'failed'
 * - 400 + other message: throw (transient/operational, leave pending)
 * - 401/403: throw (credential problem, leave pending)
 * - 5xx: throw (server error, retry later)
 */
export async function verifyPaystackPayment(
  reference: string,
  secretKey: string,
): Promise<GatewayVerifyResult> {
  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(15000),
    },
  );

  if (!response.ok) {
    // 404: transaction doesn't exist on this account — permanent
    if (response.status === 404) return 'failed';

    // 400: parse response to determine if reference is permanently invalid
    if (response.status === 400) {
      let body = '';
      try { body = await response.text(); } catch { /* ignore parse failure */ }
      if (isTerminal400(body)) return 'failed';
      // Non-terminal 400 — throw so payment stays pending
      throw new Error(`Paystack API 400: ${body.slice(0, 200)}`);
    }

    // 401/403: credential/auth problem — must not mark payment failed
    // Other errors: throw to preserve pending state
    throw new Error(`Paystack API error: ${response.status}`);
  }

  const data = await response.json();
  const status = data?.data?.status;

  if (status === 'success') return 'paid';
  if (status === 'failed' || status === 'abandoned') return 'failed';
  if (status === 'reversed') return 'failed';
  return 'pending';
}
