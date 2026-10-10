import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { cancelSubscription as cancelPaystackSub, getSubscriptionStatus as getPaystackSubStatus } from '@/lib/payments/paystack-recurring';
import { cancelSubscription as cancelStripeSub, getSubscriptionStatus as getStripeSubStatus } from '@/lib/payments/stripe-recurring';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { verifyRecurringCancellationProof } from '@/lib/otp-challenge';
import { logger } from '@/lib/logger';

// B1: Only these gateways are supported for provider-side cancellation.
// Unknown gateways MUST fail closed — never mark cancelled without confirmed
// provider state.
const SUPPORTED_GATEWAYS = ['paystack', 'stripe', 'flutterwave'] as const;
type SupportedGateway = typeof SUPPORTED_GATEWAYS[number];

/**
 * POST /api/recurring/cancel
 *
 * #597 F3: Secure subscription cancellation requiring OTP-bound proof.
 *
 * Authorization: HMAC-signed cancellation proof issued by /api/recurring/verify
 * after WhatsApp OTP verification, scoped to exact phone + subscription.
 *
 * Provider-first: gateway cancellation must succeed before DB update.
 * Fail-closed: unknown gateways, missing provider codes on gateway-managed
 * subscriptions, and ambiguous outcomes all return non-success.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'recurring-cancel'), 10, 60_000);
    if (rateLimit) return rateLimit;

    // B6/R3-3: Validate request body is valid JSON object
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
      }
      body = parsed;
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { subscriptionId, phone, cancellationProof } = body;

    // B6: Type validation before any processing
    if (typeof subscriptionId !== 'string' || typeof phone !== 'string' ||
        !subscriptionId || !phone || subscriptionId.length > 200 || phone.length > 30) {
      return NextResponse.json({ error: 'Missing or invalid required fields' }, { status: 400 });
    }

    // B6: Validate UUID format for subscriptionId
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subscriptionId)) {
      return NextResponse.json({ error: 'Invalid subscription identifier' }, { status: 400 });
    }

    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    // F3: Require OTP-bound cancellation proof — phone + UUID alone are NOT authorization
    if (!cancellationProof || typeof cancellationProof !== 'string') {
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
    const originalStatus = sub.status;
    if (!['active', 'paused', 'past_due'].includes(originalStatus)) {
      return NextResponse.json(
        { error: `Cannot cancel subscription in ${originalStatus} state` },
        { status: 400 },
      );
    }

    // ── B1 R2: Strict fail-closed gateway classification ──
    // Classify by gateway FIRST. Paystack/Stripe REQUIRE provider codes.
    // Only Flutterwave (cron-managed token billing) may do DB-only cancel.
    const gateway = sub.gateway as string;

    if (!SUPPORTED_GATEWAYS.includes(gateway as SupportedGateway)) {
      logger.error('[RECURRING-CANCEL] Unknown gateway:', gateway, 'for subscription', subscriptionId);
      return NextResponse.json(
        { error: 'This subscription type cannot be cancelled online. Please contact support.' },
        { status: 400 },
      );
    }

    // ── M439: Set durable cancellation intent BEFORE provider call ──
    // This blocks all future billing claim/dispatch RPCs even if the
    // subsequent provider call or DB status update fails.
    const { error: intentError } = await supabase
      .from('customer_subscriptions')
      .update({ cancellation_requested_at: new Date().toISOString() })
      .eq('id', subscriptionId)
      .eq('customer_phone', normalizedPhone)
      .is('cancellation_requested_at', null); // Only set once (CAS)

    if (intentError) {
      logger.error('[RECURRING-CANCEL] Failed to record cancellation intent:', intentError.message);
      return NextResponse.json(
        { error: 'Unable to process cancellation. Please try again.' },
        { status: 503 },
      );
    }
    // Note: if intent was already set (zero rows from CAS), that's fine —
    // it means a prior attempt already recorded the intent. We proceed with
    // the provider call regardless.

    let providerCancelled = false;

    if (gateway === 'paystack') {
      // Paystack: REQUIRE provider subscription code AND email token
      if (!sub.gateway_subscription_code) {
        logger.error('[RECURRING-CANCEL] Paystack subscription missing provider code:', subscriptionId);
        return NextResponse.json(
          { error: 'This subscription cannot be cancelled online — missing provider reference. Please contact support.' },
          { status: 422 },
        );
      }
      const emailToken = ((sub.metadata as Record<string, unknown>)?.email_token as string) || '';
      if (!emailToken) {
        logger.error('[RECURRING-CANCEL] Paystack subscription missing email token:', subscriptionId);
        return NextResponse.json(
          { error: 'This subscription cannot be cancelled online — missing provider credentials. Please contact support.' },
          { status: 422 },
        );
      }
      try {
        const result = await cancelPaystackSub(sub.gateway_subscription_code, emailToken);
        providerCancelled = result === true;
      } catch (err) {
        logger.error('[RECURRING-CANCEL] Paystack cancel error:', err);
      }

      // B5: If cancel API failed/refused, verify authoritative provider state.
      // On retry after prior success+DB-failure, the provider may refuse the
      // second disable call. Verify actual subscription status before giving up.
      if (!providerCancelled) {
        try {
          const providerStatus = await getPaystackSubStatus(sub.gateway_subscription_code);
          // Paystack terminal statuses (per docs.paystack.com/payments/subscriptions):
          // 'non-renewing' = currently active period, no future charges
          // 'cancelled' = fully cancelled
          // 'completed' = finished lifecycle, no future charges
          // Note: 'non-renewing' proves no future renewal will occur at the provider,
          // but does not necessarily mean the current paid period has expired.
          if (providerStatus === 'non-renewing' || providerStatus === 'cancelled' || providerStatus === 'completed') {
            logger.info('[RECURRING-CANCEL] Paystack subscription verified cancelled via status check:', providerStatus);
            providerCancelled = true;
          } else {
            logger.error('[RECURRING-CANCEL] Paystack status check:', providerStatus, 'for', subscriptionId);
          }
        } catch (verifyErr) {
          logger.error('[RECURRING-CANCEL] Paystack status verification failed:', verifyErr);
        }
      }

    } else if (gateway === 'stripe') {
      // Stripe: REQUIRE provider subscription code
      if (!sub.gateway_subscription_code) {
        logger.error('[RECURRING-CANCEL] Stripe subscription missing provider code:', subscriptionId);
        return NextResponse.json(
          { error: 'This subscription cannot be cancelled online — missing provider reference. Please contact support.' },
          { status: 422 },
        );
      }
      try {
        const result = await cancelStripeSub(sub.gateway_subscription_code);
        providerCancelled = result === true;
      } catch (err) {
        logger.error('[RECURRING-CANCEL] Stripe cancel error:', err);
      }

      // B5: If cancel API failed/refused, verify authoritative provider state.
      if (!providerCancelled) {
        try {
          const providerStatus = await getStripeSubStatus(sub.gateway_subscription_code);
          if (providerStatus === 'canceled') {
            logger.info('[RECURRING-CANCEL] Stripe subscription verified cancelled via status check:', providerStatus);
            providerCancelled = true;
          } else {
            logger.error('[RECURRING-CANCEL] Stripe status check:', providerStatus, 'for', subscriptionId);
          }
        } catch (verifyErr) {
          logger.error('[RECURRING-CANCEL] Stripe status verification failed:', verifyErr);
        }
      }

    } else if (gateway === 'flutterwave') {
      // Flutterwave: cron-managed token billing — DB-only cancel is safe
      // The cron checks DB status before charging; no provider subscription to disable
      providerCancelled = true;
    }

    if (!providerCancelled) {
      return NextResponse.json(
        { error: 'Unable to cancel with payment provider. Please try again or contact support.' },
        { status: 503 },
      );
    }

    // ── B2: CAS-guarded DB update anchored to original read state ──
    const { data: updated, error: updateError } = await supabase
      .from('customer_subscriptions')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', subscriptionId)
      .eq('customer_phone', normalizedPhone)
      .eq('status', originalStatus) // B2: Exact state anchor, not broad IN
      .select('id');

    if (updateError) {
      logger.error('[RECURRING-CANCEL] DB update failed:', updateError.message);
      return NextResponse.json(
        { error: 'Cancellation could not be completed. Please check your subscription status and try again.' },
        { status: 503 },
      );
    }

    // B2/R3-1: Zero rows = state changed concurrently. Do NOT assume success.
    if (!updated || updated.length === 0) {
      // Re-read to determine actual current state
      const { data: current, error: rereadError } = await supabase
        .from('customer_subscriptions')
        .select('status')
        .eq('id', subscriptionId)
        .eq('customer_phone', normalizedPhone)
        .maybeSingle();

      // R3-1: If re-read fails, fail closed — cannot determine state
      if (rereadError || !current) {
        logger.error('[RECURRING-CANCEL] Re-read failed after zero-row update:', rereadError?.message || 'not found');
        return NextResponse.json(
          { error: 'Unable to confirm cancellation status. Please check your subscription and try again.' },
          { status: 503 },
        );
      }

      if (current.status === 'cancelled') {
        return NextResponse.json({ success: true, already_cancelled: true });
      }

      // State changed to something other than cancelled — concurrent modification
      logger.warn('[RECURRING-CANCEL] CAS conflict: status changed from', originalStatus, 'to', current.status);
      return NextResponse.json(
        { error: 'Subscription status changed. Please refresh and try again.' },
        { status: 409 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[RECURRING-CANCEL] Unhandled error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
