import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/observability';
import { createWebhookLogger } from '@/lib/observability/webhooks';
import { createAlert } from '@/lib/alerts/create-alert';
import { processSuccessfulPayment } from '@/lib/payments/process-success';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';
export const maxDuration = 60;

const FLUTTERWAVE_SECRET_HASH = process.env.FLUTTERWAVE_WEBHOOK_HASH || '';

export async function POST(request: NextRequest) {
  const wh = createWebhookLogger('flutterwave', getRequestId(request));
  const startTime = performance.now();
  try {
    // Validate webhook signature (timing-safe)
    const verifHash = request.headers.get('verif-hash') || '';
    if (!FLUTTERWAVE_SECRET_HASH) {
      wh.rejected('Webhook secret not configured');
      return NextResponse.json({ message: 'Webhook not configured' }, { status: 500 });
    }
    try {
      if (!verifHash || !timingSafeEqual(Buffer.from(verifHash), Buffer.from(FLUTTERWAVE_SECRET_HASH))) {
        wh.rejected('Invalid hash');
        return NextResponse.json({ message: 'Invalid hash' }, { status: 401 });
      }
    } catch {
      wh.rejected('Hash comparison failed');
      return NextResponse.json({ message: 'Invalid hash' }, { status: 401 });
    }

    wh.verified();

    const body = await request.json();
    const event = body.event;
    const data = body.data;

    if (event !== 'charge.completed' || !data) {
      wh.ignored(`Unhandled event: ${event || 'unknown'}`);
      return NextResponse.json({ message: 'Ignored' }, { status: 200 });
    }

    if (data.status !== 'successful') {
      // Alert on non-successful Flutterwave charges
      const txRef = data.tx_ref as string;
      if (txRef) {
        const flwSupabase = createServiceClient();
        const { data: failedPayment } = await flwSupabase
          .from('payments')
          .select('id, amount, business_id')
          .eq('gateway_reference', txRef)
          .maybeSingle();

        if (failedPayment?.business_id) {
          await createAlert(flwSupabase, {
            businessId: failedPayment.business_id,
            type: 'payment_failed',
            severity: 'warning',
            title: 'Payment Failed',
            message: `A Flutterwave payment of ${failedPayment.amount} was not successful (status: ${data.status}).`,
            metadata: { paymentId: failedPayment.id, amount: failedPayment.amount, gateway: 'flutterwave', status: data.status },
          });
        }
      }
      return NextResponse.json({ message: 'Payment not successful' }, { status: 200 });
    }

    const txRef = data.tx_ref as string;
    wh.received({ gateway: 'flutterwave', eventType: event, providerRef: txRef || undefined });

    if (!txRef) {
      wh.ignored('Missing tx_ref');
      return NextResponse.json({ message: 'Missing tx_ref' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Idempotency: check if already processed (mark AFTER processing succeeds)
    const eventId = `flw-${txRef}`;
    const { data: existingEvent } = await supabase
      .from('processed_webhook_events')
      .select('id')
      .eq('event_id', eventId)
      .maybeSingle();

    if (existingEvent) {
      wh.duplicate({ webhookEventId: eventId });
      return NextResponse.json({ message: 'Already processed' }, { status: 200 });
    }

    // Find the payment record
    const { data: payment } = await supabase
      .from('payments')
      .select('id, booking_id, amount, reservation_id, order_id, status, gateway_reference, payment_authority_version, finalization_completed_at')
      .eq('gateway_reference', txRef)
      .single();

    if (!payment) {
      // Waaiio manages Flutterwave recurring via token billing (cron-initiated).
      // No provider-side subscription exists, so no provider-generated renewals.
      // Unknown tx_ref without a pre-existing payment → ignore safely.
      wh.ignored('Payment not found (no Flutterwave provider subscriptions)');
      return NextResponse.json({ message: 'Payment not found' }, { status: 404 });
    }

    // Skip if fully finalized (Stage 2 complete). New-authority success with incomplete Stage 2 must resume.
    if (payment.status === 'success' && (payment.payment_authority_version !== 1 || payment.finalization_completed_at)) {
      wh.duplicate({ webhookEventId: eventId, paymentId: payment.id });
      return NextResponse.json({ message: 'Already processed' }, { status: 200 });
    }

    // Verify amount matches
    const webhookAmount = data.amount as number;
    if (Math.abs(webhookAmount - payment.amount) > 0.01) {
      await supabase.from('payments').update({ status: 'failed', gateway_status: 'amount_mismatch' }).eq('id', payment.id);
      return NextResponse.json({ message: 'Amount mismatch' }, { status: 400 });
    }

    // Update payment status
    await supabase
      .from('payments')
      .update({
        status: 'success',
        gateway_status: 'successful',
        payment_method: (data.payment_type as string) || 'card',
        card_last_four: data.card?.last_4digits || null,
        card_brand: data.card?.type || null,
        paid_at: new Date().toISOString(),
      })
      .eq('id', payment.id);

    // Fetch invoice_id and campaign_id (not on the initial select)
    const { data: fullPayment } = await supabase
      .from('payments')
      .select('invoice_id, campaign_id, reservation_id, order_id')
      .eq('id', payment.id)
      .single();

    // Extract Flutterwave processing fee (data.app_fee is in major units)
    let flutterwaveGatewayFee = 0;
    try {
      flutterwaveGatewayFee = Math.round(Number(data.app_fee || 0) * 100) / 100;
    } catch {
      logger.warn('[FLUTTERWAVE WEBHOOK] Failed to extract gateway fee from app_fee');
    }

    const paymentForShared = {
      id: payment.id,
      amount: payment.amount,
      booking_id: payment.booking_id,
      invoice_id: fullPayment?.invoice_id || null,
      campaign_id: fullPayment?.campaign_id || null,
      reservation_id: fullPayment?.reservation_id || payment.reservation_id || null,
      order_id: fullPayment?.order_id || payment.order_id || null,
      gateway_fee: flutterwaveGatewayFee,
    };

    // ── Canonical Payment Authority ──
    const { reconcilePayment } = await import('@/lib/payments/reconcile');
    await reconcilePayment(supabase, payment.id, 'webhook', {
      status: 'verified',
      result: {
        provider: 'flutterwave', waaiioReference: payment.gateway_reference,
        providerTransactionId: String(data.id || ''),
        amount: data.amount as number,
        currency: ((data.currency as string) || '').toUpperCase(),
        paymentMethod: (data.payment_type as string) || 'card',
        gatewayFee: flutterwaveGatewayFee,
        providerStatus: 'successful', verifiedAt: new Date().toISOString(),
      },
    });

    // Mark event as processed AFTER all financial writes succeeded
    await supabase
      .from('processed_webhook_events')
      .upsert(
        { event_id: eventId, gateway: 'flutterwave', event_type: 'charge.completed', processed_at: new Date().toISOString() },
        { onConflict: 'event_id', ignoreDuplicates: true },
      );

    wh.processed({ durationMs: Math.round(performance.now() - startTime) });
    return NextResponse.json({ message: 'OK' }, { status: 200 });
  } catch (error) {
    wh.failed(error, { durationMs: Math.round(performance.now() - startTime) });
    Sentry.captureException(error);
    // Acknowledge receipt to prevent infinite retries, but don't mark as processed
    // so retries will reprocess the event
    return NextResponse.json({ received: true }, { status: 200 });
  }
}

