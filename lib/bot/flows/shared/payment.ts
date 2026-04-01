import type { SupabaseClient } from '@supabase/supabase-js';
import { calculatePlatformFee, type SubscriptionTier, type CountryCode } from '@/lib/constants';
import { getPaymentGateway } from '@/lib/payments/factory';

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
  },
): Promise<{ url: string; reference: string } | null> {
  const countryCode = opts.countryCode || 'NG';
  const gateway = getPaymentGateway(countryCode);
  const { currencyCode } = await import('@/lib/constants').then(m => ({
    currencyCode: m.COUNTRIES[countryCode].currencyCode,
  }));

  return gateway.initializePayment({
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
  });
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
