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

export interface StripeResponse {
  data: Record<string, unknown>;
  httpStatus: number;
  ok: boolean;
}

async function stripePost(
  path: string,
  body: Record<string, string>,
  idempotencyKey?: string,
): Promise<StripeResponse> {
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
  const data = await response.json() as Record<string, unknown>;
  return { data, httpStatus: response.status, ok: response.ok };
}

/**
 * Classify a Stripe HTTP error response.
 * Distinguishes terminal card decline from retryable/config/ambiguous outcomes.
 */
function classifyStripeError(httpStatus: number, error: Record<string, unknown>): 'terminal_decline' | 'config_error' | 'retryable' | 'idempotency_conflict' {
  const type = error.type as string;
  const code = error.code as string;

  // Idempotency conflict — same key, different params
  if (code === 'idempotency_key_in_use' || type === 'idempotent_request_mismatch') {
    return 'idempotency_conflict';
  }

  // Auth/config errors — not a customer card problem
  if (httpStatus === 401 || httpStatus === 403) return 'config_error';
  if (type === 'authentication_error' || type === 'api_connection_error') return 'config_error';
  if (httpStatus === 429) return 'retryable'; // rate limit

  // Card decline errors — genuine terminal decline
  if (type === 'card_error') return 'terminal_decline';
  if (code === 'card_declined' || code === 'expired_card' || code === 'incorrect_cvc' || code === 'processing_error') return 'terminal_decline';

  // Invalid request with specific card params — terminal
  if (type === 'invalid_request_error' && (code === 'resource_missing' || code === 'payment_method_unattached')) {
    return 'terminal_decline';
  }

  // Other invalid_request_error — config/setup issue, not customer decline
  if (type === 'invalid_request_error') return 'config_error';

  // Anything else — retryable/ambiguous
  return 'retryable';
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
    const { ok } = await stripePost(`/payment_methods/${encodeURIComponent(paymentMethodId)}`, {
      allow_redisplay: 'limited',
    });
    if (!ok) return false;

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
      // #379: Explicitly card-only — prevents Stripe from adding redirect-capable
      // payment methods (e.g. bank transfers, wallets) that require return_url.
      // This is a server-side saved-card charge, not a Checkout Session.
      'payment_method_types[0]': 'card',
    };

    if (opts.stripeAccountId) {
      params['transfer_data[destination]'] = opts.stripeAccountId;
    }
    if (opts.applicationFeeAmount != null && opts.applicationFeeAmount > 0) {
      params['application_fee_amount'] = String(opts.applicationFeeAmount);
    }

    const { data: result, httpStatus, ok } = await stripePost('/payment_intents', params, opts.idempotencyKey);

    if (!ok || result.error) {
      const error = (result.error || {}) as Record<string, unknown>;
      const classification = classifyStripeError(httpStatus, error);

      if (classification === 'terminal_decline') {
        return { status: 'declined', errorMessage: (error.message as string) || `stripe_${httpStatus}` };
      }
      if (classification === 'config_error' || classification === 'idempotency_conflict') {
        // Config/auth/idempotency errors are NOT customer declines — return indeterminate
        return { status: 'indeterminate', errorMessage: `stripe_config_${httpStatus}: ${(error.code as string) || (error.type as string) || ''}` };
      }
      // Retryable
      return { status: 'indeterminate', errorMessage: `stripe_retryable_${httpStatus}` };
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

/**
 * Build the exact PI params that would be used for a saved-card charge.
 * Used for durable storage so recovery can replay the exact same request.
 */
export function buildSavedCardPIParams(opts: {
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency: string;
  stripeAccountId?: string;
  applicationFeeAmount?: number;
}): Record<string, string> {
  const params: Record<string, string> = {
    customer: opts.customerId,
    payment_method: opts.paymentMethodId,
    amount: String(opts.amountCents),
    currency: opts.currency.toLowerCase(),
    confirm: 'true',
    // #379: Explicitly card-only for server-side saved-card charges
    'payment_method_types[0]': 'card',
  };
  if (opts.stripeAccountId) {
    params['transfer_data[destination]'] = opts.stripeAccountId;
  }
  if (opts.applicationFeeAmount != null && opts.applicationFeeAmount > 0) {
    params['application_fee_amount'] = String(opts.applicationFeeAmount);
  }
  return params;
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
    const { data: result, httpStatus, ok } = await stripePost(`/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`, {});

    if (ok && result.id) {
      return { success: true, alreadyDetached: false, terminal: false };
    }

    const error = (result.error || {}) as Record<string, unknown>;
    const code = error.code as string;

    // Already detached or not attached
    if (code === 'resource_missing' || code === 'payment_method_unattached') {
      return { success: true, alreadyDetached: true, terminal: false };
    }

    // Auth/config errors are retryable (not terminal)
    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) {
      return { success: false, alreadyDetached: false, terminal: false, error: `stripe_${httpStatus}` };
    }

    // Other 4xx are terminal
    if (httpStatus >= 400 && httpStatus < 500) {
      return { success: false, alreadyDetached: false, terminal: true, error: (error.message as string) || `stripe_${httpStatus}` };
    }

    // 5xx or unexpected — retryable
    return { success: false, alreadyDetached: false, terminal: false, error: `stripe_${httpStatus}` };
  } catch (err) {
    logger.withContext({ op: 'stripe-saved-card.detach', ...safeLogErrorContext(err) })
      .error('[STRIPE-SAVED-CARD] Detach threw');
    return { success: false, alreadyDetached: false, terminal: false, error: 'transport_error' };
  }
}

