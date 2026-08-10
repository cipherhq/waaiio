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
