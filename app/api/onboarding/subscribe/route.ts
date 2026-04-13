import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { PRICING_TIERS, getPricingTiers, formatCurrency, type SubscriptionTier, type CountryCode } from '@/lib/constants';
import { getCountry } from '@/lib/countries';

const PLAN_PAGE_SLUGS: Record<string, string | undefined> = {
  growth: process.env.PAYSTACK_GROWTH_PLAN_CODE,
  business: process.env.PAYSTACK_BUSINESS_PLAN_CODE,
};

const VALID_PLANS: SubscriptionTier[] = ['growth', 'business'];

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const { business_id, plan, callback } = await request.json();

    if (!business_id || !plan) {
      return NextResponse.json(
        { message: 'Missing business_id or plan' },
        { status: 400 },
      );
    }

    if (!VALID_PLANS.includes(plan)) {
      return NextResponse.json(
        { message: 'Invalid plan. Must be growth or business.' },
        { status: 400 },
      );
    }

    const { data: business } = await supabase
      .from('businesses')
      .select('id, owner_id, country_code')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) {
      return NextResponse.json(
        { message: 'Business not found or not owned by you' },
        { status: 403 },
      );
    }

    const countryCode = (business.country_code || 'NG') as CountryCode;
    const country = getCountry(countryCode);
    const tiers = getPricingTiers(countryCode);
    const tier = tiers[plan as SubscriptionTier];
    const gateway = country?.payment_gateway ?? 'paystack';

    const { data: profile } = await supabase
      .from('profiles')
      .select('email, phone')
      .eq('id', user.id)
      .single();

    const email = profile?.email || `${(profile?.phone || user.id).replace('+', '')}@whatsapp.waaiio.com`;
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com').trim();
    const callbackUrl = callback
      ? `${appUrl}${callback}`
      : `${appUrl}/get-started?step=success&business_id=${business_id}`;

    // Paystack path (NG, GH)
    if (gateway === 'paystack') {
      const paystackKey = process.env.PAYSTACK_SECRET_KEY;
      const pageSlug = PLAN_PAGE_SLUGS[plan];

      if (pageSlug && !pageSlug.startsWith('PLN_')) {
        const paymentPageUrl = `https://paystack.com/buy/${pageSlug}?email=${encodeURIComponent(email)}&callback_url=${encodeURIComponent(callbackUrl)}&metadata[business_id]=${business_id}&metadata[plan]=${plan}&metadata[type]=whatsapp_subscription&metadata[user_id]=${user.id}`;
        return NextResponse.json({ authorization_url: paymentPageUrl, reference: null });
      }

      if (!paystackKey) {
        return NextResponse.json({ message: 'Payment gateway not configured' }, { status: 500 });
      }

      const amount = (tier.price as number) * 100; // kobo

      const payload: Record<string, unknown> = {
        email,
        amount,
        currency: country?.currency_code ?? 'NGN',
        callback_url: callbackUrl,
        metadata: {
          business_id,
          plan,
          type: 'whatsapp_subscription',
          user_id: user.id,
        },
      };

      if (pageSlug) payload.plan = pageSlug;

      const response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!data.status) {
        return NextResponse.json(
          { message: 'Failed to initialize payment', error: data.message },
          { status: 500 },
        );
      }

      return NextResponse.json({
        authorization_url: data.data.authorization_url,
        reference: data.data.reference,
      });
    }

    // Stripe path (US, GB, CA)
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return NextResponse.json({ message: 'Payment gateway not configured' }, { status: 500 });
    }

    const amountInCents = Math.round((tier.price as number) * 100);

    const stripeBody = new URLSearchParams({
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': country?.currency_code ?? 'NGN'.toLowerCase(),
      'line_items[0][price_data][product_data][name]': `Waaiio ${tier.name} Plan`,
      'line_items[0][price_data][unit_amount]': String(amountInCents),
      'line_items[0][quantity]': '1',
      mode: 'payment',
      success_url: callbackUrl,
      cancel_url: `${(process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com').trim()}/get-started`,
      customer_email: email,
      'metadata[business_id]': business_id,
      'metadata[plan]': plan,
      'metadata[type]': 'whatsapp_subscription',
      'metadata[user_id]': user.id,
    });

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: stripeBody.toString(),
    });

    const data = await response.json();

    if (!data.url) {
      return NextResponse.json(
        { message: 'Failed to initialize payment', error: data.error?.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      authorization_url: data.url,
      reference: data.id,
    });
  } catch (error) {
    return NextResponse.json(
      { message: 'Internal server error', error: (error as Error).message },
      { status: 500 },
    );
  }
}
