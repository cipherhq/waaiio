import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/observability';
import { createWebhookLogger } from '@/lib/observability/webhooks';
import { createAlert } from '@/lib/alerts/create-alert';
import { processSuccessfulPayment } from '@/lib/payments/process-success';
import { sendProactiveConfirmation } from '@/lib/payments/send-confirmation';
export const maxDuration = 60;

import { verifyFlutterwaveSignature } from '@/lib/payments/flutterwave-signature';
import { correlateProviderSubscription, correlateProviderSubscriptionExhaustive, verifySubscriptionStatus } from '@/lib/payments/flutterwave-subscription';
import { decideCancellation, decideFinalizerResult, decideSubscriptionCorrelation, decideChargeRouting } from '@/lib/payments/flutterwave-decisions';

const FLUTTERWAVE_SECRET_HASH = process.env.FLUTTERWAVE_WEBHOOK_HASH || '';

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
      const flwKey = process.env.FLUTTERWAVE_SECRET_KEY || '';
      const cancelPlanId = data.plan?.id as number | undefined;
      const cancelEmail = data.customer?.email as string | undefined;
      // Use provider webhook/event ID when present (Blocker A)
      const webhookEventId = (body.id || body.event_id) as string | undefined;

      if (!cancelPlanId || !cancelEmail) {
        await supabase.from('subscription_payment_quarantine').insert({
          provider_tx_ref: `cancel-unknown-${Date.now()}`,
          provider_status: 'missing_cancellation_identity',
          reason: `subscription.cancelled missing plan_id=${cancelPlanId} email=${cancelEmail}`,
        }).then(({ error: qErr }) => {
          if (qErr) logger.error('[FLW-WEBHOOK] Quarantine write failed', { error: qErr });
        });
        return NextResponse.json({ error: 'Missing cancellation identifiers' }, { status: 500 });
      }

      // Correlate by stored flutterwave_plan_id + flutterwave_subscriber_email
      const { data: matchingSubs, error: matchErr } = await supabase
        .from('subscriptions')
        .select('id, status, flutterwave_subscription_id')
        .eq('gateway', 'flutterwave')
        .eq('flutterwave_plan_id', cancelPlanId)
        .eq('flutterwave_subscriber_email', cancelEmail);

      if (matchErr) {
        logger.error('[FLW-WEBHOOK] Cancellation DB lookup error', { error: matchErr });
        return NextResponse.json({ error: 'Cancellation lookup failed' }, { status: 500 });
      }

      if (!matchingSubs || matchingSubs.length !== 1) {
        const { error: qWriteErr } = await supabase.from('subscription_payment_quarantine').insert({
          provider_tx_ref: `cancel-${cancelPlanId}`,
          provider_status: matchingSubs?.length ? 'ambiguous_cancellation' : 'unmatched_cancellation',
          reason: `subscription.cancelled matched ${matchingSubs?.length || 0} for plan_id=${cancelPlanId} email=${cancelEmail}`,
        });
        if (qWriteErr) {
          logger.error('[FLW-WEBHOOK] CRITICAL: Cancellation quarantine write failed — no durable reconciliation evidence', {
            cancelPlanId, cancelEmail, matchCount: matchingSubs?.length || 0, error: qWriteErr,
          });
        }
        return NextResponse.json({ error: 'Cancellation correlation failed' }, { status: 500 });
      }

      const localSub = matchingSubs[0];

      // Provider state verification for cancellation decision
      let providerState: { ok: true; status: string } | { ok: false; reason: string } | null = null;
      if (localSub.status !== 'cancelled' && localSub.flutterwave_subscription_id) {
        providerState = await verifySubscriptionStatus(
          localSub.flutterwave_subscription_id, cancelEmail, flwKey, cancelPlanId,
        );
      }

      // Use production decision function (Blocker B)
      const cancelDecision = decideCancellation(
        localSub.status,
        !!localSub.flutterwave_subscription_id,
        providerState,
      );

      if (cancelDecision.action === 'already_cancelled') {
        wh.processed({ durationMs: Math.round(performance.now() - startTime) });
        return NextResponse.json({ message: 'Already cancelled' }, { status: 200 });
      }
      if (cancelDecision.action === 'stale_duplicate') {
        wh.ignored(`Stale cancellation: provider subscription is not cancelled`);
        return NextResponse.json({ message: 'Provider subscription not cancelled' }, { status: 200 });
      }
      if (cancelDecision.action === 'fail_closed') {
        const { error: qFailErr } = await supabase.from('subscription_payment_quarantine').insert({
          subscription_id: localSub.id,
          provider_tx_ref: `cancel-fail-${cancelPlanId}`,
          provider_status: cancelDecision.reason,
          reason: `Cancellation failed closed: ${cancelDecision.reason}`,
        });
        if (qFailErr) {
          logger.error('[FLW-WEBHOOK] CRITICAL: Cancellation fail_closed quarantine write failed — no durable reconciliation evidence', {
            subId: localSub.id, cancelPlanId, reason: cancelDecision.reason, error: qFailErr,
          });
        }
        return NextResponse.json({ error: `Cancellation verification failed: ${cancelDecision.reason}` }, { status: 500 });
      }
      // cancelDecision.action === 'cancel' — proceed

      // Provider confirmed cancelled — proceed with local cancellation
      const { error: cancelErr } = await supabase.rpc('finalize_subscription_cancellation', {
        p_subscription_id: localSub.id,
        p_provider_event_id: webhookEventId || null,
        p_reason: 'provider_cancelled',
      });
      if (cancelErr) {
        logger.error('[FLW-WEBHOOK] Cancellation RPC failed', { subId: localSub.id, error: cancelErr });
        return NextResponse.json({ error: 'Cancellation failed' }, { status: 500 });
      }
      wh.processed({ durationMs: Math.round(performance.now() - startTime) });
      return NextResponse.json({ message: 'Subscription cancelled' }, { status: 200 });
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

    // ── Routing decision using production decideChargeRouting (Blocker B) ──
    const flwKey = process.env.FLUTTERWAVE_SECRET_KEY || '';
    const { verifyTransactionById } = await import('@/lib/payments/flutterwave-verify');
    const webhookTxId = data.id as number;

    // Determine intent match
    let hasIntentMatch = false;
    if (txRef.startsWith('waaiiosub')) {
      const { data: intentCheck } = await supabase
        .from('subscription_checkout_intents')
        .select('id')
        .eq('idempotency_key', txRef)
        .maybeSingle();
      hasIntentMatch = !!intentCheck;
    }

    // Determine renewal lookup result (for non-waaiiosub tx_refs only)
    // Must check BOTH active and cancelled provider subscriptions before declaring not_subscription
    let renewalLookupResult: 'matched' | 'not_subscription' | 'unavailable' | 'ambiguous' | 'not_checked' = 'not_checked';
    let renewalLocalSubId: string | null = null;
    if (!txRef.startsWith('waaiiosub') && webhookTxId) {
      try {
        // Query BOTH active and cancelled provider subscriptions before declaring not_subscription (Blocker A)
        const subCorrelation = await correlateProviderSubscriptionExhaustive(webhookTxId, flwKey);
        if (subCorrelation.ok) {
          // Provider found a subscription — check local match
          const { data: localSub, error: localErr } = await supabase
            .from('subscriptions').select('id')
            .eq('flutterwave_subscription_id', subCorrelation.sub.subscriptionId)
            .eq('gateway', 'flutterwave')
            .maybeSingle();
          if (localErr) renewalLookupResult = 'unavailable';
          else if (localSub) { renewalLookupResult = 'matched'; renewalLocalSubId = localSub.id; }
          else renewalLookupResult = 'matched'; // provider match, no local → decideChargeRouting handles
        } else if (subCorrelation.reason === 'not_found') {
          renewalLookupResult = 'not_subscription';
        } else if (subCorrelation.reason === 'ambiguous') {
          renewalLookupResult = 'ambiguous';
        } else {
          renewalLookupResult = 'unavailable';
        }
      } catch { renewalLookupResult = 'unavailable'; }
    }

    // Production routing decision
    const routingDecision = decideChargeRouting(txRef, webhookTxId, hasIntentMatch, renewalLookupResult, renewalLocalSubId || undefined);

    // Fail closed for unknown routing
    if (routingDecision.route === 'unknown') {
      wh.failed(new Error(`Charge routing failed: ${routingDecision.reason}`));
      return NextResponse.json({ error: `Charge routing: ${routingDecision.reason}` }, { status: 500 });
    }

    // ── Platform renewal path ──
    if (routingDecision.route === 'platform_renewal' && renewalLocalSubId) {
      const renewVerify = await verifyTransactionById(webhookTxId, txRef, flwKey);
      if (!renewVerify.ok || renewVerify.tx.status !== 'successful') {
        wh.failed(new Error(`Renewal verification failed`));
        return NextResponse.json({ error: 'Renewal verification failed' }, { status: 500 });
      }
      const { tx: renewTx } = renewVerify;
      const { data: renewResult, error: renewErr } = await supabase.rpc('finalize_flutterwave_subscription_renewal', {
        p_subscription_id: renewalLocalSubId,
        p_provider_tx_id: String(renewTx.id),
        p_verified_amount_minor: Math.round(renewTx.amount * 100),
        p_verified_currency: renewTx.currency,
        p_provider_paid_at: renewTx.created_at,
      });
      const rDecision = decideFinalizerResult(renewResult as Record<string, unknown> | null, renewErr);
      if (rDecision.action === 'quarantined') {
        logger.error('[FLW-WEBHOOK] Renewal quarantined', { subId: renewalLocalSubId });
        return NextResponse.json({ message: 'Renewal quarantined' }, { status: 200 });
      }
      if (rDecision.action !== 'success') {
        wh.failed(new Error(`Renewal failed: ${rDecision.reason}`));
        return NextResponse.json({ error: 'Renewal failed' }, { status: 500 });
      }
      wh.processed({ durationMs: Math.round(performance.now() - startTime) });
      return NextResponse.json({ message: 'Subscription renewed' }, { status: 200 });
    }

    // ── Platform initial subscription path ──
    if (routingDecision.route === 'platform_initial' && txRef.startsWith('waaiiosub')) {
      const { data: intent, error: intentReadErr } = await supabase
        .from('subscription_checkout_intents')
        .select('id, status, business_id, plan, amount, currency, idempotency_key, config_version_id, subscriber_email')
        .eq('idempotency_key', txRef)
        .maybeSingle();

      // Blocker C: Once classified platform_initial, a missing/error second intent read
      // is an inconsistent/orphaned platform state — NEVER ordinary business payment
      if (intentReadErr || !intent) {
        logger.error('[FLW-WEBHOOK] CRITICAL: platform_initial classified but intent unreadable', {
          txRef, intentReadErr, hasIntent: !!intent,
        });
        return NextResponse.json(
          { error: 'Platform subscription state inconsistent — reconciliation required' },
          { status: 500 },
        );
      }

      {
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

          // Resolve subscription — production decision function (Blocker B)
          const subCorrelation = await correlateProviderSubscription(verified.id, flwKey);
          const subDecision = decideSubscriptionCorrelation(subCorrelation);
          if (subDecision.action === 'fail_closed') {
            wh.failed(new Error(`Subscription correlation failed: ${subDecision.reason}`));
            return NextResponse.json({ error: 'Subscription correlation failed' }, { status: 500 });
          }
          const providerSubId = subDecision.subscriptionId;
          const providerPlanId = subDecision.planId;

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

          // Production decision function for finalizer result (Blocker B)
          const finDecision = decideFinalizerResult(finResult as Record<string, unknown> | null, finErr);
          if (finDecision.action === 'quarantined') {
            logger.error('[FLW-WEBHOOK] Checkout finalization quarantined', { intentId: intent.id });
            return NextResponse.json({ error: 'Finalization quarantined' }, { status: 500 });
          }
          if (finDecision.action === 'failed') {
            wh.failed(new Error(`Finalization failed: ${finDecision.reason}`));
            return NextResponse.json({ error: 'Finalization failed' }, { status: 500 });
          }

          wh.processed({ durationMs: Math.round(performance.now() - startTime) });
          return NextResponse.json({ message: 'Subscription activated' }, { status: 200 });
        }

        // Intent is failed/superseded — late webhook for terminal intent (Blocker E)
        if (intent.status === 'failed' || intent.status === 'superseded') {
          const webhookTxId = data.id as number;
          if (!webhookTxId || data.status !== 'successful') {
            // Non-successful or missing ID — nothing to quarantine, acknowledge
            wh.ignored(`Late non-successful webhook for ${intent.status} intent`);
            return NextResponse.json({ message: 'Ignored' }, { status: 200 });
          }

          // Provider-verify the late success before quarantining
          const lateVerify = await verifyTransactionById(webhookTxId, txRef, flwKey);
          if (!lateVerify.ok || lateVerify.tx.status !== 'successful') {
            // Verification failed — fail closed, Flutterwave retries
            wh.failed(new Error(`Late-success verification failed: ${!lateVerify.ok ? lateVerify.reason : lateVerify.tx.status}`));
            return NextResponse.json({ error: 'Late-success verification failed' }, { status: 500 });
          }

          // Durable quarantine write — only claim quarantined if write succeeds
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
            return NextResponse.json({ error: 'Quarantine write failed' }, { status: 500 });
          }

          logger.error('[FLW-WEBHOOK] CRITICAL: Verified late success quarantined for reconciliation', {
            intentId: intent.id, txId: lateVerify.tx.id, amount: lateVerify.tx.amount,
          });
          wh.processed({ durationMs: Math.round(performance.now() - startTime) });
          return NextResponse.json({ message: 'Late success quarantined' }, { status: 200 });
        }
      }
    }

    // ── Existing business-payment path (routingDecision.route === 'business_payment') ──

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

