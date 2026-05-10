import { NextResponse } from 'next/server';

export async function GET() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  const result: Record<string, unknown> = {
    keyPresent: !!key,
    keyPrefix: key ? key.slice(0, 15) + '...' : 'MISSING',
  };

  try {
    const { createServiceClient } = await import('@/lib/supabase/service');
    const supabase = createServiceClient();

    // Test with RUNWAY (clean US business, no payout account)
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');

    let payResult = null;
    let payError = null;
    try {
      payResult = await initializePayment(supabase, {
        userId: '16d175ec-86b5-446a-ae67-0085e987c19d',
        amount: 10,
        referenceCode: 'DBG-RW-' + Date.now(),
        businessName: 'Runway Debug',
        phone: '+15712746425',
        countryCode: 'US',
        businessId: 'e7366703-8b7e-4655-a4c2-11a8e4f6d927',
      });
    } catch (e) {
      payError = (e as Error).message;
    }

    result.initPayment = payResult ? `SUCCESS: ${payResult.url.slice(0, 60)}...` : 'NULL';
    result.initPaymentError = payError;
    result.lastGlobalError = (globalThis as Record<string, unknown>).__lastPaymentError || 'none';

    // Also test gateway class directly with minimal params
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    const gw = getPaymentGateway('US');

    let gwResult = null;
    let gwError = null;
    try {
      gwResult = await gw.initializePayment({
        supabase,
        userId: '16d175ec-86b5-446a-ae67-0085e987c19d',
        amount: 10,
        currency: 'USD',
        referenceCode: 'DBG-GW-' + Date.now(),
        businessName: 'GW Direct',
        phone: '+15712746425',
      });
    } catch (e) {
      gwError = (e as Error).message;
    }

    result.gatewayDirect = gwResult ? `SUCCESS: ${gwResult.url.slice(0, 60)}...` : 'NULL';
    result.gatewayError = gwError;
    result.stripeDebug = (globalThis as Record<string, unknown>).__stripeDebug || 'not captured';

    // Raw Stripe test from THIS server
    const rawRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        'payment_method_types[0]': 'card',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': 'Raw Test',
        'line_items[0][price_data][unit_amount]': '1000',
        'line_items[0][quantity]': '1',
        mode: 'payment',
        success_url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com'}/success`,
        cancel_url: process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com',
      }).toString(),
    });
    const rawData = await rawRes.json();
    result.rawStripe = rawData.url ? 'HAS_URL' : (rawData.error?.message || JSON.stringify(rawData).slice(0, 200));
    result.rawStripeStatus = rawRes.status;

  } catch (e) {
    result.topLevelError = (e as Error).message;
  }

  return NextResponse.json(result);
}
