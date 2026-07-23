import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { chargeAuthorization } from '@/lib/payments/paystack-recurring';
import { chargeToken as chargeFlutterwaveToken } from '@/lib/payments/flutterwave-recurring';
import { resolvePaystackSplit, resolveGatewaySplit } from '@/lib/payments/charge-saved';
import { createAlert } from '@/lib/alerts/create-alert';
import { logger } from '@/lib/logger';

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

  const supabase = createServiceClient();
  let retried = 0;
  let cancelled = 0;
  let skipped = 0;

  try {
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
          logger.error(`[RETRY-CHARGES] Direct split config missing for ${sub.id}, skipping charge`, {
            businessId: sub.business_id,
            reason: splitResult.reason,
          });
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

            logger.info(`[RETRY-CHARGES] Successfully retried ${sub.id}, ref: ${result.reference}`);
            retried++;
          } else {
            // Failed again — increment failure count
            const newFailureCount = (sub.failure_count || 0) + 1;
            await supabase
              .from('customer_subscriptions')
              .update({ failure_count: newFailureCount })
              .eq('id', sub.id);

            logger.warn(`[RETRY-CHARGES] Retry failed for ${sub.id}, failure #${newFailureCount}`);
          }
        } catch (err) {
          // Charge threw — increment failure
          const newFailureCount = (sub.failure_count || 0) + 1;
          await supabase
            .from('customer_subscriptions')
            .update({ failure_count: newFailureCount })
            .eq('id', sub.id);

          logger.error(`[RETRY-CHARGES] Charge error for ${sub.id}:`, err);
        }
      }

      // ── Flutterwave recurring retry ──
      if (sub.gateway === 'flutterwave' && sub.authorization_code) {
        const reference = `retry-flw-${sub.id}-${Date.now().toString(36)}`;

        // Resolve split configuration (fail-closed for direct_split)
        const flwSplitResult = await resolveGatewaySplit(supabase, sub.business_id, sub.amount || 0, 'flutterwave');
        let flwSplitParams: { subaccounts: Array<{ id: string; transaction_charge_type: string; transaction_charge: number }> } | undefined;

        if (flwSplitResult.mode === 'split') {
          // Gate: only send split params after sandbox verification.
          // Direct-split charges are skipped (not charged unsplit) to prevent
          // funds from routing to the platform when the business expects splitting.
          // Enable by setting FLUTTERWAVE_RECURRING_SPLIT_VERIFIED=true.
          if (process.env.FLUTTERWAVE_RECURRING_SPLIT_VERIFIED !== 'true') {
            logger.warn(`[RETRY-CHARGES] Flutterwave recurring split not yet verified — skipping direct-split charge for ${sub.id}. Set FLUTTERWAVE_RECURRING_SPLIT_VERIFIED=true after sandbox verification.`);
            skipped++;
            continue;
          }
          // Flutterwave uses the subaccounts array format with flat charge = platform fee in main currency
          flwSplitParams = {
            subaccounts: [{
              id: flwSplitResult.subaccount,
              transaction_charge_type: 'flat',
              transaction_charge: flwSplitResult.transactionChargeKobo / 100, // Flutterwave uses main currency units, not kobo
            }],
          };
        } else if (flwSplitResult.mode === 'split_required_but_missing') {
          logger.error(`[RETRY-CHARGES] Direct split config missing for Flutterwave ${sub.id}, skipping charge`, {
            businessId: sub.business_id,
            reason: flwSplitResult.reason,
          });
          skipped++;
          continue;
        }

        try {
          const result = await chargeFlutterwaveToken(
            sub.authorization_code,
            sub.amount || 0,
            sub.customer_email || '',
            reference,
            sub.currency || 'NGN',
            flwSplitParams,
          );

          if (result.success) {
            await supabase
              .from('customer_subscriptions')
              .update({
                status: 'active',
                failure_count: 0,
                last_charged_at: new Date().toISOString(),
              })
              .eq('id', sub.id);

            logger.info(`[RETRY-CHARGES] Successfully retried Flutterwave ${sub.id}, ref: ${result.reference}`);
            retried++;
          } else {
            const newFailureCount = (sub.failure_count || 0) + 1;
            await supabase
              .from('customer_subscriptions')
              .update({ failure_count: newFailureCount })
              .eq('id', sub.id);

            logger.warn(`[RETRY-CHARGES] Flutterwave retry failed for ${sub.id}, failure #${newFailureCount}`);
          }
        } catch (err) {
          const newFailureCount = (sub.failure_count || 0) + 1;
          await supabase
            .from('customer_subscriptions')
            .update({ failure_count: newFailureCount })
            .eq('id', sub.id);

          logger.error(`[RETRY-CHARGES] Flutterwave charge error for ${sub.id}:`, err);
        }
      }

      // Stripe auto-retries — we don't need to charge manually
      // But if failure_count >= 3, cancel the subscription
    }

    // Cancel subscriptions with 3+ failures
    const { data: toCancel } = await supabase
      .from('customer_subscriptions')
      .select('id, business_id, customer_name, customer_phone, gateway, gateway_subscription_code, amount, currency')
      .eq('status', 'past_due')
      .gte('failure_count', 3);

    for (const sub of toCancel || []) {
      // Cancel on gateway
      try {
        if (sub.gateway === 'paystack' && sub.gateway_subscription_code) {
          const { cancelSubscription } = await import('@/lib/payments/paystack-recurring');
          await cancelSubscription(sub.gateway_subscription_code, '');
        } else if (sub.gateway === 'stripe' && sub.gateway_subscription_code) {
          const { cancelSubscription } = await import('@/lib/payments/stripe-recurring');
          await cancelSubscription(sub.gateway_subscription_code);
        } else if (sub.gateway === 'flutterwave' && sub.gateway_subscription_code) {
          const { cancelSubscription } = await import('@/lib/payments/flutterwave-recurring');
          await cancelSubscription(sub.gateway_subscription_code);
        }
      } catch (cancelErr) {
        logger.error(`[RETRY-CHARGES] Gateway cancel error for ${sub.id}:`, cancelErr);
      }

      // Update DB
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

    return NextResponse.json({ success: true, retried, cancelled, skipped });
  } catch (error) {
    logger.error('[RETRY-CHARGES] Cron error:', error);
    Sentry.captureException(error, { tags: { cron: 'retry-failed-charges' } });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
