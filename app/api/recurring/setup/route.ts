import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { getPaymentGateway } from '@/lib/payments/factory';
import { createRecurringCheckout } from '@/lib/payments/stripe-recurring';
import type { CountryCode } from '@/lib/constants';
import { getCountry } from '@/lib/countries';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { businessId, serviceId, amount, frequency, customerName, customerEmail, customerPhone, channel } = body;

    if (!businessId || !serviceId || !amount || !frequency || !customerName || !customerEmail || !customerPhone) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Fetch business
    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, slug, country_code, recurring_enabled, payment_gateway')
      .eq('id', businessId)
      .single();

    if (!business || !business.recurring_enabled) {
      return NextResponse.json({ error: 'Recurring payments not enabled for this business' }, { status: 400 });
    }

    const cc = (business.country_code || 'NG') as CountryCode;
    const currencyCode = getCountry(cc)?.currency_code ?? 'NGN';
    const isPaystack = ['NG', 'GH'].includes(cc);

    // For web setup, we create a subscription checkout
    // Paystack: Initialize a one-time payment first (auth will be captured via webhook)
    // Stripe: Create subscription checkout session directly

    if (isPaystack) {
      // For Paystack, initialize a one-time payment first
      // After payment succeeds, the webhook will capture authorization
      // Then the customer can be prompted to set up recurring via WhatsApp
      const gateway = getPaymentGateway(cc);
      const result = await gateway.initializePayment({
        supabase,
        userId: '', // Will be created/matched
        amount: parseFloat(amount),
        currency: currencyCode,
        referenceCode: `REC-${Date.now()}`,
        businessName: business.name,
        phone: customerPhone,
        userEmail: customerEmail,
      });

      if (!result) {
        return NextResponse.json({ error: 'Failed to initialize payment' }, { status: 500 });
      }

      // Create pending subscription record
      const nextCharge = new Date();
      if (frequency === 'weekly') nextCharge.setDate(nextCharge.getDate() + 7);
      else nextCharge.setMonth(nextCharge.getMonth() + 1);

      await supabase.from('customer_subscriptions').insert({
        business_id: businessId,
        user_id: '00000000-0000-0000-0000-000000000000', // Placeholder, will be updated
        service_id: serviceId,
        amount: parseFloat(amount),
        currency: currencyCode,
        frequency,
        status: 'active',
        gateway: 'paystack',
        next_charge_at: nextCharge.toISOString(),
        customer_name: customerName,
        customer_phone: customerPhone,
        customer_email: customerEmail,
        setup_channel: channel || 'web',
        metadata: { payment_reference: result.reference, pending_auth_capture: true },
      });

      return NextResponse.json({ url: result.url, reference: result.reference });
    } else {
      // Stripe: create subscription checkout
      const checkout = await createRecurringCheckout({
        businessName: business.name,
        serviceName: `Recurring ${frequency} payment`,
        amount: parseFloat(amount),
        currency: currencyCode.toLowerCase(),
        interval: frequency === 'weekly' ? 'week' : 'month',
        customerEmail,
        metadata: {
          business_id: businessId,
          service_id: serviceId,
          type: 'customer_recurring',
          customer_phone: customerPhone,
          customer_name: customerName,
        },
      });

      if (!checkout) {
        return NextResponse.json({ error: 'Failed to create checkout' }, { status: 500 });
      }

      // Create pending subscription
      const nextCharge = new Date();
      if (frequency === 'weekly') nextCharge.setDate(nextCharge.getDate() + 7);
      else nextCharge.setMonth(nextCharge.getMonth() + 1);

      await supabase.from('customer_subscriptions').insert({
        business_id: businessId,
        user_id: '00000000-0000-0000-0000-000000000000',
        service_id: serviceId,
        amount: parseFloat(amount),
        currency: currencyCode,
        frequency,
        status: 'active',
        gateway: 'stripe',
        gateway_subscription_code: checkout.sessionId,
        next_charge_at: nextCharge.toISOString(),
        customer_name: customerName,
        customer_phone: customerPhone,
        customer_email: customerEmail,
        setup_channel: channel || 'web',
      });

      return NextResponse.json({ url: checkout.url, sessionId: checkout.sessionId });
    }
  } catch (error) {
    console.error('Recurring setup error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