// ── 3DS auth attempt creation ──

/**
 * Create a durable 3DS auth attempt and generate a signed token URL.
 * Supersedes any existing active attempt for the same payment.
 */
export async function createAuthAttempt(
  supabase: SupabaseClient,
  paymentId: string,
  customerPhone: string,
): Promise<{ authUrl: string; attemptId: string } | null> {
  const { randomUUID } = await import('crypto');
  const authSecret = process.env.SAVED_CARD_AUTH_SECRET;
  if (!authSecret) {
    logger.error('[STRIPE-SAVED-CARD] SAVED_CARD_AUTH_SECRET not configured');
    return null;
  }

  try {
    // Supersede existing attempts
    await supabase
      .from('saved_card_auth_attempts')
      .update({ superseded_at: new Date().toISOString() })
      .eq('payment_id', paymentId)
      .is('superseded_at', null);

    // Get next version
    const { data: maxRow } = await supabase
      .from('saved_card_auth_attempts')
      .select('auth_version')
      .eq('payment_id', paymentId)
      .order('auth_version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextVersion = (maxRow?.auth_version || 0) + 1;
    const nonce = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    const { data: attempt, error } = await supabase
      .from('saved_card_auth_attempts')
      .insert({
        payment_id: paymentId,
        customer_phone: customerPhone,
        nonce,
        auth_version: nextVersion,
        expires_at: expiresAt.toISOString(),
      })
      .select('id')
      .single();

    if (error || !attempt) {
      logger.error('[STRIPE-SAVED-CARD] Auth attempt creation failed', { error });
      return null;
    }

    // Sign token
    const { createHmac } = await import('crypto');
    const payload = {
      payment_id: paymentId,
      nonce,
      auth_version: nextVersion,
      exp: Math.floor(expiresAt.getTime() / 1000),
    };
    const sig = createHmac('sha256', authSecret)
      .update(JSON.stringify(payload))
      .digest('hex');

    const token = Buffer.from(JSON.stringify({ ...payload, sig })).toString('base64url');
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
    const authUrl = `${appUrl}/payment-auth?t=${token}`;

    return { authUrl, attemptId: attempt.id };
  } catch (err) {
    logger.withContext({ op: 'stripe-saved-card.auth-attempt', ...safeLogErrorContext(err) })
      .error('[STRIPE-SAVED-CARD] Auth attempt creation threw');
    return null;
  }
}
