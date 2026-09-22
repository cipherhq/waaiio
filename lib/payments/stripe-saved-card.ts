/**
 * Stripe Saved Card Operations
 *
 * Provider-specific implementation for Stripe saved-card lifecycle:
 * - Evidence extraction: reads Checkout Session for consent + PM data
 * - Consent detection: checks allow_redisplay=always
 * - Redisplay downgrade: sets allow_redisplay=limited after consent capture
 * - Charge: on-session PaymentIntent with CAS state machine
 * - Detach: PM detach for cleanup
 *
 * This module is called by the provider-neutral adapter registry.
 * It does NOT modify provider-adapters.ts (read-only contract).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

function getStripeKey(): string {
  return process.env.STRIPE_SECRET_KEY || '';
}

async function stripeGet(path: string): Promise<Record<string, unknown>> {
  const key = getStripeKey();
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

async function stripePost(
  path: string,
  body: Record<string, string>,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const key = getStripeKey();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

// ── Evidence extraction ──

export interface StripeCardEvidence {
  customerId: string;
  paymentMethodId: string;
  paymentIntentId: string;
  cardLast4: string;
  cardBrand: string;
  cardExpMonth: number;
  cardExpYear: number;
  allowRedisplay: string;
  consented: boolean;
}

/**
 * Extract saved-card evidence from a completed Stripe Checkout Session.
 * Returns null if the session cannot provide reusable card evidence.
 */
export async function extractStripeSavedCardEvidence(
  checkoutSessionId: string,
): Promise<StripeCardEvidence | null> {
  try {
    // Expand payment_intent.payment_method to get card details + allow_redisplay
    const session = await stripeGet(
      `/checkout/sessions/${encodeURIComponent(checkoutSessionId)}?expand[]=payment_intent.payment_method`,
    );

    if (!session.customer || typeof session.customer !== 'string') return null;

    const pi = session.payment_intent as Record<string, unknown> | null;
    if (!pi?.payment_method) return null;

    const pm = pi.payment_method as Record<string, unknown>;
    if (!pm?.id || typeof pm.id !== 'string') return null;

    const card = pm.card as Record<string, unknown> | undefined;
    if (!card) return null;

    const allowRedisplay = (pm.allow_redisplay as string) || 'unspecified';
    const consented = allowRedisplay === 'always';

    return {
      customerId: session.customer as string,
      paymentMethodId: pm.id,
      paymentIntentId: pi.id as string,
      cardLast4: (card.last4 as string) || '????',
      cardBrand: (card.brand as string) || 'card',
      cardExpMonth: (card.exp_month as number) || 0,
      cardExpYear: (card.exp_year as number) || 0,
      allowRedisplay,
      consented,
    };
  } catch (err) {
    logger.withContext({ op: 'stripe-saved-card.extract', ...safeLogErrorContext(err) })
      .error('[STRIPE-SAVED-CARD] Evidence extraction failed');
    return null;
  }
}

// ── Redisplay downgrade ──

/**
 * Downgrade a Stripe PaymentMethod's allow_redisplay to 'limited'.
 * This prevents Stripe Checkout from surfacing it, ensuring all reuse
 * goes through Waaiio's PIN-protected saved-card flow.
 *
 * Returns true if the downgrade was verified, false otherwise.
 */
export async function downgradeAllowRedisplay(paymentMethodId: string): Promise<boolean> {
  try {
    // Update allow_redisplay to 'limited'
    await stripePost(`/payment_methods/${encodeURIComponent(paymentMethodId)}`, {
      allow_redisplay: 'limited',
    });

    // Verify the update took effect
    const pm = await stripeGet(`/payment_methods/${encodeURIComponent(paymentMethodId)}`);
    return pm.allow_redisplay === 'limited';
  } catch (err) {
    logger.withContext({ op: 'stripe-saved-card.downgrade', ...safeLogErrorContext(err) })
      .error('[STRIPE-SAVED-CARD] Redisplay downgrade failed');
    return false;
  }
}

