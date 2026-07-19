/**
 * Payment Route Resolver
 *
 * Single source of truth for determining HOW a payment should be processed.
 * Every payment-initiation path MUST use this resolver.
 *
 * Returns an explicit PaymentRoute describing:
 * - collection mode (platform/managed_split/byo/connect/flutterwave_mid)
 * - provider name and credentials source
 * - fee configuration (bearer, platform fee, etc.)
 * - connection health state
 *
 * Falls back to Waaiio platform collection when no valid default exists.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { type CountryCode, type SubscriptionTier, getPaymentGatewayForCountry } from '@/lib/constants';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { logger } from '@/lib/logger';

export type CollectionMode = 'platform' | 'managed_split' | 'byo' | 'connect' | 'flutterwave_mid';
export type FeeBearerMode = 'platform' | 'merchant' | 'shared';

export interface PaymentRoute {
  mode: CollectionMode;
  provider: string; // 'paystack' | 'stripe' | 'flutterwave' | 'square'
  connectionId: string | null; // payout_accounts.id
  feeBearerMode: FeeBearerMode;
  platformFeeAmount: number;
  // Split params for the gateway
  subaccountCode?: string;
  stripeAccountId?: string;
  flutterwaveMid?: string;
  // BYO — secret key ID (NOT the key itself — resolved separately at call time)
  byoSecretId?: string;
  byoPlatformSubaccount?: string;
  // Paystack managed-split specific
  paystackBearer?: 'account' | 'subaccount';
  // Warnings for the business dashboard
  warning?: string;
}

// Valid provider/country combinations
const PROVIDER_COUNTRY_MAP: Record<string, string[]> = {
  paystack: ['NG', 'GH'],
  flutterwave: ['NG', 'GH'],
  stripe: ['US', 'CA', 'GB'],
  square: ['US'],
};

/**
 * Resolve the payment route for a business.
 *
 * Priority:
 * 1. Default verified connection matching the business country
 * 2. Any active verified connection matching the country
 * 3. Platform fallback (Waaiio collects)
 *
 * Never selects an arbitrary connection. Falls back to platform with warning.
 */
export async function resolvePaymentRoute(
  supabase: SupabaseClient,
  businessId: string,
  paymentAmount: number,
  countryCode: CountryCode = 'NG',
): Promise<PaymentRoute> {
  // 1. Fetch business tier for fee calculation
  const { data: business } = await supabase
    .from('businesses')
    .select('subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat, payout_mode')
    .eq('id', businessId)
    .single();

  const tier = (business?.subscription_tier || 'free') as SubscriptionTier;
  const isInTrial = tier === 'free' && business?.trial_ends_at && new Date(business.trial_ends_at) > new Date();
  const { feeTotal } = await getPlatformFees(paymentAmount, tier, !!isInTrial, {
    feePercentage: business?.custom_fee_percentage != null ? Number(business.custom_fee_percentage) : undefined,
    feeFlat: business?.custom_fee_flat != null ? Number(business.custom_fee_flat) : undefined,
  });

  // 2. Look for default connection first, then any active verified connection
  const { data: connections } = await supabase
    .from('payout_accounts')
    .select('id, gateway, subaccount_code, stripe_account_id, flutterwave_mid, connection_mode, connection_status, is_default, is_active, verified_at, health_status, country_code')
    .eq('business_id', businessId)
    .in('connection_status', ['active'])
    .not('verified_at', 'is', null)
    .order('is_default', { ascending: false }); // default first

  if (!connections || connections.length === 0) {
    return platformFallback(countryCode, feeTotal);
  }

  // 3. Find the best connection: default first, then country-matching
  const defaultConn = connections.find(c => c.is_default);
  const countryMatch = connections.find(c => {
    const supported = PROVIDER_COUNTRY_MAP[c.gateway] || [];
    return supported.includes(countryCode);
  });

  const conn = defaultConn || countryMatch;

  if (!conn) {
    return platformFallback(countryCode, feeTotal, 'No verified connection supports this country');
  }

  // 4. Validate the connection is healthy and country-supported
  const supported = PROVIDER_COUNTRY_MAP[conn.gateway] || [];
  if (!supported.includes(countryCode)) {
    return platformFallback(countryCode, feeTotal, `Default connection (${conn.gateway}) does not support ${countryCode}`);
  }

  if (conn.health_status === 'unhealthy') {
    return platformFallback(countryCode, feeTotal, `Connection ${conn.gateway} is unhealthy — using platform`);
  }

  // 5. Route based on connection mode
  switch (conn.connection_mode) {
    case 'managed':
      return {
        mode: 'managed_split',
        provider: conn.gateway,
        connectionId: conn.id,
        feeBearerMode: 'merchant',
        platformFeeAmount: feeTotal,
        subaccountCode: conn.subaccount_code || undefined,
        stripeAccountId: conn.stripe_account_id || undefined,
        paystackBearer: conn.gateway === 'paystack' ? 'subaccount' : undefined,
      };

    case 'connect':
      return {
        mode: 'connect',
        provider: conn.gateway,
        connectionId: conn.id,
        feeBearerMode: 'merchant',
        platformFeeAmount: feeTotal,
        stripeAccountId: conn.stripe_account_id || undefined,
      };

    case 'byo': {
      // Look up the secret reference (NOT the key itself)
      const { data: secret } = await supabase
        .from('business_connection_secrets')
        .select('id, platform_fee_subaccount_code, webhook_verified_at, verified_at')
        .eq('payout_account_id', conn.id)
        .is('revoked_at', null)
        .maybeSingle();

      if (!secret || !secret.verified_at || !secret.webhook_verified_at) {
        return platformFallback(countryCode, feeTotal, 'BYO connection not fully verified (credentials or webhook missing)');
      }

      return {
        mode: 'byo',
        provider: conn.gateway,
        connectionId: conn.id,
        feeBearerMode: 'merchant',
        platformFeeAmount: feeTotal,
        byoSecretId: secret.id,
        byoPlatformSubaccount: secret.platform_fee_subaccount_code || undefined,
      };
    }

    case 'flutterwave_mid':
      return {
        mode: 'flutterwave_mid',
        provider: 'flutterwave',
        connectionId: conn.id,
        feeBearerMode: 'shared', // Flutterwave deducts fee before split
        platformFeeAmount: feeTotal,
        flutterwaveMid: conn.flutterwave_mid || undefined,
      };

    default:
      return platformFallback(countryCode, feeTotal);
  }
}

function platformFallback(
  countryCode: CountryCode,
  platformFeeAmount: number,
  warning?: string,
): PaymentRoute {
  const provider = getPaymentGatewayForCountry(countryCode);

  if (warning) {
    logger.warn(`[PAYMENT-ROUTE] Platform fallback: ${warning}`);
  }

  return {
    mode: 'platform',
    provider,
    connectionId: null,
    feeBearerMode: 'platform',
    platformFeeAmount,
    warning,
  };
}
