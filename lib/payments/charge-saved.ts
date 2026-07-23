import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { getPlatformFees } from '@/lib/getPlatformFees';
import type { SubscriptionTier } from '@/lib/constants';
import { observeProvider, logSplitResolved, logSplitMissing } from '@/lib/observability';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';

export type SplitResult =
  | { mode: 'no_split' }
  | { mode: 'split'; subaccount: string; transactionChargeKobo: number }
  | { mode: 'split_required_but_missing'; reason: string; businessId: string };

/**
 * Resolve split configuration for a business and a specific payment gateway.
 *
 * Fail-closed for direct_split:
 *   If payout_mode === 'direct_split' but the subaccount or payout account
 *   is missing/invalid for the specified gateway, returns split_required_but_missing
 *   — the caller MUST NOT charge.
 *
 * For platform_managed or businesses without payout_mode set:
 *   Returns no_split — the charge proceeds without split params.
 */
export async function resolveGatewaySplit(
  supabase: SupabaseClient,
  businessId: string,
  amount: number,
  gateway: 'paystack' | 'flutterwave',
): Promise<SplitResult> {
  const { data: biz, error: bizErr } = await supabase
    .from('businesses')
    .select('payout_mode, subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat')
    .eq('id', businessId)
    .single();

  if (bizErr) {
    return { mode: 'split_required_but_missing', reason: `Business lookup failed: ${bizErr.message}`, businessId };
  }

  if (!biz) {
    return { mode: 'split_required_but_missing', reason: 'Business not found', businessId };
  }

  if (biz.payout_mode !== 'direct_split') {
    return { mode: 'no_split' };
  }

  const { data: payout, error: payoutErr } = await supabase
    .from('payout_accounts')
    .select('subaccount_code')
    .eq('business_id', businessId)
    .eq('gateway', gateway)
    .eq('is_active', true)
    .not('subaccount_code', 'is', null)
    .maybeSingle();

  if (payoutErr) {
    return { mode: 'split_required_but_missing', reason: `Payout account lookup failed: ${payoutErr.message}`, businessId };
  }

  if (!payout?.subaccount_code) {
    logSplitMissing({ gateway, businessId, reason: `No active ${gateway} payout account with subaccount code` });
    return { mode: 'split_required_but_missing', reason: `No active ${gateway} payout account with subaccount code`, businessId };
  }

  const tier = (biz.subscription_tier || 'free') as SubscriptionTier;
  const isInTrial = tier === 'free' && biz.trial_ends_at && new Date(biz.trial_ends_at) > new Date();
  const feeResult = await getPlatformFees(amount, tier, !!isInTrial, {
    feePercentage: biz.custom_fee_percentage ?? undefined,
    feeFlat: biz.custom_fee_flat ?? undefined,
  });

  const feeTotal = feeResult.feeTotal;

  // Validate fee bounds — reject invalid, negative, NaN, or excessive fees
  if (!Number.isFinite(feeTotal) || feeTotal < 0) {
    return { mode: 'split_required_but_missing', reason: `Invalid platform fee calculation: ${feeTotal}`, businessId };
  }
  if (feeTotal >= amount) {
    return { mode: 'split_required_but_missing', reason: `Platform fee (${feeTotal}) exceeds transaction amount (${amount})`, businessId };
  }

  const transactionChargeKobo = Math.round(feeTotal * 100);

  logSplitResolved({ gateway, businessId, amount, splitFee: feeTotal });

  return {
    mode: 'split',
    subaccount: payout.subaccount_code,
    transactionChargeKobo,
  };
}

/** Paystack-specific split resolution (delegates to resolveGatewaySplit). */
export async function resolvePaystackSplit(
  supabase: SupabaseClient,
  businessId: string,
  amount: number,
): Promise<SplitResult> {
  return resolveGatewaySplit(supabase, businessId, amount, 'paystack');
}

interface SavedMethod {
  id: string;
  gateway: string;
  authorization_code: string | null;
  customer_code: string | null;
  stripe_payment_method_id: string | null;
  stripe_customer_id: string | null;
  card_last4: string | null;
  card_brand: string | null;
}

/**
 * Get a customer's saved payment method for a business.
 */
export async function getSavedPaymentMethod(
  supabase: SupabaseClient,
  businessId: string,
  customerPhone: string,
): Promise<SavedMethod | null> {
  const { data } = await supabase
    .from('saved_payment_methods')
    .select('id, gateway, authorization_code, customer_code, stripe_payment_method_id, stripe_customer_id, card_last4, card_brand')
    .eq('business_id', businessId)
    .eq('customer_phone', customerPhone)
    .eq('is_active', true)
    .maybeSingle();

  return data || null;
}

/**
 * Charge a saved payment method (Paystack authorization).
 * Returns the transaction reference on success, or null on failure.
 */
