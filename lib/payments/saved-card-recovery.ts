/**
 * #375: Canonical saved-card dispatched-payment recovery.
 *
 * Same payment row, same stored pi_params, same sc_charge_ idempotency key.
 * No second payment row. No fresh provider dispatch with a different key.
 *
 * Extracted from the cron payment-reconciliation inline Stripe saved-card
 * recovery block so both the cron and the bot "I've Paid" path can share
 * the exact same idempotent replay logic.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

export interface SavedCardRecoveryResult {
  outcome: 'succeeded' | 'requires_action' | 'declined' | 'provider_confirmed' | 'indeterminate' | 'quarantined' | 'already_resolved' | 'error';
  paymentIntentId?: string;
  authUrl?: string;
  message?: string;
}

/** 23 hours — safe margin under Stripe's 24h idempotency window */
const STRIPE_IDEMPOTENCY_WINDOW = 23 * 60 * 60 * 1000;

/**
 * Canonical saved-card dispatched-payment recovery.
 *
 * 1. Reads the exact payment row by ID (not gateway_reference).
 * 2. Validates it's a saved-card dispatched payment.
 * 3. Checks the idempotency window — quarantines if expired.
 * 4. Uses stored metadata.pi_params for exact Stripe PI replay.
 * 5. Uses idempotency key `sc_charge_${paymentId}`.
 * 6. Maps PI outcome to checked CAS transitions.
 *
 * @param supabase Service-role client
 * @param paymentId The Waaiio payment.id (UUID)
 */
