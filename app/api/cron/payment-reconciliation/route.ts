import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { processSuccessfulPayment } from '@/lib/payments/process-success';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';
import { logger } from '@/lib/logger';
import { createCronLogger } from '@/lib/observability/cron';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Payment Reconciliation Cron
 *
 * Finds payments stuck in 'pending' for 2+ hours and verifies them against
 * the payment gateway. If the gateway says paid, we process the payment.
 * If the gateway says failed/expired, we mark it failed.
 *
 * Runs every 4 hours: "0 *​/4 * * *"
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const cron = createCronLogger('payment-reconciliation');
  cron.started();

  try {
  const supabase = createServiceClient();

  const twoHoursAgo = new Date();
  twoHoursAgo.setHours(twoHoursAgo.getHours() - 2);

  // Find payments needing reconciliation:
  // A. Stale pending payments (provider may have been paid)
  // B. New-authority success + incomplete Stage 2 (finalization_completed_at IS NULL)
  // C. New-authority success + Stage 2 complete + incomplete Stage 3 (confirmation_sent_at IS NULL)
  //    but NOT not_deliverable (terminal — no contact info to retry with)
  const { data: stalePayments, error: queryError } = await supabase
    .from('payments')
    .select('id, amount, gateway, gateway_reference, booking_id, invoice_id, campaign_id, order_id, metadata, status, payment_authority_version, finalization_completed_at, confirmation_sent_at')
    .or(`status.eq.pending,and(status.eq.success,payment_authority_version.not.is.null,finalization_completed_at.is.null),and(status.eq.success,payment_authority_version.not.is.null,finalization_completed_at.not.is.null,confirmation_sent_at.is.null,confirmation_terminal_reason.is.null)`)
    .lt('created_at', twoHoursAgo.toISOString())
    .limit(50);

  if (queryError) {
    cron.failed(queryError);
    return NextResponse.json({ ok: false, error: 'Query failed' }, { status: 500 });
  }

  if (!stalePayments || stalePayments.length === 0) {
    cron.completed({ processedCount: 0 });
    return NextResponse.json({ ok: true, processed: 0 });
  }

  // ── #264: V1 dispatched recovery ──
  // V1 payments stuck in 'dispatched' need provider-specific recovery.
  const { data: dispatchedPayments } = await supabase
    .from('payments')
    .select('id, gateway, gateway_reference, metadata, provider_init_state, fee_policy_version, created_at, amount, currency')
    .eq('fee_policy_version', 1)
    .eq('provider_init_state', 'dispatched')
    .eq('status', 'pending')
    .lt('created_at', twoHoursAgo.toISOString())
    .limit(20);

  if (dispatchedPayments && dispatchedPayments.length > 0) {
    for (const dp of dispatchedPayments) {
      try {
        const meta = (dp.metadata || {}) as Record<string, string>;
        const clientRef = meta.reference_code || dp.gateway_reference;
        const paymentAge = Date.now() - new Date(dp.created_at as string).getTime();

        if (dp.gateway === 'paystack') {
          // Paystack: verify by client reference (provider echoes it). Recover checkout URL.
          const paystackKey = process.env.PAYSTACK_SECRET_KEY;
          if (paystackKey) {
            const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(clientRef)}`, {
              headers: { Authorization: `Bearer ${paystackKey}` },
              signal: AbortSignal.timeout(15000),
            });
            const data = await res.json();
            if (data?.data?.status === 'success') {
              // Provider charged — CAS to provider_confirmed + reconcile
              await supabase.from('payments')
                .update({ provider_init_state: 'provider_confirmed' })
                .eq('id', dp.id).eq('provider_init_state', 'dispatched');
              const { reconcilePayment: rp } = await import('@/lib/payments/reconcile');
              await rp(supabase, dp.id, 'cron');
            } else if (data?.data?.authorization_url) {
              // Provider has the transaction but not yet paid — CAS confirm with URL
              await supabase.from('payments')
                .update({ provider_init_state: 'provider_confirmed', metadata: { ...meta, checkout_url: data.data.authorization_url } })
                .eq('id', dp.id).eq('provider_init_state', 'dispatched');
            }
            // else: not found at provider — safe to leave dispatched for retry or terminal
          }
        } else if (dp.gateway === 'flutterwave') {
          // Flutterwave: verify by tx_ref
          const fwKey = process.env.FLUTTERWAVE_SECRET_KEY;
          if (fwKey) {
            const res = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(clientRef)}`, {
              headers: { Authorization: `Bearer ${fwKey}` },
              signal: AbortSignal.timeout(15000),
            });
            const data = await res.json();
            if (data?.data?.status === 'successful') {
              await supabase.from('payments')
                .update({ provider_init_state: 'provider_confirmed' })
                .eq('id', dp.id).eq('provider_init_state', 'dispatched');
              const { reconcilePayment: rp } = await import('@/lib/payments/reconcile');
              await rp(supabase, dp.id, 'cron');
            } else if (data?.data?.link) {
              await supabase.from('payments')
                .update({ provider_init_state: 'provider_confirmed', metadata: { ...meta, checkout_url: data.data.link } })
                .eq('id', dp.id).eq('provider_init_state', 'dispatched');
            }
          }
        } else if (dp.gateway === 'stripe') {
          // Stripe: re-POST with same idempotency key (within 24h window)
          const stripeKey = process.env.STRIPE_SECRET_KEY;
          if (stripeKey && paymentAge < 24 * 60 * 60 * 1000) {
            // Stripe idempotency key = `checkout_${referenceCode}`
            const idempotencyKey = `checkout_${clientRef}`;
            const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${stripeKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Idempotency-Key': idempotencyKey,
              },
              // Stripe returns the cached session for same idempotency key
              body: '', // empty body — Stripe returns cached response
              signal: AbortSignal.timeout(15000),
            });
            if (res.ok) {
              const session = await res.json();
              if (session.id && session.url) {
                await supabase.from('payments')
                  .update({ gateway_reference: session.id, provider_init_state: 'provider_confirmed', metadata: { ...meta, checkout_url: session.url, stripe_session_id: session.id } })
                  .eq('id', dp.id).eq('provider_init_state', 'dispatched');
              }
            }
            // else: idempotency key expired or error — leave for webhook recovery
          }
          // After 24h: only webhook can recover (Stripe purges idempotency keys)
        } else if (dp.gateway === 'square') {
          // Square: re-POST with same idempotency key
          const squareToken = process.env.SQUARE_ACCESS_TOKEN;
          if (squareToken) {
            const res = await fetch(`${process.env.SQUARE_ENV === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'}/v2/online-checkout/payment-links`, {
              method: 'POST',
              headers: { 'Square-Version': '2024-12-18', Authorization: `Bearer ${squareToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ idempotency_key: clientRef, quick_pay: { name: 'Recovery', price_money: { amount: Math.round(dp.amount * 100), currency: dp.currency }, location_id: process.env.SQUARE_LOCATION_ID || '' } }),
              signal: AbortSignal.timeout(15000),
            });
            if (res.ok) {
              const data = await res.json();
              const link = data.payment_link;
              if (link?.id && link?.url) {
                await supabase.from('payments')
                  .update({ provider_init_state: 'provider_confirmed', metadata: { ...meta, checkout_url: link.url, square_order_id: link.order_id } })
                  .eq('id', dp.id).eq('provider_init_state', 'dispatched');
              }
            }
          }
        } else if (dp.gateway === 'paypal') {
          // PayPal: re-POST with same PayPal-Request-Id
          const ppClientId = process.env.PAYPAL_CLIENT_ID;
          const ppSecret = process.env.PAYPAL_CLIENT_SECRET;
          if (ppClientId && ppSecret) {
            // Get access token
            const tokenRes = await fetch(`${process.env.PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'}/v1/oauth2/token`, {
              method: 'POST',
              headers: { Authorization: `Basic ${Buffer.from(`${ppClientId}:${ppSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'grant_type=client_credentials',
              signal: AbortSignal.timeout(15000),
            });
            if (tokenRes.ok) {
              const { access_token } = await tokenRes.json();
              const orderRes = await fetch(`${process.env.PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'}/v2/checkout/orders`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': clientRef },
                body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ reference_id: clientRef, amount: { currency_code: dp.currency, value: dp.amount.toFixed(2) } }] }),
                signal: AbortSignal.timeout(15000),
              });
              if (orderRes.ok) {
                const order = await orderRes.json();
                if (order.id) {
                  const links = (order.links || []) as Array<{ rel: string; href: string }>;
                  const approveUrl = links.find((l: { rel: string }) => l.rel === 'payer-action')?.href || links.find((l: { rel: string }) => l.rel === 'approve')?.href;
                  await supabase.from('payments')
                    .update({ gateway_reference: order.id, provider_init_state: 'provider_confirmed', metadata: { ...meta, checkout_url: approveUrl, paypal_order_id: order.id } })
                    .eq('id', dp.id).eq('provider_init_state', 'dispatched');
                }
              }
            }
          }
        }

        // Terminal: payments older than 24h that are still dispatched after recovery attempt
        if (paymentAge > 24 * 60 * 60 * 1000) {
          const { data: stillDispatched } = await supabase.from('payments')
            .select('provider_init_state').eq('id', dp.id).single();
          if (stillDispatched?.provider_init_state === 'dispatched') {
            await supabase.from('payments')
              .update({ status: 'failed', gateway_status: 'dispatched_unrecoverable' })
              .eq('id', dp.id).eq('provider_init_state', 'dispatched');
          }
        }
      } catch (recoveryErr) {
        logger.error('[CRON] V1 dispatched recovery error', { paymentId: dp.id, error: String(recoveryErr) });
      }
    }
  }

  let reconciled = 0;
  let markedFailed = 0;
  let errors = 0;

  const { reconcilePayment } = await import('@/lib/payments/reconcile');

  for (const payment of stalePayments) {
    try {
      // Use canonical reconciliation (provider adapter + Payment Authority)
      const result = await reconcilePayment(supabase, payment.id, 'cron');

      if (result.lifecycle?.status === 'completed' || result.lifecycle?.status === 'already_completed') {
        reconciled++;
        logger.info(`[PAYMENT-RECONCILIATION] Reconciled payment ${payment.id} (${payment.gateway})`);
      } else if (result.providerOutcome === 'not_paid') {
        // Generic not_paid is NOT proof of terminal failure.
        // Leave as pending — provider may still be processing, or the check was ambiguous.
        // Do NOT destructively mark as failed from ambiguous provider state.
        logger.info(`[PAYMENT-RECONCILIATION] Payment ${payment.id} not confirmed by provider — leaving for next cycle`);
      } else if (result.providerOutcome === 'retryable_error' || result.providerOutcome === 'config_error') {
        // Transient/config error — leave for next cycle, do not mark failed
        logger.info(`[PAYMENT-RECONCILIATION] Payment ${payment.id} provider ${result.providerOutcome} — leaving for next cycle`);
      }
      // retryable/config errors: leave payment for next cron cycle
    } catch (err) {
      errors++;
      logger.error(`[PAYMENT-RECONCILIATION] Error reconciling payment ${payment.id}:`, err);
      Sentry.captureException(err, {
        tags: { component: 'payment-reconciliation', gateway: payment.gateway },
        extra: { paymentId: payment.id, reference: payment.gateway_reference },
      });
    }
  }

  cron.completed({
    processedCount: stalePayments.length,
    successCount: reconciled,
    failureCount: markedFailed + errors,
    skippedCount: stalePayments.length - reconciled - markedFailed - errors,
  });

  return NextResponse.json({
    ok: true,
    total: stalePayments.length,
    reconciled,
    markedFailed,
    errors,
  });
  } catch (error) {
    cron.failed(error);
    throw error; // Preserve existing propagation behavior
  }
}

