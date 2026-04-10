import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { cancelSubscription as cancelStripeSub } from '@/lib/payments/stripe-recurring';
import { cancelSubscription as cancelPaystackSub } from '@/lib/payments/paystack-recurring';
import { logger } from '@/lib/logger';

export async function DELETE() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const serviceClient = createServiceClient();

    // Fetch business owned by this user
    const { data: business } = await serviceClient
      .from('businesses')
      .select('id')
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'No business found' }, { status: 404 });
    }

    // Cancel active customer subscriptions on payment gateways
    const { data: activeSubs } = await serviceClient
      .from('customer_subscriptions')
      .select('id, gateway, gateway_subscription_code, metadata')
      .eq('business_id', business.id)
      .in('status', ['active', 'past_due']);

    if (activeSubs && activeSubs.length > 0) {
      for (const sub of activeSubs) {
        if (sub.gateway === 'stripe' && sub.gateway_subscription_code) {
          await cancelStripeSub(sub.gateway_subscription_code).catch((e) =>
            logger.error(`[ACCOUNT] Failed to cancel Stripe sub ${sub.id}:`, e)
          );
        } else if (sub.gateway === 'paystack' && sub.gateway_subscription_code) {
          const emailToken = (sub.metadata as Record<string, string>)?.email_token || '';
          await cancelPaystackSub(sub.gateway_subscription_code, emailToken).catch((e) =>
            logger.error(`[ACCOUNT] Failed to cancel Paystack sub ${sub.id}:`, e)
          );
        }
      }

      // Mark all as cancelled in DB
      await serviceClient
        .from('customer_subscriptions')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
        .eq('business_id', business.id)
        .in('status', ['active', 'past_due']);
    }

    // Soft-delete business (preserves financial records)
    await serviceClient
      .from('businesses')
      .update({ status: 'deleted' })
      .eq('id', business.id);

    // Delete auth user (cascades to profiles via FK)
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(user.id);
    if (deleteError) {
      logger.error('[ACCOUNT] Failed to delete auth user:', deleteError);
      return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[ACCOUNT] DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
