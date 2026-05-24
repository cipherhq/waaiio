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

    const paystackKey = process.env.PAYSTACK_SECRET_KEY;

    let businessId: string | undefined;
    let plan: string | undefined;
    let amountKobo = 0;

    if (reference && paystackKey) {
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
      amountKobo = data.data.amount || 0;
    } else if (bodyBusinessId && bodyPlan) {
      // Only allow free tier without payment verification
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
      .select('owner_id')
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

    // Upsert: one subscription per business (prevent duplicates on re-onboarding)
    await service.from('subscriptions').upsert({
      business_id: businessId,
      plan,
      status: 'active',
      amount: amountKobo ? Math.round(amountKobo / 100) : (tier.price ?? 0),
      paystack_subscription_code: null,
      paystack_customer_code: null,
      current_period_start: new Date().toISOString(),
      current_period_end: periodEnd.toISOString(),
    }, { onConflict: 'business_id' });

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
