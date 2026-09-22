/**
 * Stripe Routing Authority Resolver
 *
 * Read-only helper that resolves the current payment routing authority
 * for a given business and Stripe gateway. Used by both:
 * 1. Normal Stripe Checkout initialization (lib/bot/flows/shared/payment.ts)
 * 2. Saved-card Stripe PaymentIntent initialization (charge-saved.ts)
 *
 * This ensures both paths use the same routing logic and Business B's
 * current config is always resolved fresh (no Business A routing carried).
 *
 * Extracted from payment.ts lines 290-451. No side effects.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SubscriptionTier } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

export interface StripeRoutingAuthority {
  classification: 'platform' | 'platform_subaccount' | 'connect' | 'byo';
  compatible: boolean;
  paymentOrigin: 'platform' | 'connect' | 'byo';
  stripeAccountId: string | null;
  platformFeeAmount: number;
  providerConnectionId: string | null;
  payoutAccountId: string | null;
  isByo: boolean;
  connectAccountId: string | null;
  subaccountCode: string | null;
  byoSecretKey: string | null;
  byoPlatformSubaccount: string | null;
  byoBusinessId: string | null;
  squareMerchantId: string | null;
  squareAccessToken: string | null;
  feeBasis: {
    payment_routing: string;
    tier: string;
    is_in_trial: boolean;
    custom_fee_percentage: number | null;
    custom_fee_flat: number | null;
  } | null;
}

/**
 * Resolve the payment routing authority for a business.
 * This is a read-only operation — no DB writes, no side effects.
 *
 * @returns The routing authority, or null on fail-closed error.
 */
