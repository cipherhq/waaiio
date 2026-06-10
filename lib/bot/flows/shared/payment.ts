import type { SupabaseClient } from '@supabase/supabase-js';
import { type SubscriptionTier, type CountryCode, type PaymentGatewayName } from '@/lib/constants';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { getPaymentGateway, getPaymentGatewayByName } from '@/lib/payments/factory';

export async function initializePayment(
  supabase: SupabaseClient,
  opts: {
    bookingId?: string;
    orderId?: string;
    invoiceId?: string;
    reservationId?: string;
    userId: string;
    amount: number;
    referenceCode: string;
    businessName: string;
    phone: string;
    userEmail?: string;
    countryCode?: CountryCode;
    /** Per-business gateway override (from businesses.payment_gateway) */
    gatewayOverride?: string | null;
    /** Business ID for split payment lookup */
    businessId?: string;
    /** Campaign ID for donation tracking */
    campaignId?: string;
    /** Donor name for campaign donations */
    donorName?: string;
  },
): Promise<{ url: string; reference: string } | null> {
  try {
    const countryCode = opts.countryCode || 'NG';

    // Per-business gateway override takes priority
    const gateway = opts.gatewayOverride
      ? getPaymentGatewayByName(opts.gatewayOverride as PaymentGatewayName)
      : getPaymentGateway(countryCode);

    const { getCountry } = await import('@/lib/countries');
    const currencyCode = getCountry(countryCode)?.currency_code ?? 'NGN';

    // Fetch payout account for split payments
    let subaccountCode: string | undefined;
    let stripeAccountId: string | undefined;
    let squareMerchantId: string | undefined;
    let squareAccessToken: string | undefined;
    let platformFeeAmount: number | undefined;

    // BYO credential fields
    let byoSecretKey: string | undefined;
    let byoPlatformSubaccount: string | undefined;
    let isByo = false;
    let byoBusinessId: string | undefined;
    let connectAccountId: string | undefined;

    if (opts.businessId) {
      // Check for BYO (Bring Your Own) gateway credentials first
      const { data: byoCreds } = await supabase
        .from('business_payment_credentials')
        .select('secret_key, platform_subaccount_code, gateway, connect_account_id, connection_type')
        .eq('business_id', opts.businessId)
        .eq('is_active', true)
        .not('verified_at', 'is', null)
        .maybeSingle();

      if (byoCreds?.platform_subaccount_code && !byoCreds?.secret_key) {
        // Subaccount-based connect: platform key + subaccount split
        // (connect_account_id may also be set to satisfy DB constraint, but we use subaccount split)
        subaccountCode = byoCreds.platform_subaccount_code;

        const { data: business, error: bizError } = await supabase
          .from('businesses')
          .select('subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat')
          .eq('id', opts.businessId)
          .single();

        if (bizError) {
          console.error('[PAYMENT] Failed to fetch business for subaccount split:', bizError.message);
        }

        if (business) {
          const tier = (business.subscription_tier || 'free') as SubscriptionTier;
          const isInTrial = tier === 'free' && business.trial_ends_at && new Date(business.trial_ends_at) > new Date();
          const { getPlatformFees } = await import('@/lib/getPlatformFees');
          const feeResult = await getPlatformFees(opts.amount, tier, !!isInTrial, {
            feePercentage: business.custom_fee_percentage ?? undefined,
            feeFlat: business.custom_fee_flat ?? undefined,
          });
          platformFeeAmount = feeResult.feeTotal;
        }
      } else if (byoCreds?.connect_account_id && !byoCreds?.platform_subaccount_code) {
        // True Connect mode: use platform key + X-Connect-Account header
        connectAccountId = byoCreds.connect_account_id;
        byoBusinessId = opts.businessId;

        const { data: business, error: bizError2 } = await supabase
          .from('businesses')
          .select('subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat')
          .eq('id', opts.businessId)
          .single();

        if (bizError2) {
          console.error('[PAYMENT] Failed to fetch business for connect split:', bizError2.message);
        }

        if (business) {
          const tier = (business.subscription_tier || 'free') as SubscriptionTier;
          const isInTrial = tier === 'free' && business.trial_ends_at && new Date(business.trial_ends_at) > new Date();
          const { getPlatformFees } = await import('@/lib/getPlatformFees');
          const feeResult = await getPlatformFees(opts.amount, tier, !!isInTrial, {
            feePercentage: business.custom_fee_percentage ?? undefined,
            feeFlat: business.custom_fee_flat ?? undefined,
          });
          platformFeeAmount = feeResult.feeTotal;
        }
      } else if (byoCreds?.secret_key && byoCreds?.platform_subaccount_code) {
        // BYO mode: use business's own gateway key with reversed split
        isByo = true;
        byoSecretKey = byoCreds.secret_key;
        byoPlatformSubaccount = byoCreds.platform_subaccount_code;
        byoBusinessId = opts.businessId;

        // Calculate platform fee based on business tier
        const { data: business, error: bizError3 } = await supabase
          .from('businesses')
          .select('subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat')
          .eq('id', opts.businessId)
          .single();

        if (bizError3) {
          console.error('[PAYMENT] Failed to fetch business for BYO split:', bizError3.message);
        }

        if (business) {
          const tier = (business.subscription_tier || 'free') as SubscriptionTier;
          const isInTrial = tier === 'free' && business.trial_ends_at && new Date(business.trial_ends_at) > new Date();
          const { getPlatformFees } = await import('@/lib/getPlatformFees');
          const feeResult = await getPlatformFees(opts.amount, tier, !!isInTrial, {
            feePercentage: business.custom_fee_percentage ?? undefined,
            feeFlat: business.custom_fee_flat ?? undefined,
          });
          platformFeeAmount = feeResult.feeTotal;
        }
      } else {
        // Normal platform flow: check payout mode
        const { data: biz, error: bizError4 } = await supabase
          .from('businesses')
          .select('payout_mode')
          .eq('id', opts.businessId)
          .single();

        if (bizError4) {
          console.error('[PAYMENT] Failed to fetch business payout mode:', bizError4.message);
        }

        const { data: payout } = await supabase
          .from('payout_accounts')
          .select('subaccount_code, stripe_account_id, square_merchant_id, square_access_token, platform_percentage, gateway')
          .eq('business_id', opts.businessId)
          .eq('is_active', true)
          .maybeSingle();

        // Only add split params if payout account gateway matches payment gateway
        if (biz?.payout_mode === 'direct_split' && payout) {
          const payoutGw = payout.gateway || 'paystack';
          const paymentGw = gateway.name;

          // Only apply split params if gateways match
          if (payoutGw === paymentGw || (payoutGw === 'paystack' && paymentGw === 'paystack') || (payoutGw === 'stripe' && paymentGw === 'stripe')) {
            subaccountCode = payout.subaccount_code || undefined;
            stripeAccountId = payout.stripe_account_id || undefined;
            squareMerchantId = payout.square_merchant_id || undefined;
            squareAccessToken = payout.square_access_token || undefined;
            platformFeeAmount = Math.round(opts.amount * (payout.platform_percentage / 100));
          }
          // If gateways don't match (e.g., Paystack payout but Stripe payment),
          // skip split — platform collects full amount
        }
        // platform_managed: no split params, full amount goes to platform
      }
    }

    const result = await gateway.initializePayment({
      supabase,
      bookingId: opts.bookingId,
      orderId: opts.orderId,
      invoiceId: opts.invoiceId,
      reservationId: opts.reservationId,
      userId: opts.userId,
      amount: opts.amount,
      currency: currencyCode,
      referenceCode: opts.referenceCode,
      businessName: opts.businessName,
      phone: opts.phone,
      userEmail: opts.userEmail,
      subaccountCode,
      stripeAccountId,
      squareMerchantId,
      squareAccessToken,
      platformFeeAmount,
      byoSecretKey,
      byoPlatformSubaccount,
      isByo,
      byoBusinessId,
      connectAccountId,
      campaignId: opts.campaignId,
    });

    // Create donation record if this is a campaign payment
    if (result?.reference && opts.campaignId) {
      // Fetch the payment_id so the webhook can match the donation record
      const { data: paymentRecord } = await supabase
        .from('payments')
        .select('id')
        .eq('gateway_reference', result.reference)
        .maybeSingle();

      await supabase.from('campaign_donations').insert({
        campaign_id: opts.campaignId,
        business_id: opts.businessId || '',
        payment_id: paymentRecord?.id || null,
        donor_phone: opts.phone.startsWith('+') ? opts.phone : `+${opts.phone}`,
        donor_name: opts.donorName || null,
        amount: opts.amount,
        currency: currencyCode,
        reference_code: opts.referenceCode,
        status: 'pending',
      });
    }

    // Store original gateway URL in payment metadata, then shorten for WhatsApp
    if (result?.url && result.reference) {
      // Save the real checkout URL before shortening
      const { data: paymentRecord } = await supabase
        .from('payments')
        .select('id, metadata')
        .eq('gateway_reference', result.reference)
        .maybeSingle();

      if (paymentRecord) {
        const existingMeta = (paymentRecord.metadata || {}) as Record<string, unknown>;
        existingMeta.checkout_url = result.url;
        await supabase.from('payments').update({ metadata: existingMeta }).eq('id', paymentRecord.id);
      }

      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
      const shortRef = result.reference.slice(-8);
      result.url = `${appUrl}/api/pay?ref=${shortRef}`;
    }

    return result;
  } catch (error) {
    const err = error as Error;
    console.error('[PAYMENT] initializePayment THREW:', err.message);
    console.error('[PAYMENT] Stack:', err.stack?.split('\n').slice(0, 6).join(' | '));
    // Store error for debug endpoint
    (globalThis as Record<string, unknown>).__lastPaymentError = { message: err.message, stack: err.stack?.split('\n').slice(0, 6) };
    return null;
  }
}

