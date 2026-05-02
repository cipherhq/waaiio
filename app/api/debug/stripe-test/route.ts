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
      userId: '16d175ec-86b5-446a-ae67-0085e987c19d',
      amount: 100,
      referenceCode: 'DBG-' + Date.now(),
      businessName: 'Citadel Debug',
      phone: '+15712746425',
      countryCode: 'US',
      businessId: 'adea3e0c-47b0-4976-b961-2709b512ab04',
    });
    result.test2_initPayment = payResult ? `SUCCESS: ${payResult.url.slice(0, 50)}...` : 'RETURNED NULL';
    result.test2_lastError = (globalThis as Record<string, unknown>).__lastPaymentError || 'no error captured';
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

    // Call stripeRequest directly to see what Stripe returns
    const stripeKey = process.env.STRIPE_SECRET_KEY || '';
    const testParams = new URLSearchParams({
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': 'GW Debug',
      'line_items[0][price_data][unit_amount]': '5000',
      'line_items[0][quantity]': '1',
      mode: 'payment',
      success_url: 'https://waaiio.com/api/payments/stripe-success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://waaiio.com',
      'metadata[booking_id]': '',
      'metadata[order_id]': '',
      'metadata[user_id]': '00000000-0000-0000-0000-000000000001',
      'metadata[reference_code]': 'DBG-GW-' + Date.now(),
      'metadata[channel]': 'whatsapp',
    });
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: testParams.toString(),
    });
    const stripeData = await stripeRes.json();
    result.test3_stripeResponse = stripeData.url ? 'HAS_URL' : (stripeData.error?.message || JSON.stringify(stripeData).slice(0, 300));

    // Now test through gateway's stripeRequest directly
    const gwParams: Record<string, string> = {
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': 'GW Class Test',
      'line_items[0][price_data][unit_amount]': '5000',
      'line_items[0][quantity]': '1',
      mode: 'payment',
      success_url: 'https://waaiio.com/success',
      cancel_url: 'https://waaiio.com',
      'metadata[user_id]': '16d175ec-86b5-446a-ae67-0085e987c19d',
      'metadata[reference_code]': 'DBG-GW2-' + Date.now(),
      'metadata[channel]': 'whatsapp',
    };
    const gwRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(gwParams).toString(),
    });
    const gwData = await gwRes.json();

    if (gwData.url) {
      // Stripe works — try inserting payment record
      try {
        const { error: insertErr } = await supabase.from('payments').insert({
          booking_id: null,
          user_id: '16d175ec-86b5-446a-ae67-0085e987c19d',
          amount: 50,
          currency: 'USD',
          gateway: 'stripe',
          gateway_reference: gwData.id,
          status: 'pending',
          metadata: { reference_code: 'DBG', channel: 'whatsapp', order_id: null },
        });
        result.test3_paymentInsert = insertErr ? `INSERT FAILED: ${insertErr.message}` : 'INSERT SUCCESS';
      } catch (insErr) {
        result.test3_paymentInsert = `INSERT THREW: ${(insErr as Error).message}`;
      }
    }
    result.test3_gatewayDirect = gwData.url ? 'STRIPE_OK' : gwData.error?.message;
  } catch (e) {
    result.test3_gatewayDirect = `THREW: ${(e as Error).message}`;
  }

  return NextResponse.json(result);
}
