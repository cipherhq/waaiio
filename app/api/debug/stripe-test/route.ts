import { NextResponse } from 'next/server';

export async function GET() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  const result: Record<string, unknown> = {
    keyPresent: !!key,
    keyPrefix: key ? key.slice(0, 15) + '...' : 'MISSING',
  };

  // Test 1: Direct Stripe call (no Waaiio code)
  try {
    const params = new URLSearchParams({
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': 'Citadel Test',
      'line_items[0][price_data][unit_amount]': '10000',
      'line_items[0][quantity]': '1',
      mode: 'payment',
      success_url: 'https://waaiio.com/api/payments/stripe-success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://waaiio.com',
    });

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const data = await res.json();
    result.test1_direct = data.url ? 'SUCCESS' : (data.error?.message || 'FAILED');
  } catch (e) {
    result.test1_direct = (e as Error).message;
  }

  // Test 2: Through initializePayment with Citadel business ID
  try {
    const { createServiceClient } = await import('@/lib/supabase/service');
    const supabase = createServiceClient();
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');

    const payResult = await initializePayment(supabase, {
      userId: '00000000-0000-0000-0000-000000000001',
      amount: 100,
      referenceCode: 'DBG-' + Date.now(),
      businessName: 'Citadel Debug',
      phone: '+12345678900',
      countryCode: 'US',
      businessId: 'adea3e0c-47b0-4976-b961-2709b512ab04',
    });
    result.test2_initPayment = payResult ? `SUCCESS: ${payResult.url.slice(0, 50)}...` : 'RETURNED NULL';
  } catch (e) {
    result.test2_initPayment = `THREW: ${(e as Error).message}`;
    result.test2_stack = (e as Error).stack?.split('\n').slice(0, 5);
  }

  // Test 3: Through gateway directly (skip business config)
  try {
    const { createServiceClient } = await import('@/lib/supabase/service');
    const supabase = createServiceClient();
    const { getPaymentGateway } = await import('@/lib/payments/factory');
    const gw = getPaymentGateway('US');

    const gwResult = await gw.initializePayment({
      supabase,
      userId: '00000000-0000-0000-0000-000000000001',
      amount: 50,
      currency: 'USD',
      referenceCode: 'DBG-GW-' + Date.now(),
      businessName: 'Gateway Debug',
      phone: '+12345678900',
    });
    result.test3_gatewayDirect = gwResult ? `SUCCESS: ${gwResult.url.slice(0, 50)}...` : 'RETURNED NULL';
  } catch (e) {
    result.test3_gatewayDirect = `THREW: ${(e as Error).message}`;
  }

  return NextResponse.json(result);
}
