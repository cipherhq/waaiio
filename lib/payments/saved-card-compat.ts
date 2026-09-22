/**
 * Saved-card provider compatibility + canonical internal email alias.
 *
 * Single routing authority for saved-card eligibility — uses the SAME
 * credential classification as the canonical payment pipeline in
 * lib/bot/flows/shared/payment.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

// ─── Canonical phone validation ───

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

/**
 * Validate and normalize a phone to canonical +E.164 for saved-card operations.
 * Returns null if the phone cannot be canonicalized.
 */
export function canonicalSavedCardPhone(phone: string): string | null {
  const withPlus = phone.startsWith('+') ? phone : `+${phone}`;
  if (!E164_REGEX.test(withPlus)) return null;
  return withPlus;
}

// ─── Gateway-neutral internal email alias ───

/**
 * Deterministic internal email alias from canonical +E.164 phone.
 * Used for both Paystack and Stripe to preserve phone-only UX.
 * NOT a real customer email — internal provider plumbing only.
 */
export function internalPaymentEmailAlias(canonicalPhone: string): string {
  const digits = canonicalPhone.replace(/^\+/, '');
  const domain = process.env.FALLBACK_EMAIL_DOMAIN || 'whatsapp.waaiio.com';
  return `${digits}@${domain}`;
}

// ─── Provider compatibility ───

export interface CompatibilityResult {
  compatible: boolean;
  reason?: string;
}

/**
 * Classify a business's payment credential state using the SAME logic
 * as the canonical payment pipeline (lib/bot/flows/shared/payment.ts:298-390).
 *
 * Returns the credential row and classification. Used by both saved-card
 * and payment-initialization paths to ensure consistent routing.
 */
export async function classifyBusinessPaymentCredential(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{
  classification: 'platform' | 'platform_subaccount' | 'byo' | 'connect' | 'ambiguous' | 'error';
  credential?: { id: string; secret_key?: string | null; platform_subaccount_code?: string | null; connect_account_id?: string | null };
}> {
  try {
    const { data: creds, error } = await supabase
      .from('business_payment_credentials')
      .select('id, secret_key, platform_subaccount_code, connect_account_id, connection_type')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .not('verified_at', 'is', null)
      .maybeSingle();

    if (error) {
      logger.error('[PAYMENT-CREDENTIAL] lookup failed — fail closed', { businessId });
      return { classification: 'error' };
    }

    if (!creds) return { classification: 'platform' };

    // Match the EXACT payment.ts routing logic:
    // 1. platform_subaccount_code && !secret_key → platform subaccount
    if (creds.platform_subaccount_code && !creds.secret_key) {
      return { classification: 'platform_subaccount', credential: creds };
    }
    // 2. connect_account_id && !platform_subaccount_code → Connect
    if (creds.connect_account_id && !creds.platform_subaccount_code) {
      return { classification: 'connect', credential: creds };
    }
    // 3. secret_key && platform_subaccount_code → BYO
    if (creds.secret_key && creds.platform_subaccount_code) {
      return { classification: 'byo', credential: creds };
    }
    // 4. Anything else → ambiguous
    return { classification: 'ambiguous', credential: creds };
  } catch (err) {
    logger.error('[PAYMENT-CREDENTIAL] unexpected error — fail closed', { businessId, err });
    return { classification: 'error' };
  }
}

/**
 * Returns true ONLY when the business is proven to use the shared platform
 * Paystack secret-key context (normal platform or subaccount split).
 * Uses classifyBusinessPaymentCredential for consistency with payment routing.
 */
export async function isSharedPlatformPaystackCompatible(
  supabase: SupabaseClient,
  businessId: string,
): Promise<CompatibilityResult> {
  const { classification } = await classifyBusinessPaymentCredential(supabase, businessId);
  switch (classification) {
    case 'platform':
    case 'platform_subaccount':
      return { compatible: true };
    case 'byo':
      return { compatible: false, reason: 'byo_paystack' };
    case 'connect':
      return { compatible: false, reason: 'paystack_connect' };
    case 'ambiguous':
      return { compatible: false, reason: 'ambiguous_credential_state' };
    case 'error':
      return { compatible: false, reason: 'credential_lookup_error' };
    default:
      return { compatible: false, reason: 'unknown_classification' };
  }
}

/**
 * Provider-neutral saved-card compatibility check.
 * Determines whether a business + gateway combination supports saved-card reuse.
 *
 * - Paystack: platform/platform_subaccount → compatible (same as isSharedPlatformPaystackCompatible)
 * - Stripe: platform/platform_subaccount → compatible (PM lives on platform Stripe account)
 *           connect/byo → fail closed (PM not reusable under different account)
 * - Other gateways → not implemented, fail closed
 */
export async function isCompatibleForSavedCard(
  supabase: SupabaseClient,
  businessId: string,
  gateway: string,
): Promise<CompatibilityResult> {
  if (gateway === 'paystack') {
    return isSharedPlatformPaystackCompatible(supabase, businessId);
  }

  if (gateway === 'stripe') {
    const { classification } = await classifyBusinessPaymentCredential(supabase, businessId);
    switch (classification) {
      case 'platform':
      case 'platform_subaccount':
        return { compatible: true };
      case 'connect':
        return { compatible: false, reason: 'stripe_connect_not_supported' };
      case 'byo':
        return { compatible: false, reason: 'stripe_byo_not_supported' };
      case 'ambiguous':
        return { compatible: false, reason: 'ambiguous_credential_state' };
      case 'error':
        return { compatible: false, reason: 'credential_lookup_error' };
      default:
        return { compatible: false, reason: 'unknown_classification' };
    }
  }

  // Flutterwave, Square, PayPal — not implemented yet
  return { compatible: false, reason: 'provider_not_implemented' };
}