export async function chargeSavedCard(
  supabase: SupabaseClient,
  opts: {
    savedMethod: SavedMethod;
    amount: number; // in main currency unit (e.g., Naira, not kobo)
    currency: string;
    email: string;
    reference: string;
    businessId: string;
    bookingId?: string;
    invoiceId?: string;
    reservationId?: string;
    orderId?: string;
    campaignId?: string;
    userId?: string;
    byoSecretKey?: string;
  },
): Promise<{ success: boolean; reference: string; message?: string }> {
  if (opts.savedMethod.gateway === 'paystack' && opts.savedMethod.authorization_code) {
    return chargePaystackAuthorization(supabase, opts);
  }

  // Stripe saved cards would go here
  // if (opts.savedMethod.gateway === 'stripe' && opts.savedMethod.stripe_payment_method_id) { ... }

  return { success: false, reference: opts.reference, message: 'Unsupported payment method' };
}

async function chargePaystackAuthorization(
  supabase: SupabaseClient,
  opts: {
    savedMethod: SavedMethod;
    amount: number;
    currency: string;
    email: string;
    reference: string;
    businessId: string;
    bookingId?: string;
    invoiceId?: string;
    reservationId?: string;
    orderId?: string;
    campaignId?: string;
    userId?: string;
    byoSecretKey?: string;
  },
): Promise<{ success: boolean; reference: string; message?: string }> {
  const secretKey = opts.byoSecretKey || paystackSecretKey;
  if (!secretKey) {
    return { success: false, reference: opts.reference, message: 'Payment gateway not configured' };
  }

  const amountInKobo = Math.round(opts.amount * 100);

  // ── Step 1: Resolve split BEFORE creating any records ──
  // Fail-closed: if direct_split config is broken, return immediately
  // without creating a payment row or calling Paystack.
  let splitParams: Record<string, unknown> = {};
  if (!opts.byoSecretKey) {
    const splitResult = await resolvePaystackSplit(supabase, opts.businessId, opts.amount);
    if (splitResult.mode === 'split') {
      splitParams = {
        subaccount: splitResult.subaccount,
        transaction_charge: splitResult.transactionChargeKobo,
      };
    } else if (splitResult.mode === 'split_required_but_missing') {
      logger.error('[SAVED-CARD] Direct split config missing, blocking charge', {
        businessId: opts.businessId,
        reason: splitResult.reason,
      });
      return {
        success: false,
        reference: opts.reference,
        message: 'Payment split configuration incomplete — charge blocked for retry',
      };
    }
    // mode === 'no_split': proceed without split params (platform_managed)
  }

  try {
    // ── Step 2: Create payment record (only after split validation passes) ──
    await supabase.from('payments').insert({
      booking_id: opts.bookingId || null,
      invoice_id: opts.invoiceId || null,
      campaign_id: opts.campaignId || null,
      reservation_id: opts.reservationId || null,
      order_id: opts.orderId || null,
      user_id: opts.userId || null,
      amount: opts.amount,
      currency: opts.currency,
      gateway: 'paystack',
      gateway_reference: opts.reference,
      status: 'pending',
      payment_method: 'saved_card',
      card_last_four: opts.savedMethod.card_last4,
      card_brand: opts.savedMethod.card_brand,
      metadata: { business_id: opts.businessId, saved_method: true },
    });

    // ── Step 3: Charge the authorization ──
    const data = await observeProvider({
      gateway: 'paystack',
      businessId: opts.businessId, amount: opts.amount, currency: opts.currency,
      providerRef: opts.reference,
    }, async () => {
      const res = await fetch('https://api.paystack.co/transaction/charge_authorization', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          authorization_code: opts.savedMethod.authorization_code,
          email: opts.email,
          amount: amountInKobo,
          currency: opts.currency,
          reference: opts.reference,
          ...splitParams,
          metadata: {
            business_id: opts.businessId,
            booking_id: opts.bookingId || null,
            invoice_id: opts.invoiceId || null,
            saved_method: true,
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
      return res.json();
    });

    if (data.status && data.data?.status === 'success') {
      // Update last used
      await supabase.from('saved_payment_methods')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', opts.savedMethod.id);

      logger.debug('[SAVED-CARD] Charge successful:', opts.reference);
      return { success: true, reference: opts.reference };
    }

    logger.error('[SAVED-CARD] Charge failed:', data.message || data.data?.gateway_response);
    return {
      success: false,
      reference: opts.reference,
      message: data.data?.gateway_response || data.message || 'Card charge failed',
    };
  } catch (error) {
    logger.error('[SAVED-CARD] Charge error:', (error as Error).message);
    return { success: false, reference: opts.reference, message: 'Payment processing error' };
  }
}