export async function recoverDispatchedSavedCardPayment(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<SavedCardRecoveryResult> {
  const logPrefix = '[SAVED-CARD-RECOVERY]';

  // 1. Read the exact payment row by ID
  const { data: payment, error: paymentErr } = await supabase
    .from('payments')
    .select('id, gateway, gateway_reference, metadata, provider_init_state, status, created_at, amount, currency')
    .eq('id', paymentId)
    .single();

  if (paymentErr || !payment) {
    logger.warn(`${logPrefix} Payment not found: ${paymentId}`);
    return { outcome: 'error', message: 'Payment not found' };
  }

  // 2. Validate it's a saved-card payment
  const meta = (payment.metadata || {}) as Record<string, unknown>;
  if (meta.saved_method !== true) {
    logger.info(`${logPrefix} Payment ${paymentId} is not a saved-card payment — skipping`);
    return { outcome: 'error', message: 'Not a saved-card dispatched payment' };
  }

  // R1-B5: If no longer dispatched/pending, another authority already won — converge
  if (payment.provider_init_state !== 'dispatched' || payment.status !== 'pending') {
    logger.info(`${logPrefix} Payment ${paymentId} already resolved (status=${payment.status}, init=${payment.provider_init_state}) — converging`);
    if (payment.status === 'success') {
      return { outcome: 'already_resolved', paymentIntentId: payment.gateway_reference || undefined };
    }
    if (payment.provider_init_state === 'provider_confirmed' && payment.status === 'pending') {
      // Another authority confirmed but reconciliation hasn't run
      return reconcileProviderConfirmedPayment(supabase, paymentId, payment.gateway_reference || undefined);
    }
    if (payment.status === 'failed') {
      return { outcome: 'declined', message: 'Payment was declined', paymentIntentId: payment.gateway_reference || undefined };
    }
    // Other states: return what we know
    return { outcome: 'indeterminate', paymentIntentId: payment.gateway_reference || undefined };
  }

  if (payment.gateway !== 'stripe') {
    // Other saved-card providers do not use Stripe's replay protocol, but the
    // known payment ID is still authoritative. Reconcile this exact row rather
    // than falling back to a logical gateway reference.
    return reconcileProviderConfirmedPayment(supabase, paymentId, payment.gateway_reference || undefined);
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    logger.error(`${logPrefix} STRIPE_SECRET_KEY not configured`);
    return { outcome: 'error', message: 'Stripe configuration error' };
  }

  // 3. Check idempotency window
  const paymentAge = Date.now() - new Date(payment.created_at as string).getTime();
  if (paymentAge > STRIPE_IDEMPOTENCY_WINDOW) {
    logger.warn(`${logPrefix} Payment ${paymentId} beyond idempotency window — quarantining`);
    const qCas = await checkedCAS(supabase, paymentId, {
      gateway_status: 'dispatched_quarantine:idempotency_expired',
      provider_init_state: 'dispatched', // keep dispatched for audit
    });
    if (!qCas) {
      // R1-B2: CAS lost — another authority won. Re-read and converge.
      return convergeAfterCASLoss(supabase, paymentId);
    }
    return { outcome: 'quarantined', message: 'Idempotency window expired' };
  }

  // 4. Build PI params from stored metadata
  if (!meta.pi_params && !(meta.stripe_customer_id && meta.stripe_pm_id)) {
    logger.warn(`${logPrefix} Payment ${paymentId} has no pi_params or customer/pm — cannot replay`);
    return { outcome: 'error', message: 'Missing PI parameters for replay' };
  }

  const idempotencyKey = `sc_charge_${paymentId}`;
  let params: Record<string, string>;

  if (meta.pi_params && typeof meta.pi_params === 'object') {
    // Use stored exact params — includes application_fee_amount
    params = meta.pi_params as Record<string, string>;
  } else {
    // Fallback: reconstruct from metadata (legacy rows without pi_params)
    params = {
      customer: meta.stripe_customer_id as string,
      payment_method: meta.stripe_pm_id as string,
      amount: String(Math.round(payment.amount * 100)),
      currency: (payment.currency as string).toLowerCase(),
      confirm: 'true',
    };
    if (meta.provider_account_id) {
      params['transfer_data[destination]'] = meta.provider_account_id as string;
    }
    if (meta.application_fee_amount) {
      params['application_fee_amount'] = String(meta.application_fee_amount);
    }
  }

  // 5. Stripe PI replay with canonical idempotency key
  try {
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey,
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const pi = await res.json() as Record<string, unknown>;
      if (pi.id && typeof pi.id === 'string') {
        // 6. Map outcome
        if (pi.status === 'succeeded') {
          const casOk = await checkedCAS(supabase, paymentId, {
            gateway_reference: pi.id,
            provider_init_state: 'provider_confirmed',
            metadata: { ...meta, stripe_pi_id: pi.id },
          });
          if (casOk) {
            const { reconcilePayment } = await import('@/lib/payments/reconcile');
            await reconcilePayment(supabase, paymentId, 'saved_card');
          } else {
            // R1-B2: CAS lost — another authority won. Re-read and converge.
            return convergeAfterCASLoss(supabase, paymentId);
          }
          return { outcome: 'succeeded', paymentIntentId: pi.id };
        }

        if (pi.status === 'requires_action') {
          const casOk = await checkedCAS(supabase, paymentId, {
            gateway_reference: pi.id,
            provider_init_state: 'provider_confirmed',
            metadata: { ...meta, stripe_pi_id: pi.id },
          });
          if (!casOk) {
            // R1-B2: CAS lost — another authority won. Re-read and converge.
            return convergeRequiresActionCASLoss(supabase, paymentId, pi.id, meta);
          }
          const authResult = await createRecoveryAuthAttempt(supabase, paymentId, meta);
          if (authResult) return { outcome: 'requires_action', paymentIntentId: pi.id, authUrl: authResult.authUrl };
          // Auth attempt creation failed — return indeterminate (not raw Stripe URL)
          return { outcome: 'indeterminate', paymentIntentId: pi.id, message: 'requires_action but auth attempt creation failed' };
        }

        if (['requires_payment_method', 'canceled'].includes(pi.status as string)) {
          const termOk = await checkedTerminal(supabase, paymentId, `stripe_pi_${pi.status}`);
          if (!termOk) {
            // R1-B2: CAS lost — another authority won. Re-read and converge.
            return convergeAfterCASLoss(supabase, paymentId);
          }
          return { outcome: 'declined', paymentIntentId: pi.id, message: `Payment ${pi.status === 'canceled' ? 'canceled' : 'declined'}` };
        }
      }
      // Unrecognized PI shape — indeterminate
      return { outcome: 'indeterminate', message: 'Unrecognized PI response' };
    }

    // Non-2xx response — classify error
    const errorBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    const error = (errorBody.error || {}) as Record<string, unknown>;
    const errType = (error.type as string) || '';
    const errCode = (error.code as string) || '';

    if (errType === 'card_error' || errCode === 'card_declined') {
      const termOk = await checkedTerminal(supabase, paymentId, `stripe_card_decline:${errCode}`);
      if (!termOk) {
        return convergeAfterCASLoss(supabase, paymentId);
      }
      return { outcome: 'declined', message: `Card declined: ${errCode}` };
    }

    if (res.status === 401 || res.status === 403 || res.status === 429
      || errType === 'authentication_error' || errCode === 'idempotency_key_in_use') {
      // Retryable — remain dispatched
      logger.warn(`${logPrefix} Retryable Stripe error`, { paymentId, status: res.status, errType, errCode });
      return { outcome: 'indeterminate', message: `Retryable error: ${errCode || errType}` };
    }

    if (errType === 'invalid_request_error' && (errCode === 'resource_missing' || errCode === 'payment_method_unattached')) {
      const termOk = await checkedTerminal(supabase, paymentId, `stripe_invalid:${errCode}`);
      if (!termOk) {
        return convergeAfterCASLoss(supabase, paymentId);
      }
      return { outcome: 'declined', message: `Invalid: ${errCode}` };
    }

    // Other errors — quarantine for review
    logger.warn(`${logPrefix} Unclassified Stripe error — quarantine`, { paymentId, status: res.status, errType, errCode });
    return { outcome: 'indeterminate', message: `Unclassified error: ${errCode || errType}` };
  } catch (err) {
    // Network error / timeout — indeterminate, remain dispatched
    logger.warn(`${logPrefix} Network error during PI replay`, { paymentId, error: String(err) });
    return { outcome: 'indeterminate', message: 'Network error during recovery' };
  }
}

