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

      // Stable tx_ref: deterministic for this subscription + billing period
      const scheduledAt = sub.next_charge_at;
      const stableRef = `flw-${sub.id}-${new Date(scheduledAt).toISOString().slice(0, 10)}`;

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

      // Step 2: Atomic claim — only after local prerequisites pass
      const { data: claim } = await supabase.rpc('claim_recurring_billing_cycle', {
        p_subscription_id: sub.id,
        p_scheduled_at: scheduledAt,
        p_stable_ref: stableRef,
      });

      if (!claim?.claimed) {
        cron.itemSkipped({ gateway: 'flutterwave', subscriptionId: sub.id, reason: claim?.reason || 'claim_failed' });
        skipped++;
        continue;
      }

      // Step 3: Reconcile if recovered claim, then charge if needed
      try {
        const { verifyTransaction } = await import('@/lib/payments/flutterwave-recurring');
        let providerSucceeded = false;

        if (claim.recovered && !claim.provider_verified) {
          // Recovered/stale claim — reconcile with provider BEFORE any charge
          const reconciliation = await verifyTransaction(stableRef);
          if (reconciliation?.outcome === 'successful') {
            // Provider already charged — DO NOT charge again
            providerSucceeded = true;
            await supabase.from('processed_webhook_events')
              .update({ status: 'provider_success' })
              .eq('event_id', stableRef);
          } else if (reconciliation === null || reconciliation.outcome === 'pending' || reconciliation.outcome === 'unknown') {
            // Ambiguous/pending/timeout — do NOT charge, leave for next cron
            cron.itemSkipped({ gateway: 'flutterwave', subscriptionId: sub.id, reason: `reconciliation_${reconciliation?.outcome || 'timeout'}` });
            skipped++;
            continue;
          }
          // else: outcome === 'failed' → provider definitively failed, retry below
        } else if (claim.recovered && claim.provider_verified) {
          // Provider already confirmed successful — just need to finalize
          providerSucceeded = true;
        }

        if (!providerSucceeded) {
          // Fresh claim or retryable: charge the token
          const result = await chargeFlutterwaveToken(
            sub.authorization_code, amountInCurrency,
            sub.customer_email || '', stableRef,
            sub.currency || 'NGN', flwSplitParams,
          );

          if (result.success) {
            providerSucceeded = true;
            await supabase.from('processed_webhook_events')
              .update({ status: 'provider_success' })
              .eq('event_id', stableRef);
          } else {
            // Explicit failure — mark for future retry
            await supabase.from('processed_webhook_events')
              .update({ status: 'provider_failed' })
              .eq('event_id', stableRef);
          }
        }

        if (providerSucceeded) {
          // Step 4: Verify provider transaction before finalization
          const verification = await verifyTransaction(stableRef);
          if (!verification || verification.outcome !== 'successful'
            || Math.abs((verification.amount || 0) - amountInCurrency) > 0.01
            || (verification.currency || '').toUpperCase() !== (sub.currency || 'NGN').toUpperCase()) {
            cron.itemFailed('Provider verification failed', { subscriptionId: sub.id, stableRef, verificationStatus: verification?.providerStatus || 'null' });
            continue;
          }

          // Step 5: Atomic finalize
          const { data: finResult } = await supabase.rpc('finalize_token_recurring_charge', {
            p_stable_ref: stableRef,
            p_subscription_id: sub.id,
            p_verified_amount: amountInCurrency,
            p_verified_currency: sub.currency || 'NGN',
            p_gateway: 'flutterwave',
          });

          if (finResult?.success) {
            // Send confirmation (non-blocking)
            if (finResult.payment_id && !finResult.already_finalized) {
              import('@/lib/payments/send-confirmation').then(({ sendProactiveConfirmation }) =>
                sendProactiveConfirmation(supabase, finResult.payment_id)
              ).catch(() => {});
            }
            cron.itemCompleted({ gateway: 'flutterwave', subscriptionId: sub.id, type: 'normal_renewal', stableRef });
            retried++;
          } else {
            cron.itemFailed('Finalize RPC failed', { subscriptionId: sub.id, result: finResult });
          }
        } else {
          // Charge failed — update failure state
          const newFailureCount = (sub.failure_count || 0) + 1;
          await supabase.from('customer_subscriptions').update({
            failure_count: newFailureCount,
            status: newFailureCount >= 3 ? 'past_due' : 'active',
          }).eq('id', sub.id);

          // Notify customer
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
          cron.itemFailed('Flutterwave renewal charge failed', { subscriptionId: sub.id, attempt: newFailureCount });
        }
      } catch (err) {
        // Provider call failed — but billing cycle was claimed. Next retry will see
        // the claimed event and the still-due next_charge_at, so it can retry finalization
        // without re-charging (claim will skip, but finalize is idempotent).
        const newFailureCount = (sub.failure_count || 0) + 1;
        await supabase.from('customer_subscriptions').update({
          failure_count: newFailureCount,
          status: newFailureCount >= 3 ? 'past_due' : 'active',
        }).eq('id', sub.id);
        cron.itemFailed(err, { gateway: 'flutterwave', subscriptionId: sub.id, type: 'normal_renewal' });
      }
    }

    // Cancel subscriptions with 3+ failures
    const { data: toCancel } = await supabase
      .from('customer_subscriptions')
      .select('id, business_id, customer_name, customer_phone, gateway, gateway_subscription_code, amount, currency, metadata')
      .eq('status', 'past_due')
      .gte('failure_count', 3);

    for (const sub of toCancel || []) {
      // Cancel on gateway
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
