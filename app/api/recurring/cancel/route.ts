import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { cancelSubscription as cancelPaystackSub } from '@/lib/payments/paystack-recurring';
import { cancelSubscription as cancelStripeSub } from '@/lib/payments/stripe-recurring';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = rateLimitResponse(getRateLimitKey(request, 'recurring-cancel'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const { subscriptionId, phone } = await request.json();

    if (!subscriptionId || !phone) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;
    const supabase = createServiceClient();

    // Verify ownership by phone
    const { data: sub } = await supabase
      .from('customer_subscriptions')
      .select('*')
      .eq('id', subscriptionId)
      .eq('customer_phone', normalizedPhone)
      .single();

    if (!sub) {
      return NextResponse.json({ error: 'Subscription not found' }, { status: 404 });
    }

    if (sub.status === 'cancelled') {
      return NextResponse.json({ success: true });
    }

    // Cancel on gateway
    if (sub.gateway === 'paystack' && sub.gateway_subscription_code) {
      await cancelPaystackSub(sub.gateway_subscription_code, sub.metadata?.email_token || '');
    } else if (sub.gateway === 'stripe' && sub.gateway_subscription_code) {
      await cancelStripeSub(sub.gateway_subscription_code);
    }

    // Update DB
    await supabase
      .from('customer_subscriptions')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', subscriptionId);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Recurring cancel error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
