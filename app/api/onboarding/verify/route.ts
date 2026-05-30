import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { PRICING_TIERS, type SubscriptionTier } from '@/lib/constants';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { reference, business_id: bodyBusinessId, plan: bodyPlan } = body;

    let businessId: string | undefined;
    let plan: string | undefined;
    let amountSmallest = 0; // amount in smallest currency unit (kobo/cents)
    let gateway: string = 'none';
    let currency: string = 'NGN';

    // ── Stripe verification (checkout session IDs start with cs_) ──
    if (reference && reference.startsWith('cs_')) {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) {
        return NextResponse.json(
          { message: 'Payment gateway not configured' },
          { status: 500 },
        );
      }

      const response = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(reference)}`,
        {
          headers: { Authorization: `Bearer ${stripeKey}` },
          signal: AbortSignal.timeout(15000),
        },
      );

      const session = await response.json();

      if (session.error) {
        return NextResponse.json(
          { message: 'Invalid payment reference' },
          { status: 400 },
        );
      }

      if (session.payment_status !== 'paid') {
        return NextResponse.json(
          { message: 'Payment not yet confirmed', stripe_status: session.payment_status },
          { status: 402 },
        );
      }

      const metadata = session.metadata as Record<string, string> | undefined;
      businessId = metadata?.business_id || bodyBusinessId;
      plan = metadata?.plan || bodyPlan;
      amountSmallest = session.amount_total || 0;
      gateway = 'stripe';
      currency = (session.currency || 'usd').toUpperCase();
    }
    // ── Paystack verification ──
    else if (reference) {
      const paystackKey = process.env.PAYSTACK_SECRET_KEY;
      if (!paystackKey) {
        return NextResponse.json(
          { message: 'Payment gateway not configured' },
          { status: 500 },
        );
      }

      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${paystackKey}` } },
      );

      const data = await response.json();

      if (data?.data?.status !== 'success') {
        return NextResponse.json(
          { message: 'Payment not yet confirmed', paystack_status: data?.data?.status },
          { status: 402 },
        );
      }

      const metadata = data.data.metadata as Record<string, string> | undefined;
      businessId = metadata?.business_id || bodyBusinessId;
      plan = metadata?.plan || bodyPlan;
      amountSmallest = data.data.amount || 0;
      gateway = 'paystack';
      currency = (data.data.currency || 'NGN').toUpperCase();
    }
    // ── Free tier (no payment required) ──
    else if (bodyBusinessId && bodyPlan) {
      if (bodyPlan !== 'free') {
        return NextResponse.json(
          { message: 'Payment reference required for paid plans' },
          { status: 402 },
        );
      }
      businessId = bodyBusinessId;
      plan = bodyPlan;
    }

    if (!businessId || !plan) {
      return NextResponse.json(
        { message: 'Missing business_id, plan, or payment reference' },
        { status: 400 },
      );
    }

    const { data: ownerCheck } = await supabase
      .from('businesses')
      .select('owner_id, subscription_tier')
      .eq('id', businessId)
      .single();

    if (!ownerCheck || ownerCheck.owner_id !== user.id) {
      return NextResponse.json(
        { message: 'Business not found or not owned by you' },
        { status: 403 },
      );
    }

    const service = createServiceClient();

    const tier = PRICING_TIERS[plan as SubscriptionTier] || PRICING_TIERS.growth;
    const periodEnd = new Date();
    periodEnd.setDate(periodEnd.getDate() + 30);

    // Determine action: upgrade vs renewal
    const previousTier = ownerCheck.subscription_tier || 'free';
    const action = previousTier === plan ? 'renewal' : 'upgrade';

    // Upsert: one subscription per business (prevent duplicates on re-onboarding)
    const { data: subscription } = await service.from('subscriptions').upsert({
      business_id: businessId,
      plan,
      status: 'active',
      amount: amountSmallest ? Math.round(amountSmallest / 100) : (tier.price ?? 0),
      gateway: gateway !== 'none' ? gateway : null,
      currency,
      paystack_subscription_code: null,
      paystack_customer_code: null,
      current_period_start: new Date().toISOString(),
      current_period_end: periodEnd.toISOString(),
    }, { onConflict: 'business_id' }).select('id').single();

    // Record subscription payment (only for paid plans)
    if (plan !== 'free' && gateway !== 'none') {
      await service.from('subscription_payments').insert({
        business_id: businessId,
        subscription_id: subscription?.id || null,
        amount: amountSmallest,
        currency,
        gateway,
        gateway_reference: reference,
        plan,
        action,
        status: 'success',
      });
    }

    await service
      .from('businesses')
      .update({
        status: 'active',
        subscription_tier: plan,
      })
      .eq('id', businessId);

    const { data: business } = await service
      .from('businesses')
      .select('bot_code, slug')
      .eq('id', businessId)
      .single();

    return NextResponse.json({
      status: 'success',
      business_id: businessId,
      plan,
      bot_code: business?.bot_code,
      slug: business?.slug,
    });
  } catch (error) {
    return NextResponse.json(
      { message: 'Something went wrong' },
      { status: 500 },
    );
  }
}
