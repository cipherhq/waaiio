/**
 * Provider-neutral saved payment adapter.
 *
 * #318 Phase 0: Defines the flow-facing interface for saved payment methods.
 * Flow files import ONLY from this module — never from charge-saved.ts directly.
 * Provider-specific tokens (authorization_code, stripe_payment_method_id, etc.)
 * are never exposed through this interface.
 *
 * Current implementation delegates to the existing Paystack path in charge-saved.ts.
 * Future provider adapters (Stripe, Flutterwave, PayPal Vault, Square) will be added
 * as internal implementations without changing the flow-facing contract.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSavedPaymentMethod, chargeSavedCard } from './charge-saved';
import type { SavedCardOutcome } from './charge-saved';
import { logger } from '@/lib/logger';

// ── Flow-facing types (no provider-specific fields) ──

/** What flow files see when listing a customer's saved payment methods. */
export interface SavedPaymentDisplay {
  /** Opaque identifier — flows must not interpret or use for provider calls directly. */
  id: string;
  /** Human-readable label: "VISA ****1234", "MASTERCARD ****5678", "PayPal j***@email.com" */
  displayLabel: string;
  /** Card brand hint for display: 'visa' | 'mastercard' | 'paypal' | 'cash_app' | null */
  brandHint: string | null;
  /** Last 4 digits of card (or null for non-card methods like PayPal) */
  last4: string | null;
  /**
   * Whether this method can be charged server-to-server without leaving WhatsApp.
   * false = will always require redirect (e.g. Cash App Pay, un-vaulted PayPal).
   * true = may still escalate to redirect if provider demands 3DS/SCA.
   */
  supportsDirectCharge: boolean;
}

/** Provider-neutral charge outcomes. */
export type ChargeOutcome =
  | { status: 'charged'; paymentId: string }
  | { status: 'already_charged'; paymentId: string }
  | { status: 'requires_provider_auth'; authUrl: string; paymentId: string }
  | { status: 'declined'; message: string; shouldDeactivate: boolean }
  | { status: 'indeterminate'; paymentId: string; message: string }
  | { status: 'method_expired' }
  | { status: 'method_not_found' };

/** PIN verification result. */
export type PinVerifyResult =
  | { valid: true }
  | { valid: false; attemptsRemaining: number; locked: boolean };

/** Options for charging a saved payment method. */
export interface ChargeOptions {
  methodId: string;
  /** Customer phone — required for business+customer+method tuple authorization. */
  customerPhone: string;
  amount: number;
  currency: string;
  email: string;
  reference: string;
  businessId: string;
  bookingId?: string;
  orderId?: string;
  reservationId?: string;
  invoiceId?: string;
  campaignId?: string;
  /** Optional donor display name for campaign donation intent; null/empty = anonymous. */
  donorName?: string | null;
  userId?: string;
  transactionCategory?: string;
  /** #382: Exact inbound WhatsApp channel that originated this payment. */
  inboundChannelId?: string;
  /** #382: Origin controls fail-closed confirmation routing. */
  confirmationOrigin?: 'whatsapp' | 'web';
}

// ── Adapter interface ──

export interface SavedPaymentAdapter {
  /** List available saved methods for a customer at a business. */
  getSavedMethods(
    supabase: SupabaseClient,
    businessId: string,
    customerPhone: string,
  ): Promise<SavedPaymentDisplay[]>;

  /** Charge a saved method by opaque ID. Provider routing is internal. */
  chargeSavedMethod(
    supabase: SupabaseClient,
    opts: ChargeOptions,
  ): Promise<ChargeOutcome>;

  /**
   * Check whether a saved method requires PIN verification.
   * Returns required: false (not found) if method does not belong to the given business+customer.
   */
  requiresPin(
    supabase: SupabaseClient,
    methodId: string,
    businessId: string,
    customerPhone: string,
  ): Promise<{ required: boolean; locked: boolean }>;

