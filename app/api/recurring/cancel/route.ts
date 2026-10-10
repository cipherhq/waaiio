import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { cancelSubscription as cancelPaystackSub } from '@/lib/payments/paystack-recurring';
import { cancelSubscription as cancelStripeSub } from '@/lib/payments/stripe-recurring';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { verifyRecurringCancellationProof } from '@/lib/otp-challenge';
import { logger } from '@/lib/logger';

/**
 * POST /api/recurring/cancel
 *
 * #597 F3: Secure subscription cancellation requiring OTP-bound proof.
 *
 * Before this fix, the route accepted only phone + subscriptionId (both public
 * identifiers), used service_role client, swallowed gateway errors, and returned
 * success unconditionally. An attacker knowing a subscription UUID and phone
 * could cancel any subscription.
 *
 * Now requires a short-lived HMAC-signed cancellation proof issued by
 * /api/recurring/verify after successful OTP verification. The proof is
 * scoped to the exact subscription and phone, expires in 5 minutes.
 *
 * Gateway cancellation must succeed (or subscription must not have a gateway
 * code) before the DB is updated. Ambiguous outcomes return 503.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'recurring-cancel'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const body = await request.json();
    const { subscriptionId, phone, cancellationProof } = body;

    if (!subscriptionId || !phone) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    // ── F3: Require OTP-bound cancellation proof ──
    // Phone + subscriptionId alone are NOT authorization.
    if (!cancellationProof) {
      return NextResponse.json(
        { error: 'Cancellation requires verification. Please verify your identity first.' },
        { status: 403 },
      );
    }

    if (!verifyRecurringCancellationProof(cancellationProof, normalizedPhone, subscriptionId)) {
      return NextResponse.json(
        { error: 'Verification expired or invalid. Please verify your identity again.' },
        { status: 403 },
      );
    }

    const supabase = createServiceClient();

    // Look up subscription — verify phone binding
    const { data: sub, error: subError } = await supabase
      .from('customer_subscriptions')
      .select('id, status, gateway, gateway_subscription_code, metadata')
      .eq('id', subscriptionId)
      .eq('customer_phone', normalizedPhone)
      .maybeSingle();

    if (subError) {
      logger.error('[RECURRING-CANCEL] Subscription lookup failed:', subError.message);
      return NextResponse.json({ error: 'Unable to process cancellation' }, { status: 503 });
    }

    if (!sub) {
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 });
    }

    // Already cancelled — idempotent success
    if (sub.status === 'cancelled') {
      return NextResponse.json({ success: true, already_cancelled: true });
    }

    // Only allow cancelling active/paused/past_due subscriptions
    if (!['active', 'paused', 'past_due'].includes(sub.status)) {
      return NextResponse.json(
        { error: `Cannot cancel subscription in ${sub.status} state` },
        { status: 400 },
      );
    }

    // ── Gateway cancellation — must succeed before DB update ──
    let providerCancelled = true;

    if (sub.gateway === 'paystack' && sub.gateway_subscription_code) {
      try {
        const result = await cancelPaystackSub(
          sub.gateway_subscription_code,
          (sub.metadata as Record<string, unknown>)?.email_token as string || '',
        );
        if (result === false) {
          logger.error('[RECURRING-CANCEL] Paystack refused cancellation for', subscriptionId);
          providerCancelled = false;
        }
      } catch (err) {
        logger.error('[RECURRING-CANCEL] Paystack cancel error:', err);
        providerCancelled = false;
      }
    } else if (sub.gateway === 'stripe' && sub.gateway_subscription_code) {
      try {
        const result = await cancelStripeSub(sub.gateway_subscription_code);
        if (result === false) {
          logger.error('[RECURRING-CANCEL] Stripe refused cancellation for', subscriptionId);
          providerCancelled = false;
        }
      } catch (err) {
        logger.error('[RECURRING-CANCEL] Stripe cancel error:', err);
        providerCancelled = false;
      }
    }
    // Flutterwave subscriptions without gateway codes: no provider call needed

    // ── Do NOT update DB if provider explicitly refused ──
    if (!providerCancelled) {
      return NextResponse.json(
        { error: 'Unable to cancel with payment provider. Please try again or contact support.' },
        { status: 503 },
      );
    }

    // ── CAS-guarded DB update ──
    const { data: updated, error: updateError } = await supabase
      .from('customer_subscriptions')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', subscriptionId)
      .in('status', ['active', 'paused', 'past_due'])
      .select('id');

    if (updateError) {
      logger.error('[RECURRING-CANCEL] DB update failed:', updateError.message);
      // Provider already cancelled — this is an ambiguous state
      // Return 503 so client retries (provider cancel is idempotent)
      return NextResponse.json(
        { error: 'Cancellation may have partially completed. Please check your subscription status.' },
        { status: 503 },
      );
    }

    if (!updated || updated.length === 0) {
      // Status changed between our read and update (CAS conflict) — likely already cancelled
      return NextResponse.json({ success: true, already_cancelled: true });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[RECURRING-CANCEL] Unhandled error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
