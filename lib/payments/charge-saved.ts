import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { getPlatformFees } from '@/lib/getPlatformFees';
import type { SubscriptionTier } from '@/lib/constants';
import { observeProvider, logSplitResolved, logSplitMissing } from '@/lib/observability';
import { normalizeError } from '@/lib/errors';
import { resolveTrialStatus } from '@/lib/trial-status';

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
  const isInTrial = await resolveTrialStatus(supabase, businessId, tier, biz.trial_ends_at);
  const feeResult = await getPlatformFees(amount, tier, isInTrial, {
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
    /** #264: Server-derived transaction category for fee policy */
    transactionCategory?: string;
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
    transactionCategory?: string;
  },
): Promise<SavedCardOutcome> {
  if (!paystackSecretKey) {
    return { outcome: 'declined', reference: opts.reference, message: 'Payment gateway not configured' };
  }

  // ── Step 0: Check existing canonical payment for this reference ──
  // Prevents double-charge on repeated taps and handles recovery.
  // Fail closed on lookup error — never call provider without confirming no existing charge.
  const { data: existing, error: lookupErr } = await supabase
    .from('payments')
    .select('id, status, booking_id, business_id, metadata')
    .eq('gateway_reference', opts.reference)
    .maybeSingle();

  if (lookupErr) {
    // Unknown prior-payment state — must NOT enable another charge or payment route.
    // Return indeterminate so the caller keeps the session recoverable without offering alternatives.
    logger.error('[SAVED-CARD] Existing payment lookup failed — blocking charge', lookupErr.message);
    return { outcome: 'indeterminate', paymentId: '', reference: opts.reference, message: 'Payment verification failed — please try again' };
  }

  if (existing) {
    // Validate entity + business identity: existing row must belong to same booking and business.
    // If opts.bookingId is supplied, existing must match (null existing.booking_id = mismatch).
    if (opts.bookingId && existing.booking_id !== opts.bookingId) {
      logger.error('[SAVED-CARD] Existing payment booking mismatch', { existing: existing.booking_id, expected: opts.bookingId });
      return { outcome: 'indeterminate', paymentId: existing.id, reference: opts.reference, message: 'Payment reference conflict' };
    }
    // Business ownership: check top-level business_id first; fall back to legacy metadata.
    // Pre-PR saved-card rows stored business_id only in metadata, not the top-level column.
    const meta = (existing.metadata || {}) as Record<string, unknown>;
    const existingBizId = existing.business_id || (meta.business_id as string | undefined);
    if (!existingBizId) {
      // Cannot prove ownership — stay indeterminate, do not call provider
      logger.error('[SAVED-CARD] Existing payment has no business identity', { paymentId: existing.id });
      return { outcome: 'indeterminate', paymentId: existing.id, reference: opts.reference, message: 'Payment ownership unverifiable' };
    }
    if (existingBizId !== opts.businessId) {
      logger.error('[SAVED-CARD] Existing payment business mismatch', { existing: existingBizId, expected: opts.businessId });
      return { outcome: 'indeterminate', paymentId: existing.id, reference: opts.reference, message: 'Payment reference conflict' };
    }
    if (existing.status === 'success') {
      return { outcome: 'already_charged', paymentId: existing.id, reference: opts.reference };
    }
    if (existing.status === 'pending') {
      // Previous attempt may have charged the provider — do NOT charge again.
      // Actively reconcile to determine provider state.
      try {
        const { reconcilePayment } = await import('./reconcile');
        const result = await reconcilePayment(supabase, existing.id, 'saved_card');
        if (result.lifecycle?.status === 'completed' || result.lifecycle?.status === 'already_completed') {
          return { outcome: 'already_charged', paymentId: existing.id, reference: opts.reference };
        }
        if (result.providerOutcome === 'not_paid') {
          // not_paid can include non-terminal states (pending/ongoing at provider).
          // Only terminalize if the provider reason indicates explicit terminal failure.
          // providerReason comes from the actual provider response (e.g., 'paystack_status: abandoned').
          const reason = result.providerReason || '';
          const isTerminal = /abandoned|failed|reversed|expired|declined/i.test(reason);
          if (isTerminal) {
            const { data: termRow, error: termErr } = await supabase.from('payments')
              .update({ status: 'failed', gateway_status: reason.slice(0, 50) })
              .eq('id', existing.id)
              .eq('status', 'pending')
              .select('id')
              .maybeSingle();
            if (termErr) {
              // DB error — stay indeterminate
            } else if (termRow) {
              // Row was actually updated — safe to report as declined
              return { outcome: 'previously_declined', reference: opts.reference };
            } else {
              // Zero rows affected — status changed concurrently. Re-read.
              const { data: reread } = await supabase.from('payments')
                .select('status').eq('id', existing.id).single();
              if (reread?.status === 'success') {
                return { outcome: 'already_charged', paymentId: existing.id, reference: opts.reference };
              }
              if (reread?.status === 'failed') {
                return { outcome: 'previously_declined', reference: opts.reference };
              }
              // Otherwise stay indeterminate
            }
          }
          // Non-terminal not_paid (pending/ongoing/unknown at provider) — stay recoverable
        }
      } catch (e) {
        logger.error('[SAVED-CARD] Reconciliation of existing pending payment failed:', e);
      }
      // Retryable/config/ambiguous/non-terminal — stay pending/recoverable, no second charge
      return { outcome: 'indeterminate', paymentId: existing.id, reference: opts.reference, message: 'Previous charge attempt pending — reconciling' };
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

  // ── Step 2: Resolve fee-policy gate + create canonical payment row ──
  // #264: If fee_policy_enabled, bind v1 authority before provider charge
  let v1Fields: Record<string, unknown> = {};
  if (opts.transactionCategory) {
    try {
      // Fail closed on read errors — only authoritative gate=false selects v0
      const { data: configVer, error: cvErr } = await supabase
        .from('platform_config_versions')
        .select('id, config_snapshot')
        .lte('effective_from', new Date().toISOString())
        .order('effective_from', { ascending: false })
        .limit(1)
        .single();

      if (cvErr || !configVer?.config_snapshot) {
        logger.error('[SAVED-CARD] Config version lookup failed — fail closed', { cvErr });
        return { outcome: 'declined', reference: opts.reference, message: 'Fee policy config unavailable' };
      }

      const snapshot = configVer.config_snapshot as Record<string, unknown>;
      // Strict tri-state: true → v1, false → v0, anything else → fail closed
      const gateVal = snapshot.fee_policy_enabled;
      if (gateVal !== true && gateVal !== false) {
        logger.error('[SAVED-CARD] fee_policy_enabled is not true/false — fail closed', { gateVal });
        return { outcome: 'declined', reference: opts.reference, message: 'Fee policy gate malformed' };
      }

      if (gateVal === true) {
        const { data: bizForFee, error: bizErr } = await supabase
          .from('businesses')
          .select('subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat')
          .eq('id', opts.businessId)
          .single();

        if (bizErr || !bizForFee) {
          logger.error('[SAVED-CARD] Business lookup failed during v1 resolution — fail closed', { bizErr });
          return { outcome: 'declined', reference: opts.reference, message: 'Business lookup failed' };
        }

        const scTier = (bizForFee.subscription_tier || 'free') as SubscriptionTier;
        const scTrial = await resolveTrialStatus(supabase, opts.businessId, scTier, bizForFee.trial_ends_at);
        const { validateV1Snapshot } = await import('@/lib/payments/calculateFee');
        const snapErr = validateV1Snapshot(
          snapshot as Parameters<typeof validateV1Snapshot>[0],
          scTier,
        );
        if (snapErr) {
          logger.error('[SAVED-CARD] V1 snapshot validation failed — fail closed', { snapErr });
          return { outcome: 'declined', reference: opts.reference, message: 'Fee policy snapshot invalid' };
        }

        const scBasis = {
          payment_routing: 'platform' as const,
          tier: scTier,
          is_in_trial: scTrial,
          custom_fee_percentage: bizForFee.custom_fee_percentage != null ? Number(bizForFee.custom_fee_percentage) : null,
          custom_fee_flat: bizForFee.custom_fee_flat != null ? Number(bizForFee.custom_fee_flat) : null,
        };

        v1Fields = {
          fee_policy_version: 1,
          config_version_id: configVer.id,
          transaction_category: opts.transactionCategory,
          fee_basis: scBasis,
          provider_init_state: 'pre_dispatch',
        };

        // Override the provider split with the pinned v1 fee (not live getPlatformFees)
        const { calculateFee } = await import('@/lib/payments/calculateFee');
        const v1Fee = calculateFee(opts.amount, scBasis, opts.transactionCategory, snapshot as Parameters<typeof calculateFee>[3]);
        if (splitResult.mode === 'split') {
          splitParams = {
            subaccount: splitResult.subaccount,
            transaction_charge: Math.round(v1Fee.feeTotal * 100),
          };
        }
      }
      // gateVal === false → v0, no v1Fields set
    } catch (feePolicyErr) {
      logger.error('[SAVED-CARD] Fee policy resolution error — fail closed', feePolicyErr);
      return { outcome: 'declined', reference: opts.reference, message: 'Fee policy resolution failed' };
    }
  }

  // v1 split is already computed above from pinned snapshot — no separate override needed

  const { data: payRow, error: insertErr } = await supabase.from('payments').insert({
    business_id: opts.businessId,
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
    ...v1Fields,
  }).select('id').single();

  if (insertErr || !payRow) {
    logger.error('[SAVED-CARD] Payment row creation failed — NOT calling provider', insertErr);
    return { outcome: 'declined', reference: opts.reference, message: 'Payment record creation failed' };
  }

  const paymentId = payRow.id;
  const amountInKobo = Math.round(opts.amount * 100);

  // ── Step 2b: Provider-init state machine for v1 ──
  if (v1Fields.fee_policy_version === 1) {
    // CAS: pre_dispatch → dispatched
    const { data: casRows } = await supabase.from('payments')
      .update({ provider_init_state: 'dispatched' })
      .eq('id', paymentId)
      .eq('provider_init_state', 'pre_dispatch')
      .select('id');
    if (!casRows || casRows.length !== 1) {
      logger.error('[SAVED-CARD] V1 CAS pre_dispatch→dispatched failed');
      return { outcome: 'declined', reference: opts.reference, message: 'Provider dispatch state conflict' };
    }
  }

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
      // CAS: dispatched → provider_confirmed (for v1) — exact row check
      if (v1Fields.fee_policy_version === 1) {
        const { data: confirmRows, error: confirmErr } = await supabase.from('payments')
          .update({ provider_init_state: 'provider_confirmed' })
          .eq('id', paymentId)
          .eq('provider_init_state', 'dispatched')
          .select('id');
        if (confirmErr || !confirmRows || confirmRows.length !== 1) {
          // Provider has charged but authority row didn't reach provider_confirmed.
          // Return indeterminate — do not hide the provider-paid ambiguity.
          logger.error('[SAVED-CARD] V1 provider_confirmed CAS failed after successful charge', { confirmErr, rowCount: confirmRows?.length });
          return { outcome: 'indeterminate', paymentId, reference: opts.reference, message: 'Provider charged but authority write failed' };
        }
      }

      await supabase.from('saved_payment_methods')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', opts.savedMethod.id);

      logger.debug('[SAVED-CARD] Charge successful:', opts.reference);
      return { outcome: 'charged', paymentId, reference: opts.reference };
    }

    // Determine if provider response is a definitive decline or non-terminal
    const providerStatus = (data.data?.status || '').toLowerCase();
    const gatewayResponse = data.data?.gateway_response || data.message || 'unknown';
    const isTerminalDecline = ['failed', 'abandoned', 'reversed', 'expired'].includes(providerStatus)
      || /declined|insufficient|invalid|expired|blocked/i.test(gatewayResponse);

    if (!isTerminalDecline) {
      // Non-terminal/unknown provider state — leave payment pending for reconciliation
      logger.warn('[SAVED-CARD] Non-terminal provider response:', providerStatus, gatewayResponse);
      return { outcome: 'indeterminate', paymentId, reference: opts.reference, message: gatewayResponse };
    }

    // Definitive provider decline — mark payment row terminal and prove the write occurred.
    const { data: termRow, error: termErr } = await supabase.from('payments')
      .update({ status: 'failed', gateway_status: gatewayResponse.slice(0, 100) })
      .eq('id', paymentId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (termErr || !termRow) {
      logger.error('[SAVED-CARD] Decline terminalization failed or no row affected:', termErr?.message);
      return { outcome: 'indeterminate', paymentId, reference: opts.reference, message: 'Card declined but could not record — verifying' };
    }

    logger.error('[SAVED-CARD] Charge declined:', gatewayResponse);
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