  /**
   * Verify a PIN for a saved method. Handles attempt counting and lockout.
   * Fails closed if method does not belong to the given business+customer.
   */
  verifyPin(
    supabase: SupabaseClient,
    methodId: string,
    businessId: string,
    customerPhone: string,
    pin: string,
  ): Promise<PinVerifyResult>;
}

// ── Paystack adapter implementation (Phase 0) ──

/**
 * Maps the internal SavedMethod (with provider tokens) to the flow-facing
 * SavedPaymentDisplay (without provider tokens).
 */
function toDisplay(method: {
  id: string;
  gateway: string;
  card_last4: string | null;
  card_brand: string | null;
}): SavedPaymentDisplay {
  const brand = method.card_brand?.toUpperCase() || 'Card';
  const last4 = method.card_last4 || '????';
  return {
    id: method.id,
    displayLabel: `${brand} ****${last4}`,
    brandHint: method.card_brand?.toLowerCase() || null,
    last4: method.card_last4,
    supportsDirectCharge: true, // Paystack charge_authorization is server-to-server
  };
}

/**
 * Maps SavedCardOutcome (provider-level) to ChargeOutcome (provider-neutral).
 */
function mapOutcome(result: SavedCardOutcome): ChargeOutcome {
  switch (result.outcome) {
    case 'charged':
      return { status: 'charged', paymentId: result.paymentId };
    case 'already_charged':
      return { status: 'already_charged', paymentId: result.paymentId };
    case 'declined':
      return { status: 'declined', message: result.message, shouldDeactivate: false };
    case 'previously_declined':
      return { status: 'declined', message: 'Previously declined', shouldDeactivate: false };
    case 'indeterminate':
      return { status: 'indeterminate', paymentId: result.paymentId, message: result.message };
  }
}

const MAX_PIN_ATTEMPTS = 3;
const PIN_LOCKOUT_MINUTES = 30;

/**
 * Normalize phone to '+' prefix for consistent DB lookups.
 * Matches the canonical format used by getSavedPaymentMethod in charge-saved.ts.
 */
