import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { cancelSubscription as cancelStripeSub } from '@/lib/payments/stripe-recurring';
import { cancelSubscription as cancelPaystackSub } from '@/lib/payments/paystack-recurring';
import { logger } from '@/lib/logger';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Owner-requested local downgrade; provider cancellation is attempted, not assumed. */
export async function POST(request: Request) {
  let providerAttempted = false;
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request' }, { status: 400 }); }
    const { businessId, operationId = randomUUID() } = body || {};
    if (typeof businessId !== 'string' || !UUID.test(businessId) || typeof operationId !== 'string' || !UUID.test(operationId)) {
      return NextResponse.json({ error: 'Valid businessId and operationId required' }, { status: 400 });
    }
    const service = createServiceClient();
    const { data: biz, error: businessError } = await service.from('businesses')
      .select('id, owner_id, subscription_tier, updated_at').eq('id', businessId).eq('owner_id', user.id).maybeSingle();
    if (businessError) return NextResponse.json({ error: 'Unable to verify business ownership' }, { status: 503 });
    if (!biz) return NextResponse.json({ error: 'Not found or not authorized' }, { status: 403 });

    // Completed retry must return before any repeated provider request.
    const { data: receipt, error: receiptError } = await service.from('subscription_payments')
      .select('id, business_id, amount, gateway, plan, action, status, provider_reference, gateway_reference')
      .eq('id', operationId).maybeSingle();
    if (receiptError) return NextResponse.json({ error: 'Unable to verify downgrade retry' }, { status: 503 });
    if (receipt) {
      if (receipt.business_id !== businessId || receipt.provider_reference !== `user-downgrade:${user.id}:${operationId}`
        || receipt.gateway !== 'none' || receipt.plan !== 'free' || receipt.action !== 'downgrade'
        || receipt.status !== 'success' || Number(receipt.amount) !== 0
        || !/^state:[0-9a-f]{64}$/.test(receipt.gateway_reference || '')) {
        return NextResponse.json({ error: 'Downgrade operation conflicts with another request' }, { status: 409 });
      }
      return NextResponse.json({ success: true, downgraded: false, replayed: true, operationId, current_tier: biz.subscription_tier,
        provider_cancellation_confirmed: null, provider_warning: 'This earlier downgrade request was completed. Your plan may have changed since then. Refresh to see your current plan. Provider cancellation was not checked again.' });
    }
    const { data: subscriptions, error: subscriptionError } = await service.from('subscriptions')
      .select('id, status, gateway, plan, stripe_subscription_id, paystack_subscription_code, paystack_customer_code, metadata, updated_at')
      .eq('business_id', businessId).eq('status', 'active').order('id');
    if (subscriptionError || !subscriptions) return NextResponse.json({ error: 'Unable to verify active subscription' }, { status: 503 });
    if (subscriptions.length > 1) return NextResponse.json({ error: 'Subscription state needs review before downgrade' }, { status: 409 });
    let providerConfirmed = true;
    for (const sub of subscriptions) {
      if (sub.stripe_subscription_id) {
        providerAttempted = true;
        try { if (!(await cancelStripeSub(sub.stripe_subscription_id))) providerConfirmed = false; }
        catch { providerConfirmed = false; }
      }
      if (sub.paystack_subscription_code) {
        providerAttempted = true;
        const metadata = sub.metadata && typeof sub.metadata === 'object' ? sub.metadata as Record<string, unknown> : {};
        try { if (!(await cancelPaystackSub(sub.paystack_subscription_code, typeof metadata.email_token === 'string' ? metadata.email_token : ''))) providerConfirmed = false; }
        catch { providerConfirmed = false; }
      }
      if (!sub.stripe_subscription_id && !sub.paystack_subscription_code) providerConfirmed = false;
    }
    // Existing policy: local downgrade continues even when cancellation is unconfirmed.
    const { data: result, error: commitError } = await service.rpc('complete_owner_subscription_downgrade', {
      p_business_id: businessId, p_actor_id: user.id, p_operation_id: operationId,
      p_expected_business: { subscription_tier: biz.subscription_tier, updated_at: biz.updated_at },
      p_expected_subscriptions: subscriptions,
    });
    if (commitError || !result?.downgraded) {
      const conflict = /downgrade_(state_changed|operation_conflict|not_authorized)/.test(commitError?.message || '');
      return NextResponse.json({ success: false, error: conflict ? 'Subscription state changed. Refresh before trying again.' : 'Local downgrade was not completed. Please try again.',
        operationId, provider_cancellation_may_have_changed: providerAttempted }, { status: conflict ? 409 : 503 });
    }
    return NextResponse.json({ success: true, downgraded: result.replayed !== true, replayed: result.replayed === true, operationId,
      provider_cancellation_confirmed: providerAttempted ? providerConfirmed : null,
      ...(providerConfirmed ? {} : { provider_warning: 'Your plan is now Free, but provider cancellation could not be confirmed. Please check your billing provider.' }) });
  } catch {
    logger.error('[SUB-CANCEL] Downgrade request failed');
    return NextResponse.json({ error: 'Local downgrade could not be confirmed', provider_cancellation_may_have_changed: providerAttempted }, { status: 500 });
  }
}
