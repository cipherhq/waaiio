/**
 * Stripe Invoice Extractors — #177 Revision 7
 *
 * Version-tolerant extractors for Stripe invoice.paid webhook payloads.
 * Supports both legacy (pre-Basil) and modern (2025-03-31+) Stripe API shapes.
 *
 * Two extractors:
 * 1. classifyInvoiceSubscription — tri-state: subscription | not_subscription | malformed_or_conflicting
 * 2. extractInvoicePaymentIdentity — resolves exactly one refund-capable PaymentIntent ID
 */

// ═══════════════════════════════════════════════════════════
// 1. Subscription Identity Classification
// ═══════════════════════════════════════════════════════════

export type SubscriptionClassification =
  | { type: 'subscription'; subscriptionId: string }
  | { type: 'not_subscription'; reason: string }
  | { type: 'malformed_or_conflicting'; error: string; detail?: string };

// Billing reasons that indicate subscription semantics
const SUBSCRIPTION_BILLING_REASONS = new Set([
  'subscription',
  'subscription_create',
  'subscription_cycle',
  'subscription_threshold',
  'subscription_update',
]);

export function classifyInvoiceSubscription(
  invoiceData: Record<string, unknown>,
): SubscriptionClassification {

  // ── Extract legacy subscription identity ──
  const legacySub = invoiceData.subscription;
  const hasLegacy = typeof legacySub === 'string' && legacySub.startsWith('sub_');

  // ── Extract modern parent subscription identity ──
  const parent = invoiceData.parent as Record<string, unknown> | undefined;
  const hasModernParent = parent !== undefined && parent !== null;
  let modernSub: string | null = null;
  let modernParentIsSubscription = false;
  let modernParentMalformed = false;

  if (hasModernParent) {
    if (parent!.type === 'subscription_details') {
      modernParentIsSubscription = true;
      const subDetails = parent!.subscription_details as Record<string, unknown> | undefined;
      const subId = subDetails?.subscription;
      if (typeof subId === 'string' && subId.startsWith('sub_')) {
        modernSub = subId;
      } else {
        modernParentMalformed = true;
      }
    }
    // parent.type other than 'subscription_details' (e.g., 'quote_details')
    // is a legitimate non-subscription parent — handled below
  }

  const hasModern = modernSub !== null;

  // ── Both present: verify consistency ──
  if (hasLegacy && hasModern) {
    if (legacySub === modernSub) {
      return { type: 'subscription', subscriptionId: modernSub! };
    }
    return { type: 'malformed_or_conflicting',
      error: 'legacy_modern_subscription_conflict',
      detail: `legacy=${legacySub}, modern=${modernSub}` };
  }

  // ── Modern parent claims subscription but identity unresolvable ──
  if (modernParentIsSubscription && modernParentMalformed) {
    if (hasLegacy) {
      return { type: 'malformed_or_conflicting',
        error: 'legacy_masks_malformed_modern_subscription',
        detail: `legacy=${legacySub}, modern subscription_details malformed` };
    }
    return { type: 'malformed_or_conflicting',
      error: 'malformed_subscription_parent',
      detail: 'parent.type=subscription_details but subscription field invalid' };
  }

  // ── Valid legacy only (no modern parent at all) ──
  if (hasLegacy && !hasModernParent) {
    return { type: 'subscription', subscriptionId: legacySub as string };
  }

  // ── Legacy subscription + explicitly non-subscription modern parent ──
  // parent.type replaces legacy subscription field (Stripe Basil 2025-03-31).
  // A non-subscription parent contradicts the legacy subscription field.
  if (hasLegacy && hasModernParent && !modernParentIsSubscription) {
    return { type: 'malformed_or_conflicting',
      error: 'legacy_subscription_contradicts_modern_parent',
      detail: `legacy=${legacySub}, parent.type=${String(parent!.type)}` };
  }

  // ── Valid modern only ──
  if (hasModern) {
    return { type: 'subscription', subscriptionId: modernSub! };
  }

  // ══════════════════════════════════════════════════════════
  // No valid subscription identity resolved.
  // Classify: not_subscription vs malformed based on billing_reason.
  // ══════════════════════════════════════════════════════════

  const billingReason = invoiceData.billing_reason as string | undefined | null;

  // ── Subscription billing reason but no identity → malformed ──
  if (billingReason && SUBSCRIPTION_BILLING_REASONS.has(billingReason)) {
    return { type: 'malformed_or_conflicting',
      error: 'subscription_reason_without_identity',
      detail: `billing_reason=${billingReason} but no resolvable subscription ID` };
  }

  // ── Non-subscription parent type → positively not a subscription ──
  if (hasModernParent && !modernParentIsSubscription) {
    return { type: 'not_subscription',
      reason: `parent.type=${String(parent!.type)}` };
  }

  // ── Explicit non-subscription billing reasons ──
  if (billingReason === 'manual' || billingReason === 'quote_accept') {
    return { type: 'not_subscription', reason: `billing_reason=${billingReason}` };
  }

  // ── No identity, no subscription signals ──
  // Preserve existing safe non-recurring behavior: skip subscription
  // processing, allow normal webhook completion.
  return { type: 'not_subscription',
    reason: `no_subscription_signals (billing_reason=${billingReason ?? 'null'})` };
}