export async function resolvePaymentRoutingAuthority(
  supabase: SupabaseClient,
  businessId: string,
  gatewayName: string,
  amount: number,
): Promise<StripeRoutingAuthority | null> {
  const result: StripeRoutingAuthority = {
    classification: 'platform',
    compatible: true,
    paymentOrigin: 'platform',
    stripeAccountId: null,
    platformFeeAmount: 0,
    providerConnectionId: null,
    payoutAccountId: null,
    isByo: false,
    connectAccountId: null,
    subaccountCode: null,
    byoSecretKey: null,
    byoPlatformSubaccount: null,
    byoBusinessId: null,
    squareMerchantId: null,
    squareAccessToken: null,
    feeBasis: null,
  };

  try {
    const { classifyBusinessPaymentCredential } = await import('@/lib/payments/saved-card-compat');
    const { classification, credential: byoCreds } = await classifyBusinessPaymentCredential(supabase, businessId);

    if (classification === 'error') {
      logger.withContext({ op: 'routing.credential-classification' })
        .error('[ROUTING] Credential classification failed — fail closed');
      return null;
    }

    // Helper: resolve business tier + fee
    const resolveFee = async (): Promise<number> => {
      const { data: business, error: bizError } = await supabase
        .from('businesses')
        .select('subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat')
        .eq('id', businessId)
        .single();

      if (bizError) {
        throw new Error(`Business tier lookup failed: ${bizError.message}`);
      }

      if (business) {
        const tier = (business.subscription_tier || 'free') as SubscriptionTier;
        const { resolveTrialStatus } = await import('@/lib/trial-status');
        const isInTrial = await resolveTrialStatus(supabase, businessId, tier, business.trial_ends_at);
        const { getPlatformFees } = await import('@/lib/getPlatformFees');
        const feeResult = await getPlatformFees(amount, tier, isInTrial, {
          feePercentage: business.custom_fee_percentage ?? undefined,
          feeFlat: business.custom_fee_flat ?? undefined,
        });

        result.feeBasis = {
          payment_routing: result.paymentOrigin,
          tier,
          is_in_trial: isInTrial,
          custom_fee_percentage: business.custom_fee_percentage != null ? Number(business.custom_fee_percentage) : null,
          custom_fee_flat: business.custom_fee_flat != null ? Number(business.custom_fee_flat) : null,
        };

        return feeResult.feeTotal;
      }
      return 0;
    };

    if (classification === 'platform_subaccount' && byoCreds?.platform_subaccount_code) {
      result.classification = 'platform_subaccount';
      result.subaccountCode = byoCreds.platform_subaccount_code;
      try {
        result.platformFeeAmount = await resolveFee();
      } catch (e) {
        logger.withContext({ op: 'routing.subaccount-split-fee', ...safeLogErrorContext(e) })
          .error('[ROUTING] Business tier lookup failed for subaccount split — fail closed');
        return null;
      }
    } else if (classification === 'connect' && byoCreds?.connect_account_id) {
      result.classification = 'connect';
      result.paymentOrigin = 'connect';
      result.connectAccountId = byoCreds.connect_account_id;
      result.byoBusinessId = businessId;
      result.providerConnectionId = byoCreds.id;
      try {
        result.platformFeeAmount = await resolveFee();
      } catch (e) {
        logger.withContext({ op: 'routing.connect-split-fee', ...safeLogErrorContext(e) })
          .error('[ROUTING] Business tier lookup failed for connect split — fail closed');
        return null;
      }
    } else if (classification === 'byo' && byoCreds?.secret_key && byoCreds?.platform_subaccount_code) {
      result.classification = 'byo';
      result.paymentOrigin = 'byo';
      result.isByo = true;
      result.byoSecretKey = byoCreds.secret_key;
      result.byoPlatformSubaccount = byoCreds.platform_subaccount_code;
      result.byoBusinessId = businessId;
      result.providerConnectionId = byoCreds.id;
      try {
        result.platformFeeAmount = await resolveFee();
      } catch (e) {
        logger.withContext({ op: 'routing.byo-split-fee', ...safeLogErrorContext(e) })
          .error('[ROUTING] Business tier lookup failed for BYO split — fail closed');
        return null;
      }
    } else if (classification === 'platform') {
      result.classification = 'platform';
      const { data: biz, error: bizError } = await supabase
        .from('businesses')
        .select('payout_mode')
        .eq('id', businessId)
        .single();

      if (bizError) {
        logger.withContext({ op: 'routing.payout-mode-authority', ...safeLogErrorContext(bizError) })
          .error('[ROUTING] Payout-mode authority lookup failed — fail closed');
        return null;
      }

      if (biz?.payout_mode === 'direct_split') {
        const { data: payout, error: payoutError } = await supabase
          .from('payout_accounts')
          .select('id, subaccount_code, stripe_account_id, square_merchant_id, square_access_token, platform_percentage, gateway')
          .eq('business_id', businessId)
          .eq('is_active', true)
          .maybeSingle();

        if (payoutError) {
          logger.withContext({ op: 'routing.payout-account-authority', ...safeLogErrorContext(payoutError) })
            .error('[ROUTING] Payout account authority lookup failed — fail closed');
          return null;
        }

        if (payout) {
          const payoutGw = payout.gateway || 'paystack';
          if (payoutGw === gatewayName) {
            result.subaccountCode = payout.subaccount_code || null;
            result.stripeAccountId = payout.stripe_account_id || null;
            result.squareMerchantId = payout.square_merchant_id || null;
            result.squareAccessToken = payout.square_access_token || null;
            result.platformFeeAmount = Math.round(amount * (payout.platform_percentage / 100));
            result.payoutAccountId = payout.id;
          }
        }
      }
    } else {
      logger.withContext({ op: 'routing.credential-classification' })
        .error(`[ROUTING] Ambiguous/unknown credential classification: ${classification} — fail closed`);
      return null;
    }

    return result;
  } catch (routingErr) {
    logger.withContext({ op: 'routing.authority-threw', ...safeLogErrorContext(routingErr) })
      .error('[ROUTING] Payment routing authority resolution threw — fail closed');
    return null;
  }
}

/**
 * Check if a business is compatible with Stripe saved-card reuse.
 * Platform and platform destination-charge are compatible.
 * True Connect and BYO are fail-closed.
 */
export function isStripeCompatibleForSavedCard(
  classification: StripeRoutingAuthority['classification'],
): boolean {
  return classification === 'platform' || classification === 'platform_subaccount';
}
