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

    // Platform subscription cancellation event
    if (event === 'subscription.cancelled' && data) {
      const supabase = createServiceClient();
      const cancelPlanId = data.plan?.id as number | undefined;
      const cancelEmail = data.customer?.email as string | undefined;
      if (cancelPlanId && cancelEmail) {
        // Correlate via stored flutterwave_plan_id + flutterwave_subscriber_email
        const { data: matchingSubs } = await supabase
          .from('subscriptions')
          .select('id')
          .eq('gateway', 'flutterwave')
          .eq('status', 'active')
          .eq('flutterwave_plan_id', cancelPlanId)
          .eq('flutterwave_subscriber_email', cancelEmail);

        if (matchingSubs?.length === 1) {
          const cancelEventId = `flw-cancel-${cancelPlanId}-${Date.now()}`;
          await supabase.rpc('finalize_subscription_cancellation', {
            p_subscription_id: matchingSubs[0].id,
            p_provider_event_id: cancelEventId,
            p_reason: 'provider_cancelled',
          });
          wh.processed({ durationMs: Math.round(performance.now() - startTime) });
          return NextResponse.json({ message: 'Subscription cancelled' }, { status: 200 });
        }
        // 0 or >1 matches — fail closed, alert
        wh.ignored(`Ambiguous subscription.cancelled: plan_id=${cancelPlanId} matches=${matchingSubs?.length || 0}`);
      }
      return NextResponse.json({ message: 'Processed' }, { status: 200 });
    }

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

    // ── Platform subscription routing (M378) ──
    // Checkout intents use tx_ref starting with 'waaiiosub'
    if (txRef.startsWith('waaiiosub')) {
      // Platform subscription initial charge — correlate via durable intent
      const { data: intent } = await supabase
        .from('subscription_checkout_intents')
        .select('id, status, business_id, plan, amount, currency, idempotency_key, config_version_id, subscriber_email')
        .eq('idempotency_key', txRef)
        .maybeSingle();

      if (intent) {
        if (intent.status === 'completed') {
          wh.duplicate({ webhookEventId: `flw-sub-${txRef}` });
          return NextResponse.json({ message: 'Already finalized' }, { status: 200 });
        }
        if (intent.status === 'pending') {
          const providerTxId = String(data.id || '');
          const providerAmount = Math.round((data.amount as number) * 100); // → minor units
          const providerCurrency = ((data.currency as string) || '').toUpperCase();
          const providerPaidAt = data.created_at as string || new Date().toISOString();

          // Resolve Flutterwave subscription ID via documented lookup
          let providerSubId = '';
          let providerPlanId = 0;
          try {
            const subLookup = await fetch(
              `https://api.flutterwave.com/v3/subscriptions?transaction_id=${data.id}`,
              { headers: { 'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }, signal: AbortSignal.timeout(10000) },
            );
            const subData = await subLookup.json() as { data?: { id: number; plan: number }[] };
            if (subData.data?.length) {
              providerSubId = String(subData.data[0].id);
              providerPlanId = subData.data[0].plan;
            }
          } catch { /* subscription lookup failure is non-fatal */ }

          const { data: result, error: finErr } = await supabase.rpc('finalize_flutterwave_subscription_checkout', {
            p_intent_id: intent.id,
            p_provider_tx_id: providerTxId,
            p_provider_subscription_id: providerSubId,
            p_provider_plan_id: providerPlanId,
            p_verified_amount_minor: providerAmount,
            p_verified_currency: providerCurrency,
            p_provider_paid_at: providerPaidAt,
          });

          if (finErr) {
            wh.failed(finErr, { durationMs: Math.round(performance.now() - startTime) });
            // Return 500 for subscription events so Flutterwave retries
            return NextResponse.json({ error: finErr.message }, { status: 500 });
          }

          wh.processed({ durationMs: Math.round(performance.now() - startTime) });
          return NextResponse.json({ message: 'Subscription activated' }, { status: 200 });
        }
        // Intent is failed/superseded — late webhook for terminal intent
        if (intent.status === 'failed' || intent.status === 'superseded') {
          // Quarantine: do not silently lose a captured payment
          if (data.status === 'successful') {
            await supabase.from('subscription_payment_quarantine').insert({
              intent_id: intent.id,
              provider_tx_ref: txRef,
              provider_tx_id: String(data.id || ''),
              provider_amount: Math.round((data.amount as number) * 100),
              provider_currency: ((data.currency as string) || '').toUpperCase(),
              provider_status: 'late_success_for_terminal_intent',
              reason: 'late_webhook_for_terminal_intent',
            });
          }
          wh.ignored(`Late webhook for ${intent.status} intent`);
          return NextResponse.json({ message: 'Intent terminal, quarantined' }, { status: 200 });
        }
      }

      // No intent match for waaiiosub prefix — could be a renewal from Flutterwave auto-charge
      // Renewals don't have our tx_ref — they're generated by Flutterwave
      // Fall through to check if it's a known subscription renewal
    }

    // ── Flutterwave subscription renewal routing ──
    // For non-waaiiosub tx_refs, check if this is a subscription renewal
    // by looking up the Flutterwave subscription via transaction_id
    if (!txRef.startsWith('waaiiosub')) {
      // Check if this transaction belongs to a known Flutterwave subscription
      try {
        const subLookup = await fetch(
          `https://api.flutterwave.com/v3/subscriptions?transaction_id=${data.id}`,
          { headers: { 'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }, signal: AbortSignal.timeout(10000) },
        );
        const subData = await subLookup.json() as { data?: { id: number }[] };
        if (subData.data?.length) {
          const flwSubId = String(subData.data[0].id);
          // Look up local subscription by flutterwave_subscription_id
          const { data: localSub } = await supabase
            .from('subscriptions')
            .select('id')
            .eq('flutterwave_subscription_id', flwSubId)
            .eq('gateway', 'flutterwave')
            .maybeSingle();

          if (localSub) {
            // This is a renewal for a known platform subscription
            const providerAmount = Math.round((data.amount as number) * 100);
            const providerCurrency = ((data.currency as string) || '').toUpperCase();
            const providerPaidAt = data.created_at as string || new Date().toISOString();

            const { error: renewErr } = await supabase.rpc('finalize_flutterwave_subscription_renewal', {
              p_subscription_id: localSub.id,
              p_provider_tx_id: String(data.id || ''),
              p_verified_amount_minor: providerAmount,
              p_verified_currency: providerCurrency,
              p_provider_paid_at: providerPaidAt,
            });

            if (renewErr) {
              wh.failed(renewErr, { durationMs: Math.round(performance.now() - startTime) });
              return NextResponse.json({ error: renewErr.message }, { status: 500 });
            }

            wh.processed({ durationMs: Math.round(performance.now() - startTime) });
            return NextResponse.json({ message: 'Subscription renewed' }, { status: 200 });
          }
        }
      } catch {
        // Subscription lookup failed — fall through to business-payment path
      }
    }

    // ── Existing business-payment path (preserved) ──

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
      wh.ignored('Payment not found');
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

    // Persist non-authoritative metadata — authority owns Stage 1 transition
    await supabase
      .from('payments')
      .update({
        payment_method: (data.payment_type as string) || 'card',
        card_last_four: data.card?.last_4digits || null,
        card_brand: data.card?.type || null,
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
    // Return 500 so Flutterwave retries — do not acknowledge with 200 on unhandled errors
    return NextResponse.json({ received: true }, { status: 500 });
  }
}