type GatewayVerifyResult = 'paid' | 'pending' | 'failed' | 'expired';

async function verifyWithGateway(
  gateway: string,
  reference: string,
): Promise<GatewayVerifyResult> {
  if (gateway === 'stripe') {
    return verifyStripePayment(reference);
  }
  if (gateway === 'paystack') {
    return verifyPaystackPayment(reference);
  }
  return 'pending'; // Unknown gateway — leave as-is
}

async function verifyStripePayment(reference: string): Promise<GatewayVerifyResult> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return 'pending'; // Can't verify without key

  // Determine if reference is a checkout session (cs_) or payment intent (pi_)
  const isSession = reference.startsWith('cs_');
  const endpoint = isSession
    ? `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(reference)}`
    : `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(reference)}`;

  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${stripeKey}` },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    // If 404, the session/intent doesn't exist — treat as failed
    if (response.status === 404) return 'failed';
    throw new Error(`Stripe API error: ${response.status}`);
  }

  const data = await response.json();

  if (isSession) {
    // Checkout session statuses
    if (data.payment_status === 'paid') return 'paid';
    if (data.status === 'expired') return 'expired';
    return 'pending';
  } else {
    // Payment intent statuses
    if (data.status === 'succeeded') return 'paid';
    if (data.status === 'canceled') return 'failed';
    if (data.status === 'requires_payment_method') return 'failed';
    return 'pending';
  }
}

async function verifyPaystackPayment(reference: string): Promise<GatewayVerifyResult> {
  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackKey) return 'pending'; // Can't verify without key

  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: { Authorization: `Bearer ${paystackKey}` },
      signal: AbortSignal.timeout(15000),
    },
  );

  if (!response.ok) {
    if (response.status === 404) return 'failed';
    throw new Error(`Paystack API error: ${response.status}`);
  }

  const data = await response.json();
  const status = data?.data?.status;

  if (status === 'success') return 'paid';
  if (status === 'failed' || status === 'abandoned') return 'failed';
  if (status === 'reversed') return 'failed';
  return 'pending';
}