// ── Charge (on-session PaymentIntent) ──

export interface StripeChargeResult {
  status: 'succeeded' | 'requires_action' | 'declined' | 'error' | 'indeterminate';
  paymentIntentId?: string;
  clientSecret?: string;
  errorMessage?: string;
}

/**
 * Create an on-session PaymentIntent to charge a saved Stripe card.
 *
 * @param customerId Stripe Customer ID (cus_...)
 * @param paymentMethodId Stripe PaymentMethod ID (pm_...)
 * @param amountCents Amount in smallest currency unit
 * @param currency ISO 4217 currency code (lowercase)
 * @param idempotencyKey Deterministic key to prevent duplicate charges
 * @param stripeAccountId Optional destination account for split payments
 * @param applicationFeeAmount Optional application fee in cents
 */
export async function chargeStripeSavedCard(opts: {
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  stripeAccountId?: string;
  applicationFeeAmount?: number;
}): Promise<StripeChargeResult> {
  try {
    const params: Record<string, string> = {
      customer: opts.customerId,
      payment_method: opts.paymentMethodId,
      amount: String(opts.amountCents),
      currency: opts.currency.toLowerCase(),
      confirm: 'true',
      // on-session: customer is present in the WhatsApp flow
    };

    if (opts.stripeAccountId) {
      params['transfer_data[destination]'] = opts.stripeAccountId;
    }
    if (opts.applicationFeeAmount != null && opts.applicationFeeAmount > 0) {
      params['application_fee_amount'] = String(opts.applicationFeeAmount);
    }

    const result = await stripePost('/payment_intents', params, opts.idempotencyKey);

    if (result.error) {
      const error = result.error as Record<string, unknown>;
      return {
        status: 'declined',
        errorMessage: (error.message as string) || 'Stripe charge failed',
      };
    }

    const piId = result.id as string;
    const piStatus = result.status as string;

    if (piStatus === 'succeeded') {
      return { status: 'succeeded', paymentIntentId: piId };
    }
    if (piStatus === 'requires_action') {
      return {
        status: 'requires_action',
        paymentIntentId: piId,
        clientSecret: result.client_secret as string,
      };
    }
    if (['requires_payment_method', 'canceled'].includes(piStatus)) {
      return { status: 'declined', paymentIntentId: piId, errorMessage: `stripe_pi_${piStatus}` };
    }

    // processing or other → indeterminate
    return { status: 'indeterminate', paymentIntentId: piId };
  } catch (err) {
    logger.withContext({ op: 'stripe-saved-card.charge', ...safeLogErrorContext(err) })
      .error('[STRIPE-SAVED-CARD] Charge threw');
    return { status: 'error', errorMessage: 'Stripe charge error' };
  }
}

// ── Detach ──

/**
 * Detach a PaymentMethod from its Customer.
 * Idempotent: already-detached PM returns success.
 */
export async function detachStripePaymentMethod(paymentMethodId: string): Promise<{
  success: boolean;
  alreadyDetached: boolean;
  terminal: boolean;
  error?: string;
}> {
  try {
    const result = await stripePost(`/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`, {});

    if (result.id) {
      return { success: true, alreadyDetached: false, terminal: false };
    }

    const error = result.error as Record<string, unknown> | undefined;
    if (error) {
      const code = error.code as string;
      // Already detached or not attached
      if (code === 'resource_missing' || code === 'payment_method_unattached') {
        return { success: true, alreadyDetached: true, terminal: false };
      }
      return { success: false, alreadyDetached: false, terminal: true, error: (error.message as string) || code };
    }

    return { success: false, alreadyDetached: false, terminal: false, error: 'unexpected_response' };
  } catch (err) {
    logger.withContext({ op: 'stripe-saved-card.detach', ...safeLogErrorContext(err) })
      .error('[STRIPE-SAVED-CARD] Detach threw');
    return { success: false, alreadyDetached: false, terminal: false, error: 'transport_error' };
  }
}
