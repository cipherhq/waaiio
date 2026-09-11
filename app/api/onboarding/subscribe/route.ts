import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { formatCurrency, type SubscriptionTier, type CountryCode } from '@/lib/constants';

const VALID_PLANS: SubscriptionTier[] = ['growth', 'business'];

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
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

    // #270: Annual billing is not supported — reject before any provider interaction
    if (billing_interval !== 'month') {
      return NextResponse.json(
        { message: 'Only monthly billing is currently supported.' },
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

    if (!business.country_code) {
      return NextResponse.json({ message: 'Business country code is required' }, { status: 400 });
    }
    const countryCode = business.country_code as CountryCode;

    // Read regional tier price directly from DB — fail closed, no hardcoded fallback
    const service = createServiceClient();
    const { data: countryRow, error: countryError } = await service
      .from('countries')
      .select('pricing, currency_code, payment_gateway')
      .eq('code', countryCode)
      .eq('is_active', true)
      .single();

    if (countryError || !countryRow?.pricing) {
      return NextResponse.json(
        { message: 'Regional pricing is unavailable. Please try again later.' },
        { status: 503 },
      );
    }

    const countryPricing = countryRow.pricing as Record<string, Record<string, number>>;
    const tierPricing = countryPricing[plan as string];

    if (!tierPricing || typeof tierPricing.price !== 'number' || tierPricing.price <= 0) {
      return NextResponse.json(
        { message: 'Plan pricing is unavailable for this region.' },
        { status: 503 },
      );
    }

    const monthlyPrice = tierPricing.price;
    const currency = countryRow.currency_code as string;
    const gateway = countryRow.payment_gateway as string;

    if (!currency) {
      return NextResponse.json({ message: 'Currency not configured for this region.' }, { status: 503 });
    }
    if (!gateway) {
      return NextResponse.json({ message: 'Payment gateway not configured for this region.' }, { status: 503 });
    }

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

    // Paystack path (NG, GH)
    if (gateway === 'paystack') {
      const paystackKey = process.env.PAYSTACK_SECRET_KEY;
      // Market+tier Paystack plan code — resolved from per-country pricing
      const pageSlug = tierPricing.paystack_plan_code as string | undefined;

      if (!paystackKey) {
        return NextResponse.json({ message: 'Payment gateway not configured' }, { status: 500 });
      }

      const amount = monthlyPrice * 100; // kobo/pesewa

      const payload: Record<string, unknown> = {
        email,
        amount,
        currency,
        callback_url: callbackUrl,
        metadata: {
          business_id,
          plan,
          billing_interval: 'month',
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

    // Explicit gateway dispatch — fail closed for unsupported gateways
    if (gateway !== 'stripe') {
      return NextResponse.json(
        { message: `Payment gateway "${gateway}" is not supported for subscription checkout.` },
        { status: 400 },
      );
    }

    // Stripe path
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return NextResponse.json({ message: 'Payment gateway not configured' }, { status: 500 });
    }

    const amountInCents = Math.round(monthlyPrice * 100);
    const tierName = plan === 'growth' ? 'Pro' : 'Premium';

    const stripeBody = new URLSearchParams({
      'payment_method_types[0]': 'card',
      'line_items[0][quantity]': '1',
      mode: 'subscription',
      success_url: callbackUrl,
      cancel_url: `${(process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com').trim()}/get-started`,
      customer_email: email,
      'metadata[business_id]': business_id,
      'metadata[plan]': plan,
      'metadata[billing_interval]': 'month',
      'metadata[type]': 'whatsapp_subscription',
      'metadata[user_id]': user.id,
    });

    stripeBody.set('line_items[0][price_data][currency]', currency.toLowerCase());
    stripeBody.set('line_items[0][price_data][product_data][name]', `Waaiio ${tierName} Plan (Monthly)`);
    stripeBody.set('line_items[0][price_data][unit_amount]', String(amountInCents));
    stripeBody.set('line_items[0][price_data][recurring][interval]', 'month');

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
