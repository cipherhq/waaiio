import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { cancelSubscription as cancelStripeSub } from '@/lib/payments/stripe-recurring';
import { cancelSubscription as cancelPaystackSub } from '@/lib/payments/paystack-recurring';
import { logger } from '@/lib/logger';

/**
 * POST /api/subscriptions/cancel
 * Cancels the active platform subscription on the payment gateway (Stripe or Paystack).
 * Called during downgrade to free plan so the recurring charge stops.
 *
 * Body: { businessId: string }
 * Auth: requires logged-in user who owns the business.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { businessId } = body;
    if (!businessId) {
      return NextResponse.json({ error: 'businessId required' }, { status: 400 });
    }

    // Verify ownership
    const service = createServiceClient();
    const { data: biz } = await service
      .from('businesses')
      .select('id, owner_id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!biz) {
      return NextResponse.json({ error: 'Not found or not authorized' }, { status: 403 });
    }

    // Fetch active subscription with gateway IDs
    const { data: sub } = await service
      .from('subscriptions')
      .select('id, status, stripe_subscription_id, paystack_subscription_code, paystack_customer_code, metadata')
      .eq('business_id', businessId)
      .eq('status', 'active')
      .maybeSingle();

    if (!sub) {
      // No active subscription to cancel — not an error
      return NextResponse.json({ success: true, message: 'No active subscription' });
    }

    const errors: string[] = [];

    // Cancel on Stripe if applicable
    if (sub.stripe_subscription_id) {
      try {
        await cancelStripeSub(sub.stripe_subscription_id);
        logger.info(`[SUB-CANCEL] Cancelled Stripe subscription ${sub.stripe_subscription_id} for business ${businessId}`);
      } catch (e) {
        logger.error(`[SUB-CANCEL] Failed to cancel Stripe sub ${sub.stripe_subscription_id}:`, e);
        errors.push('Stripe cancellation failed');
      }
    }

    // Cancel on Paystack if applicable
    if (sub.paystack_subscription_code) {
      try {
        const metadata = (sub.metadata || {}) as Record<string, string>;
        const emailToken = metadata.email_token || '';
        await cancelPaystackSub(sub.paystack_subscription_code, emailToken);
        logger.info(`[SUB-CANCEL] Cancelled Paystack subscription ${sub.paystack_subscription_code} for business ${businessId}`);
      } catch (e) {
        logger.error(`[SUB-CANCEL] Failed to cancel Paystack sub ${sub.paystack_subscription_code}:`, e);
        errors.push('Paystack cancellation failed');
      }
    }

    if (errors.length > 0) {
      return NextResponse.json({ success: false, errors }, { status: 502 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[SUB-CANCEL] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
