import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * POST /api/recurring/manage
 * Pause, resume, or cancel a customer subscription.
 * Calls the gateway API (Paystack/Stripe) then updates DB.
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

    // Fetch the subscription + verify business ownership
    const { data: sub } = await service
      .from('customer_subscriptions')
      .select('id, business_id, gateway, gateway_subscription_code, gateway_customer_code, status, customer_email')
      .eq('id', subscriptionId)
      .single();

    if (!sub) return NextResponse.json({ error: 'Subscription not found' }, { status: 404 });

    // Validate status before action
    if (action === 'resume' && sub.status !== 'paused') {
      return NextResponse.json({ error: 'Only paused subscriptions can be resumed' }, { status: 400 });
    }
    if (action === 'pause' && sub.status !== 'active') {
      return NextResponse.json({ error: 'Only active subscriptions can be paused' }, { status: 400 });
    }

    // Verify user owns the business
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', sub.business_id)
      .eq('owner_id', user.id)
      .single();

    if (!biz) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

    const now = new Date().toISOString();

    // Call gateway API
    if (sub.gateway === 'paystack' && sub.gateway_subscription_code) {
      const emailToken = sub.customer_email || '';

      if (action === 'pause') {
        const { cancelSubscription } = await import('@/lib/payments/paystack-recurring');
        await cancelSubscription(sub.gateway_subscription_code, emailToken);
      } else if (action === 'resume') {
        const { enableSubscription } = await import('@/lib/payments/paystack-recurring');
        await enableSubscription(sub.gateway_subscription_code, emailToken);
      } else if (action === 'cancel') {
        const { cancelSubscription } = await import('@/lib/payments/paystack-recurring');
        await cancelSubscription(sub.gateway_subscription_code, emailToken);
      }
    } else if (sub.gateway === 'stripe' && sub.gateway_subscription_code) {
      if (action === 'pause') {
        const { pauseSubscription } = await import('@/lib/payments/stripe-recurring');
        await pauseSubscription(sub.gateway_subscription_code);
      } else if (action === 'resume') {
        const { resumeSubscription } = await import('@/lib/payments/stripe-recurring');
        await resumeSubscription(sub.gateway_subscription_code);
      } else if (action === 'cancel') {
        const { cancelSubscription } = await import('@/lib/payments/stripe-recurring');
        await cancelSubscription(sub.gateway_subscription_code);
      }
    }

    // Update DB status
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
