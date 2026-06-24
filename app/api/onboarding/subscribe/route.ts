import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { PRICING_TIERS, getPricingTiers, formatCurrency, type SubscriptionTier, type CountryCode } from '@/lib/constants';
import { getCountry } from '@/lib/countries';
import { getAnnualDiscount } from '@/lib/platformSettings';

const PLAN_PAGE_SLUGS: Record<string, Record<string, string | undefined>> = {
  month: {
    growth: process.env.PAYSTACK_GROWTH_PLAN_CODE,
    business: process.env.PAYSTACK_BUSINESS_PLAN_CODE,
  },
  year: {
    growth: process.env.PAYSTACK_GROWTH_ANNUAL_PLAN_CODE,
    business: process.env.PAYSTACK_BUSINESS_ANNUAL_PLAN_CODE,
  },
};

const STRIPE_ANNUAL_PRICE_IDS: Record<string, string | undefined> = {
  growth: process.env.STRIPE_GROWTH_ANNUAL_PRICE_ID,
  business: process.env.STRIPE_BUSINESS_ANNUAL_PRICE_ID,
};

type BillingInterval = 'month' | 'year';
const VALID_INTERVALS: BillingInterval[] = ['month', 'year'];
const VALID_PLANS: SubscriptionTier[] = ['growth', 'business'];

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { multiplier: ANNUAL_DISCOUNT } = await getAnnualDiscount({ useServiceClient: true });
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    let { business_id, plan, callback, billing_interval = 'month' } = await request.json();
    if (callback !== undefined && (!callback.startsWith('/') || callback.startsWith('//'))) callback = '/dashboard';

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

    if (!VALID_INTERVALS.includes(billing_interval)) {
      return NextResponse.json(
        { message: 'Invalid billing_interval. Must be month or year.' },
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
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com').trim();
    const callbackUrl = callback
      ? `${appUrl}${callback}`
      : `${appUrl}/get-started?step=success&business_id=${business_id}`;

    // Paystack path (NG, GH) — always use Transaction Initialize API
    if (gateway === 'paystack') {
      const paystackKey = process.env.PAYSTACK_SECRET_KEY;
      const pageSlug = PLAN_PAGE_SLUGS[billing_interval]?.[plan];

      if (!paystackKey) {
        return NextResponse.json({ message: 'Payment gateway not configured' }, { status: 500 });
      }

      const monthlyPrice = tier.price as number;
      const amount = billing_interval === 'year'
        ? Math.round(monthlyPrice * 12 * ANNUAL_DISCOUNT * 100) // kobo, annual with 20% discount
        : monthlyPrice * 100; // kobo, monthly

      const payload: Record<string, unknown> = {
        email,
        amount,
        currency: country?.currency_code ?? 'NGN',
        callback_url: callbackUrl,
        metadata: {
          business_id,
          plan,
          billing_interval,
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

    const monthlyPriceCents = Math.round((tier.price as number) * 100);
    const annualPriceId = billing_interval === 'year' ? STRIPE_ANNUAL_PRICE_IDS[plan] : undefined;
    const amountInCents = billing_interval === 'year'
      ? Math.round(monthlyPriceCents * 12 * ANNUAL_DISCOUNT) // annual with 20% discount
      : monthlyPriceCents;

    const stripeBody = new URLSearchParams({
      'payment_method_types[0]': 'card',
      'line_items[0][quantity]': '1',
      mode: 'subscription',
      success_url: callbackUrl,
      cancel_url: `${(process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com').trim()}/get-started`,
      customer_email: email,
      'metadata[business_id]': business_id,
      'metadata[plan]': plan,
      'metadata[billing_interval]': billing_interval,
      'metadata[type]': 'whatsapp_subscription',
      'metadata[user_id]': user.id,
    });

    // Use pre-created Stripe Price ID if available, otherwise use inline price_data
    if (annualPriceId) {
      stripeBody.set('line_items[0][price]', annualPriceId);
    } else {
      stripeBody.set('line_items[0][price_data][currency]', (country?.currency_code ?? 'USD').toLowerCase());
      stripeBody.set('line_items[0][price_data][product_data][name]', `Waaiio ${tier.name} Plan (${billing_interval === 'year' ? 'Annual' : 'Monthly'})`);
      stripeBody.set('line_items[0][price_data][unit_amount]', String(amountInCents));
      stripeBody.set('line_items[0][price_data][recurring][interval]', billing_interval);
    }

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
      { message: 'Something went wrong' },
      { status: 500 },
    );
  }
}