// ── Internal helpers ──

/**
 * R1-B2: After a CAS transition fails, re-read the payment row and converge
 * to the correct outcome based on current state.
 */
async function convergeAfterCASLoss(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<SavedCardRecoveryResult> {
  const { data: current, error } = await supabase.from('payments')
    .select('status, provider_init_state, gateway_reference')
    .eq('id', paymentId).single();

  if (error || !current) return { outcome: 'indeterminate', message: 'CAS lost and canonical state could not be read' };

  if (current.status === 'success') {
    return { outcome: 'already_resolved', paymentIntentId: current.gateway_reference || undefined };
  }
  if (current.provider_init_state === 'provider_confirmed' && current.status === 'pending') {
    // Another authority confirmed but reconciliation hasn't completed
    return reconcileProviderConfirmedPayment(supabase, paymentId, current.gateway_reference || undefined);
  }
  if (current.status === 'failed') {
    return { outcome: 'declined', paymentIntentId: current.gateway_reference || undefined, message: 'Payment was declined' };
  }
  return { outcome: 'indeterminate', paymentIntentId: current.gateway_reference || undefined, message: 'CAS lost to a non-terminal canonical state' };
}

async function reconcileProviderConfirmedPayment(
  supabase: SupabaseClient,
  paymentId: string,
  paymentIntentId?: string,
): Promise<SavedCardRecoveryResult> {
  const { reconcilePayment } = await import('@/lib/payments/reconcile');
  const result = await reconcilePayment(supabase, paymentId, 'saved_card');
  const status = result.lifecycle?.status;
  if (status === 'completed' || status === 'already_completed' || status === 'not_deliverable') {
    return { outcome: 'already_resolved', paymentIntentId };
  }

  const { data: current } = await supabase.from('payments')
    .select('status, provider_init_state, gateway_reference')
    .eq('id', paymentId).single();
  if (current?.status === 'success') return { outcome: 'already_resolved', paymentIntentId: current.gateway_reference || paymentIntentId };
  if (current?.status === 'failed') return { outcome: 'declined', paymentIntentId: current.gateway_reference || paymentIntentId, message: 'Payment was declined' };
  if (current?.provider_init_state === 'provider_confirmed') {
    return { outcome: 'provider_confirmed', paymentIntentId: current.gateway_reference || paymentIntentId, message: 'Provider confirmed; canonical finalization is still pending' };
  }
  return { outcome: 'indeterminate', paymentIntentId: current?.gateway_reference || paymentIntentId, message: 'Canonical payment remains pending' };
}

async function convergeRequiresActionCASLoss(
  supabase: SupabaseClient,
  paymentId: string,
  paymentIntentId: string,
  metadata: Record<string, unknown>,
): Promise<SavedCardRecoveryResult> {
  const { data: current } = await supabase.from('payments')
    .select('status, provider_init_state, gateway_reference')
    .eq('id', paymentId).single();
  if (current?.status === 'pending'
    && current.provider_init_state === 'provider_confirmed'
    && current.gateway_reference === paymentIntentId) {
    const authResult = await createRecoveryAuthAttempt(supabase, paymentId, metadata);
    if (authResult) return { outcome: 'requires_action', paymentIntentId, authUrl: authResult.authUrl };
    return { outcome: 'indeterminate', paymentIntentId, message: 'Canonical PI requires action but auth attempt creation failed' };
  }
  return convergeAfterCASLoss(supabase, paymentId);
}

async function createRecoveryAuthAttempt(
  supabase: SupabaseClient,
  paymentId: string,
  metadata: Record<string, unknown>,
): Promise<{ authUrl: string; attemptId: string } | null> {
  const { canonicalSavedCardPhone } = await import('./saved-card-compat');
  let phone = typeof metadata.customer_phone === 'string'
    ? canonicalSavedCardPhone(metadata.customer_phone)
    : null;

  // Older dispatched rows predate customer_phone persistence. Recover the durable
  // owner from the exact Stripe credential tuple instead of inventing identity.
  if (!phone && metadata.stripe_customer_id && metadata.stripe_pm_id) {
    const { data: method } = await supabase.from('saved_payment_methods')
      .select('customer_phone')
      .eq('stripe_customer_id', metadata.stripe_customer_id)
      .eq('stripe_payment_method_id', metadata.stripe_pm_id)
      .maybeSingle();
    if (method?.customer_phone) phone = canonicalSavedCardPhone(method.customer_phone);
  }
  if (!phone) return null;

  const { createAuthAttempt } = await import('./stripe-saved-card');
  return createAuthAttempt(supabase, paymentId, phone);
}

/** Checked CAS — returns true only on exactly one affected row */
async function checkedCAS(
  supabase: SupabaseClient,
  paymentId: string,
  updates: Record<string, unknown>,
): Promise<boolean> {
  const { data: rows, error: casErr } = await supabase.from('payments')
    .update(updates)
    .eq('id', paymentId).eq('provider_init_state', 'dispatched')
    .eq('status', 'pending')
    .select('id');
  return !casErr && rows != null && rows.length === 1;
}

/** Checked terminal transition for provider-proven failure */
async function checkedTerminal(
  supabase: SupabaseClient,
  paymentId: string,
  reason: string,
): Promise<boolean> {
  const { data: rows, error: err } = await supabase.from('payments')
    .update({ status: 'failed', gateway_status: `provider_terminal_${reason}` })
    .eq('id', paymentId).eq('provider_init_state', 'dispatched').eq('status', 'pending')
    .select('id');
  return !err && rows != null && rows.length === 1;
}
