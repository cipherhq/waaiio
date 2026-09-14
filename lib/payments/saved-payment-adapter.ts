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
  userId?: string;
  transactionCategory?: string;
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
  businessId: string,
  customerPhone: string,
): Promise<{
  id: string;
  gateway: string;
  authorization_code: string | null;
  customer_code: string | null;
  stripe_payment_method_id: string | null;
  stripe_customer_id: string | null;
  card_last4: string | null;
  card_brand: string | null;
  pin_hash: string | null;
  pin_attempts: number;
  pin_locked_until: string | null;
} | null> {
  const phone = normalizePhone(customerPhone);
  const { data } = await supabase
    .from('saved_payment_methods')
    .select('id, gateway, authorization_code, customer_code, stripe_payment_method_id, stripe_customer_id, card_last4, card_brand, pin_hash, pin_attempts, pin_locked_until')
    .eq('id', methodId)
    .eq('business_id', businessId)
    .eq('customer_phone', phone)
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
    // Canonical tuple authorization: method must belong to this business + customer
    const method = await lookupAuthorizedMethod(supabase, opts.methodId, opts.businessId, opts.customerPhone);
    if (!method) {
      return { status: 'method_not_found' };
    }

    const result = await chargeSavedCard(supabase, {
      savedMethod: method,
      amount: opts.amount,
      currency: opts.currency,
      email: opts.email,
      reference: opts.reference,
      businessId: opts.businessId,
      bookingId: opts.bookingId,
      orderId: opts.orderId,
      reservationId: opts.reservationId,
      invoiceId: opts.invoiceId,
      campaignId: opts.campaignId,
      userId: opts.userId,
      transactionCategory: opts.transactionCategory,
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

// ── Singleton adapter instance ──

/** The provider-neutral saved payment adapter. Flow files use this. */
export const savedPaymentAdapter: SavedPaymentAdapter = new PaystackSavedPaymentAdapter();