export async function verifyPayment(
  supabase: SupabaseClient,
  reference: string,
  countryCode: CountryCode = 'NG',
): Promise<boolean> {
  const gateway = getPaymentGateway(countryCode);
  return gateway.verifyPayment(supabase, reference);
}

// Keep backward-compat aliases
export const initializePaystackPayment = initializePayment;
export const verifyPaystackPayment = (supabase: SupabaseClient, reference: string) =>
  verifyPayment(supabase, reference, 'NG');

export async function recordPlatformFee(
  supabase: SupabaseClient,
  opts: {
    businessId: string;
    bookingId?: string;
    orderId?: string;
    invoiceId?: string;
    reservationId?: string;
    transactionAmount: number;
    tier: SubscriptionTier;
    isInTrial: boolean;
  },
): Promise<void> {
  // Skip fee for direct_split businesses — gateway already collected the fee
  const { data: biz } = await supabase
    .from('businesses')
    .select('payout_mode, custom_fee_percentage, custom_fee_flat')
    .eq('id', opts.businessId)
    .single();
  if (biz?.payout_mode === 'direct_split') return;

  // Look up custom fee overrides for this business
  let overrides: { feePercentage?: number | null; feeFlat?: number | null } | undefined;
  if (biz && (biz.custom_fee_percentage != null || biz.custom_fee_flat != null)) {
    overrides = { feePercentage: biz.custom_fee_percentage, feeFlat: biz.custom_fee_flat };
  }
  const fee = await getPlatformFees(opts.transactionAmount, opts.tier, opts.isInTrial, overrides);

  await supabase.from('platform_fees').insert({
    business_id: opts.businessId,
    booking_id: opts.bookingId || null,
    order_id: opts.orderId || null,
    invoice_id: opts.invoiceId || null,
    reservation_id: opts.reservationId || null,
    transaction_amount: opts.transactionAmount,
    fee_percentage: fee.feePercentage,
    fee_flat: fee.feeFlat,
    fee_total: fee.feeTotal,
    tier: opts.tier,
    waived: opts.isInTrial,
  });
}