// ═══════════════════════════════════════════════════════════
// 2. Payment Identity Extraction
// ═══════════════════════════════════════════════════════════

export interface PaymentIdentityResult {
  paymentIntentId: string;
}

export interface PaymentIdentityError {
  error: string;
  detail?: string;
}

export function extractInvoicePaymentIdentity(
  invoiceData: Record<string, unknown>,
  invoiceAmountCents: number,
  invoiceCurrency: string,
): PaymentIdentityResult | PaymentIdentityError {

  const legacyPi = invoiceData.payment_intent;
  const hasLegacyPi = typeof legacyPi === 'string' && legacyPi.startsWith('pi_');

  // ── Detect modern payments PRESENCE vs ABSENCE ──
  const paymentsObj = invoiceData.payments as Record<string, unknown> | undefined;
  const modernPaymentsPresent = paymentsObj !== undefined && paymentsObj !== null;

  // ── Legacy out-of-band guard ──
  if (invoiceData.paid_out_of_band === true) {
    return { error: 'paid_out_of_band',
      detail: 'Invoice paid out-of-band — cannot attribute full amount to PaymentIntent' };
  }

  // ── Modern payments object PRESENT: must validate it ──
  if (modernPaymentsPresent) {
    // Validate modern structure
    if (!Array.isArray(paymentsObj!.data)) {
      // Modern object present but data is not an array — malformed
      if (hasLegacyPi) {
        return { error: 'legacy_masks_malformed_modern_payments',
          detail: `payments object present but data is not array; legacy pi=${legacyPi}` };
      }
      return { error: 'malformed_modern_payments',
        detail: 'payments object present but data is not an array' };
    }

    // Pagination check — fail closed if list is incomplete
    if (paymentsObj!.has_more === true) {
      if (hasLegacyPi) {
        return { error: 'legacy_masks_paginated_payments',
          detail: `payments.has_more=true, unseen entries may exist; legacy pi=${legacyPi}` };
      }
      return { error: 'paginated_payments',
        detail: 'payments.has_more is true — unseen entries may exist' };
    }

    // Modern array is valid — classify entries
    const entries = paymentsObj!.data as Array<Record<string, unknown>>;
    const paidPIs: Array<{ piId: string; amountPaid: number; currency: string }> = [];
    let hasUnsupportedPaidType = false;

    for (const entry of entries) {
      if (entry.status !== 'paid') continue;

      const paymentObj = entry.payment as Record<string, unknown> | undefined;
      if (!paymentObj) {
        hasUnsupportedPaidType = true;
        continue;
      }

      if (paymentObj.type === 'payment_intent') {
        const piId = typeof paymentObj.payment_intent === 'string'
          ? paymentObj.payment_intent
          : (paymentObj.payment_intent as Record<string, unknown>)?.id as string | undefined;

        if (piId && piId.startsWith('pi_')) {
          paidPIs.push({
            piId,
            amountPaid: (entry.amount_paid as number) || 0,
            currency: ((entry.currency as string) || '').toUpperCase(),
          });
        } else {
          hasUnsupportedPaidType = true;
        }
      } else {
        // payment_record, charge, or other unsupported type
        hasUnsupportedPaidType = true;
      }
    }

    // Fail closed: no unsupported paid types
    if (hasUnsupportedPaidType) {
      return { error: 'unsupported_paid_type',
        detail: 'Non-PaymentIntent paid entry present (payment_record/charge/other)' };
    }

    // Exactly one paid PI required
    if (paidPIs.length !== 1) {
      return { error: paidPIs.length === 0 ? 'no_paid_pi' : 'multiple_paid_pis',
        detail: `${paidPIs.length} paid PaymentIntents` };
    }

    const pi = paidPIs[0];

    // InvoicePayment amount must equal invoice amount (no partial/out-of-band)
    if (pi.amountPaid !== invoiceAmountCents) {
      return { error: 'partial_payment',
        detail: `PI paid ${pi.amountPaid} cents, invoice expects ${invoiceAmountCents}` };
    }

    // InvoicePayment currency must match
    if (pi.currency !== invoiceCurrency.toUpperCase()) {
      return { error: 'currency_mismatch',
        detail: `PI currency ${pi.currency}, invoice currency ${invoiceCurrency}` };
    }

    // ── If legacy PI also present: verify consistency ──
    if (hasLegacyPi && legacyPi !== pi.piId) {
      return { error: 'legacy_modern_pi_mismatch',
        detail: `legacy=${legacyPi}, modern=${pi.piId}` };
    }

    return { paymentIntentId: pi.piId };
  }

  // ── Modern payments object ABSENT: legacy-only path ──
  if (hasLegacyPi) {
    return { paymentIntentId: legacyPi as string };
  }

  return { error: 'no_payment_identity',
    detail: 'No payment_intent and no payments object' };
}
