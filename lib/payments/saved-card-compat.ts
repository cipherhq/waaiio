/**
 * Saved-card provider compatibility resolver.
 *
 * Determines whether a business is in the shared-platform Paystack credential
 * domain, which is the ONLY domain where global saved cards can be offered/charged.
 *
 * Uses the same canonical payment-routing authority as the payment pipeline.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

export interface CompatibilityResult {
  compatible: boolean;
  reason?: string;
}

/**
 * Returns true ONLY when the business is proven to use the shared platform
 * Paystack secret-key context (normal platform or subaccount split).
 *
 * Returns false for: BYO, Connect, non-Paystack, missing/ambiguous/error.
 */
export async function isSharedPlatformPaystackCompatible(
  supabase: SupabaseClient,
  businessId: string,
): Promise<CompatibilityResult> {
  try {
    // Query the same credential table the payment pipeline uses
    const { data: byoCreds, error } = await supabase
      .from('business_payment_credentials')
      .select('id, secret_key, platform_subaccount_code, connect_account_id, connection_type')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .not('verified_at', 'is', null)
      .maybeSingle();

    if (error) {
      logger.error('[SAVED-CARD-COMPAT] credential lookup failed — fail closed', { businessId });
      return { compatible: false, reason: 'credential_lookup_error' };
    }

    // No BYO/Connect credentials → business uses platform key → compatible
    if (!byoCreds) {
      return { compatible: true };
    }

    // Subaccount-only (platform key + split) → compatible
    if (byoCreds.platform_subaccount_code && !byoCreds.secret_key && !byoCreds.connect_account_id) {
      return { compatible: true };
    }

    // BYO mode (own secret key)
    if (byoCreds.secret_key) {
      return { compatible: false, reason: 'byo_paystack' };
    }

    // Connect mode
    if (byoCreds.connect_account_id) {
      return { compatible: false, reason: 'paystack_connect' };
    }

    // Ambiguous state
    return { compatible: false, reason: 'ambiguous_credential_state' };
  } catch (err) {
    logger.error('[SAVED-CARD-COMPAT] unexpected error — fail closed', { businessId, err });
    return { compatible: false, reason: 'unexpected_error' };
  }
}

/**
 * Canonical internal Paystack email alias from a +E.164 phone number.
 * Used for transaction initialization in the shared-platform context.
 */
export function canonicalPaystackEmail(canonicalPhone: string): string {
  const digits = canonicalPhone.replace(/^\+/, '');
  const domain = process.env.FALLBACK_EMAIL_DOMAIN || 'whatsapp.waaiio.com';
  return `${digits}@${domain}`;
}
