import type { SupabaseClient } from '@supabase/supabase-js';
import { calculatePlatformFee, type SubscriptionTier, type CountryCode, type PaymentGatewayName } from '@/lib/constants';
import { getPaymentGateway, getPaymentGatewayByName } from '@/lib/payments/factory';

export async function initializePayment(
  supabase: SupabaseClient,
  opts: {
    bookingId?: string;
    orderId?: string;
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
  },
): Promise<{ url: string; reference: string } | null> {
  try {
    const countryCode = opts.countryCode || 'NG';

    // Per-business gateway override takes priority
    const gateway = opts.gatewayOverride
      ? getPaymentGatewayByName(opts.gatewayOverride as PaymentGatewayName)
      : getPaymentGateway(countryCode);

    console.log('[PAYMENT] gateway:', gateway.name, 'country:', countryCode, 'amount:', opts.amount);

    const { getCountry } = await import('@/lib/countries');
    const currencyCode = getCountry(countryCode)?.currency_code ?? 'NGN';

    console.log('[PAYMENT] currency:', currencyCode, 'userId:', opts.userId?.slice(0, 8));

    // Fetch payout account for split payments
    let subaccountCode: string | undefined;
    let stripeAccountId: string | undefined;
    let platformFeeAmount: number | undefined;

    if (opts.businessId) {
      // Check business payout mode
      const { data: biz } = await supabase
        .from('businesses')
        .select('payout_mode')
        .eq('id', opts.businessId)
        .single();

      const { data: payout } = await supabase
        .from('payout_accounts')
        .select('subaccount_code, stripe_account_id, platform_percentage, gateway')
        .eq('business_id', opts.businessId)
        .eq('is_active', true)
        .maybeSingle();

      // Only add split params for direct_split mode with an active payout account
      if (biz?.payout_mode === 'direct_split' && payout) {
        subaccountCode = payout.subaccount_code || undefined;
        stripeAccountId = payout.stripe_account_id || undefined;
        platformFeeAmount = Math.round(opts.amount * (payout.platform_percentage / 100));
      }
      // platform_managed: no split params, full amount goes to platform
    }

    const result = await gateway.initializePayment({
      supabase,
      bookingId: opts.bookingId,
      orderId: opts.orderId,
      userId: opts.userId,
      amount: opts.amount,
      currency: currencyCode,
      referenceCode: opts.referenceCode,
      businessName: opts.businessName,
      phone: opts.phone,
      userEmail: opts.userEmail,
      subaccountCode,
      stripeAccountId,
      platformFeeAmount,
    });

    console.log('[PAYMENT] result:', result ? `url=${result.url?.slice(0, 60)}` : 'NULL');
    return result;
  } catch (error) {
    console.error('[PAYMENT] initializePayment error:', (error as Error).message, (error as Error).stack?.slice(0, 300));
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
    transactionAmount: number;
    tier: SubscriptionTier;
    isInTrial: boolean;
  },
): Promise<void> {
  const fee = calculatePlatformFee(opts.transactionAmount, opts.tier, opts.isInTrial);

  await supabase.from('platform_fees').insert({
    business_id: opts.businessId,
    booking_id: opts.bookingId || null,
    order_id: opts.orderId || null,
    transaction_amount: opts.transactionAmount,
    fee_percentage: fee.feePercentage,
    fee_flat: fee.feeFlat,
    fee_total: fee.feeTotal,
    tier: opts.tier,
    waived: opts.isInTrial,
  });
}
