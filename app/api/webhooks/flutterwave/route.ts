import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual, createHmac } from 'crypto';
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

/**
 * Verify Flutterwave webhook signature.
 * Supports both:
 * - Current: HMAC-SHA256 via `flutterwave-signature` header (hashed raw body)
 * - Legacy: Direct `verif-hash` header comparison against dashboard secret
 *
 * Returns true if either method validates successfully.
 */
function verifyFlutterwaveSignature(
  rawBody: string,
  headers: { verifHash?: string; flutterwaveSignature?: string },
  secretHash: string,
): boolean {
  // Current method: HMAC-SHA256 flutterwave-signature
  if (headers.flutterwaveSignature) {
    const computed = createHmac('sha256', secretHash).update(rawBody).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(computed), Buffer.from(headers.flutterwaveSignature));
    } catch {
      return false;
    }
  }
  // Legacy method: direct verif-hash comparison
  if (headers.verifHash) {
    try {
      return timingSafeEqual(Buffer.from(headers.verifHash), Buffer.from(secretHash));
    } catch {
      return false;
    }
  }
  return false;
}

export async function POST(request: NextRequest) {
  const wh = createWebhookLogger('flutterwave', getRequestId(request));
  const startTime = performance.now();
  try {
    if (!FLUTTERWAVE_SECRET_HASH) {
      wh.rejected('Webhook secret not configured');
      return NextResponse.json({ message: 'Webhook not configured' }, { status: 500 });
    }

    // Read raw body for HMAC signature verification
    const rawBody = await request.text();
    const verifHash = request.headers.get('verif-hash') || '';
    const flutterwaveSignature = request.headers.get('flutterwave-signature') || '';

    if (!verifyFlutterwaveSignature(rawBody, { verifHash, flutterwaveSignature }, FLUTTERWAVE_SECRET_HASH)) {
      wh.rejected('Invalid signature');
      return NextResponse.json({ message: 'Invalid signature' }, { status: 401 });
    }

    wh.verified();

    const body = JSON.parse(rawBody);
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
          const { error: cancelErr } = await supabase.rpc('finalize_subscription_cancellation', {
            p_subscription_id: matchingSubs[0].id,
            p_provider_event_id: cancelEventId,
            p_reason: 'provider_cancelled',
          });
          if (cancelErr) {
            logger.error('[FLW-WEBHOOK] Cancellation RPC failed', { subId: matchingSubs[0].id, error: cancelErr });
            return NextResponse.json({ error: 'Cancellation failed' }, { status: 500 });
          }
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
    const flwKey = process.env.FLUTTERWAVE_SECRET_KEY || '';
    const { verifyTransactionById } = await import('@/lib/payments/flutterwave-verify');

    // Initial checkout charges use tx_ref starting with 'waaiiosub'
    if (txRef.startsWith('waaiiosub')) {
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
          const webhookTxId = data.id as number;
          if (!webhookTxId) {
            return NextResponse.json({ error: 'Missing transaction ID' }, { status: 500 });
          }

          // Verify transaction by exact provider ID before granting value
          const verifyResult = await verifyTransactionById(webhookTxId, txRef, flwKey);
          if (!verifyResult.ok) {
            wh.failed(new Error(`Transaction verification failed: ${verifyResult.reason}`));
            return NextResponse.json({ error: 'Transaction verification failed' }, { status: 500 });
          }

          const { tx: verified } = verifyResult;
          if (verified.status !== 'successful') {
            wh.ignored(`Verified tx status: ${verified.status}`);
            return NextResponse.json({ message: 'Transaction not successful' }, { status: 200 });
          }

          // Validate amount/currency against intent
          const verifiedAmountMinor = Math.round(verified.amount * 100);
          if (verifiedAmountMinor !== intent.amount * 100) {
            wh.failed(new Error(`Amount mismatch: verified=${verifiedAmountMinor} expected=${intent.amount * 100}`));
            return NextResponse.json({ error: 'Amount mismatch' }, { status: 500 });
          }
          if (verified.currency !== intent.currency.toUpperCase()) {
            wh.failed(new Error(`Currency mismatch: verified=${verified.currency} expected=${intent.currency}`));
            return NextResponse.json({ error: 'Currency mismatch' }, { status: 500 });
          }

          // Resolve subscription — fail closed if unavailable
          let providerSubId = '';
          let providerPlanId = 0;
          try {
            const subLookup = await fetch(
              `https://api.flutterwave.com/v3/subscriptions?transaction_id=${verified.id}`,
              { headers: { 'Authorization': `Bearer ${flwKey}` }, signal: AbortSignal.timeout(10000) },
            );
            const subData = await subLookup.json() as { data?: { id: number; plan: number }[] };
            if (subData.data?.length) {
              providerSubId = String(subData.data[0].id);
              providerPlanId = subData.data[0].plan;
            }
          } catch { /* handled below */ }

          if (!providerSubId) {
            // Subscription correlation unavailable — fail closed, Flutterwave retries
            wh.failed(new Error('Subscription lookup unavailable'));
            return NextResponse.json({ error: 'Subscription lookup unavailable' }, { status: 500 });
          }

          // Call authoritative finalizer
          const { data: finResult, error: finErr } = await supabase.rpc('finalize_flutterwave_subscription_checkout', {
            p_intent_id: intent.id,
            p_provider_tx_id: String(verified.id),
            p_provider_subscription_id: providerSubId,
            p_provider_plan_id: providerPlanId,
            p_verified_amount_minor: verifiedAmountMinor,
            p_verified_currency: verified.currency,
            p_provider_paid_at: verified.created_at, // verified provider timestamp only
          });

          if (finErr) {
            wh.failed(finErr, { durationMs: Math.round(performance.now() - startTime) });
            return NextResponse.json({ error: finErr.message }, { status: 500 });
          }

          // Inspect structured result — finalized !== true is not success
          const result = finResult as Record<string, unknown> | null;
          if (!result || result.finalized !== true) {
            if (result?.quarantine) {
              logger.error('[FLW-WEBHOOK] Checkout finalization quarantined', { intentId: intent.id, result });
            }
            wh.failed(new Error(`Finalization not successful: ${JSON.stringify(result)}`));
            return NextResponse.json({ error: 'Finalization conflict' }, { status: 500 });
          }

          wh.processed({ durationMs: Math.round(performance.now() - startTime) });
          return NextResponse.json({ message: 'Subscription activated' }, { status: 200 });
        }

        // Intent is failed/superseded — late webhook for terminal intent
        if (intent.status === 'failed' || intent.status === 'superseded') {
          // Provider-verify the late success before quarantining
          const webhookTxId = data.id as number;
          if (webhookTxId && data.status === 'successful') {
            const lateVerify = await verifyTransactionById(webhookTxId, txRef, flwKey);
            if (lateVerify.ok && lateVerify.tx.status === 'successful') {
              const { error: qErr } = await supabase.from('subscription_payment_quarantine').insert({
                intent_id: intent.id,
                provider_tx_ref: txRef,
                provider_tx_id: String(lateVerify.tx.id),
                provider_amount: Math.round(lateVerify.tx.amount * 100),
                provider_currency: lateVerify.tx.currency,
                provider_status: 'verified_late_success',
                reason: 'late_webhook_for_terminal_intent',
              });
              if (qErr) {
                logger.error('[FLW-WEBHOOK] Quarantine write failed for late success', { intentId: intent.id, error: qErr });
                return NextResponse.json({ error: 'Quarantine failed' }, { status: 500 });
              }
              logger.error('[FLW-WEBHOOK] CRITICAL: Verified late success quarantined for reconciliation', {
                intentId: intent.id, txId: lateVerify.tx.id, amount: lateVerify.tx.amount,
              });
            }
          }
          wh.ignored(`Late webhook for ${intent.status} intent`);
          return NextResponse.json({ message: 'Intent terminal, quarantined' }, { status: 200 });
        }
      }
      // No intent match — fall through to renewal/business-payment check
    }

    // ── Flutterwave subscription renewal routing ──
    // For charges without waaiiosub prefix, check if they belong to a known subscription
    if (!txRef.startsWith('waaiiosub')) {
      const webhookTxId = data.id as number;
      if (webhookTxId) {
        try {
          const subLookup = await fetch(
            `https://api.flutterwave.com/v3/subscriptions?transaction_id=${webhookTxId}`,
            { headers: { 'Authorization': `Bearer ${flwKey}` }, signal: AbortSignal.timeout(10000) },
          );
          const subData = await subLookup.json() as { data?: { id: number }[] };
          if (subData.data?.length) {
            const flwSubId = String(subData.data[0].id);
            const { data: localSub } = await supabase
              .from('subscriptions')
              .select('id')
              .eq('flutterwave_subscription_id', flwSubId)
              .eq('gateway', 'flutterwave')
              .maybeSingle();

            if (localSub) {
              // Verify transaction before granting renewal value
              const renewVerify = await verifyTransactionById(webhookTxId, txRef, flwKey);
              if (!renewVerify.ok || renewVerify.tx.status !== 'successful') {
                wh.failed(new Error(`Renewal verification failed: ${!renewVerify.ok ? renewVerify.reason : renewVerify.tx.status}`));
                return NextResponse.json({ error: 'Renewal verification failed' }, { status: 500 });
              }

              const { tx: renewTx } = renewVerify;
              const { data: renewResult, error: renewErr } = await supabase.rpc('finalize_flutterwave_subscription_renewal', {
                p_subscription_id: localSub.id,
                p_provider_tx_id: String(renewTx.id),
                p_verified_amount_minor: Math.round(renewTx.amount * 100),
                p_verified_currency: renewTx.currency,
                p_provider_paid_at: renewTx.created_at, // verified provider timestamp
              });

              if (renewErr) {
                wh.failed(renewErr, { durationMs: Math.round(performance.now() - startTime) });
                return NextResponse.json({ error: renewErr.message }, { status: 500 });
              }

              // Inspect structured result
              const rResult = renewResult as Record<string, unknown> | null;
              if (rResult && rResult.finalized !== true) {
                if (rResult.quarantine) {
                  logger.error('[FLW-WEBHOOK] Renewal quarantined', { subId: localSub.id, result: rResult });
                }
                // Quarantine persisted but no entitlement granted — acknowledge safely
                return NextResponse.json({ message: 'Renewal quarantined for reconciliation' }, { status: 200 });
              }

              wh.processed({ durationMs: Math.round(performance.now() - startTime) });
              return NextResponse.json({ message: 'Subscription renewed' }, { status: 200 });
            }
          }
        } catch {
          // Subscription lookup failed — fall through to business-payment path
        }
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

