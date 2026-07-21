import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { processSuccessfulPayment } from '@/lib/payments/process-success';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';
import { logger } from '@/lib/logger';

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

  const supabase = createServiceClient();

  const twoHoursAgo = new Date();
  twoHoursAgo.setHours(twoHoursAgo.getHours() - 2);

  // Find stale pending payments (only Stripe and Paystack — we can verify those)
  const { data: stalePayments, error: queryError } = await supabase
    .from('payments')
    .select('id, amount, gateway, gateway_reference, booking_id, invoice_id, campaign_id, order_id, metadata, collection_mode')
    .eq('status', 'pending')
    .lt('created_at', twoHoursAgo.toISOString())
    .in('gateway', ['stripe', 'paystack'])
    .limit(50); // Process in batches to stay within maxDuration

  if (queryError) {
    logger.error('[PAYMENT-RECONCILIATION] Query error:', queryError);
    return NextResponse.json({ ok: false, error: 'Query failed' }, { status: 500 });
  }

  if (!stalePayments || stalePayments.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  let reconciled = 0;
  let markedFailed = 0;
  let errors = 0;

  for (const payment of stalePayments) {
    try {
      const gatewayStatus = await verifyWithGateway(payment.gateway, payment.gateway_reference);

      if (gatewayStatus === 'paid') {
        // Gateway says paid — update status and run post-payment pipeline
        await supabase
          .from('payments')
          .update({
            status: 'success',
            gateway_status: 'reconciled',
            paid_at: new Date().toISOString(),
          })
          .eq('id', payment.id)
          .eq('status', 'pending'); // Only update if still pending (idempotent)

        await processSuccessfulPayment(supabase, {
          id: payment.id,
          amount: payment.amount,
          booking_id: payment.booking_id,
          invoice_id: payment.invoice_id,
          campaign_id: payment.campaign_id,
          order_id: payment.order_id,
          metadata: payment.metadata as Record<string, unknown> | null,
          collection_mode: (payment.collection_mode as string) || undefined,
        });

        try {
          await sendProactiveConfirmation(supabase, {
            id: payment.id,
            amount: payment.amount,
            booking_id: payment.booking_id,
            invoice_id: payment.invoice_id,
            campaign_id: payment.campaign_id,
          }, '[RECONCILIATION]');
        } catch (confirmErr) {
          logger.error('[PAYMENT-RECONCILIATION] Confirmation error:', confirmErr);
        }

        reconciled++;
        logger.info(`[PAYMENT-RECONCILIATION] Reconciled payment ${payment.id} (${payment.gateway})`);
      } else if (gatewayStatus === 'failed' || gatewayStatus === 'expired') {
        // Gateway says failed/expired — mark as failed
        await supabase
          .from('payments')
          .update({
            status: 'failed',
            gateway_status: gatewayStatus,
          })
          .eq('id', payment.id)
          .eq('status', 'pending');

        markedFailed++;
        logger.info(`[PAYMENT-RECONCILIATION] Marked payment ${payment.id} as ${gatewayStatus}`);
      }
      // If gatewayStatus === 'pending', leave it alone — gateway is still processing
    } catch (err) {
      errors++;
      logger.error(`[PAYMENT-RECONCILIATION] Error reconciling payment ${payment.id}:`, err);
      Sentry.captureException(err, {
        tags: { component: 'payment-reconciliation', gateway: payment.gateway },
        extra: { paymentId: payment.id, reference: payment.gateway_reference },
      });
    }
  }

  return NextResponse.json({
    ok: true,
    total: stalePayments.length,
    reconciled,
    markedFailed,
    errors,
  });
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
