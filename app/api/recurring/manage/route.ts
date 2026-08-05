import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { logger } from '@/lib/logger';

/**
 * POST /api/recurring/manage
 * Pause, resume, or cancel a customer subscription.
 * Calls the gateway API (Paystack/Stripe) then updates DB.
 *
 * IMPORTANT: DB status is updated ONLY after provider success.
 * If the provider call fails, the local status is NOT changed
 * to avoid local/provider state divergence.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { subscriptionId, action } = await request.json();
    if (!subscriptionId || !['pause', 'resume', 'cancel'].includes(action)) {
      return NextResponse.json({ error: 'subscriptionId and action (pause/resume/cancel) required' }, { status: 400 });
    }

    const service = createServiceClient();

    // Fetch the subscription + metadata (contains Paystack email_token) + verify business ownership
    const { data: sub } = await service
      .from('customer_subscriptions')
      .select('id, business_id, gateway, gateway_subscription_code, gateway_customer_code, status, customer_email, metadata')
      .eq('id', subscriptionId)
      .single();

    if (!sub) return NextResponse.json({ error: 'Subscription not found' }, { status: 404 });

    // Verify user owns the business
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', sub.business_id)
      .eq('owner_id', user.id)
      .single();

    if (!biz) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

    // ── Capability enforcement: recurring/manage_existing ──
    const guard = await requireCapability(supabase, service, {
      businessId: sub.business_id, userId: user.id, capability: 'recurring', action: 'manage_existing',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    const now = new Date().toISOString();

    // ── Provider operation (must succeed before DB update) ──
    let providerSuccess = true;

    if (sub.gateway === 'paystack') {
      // Paystack requires both gateway_subscription_code and email_token.
      // Fail closed if either is missing — do not allow DB-only status change
      // for a provider-managed subscription.
      if (!sub.gateway_subscription_code) {
        logger.warn('[RECURRING] Paystack subscription missing gateway_subscription_code', {
          subscriptionId, action, gateway: 'paystack',
        });
        return NextResponse.json({
          error: 'Subscription is missing the Paystack subscription code required for this operation. Please contact support.',
          code: 'MISSING_SUBSCRIPTION_CODE',
        }, { status: 422 });
      }

      // Paystack requires the subscription's email_token (returned at creation),
      // NOT the customer's email address. The token is stored in metadata.email_token.
      const metadata = (sub.metadata as Record<string, string>) || {};
      const emailToken = metadata.email_token || '';

      if (!emailToken) {
        logger.warn('[RECURRING] Paystack subscription missing email_token', {
          subscriptionId, action, gateway: 'paystack',
        });
        return NextResponse.json({
          error: 'Subscription is missing the Paystack email token required for this operation. Please contact support.',
          code: 'MISSING_EMAIL_TOKEN',
        }, { status: 422 });
      }

      if (action === 'pause' || action === 'cancel') {
        // Paystack uses the same disable endpoint for both pause and cancel
        const { cancelSubscription } = await import('@/lib/payments/paystack-recurring');
        providerSuccess = await cancelSubscription(sub.gateway_subscription_code, emailToken);
      } else if (action === 'resume') {
        const { enableSubscription } = await import('@/lib/payments/paystack-recurring');
        providerSuccess = await enableSubscription(sub.gateway_subscription_code, emailToken);
      }
    } else if (sub.gateway === 'stripe') {
      if (!sub.gateway_subscription_code) {
        logger.warn('[RECURRING] Stripe subscription missing gateway_subscription_code', {
          subscriptionId, action, gateway: 'stripe',
        });
        return NextResponse.json({
          error: 'Subscription is missing the Stripe subscription ID required for this operation. Please contact support.',
          code: 'MISSING_SUBSCRIPTION_CODE',
        }, { status: 422 });
      }

      if (action === 'pause') {
        const { pauseSubscription } = await import('@/lib/payments/stripe-recurring');
        providerSuccess = await pauseSubscription(sub.gateway_subscription_code);
      } else if (action === 'resume') {
        const { resumeSubscription } = await import('@/lib/payments/stripe-recurring');
        providerSuccess = await resumeSubscription(sub.gateway_subscription_code);
      } else if (action === 'cancel') {
        const { cancelSubscription } = await import('@/lib/payments/stripe-recurring');
        providerSuccess = await cancelSubscription(sub.gateway_subscription_code);
      }
    }
    // Flutterwave: DB-only — no provider call needed (Waaiio manages scheduling via cron)

    // ── Fail closed: do NOT update DB if provider operation failed ──
    if (!providerSuccess) {
      logger.error('[RECURRING] Provider operation failed — local status NOT changed', {
        subscriptionId, action, gateway: sub.gateway,
      });
      return NextResponse.json({
        error: `Failed to ${action} subscription at payment provider. Local status was not changed.`,
        code: 'PROVIDER_OPERATION_FAILED',
      }, { status: 502 });
    }

    // ── Update DB status (only after confirmed provider success) ──
    const updates: Record<string, unknown> = {};
    if (action === 'pause') {
      updates.status = 'paused';
      updates.paused_at = now;
    } else if (action === 'resume') {
      updates.status = 'active';
      updates.paused_at = null;
    } else if (action === 'cancel') {
      updates.status = 'cancelled';
      updates.cancelled_at = now;
    }

    await service
      .from('customer_subscriptions')
      .update(updates)
      .eq('id', subscriptionId);

    logger.info(`[RECURRING] Subscription ${subscriptionId} ${action}d via gateway ${sub.gateway}`);

    return NextResponse.json({ success: true, action, status: updates.status });
  } catch (error) {
    logger.error('[RECURRING] Manage error:', error);
    return NextResponse.json({ error: 'Failed to update subscription' }, { status: 500 });
  }
}
