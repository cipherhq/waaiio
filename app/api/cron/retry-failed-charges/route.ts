import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { chargeAuthorization } from '@/lib/payments/paystack-recurring';
import { chargeToken as chargeFlutterwaveToken } from '@/lib/payments/flutterwave-recurring';
import { resolvePaystackSplit, resolveGatewaySplit } from '@/lib/payments/charge-saved';
import { createAlert } from '@/lib/alerts/create-alert';
import { logger } from '@/lib/logger';
import { createCronLogger } from '@/lib/observability/cron';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Cron: Retry failed recurring charges for past_due subscriptions.
 * - Paystack: charge authorization directly
 * - Stripe: auto-retries (we just check and update status)
 * - After 3 failures: cancel subscription and notify business
 *
 * Schedule: daily at 10 AM
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const cron = createCronLogger('retry-failed-charges');
  cron.started();

  let retried = 0;
  let cancelled = 0;
  let skipped = 0;

  try {
    const supabase = createServiceClient();
    // Find past_due subscriptions with fewer than 3 failures
    const { data: pastDue } = await supabase
      .from('customer_subscriptions')
      .select('id, business_id, user_id, service_id, amount, currency, gateway, authorization_code, customer_email, customer_name, customer_phone, frequency, failure_count, gateway_subscription_code')
      .eq('status', 'past_due')
      .lt('failure_count', 3);

    for (const sub of pastDue || []) {
      // Skip if no authorization code (can't charge)
      if (sub.gateway === 'paystack' && !sub.authorization_code) {
        logger.warn(`[RETRY-CHARGES] Skipping ${sub.id} — no authorization code`);
        continue;
      }

      if (sub.gateway === 'paystack' && sub.authorization_code) {
        const amountKobo = Math.round((sub.amount || 0) * 100);
        const reference = `retry-${sub.id}-${Date.now().toString(36)}`;

        // Resolve split configuration (fail-closed for direct_split)
        const splitResult = await resolvePaystackSplit(supabase, sub.business_id, sub.amount || 0);
        let splitParams: { subaccount: string; transaction_charge: number } | undefined;

        if (splitResult.mode === 'split') {
          splitParams = { subaccount: splitResult.subaccount, transaction_charge: splitResult.transactionChargeKobo };
        } else if (splitResult.mode === 'split_required_but_missing') {
          cron.itemSkipped({ gateway: 'paystack', subscriptionId: sub.id, businessId: sub.business_id, reason: splitResult.reason, splitRequired: true, splitResolved: false });
          skipped++;
          continue;
        }
        // mode === 'no_split': proceed without split params

        try {
          const result = await chargeAuthorization(
            sub.authorization_code,
            amountKobo,
            sub.customer_email || '',
            reference,
            splitParams,
          );

          if (result.success) {
            // Success — mark active, reset failures
            await supabase
              .from('customer_subscriptions')
              .update({
                status: 'active',
                failure_count: 0,
                last_charged_at: new Date().toISOString(),
                charge_count: (sub.failure_count || 0) > 0 ? undefined : undefined, // Don't change — webhook will handle
              })
              .eq('id', sub.id);

            cron.itemCompleted({ gateway: 'paystack', subscriptionId: sub.id, providerReference: result.reference });
            retried++;
          } else {
            const newFailureCount = (sub.failure_count || 0) + 1;
            await supabase
              .from('customer_subscriptions')
              .update({ failure_count: newFailureCount })
              .eq('id', sub.id);

            cron.itemFailed('Charge returned unsuccessful', { gateway: 'paystack', subscriptionId: sub.id, attempt: newFailureCount });
          }
        } catch (err) {
          const newFailureCount = (sub.failure_count || 0) + 1;
          await supabase
            .from('customer_subscriptions')
            .update({ failure_count: newFailureCount })
            .eq('id', sub.id);

          cron.itemFailed(err, { gateway: 'paystack', subscriptionId: sub.id, attempt: newFailureCount });
        }
      }

      // Flutterwave past_due retries use the same claim/reconcile/finalize path below.
      // No separate unsafe retry block needed — all Flutterwave charging goes through
      // stableRef → claim → reconcile → charge → verify → finalize.

      // Stripe auto-retries — we don't need to charge manually
      // But if failure_count >= 3, cancel the subscription
    }

    // ── Flutterwave unified renewal + retry scheduler ──
    // Waaiio manages Flutterwave recurrence via token billing.
    // Both active (normal renewal) and past_due (retry) use the same safe path:
    // stableRef → claim → reconcile → charge → verify → finalize
    const { data: flwDue } = await supabase
      .from('customer_subscriptions')
      .select('id, business_id, user_id, service_id, amount, currency, authorization_code, customer_email, customer_name, customer_phone, frequency, failure_count, next_charge_at')
      .eq('gateway', 'flutterwave')
      .in('status', ['active', 'past_due'])
      .lt('failure_count', 3)
      .not('authorization_code', 'is', null)
      .lte('next_charge_at', new Date().toISOString());

    for (const sub of flwDue || []) {
      if (!sub.authorization_code) continue;
      const amountInCurrency = sub.amount || 0;

      // Step 1: LOCAL prerequisites BEFORE claim (prevents stranded claims)
      const flwSplitResult = await resolveGatewaySplit(supabase, sub.business_id, amountInCurrency, 'flutterwave');
      let flwSplitParams: { subaccounts: Array<{ id: string; transaction_charge_type: string; transaction_charge: number }> } | undefined;
      if (flwSplitResult.mode === 'split') {
        if (process.env.FLUTTERWAVE_RECURRING_SPLIT_VERIFIED !== 'true') {
          cron.itemSkipped({ gateway: 'flutterwave', subscriptionId: sub.id, reason: 'split not verified' });
          skipped++;
          continue;
        }
        flwSplitParams = {
          subaccounts: [{
            id: flwSplitResult.subaccount,
            transaction_charge_type: 'flat',
            transaction_charge: flwSplitResult.transactionChargeKobo / 100,
          }],
        };
      } else if (flwSplitResult.mode === 'split_required_but_missing') {
        cron.itemSkipped({ gateway: 'flutterwave', subscriptionId: sub.id, reason: flwSplitResult.reason });
        skipped++;
        continue;
      }

      // Use the tested processFlutterwaveRenewal helper — ONE production implementation
      const { processFlutterwaveRenewal } = await import('@/lib/payments/flutterwave-renewal');
      const result = await processFlutterwaveRenewal(
        { supabase },
        {
          id: sub.id, business_id: sub.business_id, amount: amountInCurrency,
          currency: sub.currency || 'NGN', authorization_code: sub.authorization_code,
          customer_email: sub.customer_email || '', customer_phone: sub.customer_phone || '',
          service_id: sub.service_id, frequency: sub.frequency, failure_count: sub.failure_count || 0,
        },
        flwSplitParams,
      );

      if (result.action === 'finalized') {
        // Send confirmation (non-blocking)
        if (result.paymentId) {
          // Send confirmation (non-blocking)
          (async () => {
            try {
              const { data: paymentRec } = await supabase.from('payments')
                .select('id, amount, booking_id, invoice_id, campaign_id, reservation_id, order_id')
                .eq('id', result.paymentId).single();
              if (paymentRec) {
                const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
                await sendProactiveConfirmation(supabase, paymentRec);
              }
            } catch { /* non-fatal */ }
          })();
        }
        cron.itemCompleted({ gateway: 'flutterwave', subscriptionId: sub.id, type: 'normal_renewal' });
        retried++;
      } else if (result.action === 'failure_recorded') {
        // Notify customer after durable failure recording
        if (sub.customer_phone && sub.business_id) {
          try {
            const { notifyCustomerChargeFailed } = await import('@/lib/payments/notify-charge-failed');
            await notifyCustomerChargeFailed(supabase, {
              subscriptionId: sub.id, businessId: sub.business_id,
              customerPhone: sub.customer_phone, amount: sub.amount || 0,
              currency: sub.currency || 'NGN', serviceId: sub.service_id,
              gateway: 'flutterwave',
            });
          } catch { /* non-fatal */ }
        }
        cron.itemFailed('Flutterwave renewal charge failed', { subscriptionId: sub.id, attempt: result.failureCount });
      } else if (result.action === 'skipped') {
        cron.itemSkipped({ gateway: 'flutterwave', subscriptionId: sub.id, reason: result.reason });
        skipped++;
      } else {
        cron.itemFailed(result.reason || 'error', { gateway: 'flutterwave', subscriptionId: sub.id });
      }
    }

    // Cancel subscriptions with 3+ failures
    const { data: toCancel } = await supabase
      .from('customer_subscriptions')
      .select('id, business_id, customer_name, customer_phone, gateway, gateway_subscription_code, amount, currency, metadata')
      .eq('status', 'past_due')
      .gte('failure_count', 3);

    for (const sub of toCancel || []) {
      // For Flutterwave: use fail-closed atomic cancellation RPC
      if (sub.gateway === 'flutterwave') {
        const { data: cancelResult } = await supabase.rpc('cancel_flutterwave_after_failures', {
          p_subscription_id: sub.id,
        });
        if (cancelResult?.cancelled) {
          cancelled++;
          logger.info(`[RETRY-CHARGES] Flutterwave subscription ${sub.id} cancelled atomically`);
        } else {
          logger.warn(`[RETRY-CHARGES] Flutterwave cancel blocked for ${sub.id}: ${cancelResult?.reason || 'rpc_error'}`);
        }
        continue; // Skip provider-managed cancel logic below
      }

      // Cancel on gateway (Stripe/Paystack — provider-first)
      let providerCancelled = true;
      try {
        if (sub.gateway === 'paystack' && sub.gateway_subscription_code) {
          const { cancelSubscription } = await import('@/lib/payments/paystack-recurring');
          // Use stored email token from subscription metadata
          const psMeta = typeof sub.metadata === 'object' && sub.metadata ? (sub.metadata as Record<string, string>) : {};
          providerCancelled = await cancelSubscription(sub.gateway_subscription_code, psMeta.email_token || '');
        } else if (sub.gateway === 'stripe' && sub.gateway_subscription_code) {
          const { cancelSubscription } = await import('@/lib/payments/stripe-recurring');
          providerCancelled = await cancelSubscription(sub.gateway_subscription_code);
        }
        // Flutterwave: DB-only cancel — Waaiio manages token billing
      } catch (cancelErr) {
        logger.error(`[RETRY-CHARGES] Gateway cancel error for ${sub.id}:`, cancelErr);
        providerCancelled = false;
      }

      if (!providerCancelled && (sub.gateway === 'stripe' || sub.gateway === 'paystack')) {
        // Provider cancel failed — do NOT mark DB as cancelled for provider-managed subs
        logger.warn(`[RETRY-CHARGES] Skipping DB cancel for ${sub.id}: provider cancel failed`);
        continue;
      }

      // Update DB (safe for Flutterwave DB-only or after successful provider cancel)
      await supabase
        .from('customer_subscriptions')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
        .eq('id', sub.id);

      // Notify business owner
      await createAlert(supabase, {
        businessId: sub.business_id,
        type: 'subscription_cancelled',
        severity: 'warning',
        title: 'Recurring subscription cancelled',
        message: `${sub.customer_name || 'A customer'}'s recurring payment was cancelled after 3 failed charge attempts.`,
        metadata: { subscription_id: sub.id, customer_phone: sub.customer_phone },
      });

      cancelled++;
      logger.info(`[RETRY-CHARGES] Cancelled ${sub.id} after 3 failures`);
    }

    cron.completed({ successCount: retried, failureCount: cancelled, skippedCount: skipped });
    return NextResponse.json({ success: true, retried, cancelled, skipped });
  } catch (error) {
    cron.failed(error, { successCount: retried, failureCount: cancelled, skippedCount: skipped });
    Sentry.captureException(error, { tags: { cron: 'retry-failed-charges' } });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