function normalizePhone(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone}`;
}

/** #379: Keep provider diagnostics useful without persisting free-form provider messages. */
function sanitizeStripeEvidenceToken(value: string | undefined, fallback = 'unknown'): string {
  const raw = value || fallback;
  return raw.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || fallback;
}

function formatStripeDispatchEvidence(evidence: {
  httpStatus: number;
  type: string;
  code: string;
  classification: string;
}): string {
  return [
    'dispatched_error',
    `http=${Number.isFinite(evidence.httpStatus) ? evidence.httpStatus : 0}`,
    `class=${sanitizeStripeEvidenceToken(evidence.classification)}`,
    `type=${sanitizeStripeEvidenceToken(evidence.type)}`,
    `code=${sanitizeStripeEvidenceToken(evidence.code)}`,
  ].join(';').slice(0, 200);
}

/**
 * Canonical saved-method lookup by the full (business + customer + method + active) tuple.
 * Reuses the same columns as getSavedPaymentMethod but adds the methodId constraint.
 * Fail-closed: returns null if any part of the tuple does not match.
 *
 * This is the ONLY path through which chargeSavedMethod, requiresPin, and verifyPin
 * reach the saved_payment_methods table. A foreign method ID (wrong business or wrong
 * customer) will never match, preventing cross-customer object authorization.
 */
async function lookupAuthorizedMethod(
  supabase: SupabaseClient,
  methodId: string,
  _businessId: string, // kept for signature compat; customer-scoped lookup uses phone + method ID
  customerPhone: string,
): Promise<{
  id: string;
  gateway: string;
  authorization_code: string | null;
  customer_code: string | null;
  authorization_email: string | null;
  stripe_payment_method_id: string | null;
  stripe_customer_id: string | null;
  card_last4: string | null;
  card_brand: string | null;
  pin_hash: string | null;
  pin_attempts: number;
  pin_locked_until: string | null;
} | null> {
  // Customer-scoped lookup: methodId + customer_phone + is_active.
  const { canonicalSavedCardPhone } = await import('./saved-card-compat');
  const phoneP = canonicalSavedCardPhone(customerPhone);
  if (!phoneP) return null; // Invalid phone — fail closed
  const phoneN = phoneP.slice(1);
  const { data } = await supabase
    .from('saved_payment_methods')
    .select('id, gateway, authorization_code, customer_code, authorization_email, stripe_payment_method_id, stripe_customer_id, card_last4, card_brand, pin_hash, pin_attempts, pin_locked_until')
    .eq('id', methodId)
    .in('customer_phone', [phoneP, phoneN])
    .eq('is_active', true)
    .maybeSingle();

  return data || null;
}

class PaystackSavedPaymentAdapter implements SavedPaymentAdapter {
  async getSavedMethods(
    supabase: SupabaseClient,
    businessId: string,
    customerPhone: string,
  ): Promise<SavedPaymentDisplay[]> {
    const method = await getSavedPaymentMethod(supabase, businessId, customerPhone);
    if (!method) return [];
    return [toDisplay(method)];
  }

  async chargeSavedMethod(
    supabase: SupabaseClient,
    opts: ChargeOptions,
  ): Promise<ChargeOutcome> {
    // B2: Re-resolve provider compatibility immediately before dispatch
    const { isSharedPlatformPaystackCompatible } = await import('./saved-card-compat');
    const compat = await isSharedPlatformPaystackCompatible(supabase, opts.businessId);
    if (!compat.compatible) {
      return { status: 'method_not_found' }; // Business no longer compatible
    }

    // Customer-scoped lookup (global card)
    const method = await lookupAuthorizedMethod(supabase, opts.methodId, opts.businessId, opts.customerPhone);
    if (!method) {
      return { status: 'method_not_found' };
    }

    // Require stored authorization_email for Paystack charge
    if (!method.authorization_email) {
      return { status: 'method_not_found' }; // Legacy card without stored email — must re-save
    }

    const result = await chargeSavedCard(supabase, {
      savedMethod: method,
      amount: opts.amount,
      currency: opts.currency,
      email: method.authorization_email,
      reference: opts.reference,
      businessId: opts.businessId,
      bookingId: opts.bookingId,
      orderId: opts.orderId,
      reservationId: opts.reservationId,
      invoiceId: opts.invoiceId,
      campaignId: opts.campaignId,
      userId: opts.userId,
      transactionCategory: opts.transactionCategory,
      inboundChannelId: opts.inboundChannelId,
      confirmationOrigin: opts.confirmationOrigin,
      customerPhone: opts.customerPhone,
      donorName: opts.donorName,
    });

    return mapOutcome(result);
  }

  async requiresPin(
    supabase: SupabaseClient,
    methodId: string,
    businessId: string,
    customerPhone: string,
  ): Promise<{ required: boolean; locked: boolean }> {
    // Canonical tuple authorization: fail closed if method doesn't belong to this business+customer
    const method = await lookupAuthorizedMethod(supabase, methodId, businessId, customerPhone);
    if (!method) {
      return { required: false, locked: false };
    }

    if (!method.pin_hash) {
      return { required: false, locked: false };
    }

    const locked = !!(method.pin_locked_until && new Date(method.pin_locked_until) > new Date());
    return { required: true, locked };
  }

  async verifyPin(
    supabase: SupabaseClient,
    methodId: string,
    businessId: string,
    customerPhone: string,
    pin: string,
  ): Promise<PinVerifyResult> {
    // Canonical tuple authorization: fail closed if method doesn't belong to this business+customer
    const method = await lookupAuthorizedMethod(supabase, methodId, businessId, customerPhone);
    if (!method) {
      // Foreign method — do not reveal PIN state, do not mutate anything
      return { valid: false, attemptsRemaining: 0, locked: true };
    }

    const { createHash } = await import('crypto');
    const phone = normalizePhone(customerPhone);
    const pinHash = createHash('sha256').update(`${pin}:${phone}`).digest('hex');

    if (method.pin_hash !== pinHash) {
      const attempts = (method.pin_attempts || 0) + 1;
      const locked = attempts >= MAX_PIN_ATTEMPTS;
      const lockUntil = locked
        ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60 * 1000).toISOString()
        : null;
      await supabase.from('saved_payment_methods')
        .update({ pin_attempts: attempts, ...(lockUntil ? { pin_locked_until: lockUntil } : {}) })
        .eq('id', method.id);

      return {
        valid: false,
        attemptsRemaining: Math.max(0, MAX_PIN_ATTEMPTS - attempts),
        locked,
      };
    }

    // PIN correct — reset attempts
    await supabase.from('saved_payment_methods')
      .update({ pin_attempts: 0 })
      .eq('id', method.id);

    return { valid: true };
  }
}

// ── Provider-neutral adapter registry ──

class SavedPaymentAdapterRegistry implements SavedPaymentAdapter {
  private adapters: Map<string, SavedPaymentAdapter> = new Map();

  register(gateway: string, adapter: SavedPaymentAdapter): void {
    this.adapters.set(gateway, adapter);
  }

  async getSavedMethods(
    supabase: SupabaseClient,
    businessId: string,
    customerPhone: string,
  ): Promise<SavedPaymentDisplay[]> {
    const results: SavedPaymentDisplay[] = [];
    for (const adapter of this.adapters.values()) {
      const methods = await adapter.getSavedMethods(supabase, businessId, customerPhone);
      results.push(...methods);
    }
    return results;
  }

  async chargeSavedMethod(
    supabase: SupabaseClient,
    opts: ChargeOptions,
  ): Promise<ChargeOutcome> {
    // Resolve gateway from saved method
    const method = await lookupAuthorizedMethod(supabase, opts.methodId, opts.businessId, opts.customerPhone);
    if (!method) return { status: 'method_not_found' };

    const adapter = this.adapters.get(method.gateway);
    if (!adapter) return { status: 'method_not_found' };

    return adapter.chargeSavedMethod(supabase, opts);
  }

  async requiresPin(
    supabase: SupabaseClient,
    methodId: string,
    businessId: string,
    customerPhone: string,
  ): Promise<{ required: boolean; locked: boolean }> {
    // PIN is provider-neutral — delegate to Paystack adapter (same logic for all)
    const paystackAdapter = this.adapters.get('paystack');
    if (paystackAdapter) return paystackAdapter.requiresPin(supabase, methodId, businessId, customerPhone);
    return { required: false, locked: false };
  }

  async verifyPin(
    supabase: SupabaseClient,
    methodId: string,
    businessId: string,
    customerPhone: string,
    pin: string,
  ): Promise<PinVerifyResult> {
    // PIN is provider-neutral — delegate to Paystack adapter (same logic for all)
    const paystackAdapter = this.adapters.get('paystack');
    if (paystackAdapter) return paystackAdapter.verifyPin(supabase, methodId, businessId, customerPhone, pin);
    return { valid: false, attemptsRemaining: 0, locked: true };
  }
}

const registry = new SavedPaymentAdapterRegistry();
registry.register('paystack', new PaystackSavedPaymentAdapter());

// Stripe adapter: uses the same provider-neutral PIN/display but dispatches charge to Stripe
class StripeSavedPaymentAdapterImpl implements SavedPaymentAdapter {
  async getSavedMethods(
    supabase: SupabaseClient,
    businessId: string,
    customerPhone: string,
  ): Promise<SavedPaymentDisplay[]> {
    const { canonicalSavedCardPhone, isCompatibleForSavedCard } = await import('./saved-card-compat');
    const phoneP = canonicalSavedCardPhone(customerPhone);
    if (!phoneP) return [];

    const compat = await isCompatibleForSavedCard(supabase, businessId, 'stripe');
    if (!compat.compatible) return [];

    const phoneN = phoneP.slice(1);
    const { data } = await supabase.from('saved_payment_methods')
      .select('id, gateway, card_last4, card_brand, card_exp_month, card_exp_year, stripe_payment_method_id, stripe_customer_id, pin_hash, pin_attempts, pin_locked_until')
      .in('customer_phone', [phoneP, phoneN])
      .eq('is_active', true)
      .eq('gateway', 'stripe')
      .maybeSingle();

    if (!data) return [];
    return [toDisplay(data)];
  }

  async chargeSavedMethod(
    supabase: SupabaseClient,
    opts: ChargeOptions,
  ): Promise<ChargeOutcome> {
    const { isCompatibleForSavedCard } = await import('./saved-card-compat');
    const compat = await isCompatibleForSavedCard(supabase, opts.businessId, 'stripe');
    if (!compat.compatible) return { status: 'method_not_found' };

    const method = await lookupAuthorizedMethod(supabase, opts.methodId, opts.businessId, opts.customerPhone);
    if (!method || !method.stripe_payment_method_id || !method.stripe_customer_id) {
      return { status: 'method_not_found' };
    }

    // Resolve fresh target-business routing
    const { resolvePaymentRoutingAuthority, isStripeCompatibleForSavedCard } = await import('./resolve-stripe-routing');
    const routing = await resolvePaymentRoutingAuthority(supabase, opts.businessId, 'stripe', opts.amount);
    if (!routing || !isStripeCompatibleForSavedCard(routing.classification)) {
      return { status: 'method_not_found' };
    }

    const amountCents = Math.round(opts.amount * 100);
    const appFeeCents = routing.platformFeeAmount ? Math.round(routing.platformFeeAmount * 100) : 0;

    // Build exact PI params for durable storage + exact replay
    const { buildSavedCardPIParams, chargeStripeSavedCard } = await import('./stripe-saved-card');
    const piParams = buildSavedCardPIParams({
      customerId: method.stripe_customer_id,
      paymentMethodId: method.stripe_payment_method_id,
      amountCents,
      currency: opts.currency,
      stripeAccountId: routing.stripeAccountId || undefined,
      applicationFeeAmount: appFeeCents > 0 ? appFeeCents : undefined,
    });

    // I3: Duplicate-tap fence — check for existing pending/dispatched saved-card payment
    // for the same entity + amount + gateway to prevent second payment row
    const entityCol = opts.bookingId ? 'booking_id' : opts.orderId ? 'order_id'
      : opts.invoiceId ? 'invoice_id' : opts.reservationId ? 'reservation_id'
      : opts.campaignId ? 'campaign_id' : null;
    const entityId = opts.bookingId || opts.orderId || opts.invoiceId || opts.reservationId || opts.campaignId;

    if (entityCol && entityId) {
      const { data: existingPay } = await supabase.from('payments')
        .select('id, status, gateway_reference, provider_init_state')
        .eq(entityCol, entityId)
        .eq('business_id', opts.businessId)
        .eq('gateway', 'stripe')
        .eq('payment_method', 'saved_card')
        .eq('amount', opts.amount)
        .eq('currency', opts.currency)
        .in('status', ['pending'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingPay) {
        // #389 R6-A: giving recovery must prove its donation intent before
        // reconciliation or provider replay can advance the payment.
        if (opts.campaignId) {
          const { data: intentResult, error: intentErr } = await supabase.rpc('ensure_campaign_donation_intent_for_payment', {
            p_payment_id: existingPay.id,
            p_donor_phone: normalizePhone(opts.customerPhone),
            p_donor_name: opts.donorName || null,
            p_reference_code: null,
          });
          if (intentErr || (!intentResult?.created && !intentResult?.already_existed)) {
            logger.error('[STRIPE-SAVED-CARD] Existing campaign donation intent could not be proven — blocking recovery', intentErr);
            return { status: 'indeterminate', paymentId: existingPay.id, message: 'Donation intent unavailable' };
          }
        }

        if (existingPay.status === 'pending' && existingPay.gateway_reference?.startsWith('pi_')) {
          // Provider-confirmed row: converge through canonical reconciliation.
          const { reconcilePayment } = await import('./reconcile');
          const reconcileResult = await reconcilePayment(supabase, existingPay.id, 'saved_card');
          if (reconcileResult.lifecycle?.status === 'completed'
            || reconcileResult.lifecycle?.status === 'already_completed'
            || reconcileResult.lifecycle?.status === 'not_deliverable') {
            return { status: 'already_charged', paymentId: existingPay.id };
          }
          return { status: 'indeterminate', paymentId: existingPay.id, message: 'existing_payment_in_progress' };
        }

        if (existingPay.provider_init_state === 'pre_dispatch') {
          // Safe resume: pre_dispatch proves Stripe was never called. Move the
          // same canonical row to dispatched, then use the existing exact-row
          // recovery path which replays stored pi_params with sc_charge_<paymentId>.
          const { data: dispatchRows, error: dispatchErr } = await supabase.from('payments')
            .update({ provider_init_state: 'dispatched' })
            .eq('id', existingPay.id)
            .eq('status', 'pending')
            .eq('provider_init_state', 'pre_dispatch')
            .select('id');
          if (dispatchErr || !dispatchRows || dispatchRows.length !== 1) {
            return { status: 'indeterminate', paymentId: existingPay.id, message: 'pre_dispatch_resume_conflict' };
          }
        }

        if (existingPay.provider_init_state === 'pre_dispatch' || existingPay.provider_init_state === 'dispatched') {
          const { recoverDispatchedSavedCardPayment } = await import('./saved-card-recovery');
          const recovery = await recoverDispatchedSavedCardPayment(supabase, existingPay.id);
          if (recovery.outcome === 'succeeded' || recovery.outcome === 'already_resolved') {
            return { status: 'already_charged', paymentId: existingPay.id };
          }
          if (recovery.outcome === 'requires_action' && recovery.authUrl) {
            return { status: 'requires_provider_auth', authUrl: recovery.authUrl, paymentId: existingPay.id };
          }
          if (recovery.outcome === 'declined') {
            return { status: 'declined', message: recovery.message || 'Card declined', shouldDeactivate: false };
          }
          return { status: 'indeterminate', paymentId: existingPay.id, message: recovery.message || recovery.outcome };
        }
      }
    }

    // Create canonical payment row BEFORE provider dispatch
    const { data: payRow, error: payErr } = await supabase.from('payments').insert({
      business_id: opts.businessId,
      booking_id: opts.bookingId || null,
      order_id: opts.orderId || null,
      invoice_id: opts.invoiceId || null,
      reservation_id: opts.reservationId || null,
      campaign_id: opts.campaignId || null,
      user_id: opts.userId,
      amount: opts.amount,
      currency: opts.currency,
      gateway: 'stripe',
      gateway_reference: `sc_pending_${Date.now()}`,
      status: 'pending',
      payment_method: 'saved_card',
      payment_authority_version: 1,
      provider_init_state: 'pre_dispatch',
      metadata: {
        saved_method: true,
        saved_method_id: method.id,
        customer_phone: normalizePhone(opts.customerPhone),
        payment_origin: routing.paymentOrigin,
        ...(opts.inboundChannelId && { _inbound_channel_id: opts.inboundChannelId }),
        ...(opts.confirmationOrigin && { _confirmation_origin: opts.confirmationOrigin }),
        stripe_customer_id: method.stripe_customer_id,
        stripe_pm_id: method.stripe_payment_method_id,
        ...(routing.stripeAccountId && { provider_account_id: routing.stripeAccountId }),
        ...(appFeeCents > 0 && { application_fee_amount: appFeeCents }),
        pi_params: piParams,
      },
    }).select('id').single();

    if (payErr || !payRow) {
      return { status: 'declined', message: 'Payment creation failed', shouldDeactivate: false };
    }

    // #389 B4: For giving/campaign payments, ensure donation intent BEFORE provider dispatch — BLOCKING
    if (opts.campaignId) {
      const { data: intentResult, error: intentErr } = await supabase.rpc('ensure_campaign_donation_intent_for_payment', {
        p_payment_id: payRow.id,
        p_donor_phone: normalizePhone(opts.customerPhone),
        p_donor_name: null,
        p_reference_code: null,
      });
      if (intentErr || (!intentResult?.created && !intentResult?.already_existed)) {
        logger.error('[STRIPE-SAVED-CARD] Campaign donation intent creation failed — blocking dispatch', intentErr);
        return { status: 'indeterminate', paymentId: payRow.id, message: 'Donation intent creation failed' };
      }
    }

    // I2: Derive canonical idempotency key from durable payment row ID
    // Both live dispatch and recovery cron must use this exact key
    const canonicalIdempotencyKey = `sc_charge_${payRow.id}`;

    // CAS: pre_dispatch → dispatched
    const { data: casRows } = await supabase.from('payments')
      .update({ provider_init_state: 'dispatched' })
      .eq('id', payRow.id)
      .eq('provider_init_state', 'pre_dispatch')
      .select('id');

    if (!casRows || casRows.length !== 1) {
      return { status: 'indeterminate', paymentId: payRow.id, message: 'CAS pre_dispatch failed' };
    }

    // Dispatch to Stripe with canonical idempotency key
    const result = await chargeStripeSavedCard({
      customerId: method.stripe_customer_id,
      paymentMethodId: method.stripe_payment_method_id,
      amountCents,
      currency: opts.currency,
      idempotencyKey: canonicalIdempotencyKey,
      stripeAccountId: routing.stripeAccountId || undefined,
      applicationFeeAmount: appFeeCents > 0 ? appFeeCents : undefined,
    });

    if (result.status === 'succeeded' && result.paymentIntentId) {
      // I4: Checked CAS — dispatched → provider_confirmed
      const { data: confirmRows } = await supabase.from('payments')
        .update({
          gateway_reference: result.paymentIntentId,
          provider_init_state: 'provider_confirmed',
        })
        .eq('id', payRow.id)
        .eq('provider_init_state', 'dispatched')
        .select('id');

      if (!confirmRows || confirmRows.length !== 1) {
        // CAS failed — PI exists but not bound. Re-read to check state.
        const { data: reread } = await supabase.from('payments')
          .select('provider_init_state, gateway_reference')
          .eq('id', payRow.id).single();
        if (reread?.provider_init_state === 'provider_confirmed') {
          // Another path confirmed — reconcile
          const { reconcilePayment } = await import('./reconcile');
          await reconcilePayment(supabase, payRow.id, 'saved_card');
          return { status: 'charged', paymentId: payRow.id };
        }
        return { status: 'indeterminate', paymentId: payRow.id, message: 'CAS provider_confirmed failed' };
      }

      // Reconcile
      const { reconcilePayment } = await import('./reconcile');
      await reconcilePayment(supabase, payRow.id, 'saved_card');
      return { status: 'charged', paymentId: payRow.id };
    }

    if (result.status === 'requires_action' && result.paymentIntentId) {
      // I4: Checked CAS — bind PI before issuing auth URL
      const { data: confirmRows } = await supabase.from('payments')
        .update({
          gateway_reference: result.paymentIntentId,
          provider_init_state: 'provider_confirmed',
        })
        .eq('id', payRow.id)
        .eq('provider_init_state', 'dispatched')
        .select('id');

      if (!confirmRows || confirmRows.length !== 1) {
        return { status: 'indeterminate', paymentId: payRow.id, message: 'CAS provider_confirmed failed for 3DS' };
      }

      // PI is durably bound — now create 3DS auth attempt
      const { createAuthAttempt } = await import('./stripe-saved-card');
      const { canonicalSavedCardPhone } = await import('./saved-card-compat');
      const phone = canonicalSavedCardPhone(opts.customerPhone);
      if (phone) {
        const authResult = await createAuthAttempt(supabase, payRow.id, phone);
        if (authResult) {
          return { status: 'requires_provider_auth', authUrl: authResult.authUrl, paymentId: payRow.id };
        }
      }
      return { status: 'indeterminate', paymentId: payRow.id, message: 'requires_action but auth attempt failed' };
    }

    if (result.status === 'declined') {
      await supabase.from('payments')
        .update({ status: 'failed', gateway_status: result.errorMessage || 'declined' })
        .eq('id', payRow.id)
        .eq('provider_init_state', 'dispatched');
      return { status: 'declined', message: result.errorMessage || 'Card declined', shouldDeactivate: false };
    }

    // indeterminate/error — leave dispatched for canonical same-row recovery.
    // #379: Persist structured, sanitized provider evidence. Never persist Stripe's
    // free-form error message, customer data, keys, or request payload.
    if (result.errorEvidence) {
      const gatewayStatus = formatStripeDispatchEvidence(result.errorEvidence);
      logger.warn('[STRIPE-SAVED-CARD] Dispatch remained indeterminate', {
        paymentId: payRow.id,
        httpStatus: result.errorEvidence.httpStatus,
        errorType: result.errorEvidence.type,
        errorCode: result.errorEvidence.code,
        classification: result.errorEvidence.classification,
      });
      await supabase.from('payments')
        .update({ gateway_status: gatewayStatus })
        .eq('id', payRow.id)
        .eq('provider_init_state', 'dispatched'); // CAS: only update if still dispatched
    }
    return { status: 'indeterminate', paymentId: payRow.id, message: result.errorMessage || 'unknown' };
  }

  async requiresPin(
    supabase: SupabaseClient,
    methodId: string,
    businessId: string,
    customerPhone: string,
  ): Promise<{ required: boolean; locked: boolean }> {
    // PIN is provider-neutral — same logic as Paystack
    const method = await lookupAuthorizedMethod(supabase, methodId, businessId, customerPhone);
    if (!method) return { required: false, locked: false };
    if (!method.pin_hash) return { required: false, locked: false };
    const locked = !!(method.pin_locked_until && new Date(method.pin_locked_until) > new Date());
    return { required: true, locked };
  }

  async verifyPin(
    supabase: SupabaseClient,
    methodId: string,
    businessId: string,
    customerPhone: string,
    pin: string,
  ): Promise<PinVerifyResult> {
    // PIN is provider-neutral — same logic as Paystack
    const method = await lookupAuthorizedMethod(supabase, methodId, businessId, customerPhone);
    if (!method) return { valid: false, attemptsRemaining: 0, locked: true };

    const { createHash } = await import('crypto');
    const phone = normalizePhone(customerPhone);
    const pinHash = createHash('sha256').update(`${pin}:${phone}`).digest('hex');

    if (method.pin_hash !== pinHash) {
      const attempts = (method.pin_attempts || 0) + 1;
      const locked = attempts >= MAX_PIN_ATTEMPTS;
      const lockUntil = locked
        ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60 * 1000).toISOString()
        : null;
      await supabase.from('saved_payment_methods')
        .update({ pin_attempts: attempts, ...(lockUntil ? { pin_locked_until: lockUntil } : {}) })
        .eq('id', method.id);
      return { valid: false, attemptsRemaining: Math.max(0, MAX_PIN_ATTEMPTS - attempts), locked };
    }

    await supabase.from('saved_payment_methods')
      .update({ pin_attempts: 0 })
      .eq('id', method.id);
    return { valid: true };
  }
}

registry.register('stripe', new StripeSavedPaymentAdapterImpl());

/** The provider-neutral saved payment adapter. Flow files use this. */
export const savedPaymentAdapter: SavedPaymentAdapter = registry;
