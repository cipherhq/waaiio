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
   * Returns true if a PIN is set and not currently locked out.
   * Returns false if no PIN is set (legacy card) or method not found.
   */
  requiresPin(
    supabase: SupabaseClient,
    methodId: string,
  ): Promise<{ required: boolean; locked: boolean }>;

  /** Verify a PIN for a saved method. Handles attempt counting and lockout. */
  verifyPin(
    supabase: SupabaseClient,
    methodId: string,
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
    // Look up the internal saved method by opaque ID
    const method = await getSavedPaymentMethod(supabase, opts.businessId, '');
    // We need to find by ID, not by phone — use direct query
    const { data: internalMethod } = await supabase
      .from('saved_payment_methods')
      .select('id, gateway, authorization_code, customer_code, stripe_payment_method_id, stripe_customer_id, card_last4, card_brand')
      .eq('id', opts.methodId)
      .eq('business_id', opts.businessId)
      .eq('is_active', true)
      .maybeSingle();

    if (!internalMethod) {
      return { status: 'method_not_found' };
    }

    const result = await chargeSavedCard(supabase, {
      savedMethod: internalMethod,
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
  ): Promise<{ required: boolean; locked: boolean }> {
    const { data } = await supabase
      .from('saved_payment_methods')
      .select('pin_hash, pin_locked_until')
      .eq('id', methodId)
      .single();

    if (!data || !data.pin_hash) {
      return { required: false, locked: false };
    }

    const locked = !!(data.pin_locked_until && new Date(data.pin_locked_until) > new Date());
    return { required: true, locked };
  }

  async verifyPin(
    supabase: SupabaseClient,
    methodId: string,
    customerPhone: string,
    pin: string,
  ): Promise<PinVerifyResult> {
    const { createHash } = await import('crypto');
    const phone = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
    const pinHash = createHash('sha256').update(`${pin}:${phone}`).digest('hex');

    const { data: card } = await supabase
      .from('saved_payment_methods')
      .select('id, pin_hash, pin_attempts')
      .eq('id', methodId)
      .single();

    if (!card || card.pin_hash !== pinHash) {
      const attempts = (card?.pin_attempts || 0) + 1;
      const locked = attempts >= MAX_PIN_ATTEMPTS;
      if (card) {
        const lockUntil = locked
          ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60 * 1000).toISOString()
          : null;
        await supabase.from('saved_payment_methods')
          .update({ pin_attempts: attempts, ...(lockUntil ? { pin_locked_until: lockUntil } : {}) })
          .eq('id', card.id);
      }
      return {
        valid: false,
        attemptsRemaining: Math.max(0, MAX_PIN_ATTEMPTS - attempts),
        locked,
      };
    }

    // PIN correct — reset attempts
    await supabase.from('saved_payment_methods')
      .update({ pin_attempts: 0 })
      .eq('id', card.id);

    return { valid: true };
  }
}

// ── Singleton adapter instance ──

/** The provider-neutral saved payment adapter. Flow files use this. */
export const savedPaymentAdapter: SavedPaymentAdapter = new PaystackSavedPaymentAdapter();
