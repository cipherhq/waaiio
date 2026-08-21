import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { getPlatformFees } from '@/lib/getPlatformFees';
import type { SubscriptionTier } from '@/lib/constants';
import { observeProvider, logSplitResolved, logSplitMissing } from '@/lib/observability';
import { normalizeError } from '@/lib/errors';

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

/** Explicit saved-card charge outcomes for safe canonical convergence. */
export type SavedCardOutcome =
  | { outcome: 'charged'; paymentId: string; reference: string }
  | { outcome: 'already_charged'; paymentId: string; reference: string }
  | { outcome: 'declined'; reference: string; message: string }
  | { outcome: 'previously_declined'; reference: string }
  | { outcome: 'indeterminate'; paymentId: string; reference: string; message: string };

/**
 * Charge a saved payment method with explicit durable state machine.
 *
 * Before any provider call:
 * 1. Query existing canonical payment by reference
 * 2. Existing success → never charge again (already_charged)
 * 3. Existing pending → never charge again (indeterminate — reconcile same ref)
 * 4. Existing failed → don't reuse reference (previously_declined)
 * 5. No existing row → INSERT canonical row first, fail closed if error
 * 6. Call provider → charged / declined / indeterminate
 *
 * BYO saved-card charging is NOT supported in this implementation. If byoSecretKey
 * is supplied, fail closed — the payment_origin cannot be verified without a durable
 * provider connection identity.
 */
export async function chargeSavedCard(
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
): Promise<SavedCardOutcome> {
  // BYO saved-card not supported — fail closed without durable provider identity
  if (opts.byoSecretKey) {
    return { outcome: 'declined', reference: opts.reference, message: 'BYO saved-card charging not supported' };
  }

  if (opts.savedMethod.gateway === 'paystack' && opts.savedMethod.authorization_code) {
    return chargePaystackAuthorization(supabase, opts);
  }

  return { outcome: 'declined', reference: opts.reference, message: 'Unsupported payment method' };
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
  },
): Promise<SavedCardOutcome> {
  if (!paystackSecretKey) {
    return { outcome: 'declined', reference: opts.reference, message: 'Payment gateway not configured' };
  }

  // ── Step 0: Check existing canonical payment for this reference ──
  // Prevents double-charge on repeated taps and handles recovery.
  const { data: existing } = await supabase
    .from('payments')
    .select('id, status')
    .eq('gateway_reference', opts.reference)
    .maybeSingle();

  if (existing) {
    if (existing.status === 'success') {
      return { outcome: 'already_charged', paymentId: existing.id, reference: opts.reference };
    }
    if (existing.status === 'pending') {
      // Previous attempt may have charged the provider — don't charge again.
      return { outcome: 'indeterminate', paymentId: existing.id, reference: opts.reference, message: 'Previous charge attempt pending — reconcile this reference' };
    }
    if (existing.status === 'failed') {
      return { outcome: 'previously_declined', reference: opts.reference };
    }
  }

  // ── Step 1: Resolve split BEFORE creating any records ──
  let splitParams: Record<string, unknown> = {};
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
    return { outcome: 'declined', reference: opts.reference, message: 'Payment split configuration incomplete' };
  }

  // ── Step 2: Create canonical payment row FIRST — fail closed ──
  const { data: payRow, error: insertErr } = await supabase.from('payments').insert({
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
    payment_authority_version: 1,
    metadata: {
      business_id: opts.businessId,
      saved_method: true,
      payment_origin: 'platform',
    },
  }).select('id').single();

  if (insertErr || !payRow) {
    logger.error('[SAVED-CARD] Payment row creation failed — NOT calling provider', insertErr);
    return { outcome: 'declined', reference: opts.reference, message: 'Payment record creation failed' };
  }

  const paymentId = payRow.id;
  const amountInKobo = Math.round(opts.amount * 100);

  // ── Step 3: Charge the authorization ──
  try {
    const data = await observeProvider({
      gateway: 'paystack',
      businessId: opts.businessId, amount: opts.amount, currency: opts.currency,
      providerRef: opts.reference,
    }, async () => {
      const res = await fetch('https://api.paystack.co/transaction/charge_authorization', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
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
      await supabase.from('saved_payment_methods')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', opts.savedMethod.id);

      logger.debug('[SAVED-CARD] Charge successful:', opts.reference);
      return { outcome: 'charged', paymentId, reference: opts.reference };
    }

    // Definitive provider decline — mark payment row terminal
    await supabase.from('payments')
      .update({ status: 'failed', gateway_status: data.data?.gateway_response || 'declined' })
      .eq('id', paymentId);

    logger.error('[SAVED-CARD] Charge declined:', data.message || data.data?.gateway_response);
    return {
      outcome: 'declined',
      reference: opts.reference,
      message: data.data?.gateway_response || data.message || 'Card charge failed',
    };
  } catch (error) {
    // Network/timeout/ambiguous — leave payment pending for reconciliation
    logger.error('[SAVED-CARD] Charge indeterminate:', normalizeError(error).message);
    return {
      outcome: 'indeterminate',
      paymentId,
      reference: opts.reference,
      message: 'Payment processing timed out — verifying automatically',
    };
  }
}
