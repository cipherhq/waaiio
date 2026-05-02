import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { initializePayment } from '@/lib/bot/flows/shared/payment';

export async function GET() {
  const result: Record<string, unknown> = {
    stripeKey: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.slice(0, 12) + '...' : 'MISSING',
  };

  try {
    const supabase = createServiceClient();

    // Simulate exact payment flow for Citadel
    const paymentResult = await initializePayment(supabase, {
      bookingId: undefined,
      userId: '00000000-0000-0000-0000-000000000001',
      amount: 100,
      referenceCode: 'DEBUG-TEST-' + Date.now(),
      businessName: 'Debug Test',
      phone: '+1234567890',
      countryCode: 'US',
      businessId: 'adea3e0c-47b0-4976-b961-2709b512ab04', // Citadel
    });

    // Check currency resolution
    const { getCountry } = await import('@/lib/countries');
    const country = getCountry('US');
    result.countryResolved = !!country;
    result.currencyCode = country?.currency_code || 'MISSING';

    if (paymentResult) {
      result.status = 'SUCCESS';
      result.url = paymentResult.url.slice(0, 80) + '...';
      result.reference = paymentResult.reference;
    } else {
      result.status = 'FAILED - initializePayment returned null';

      // Try calling Stripe directly to see if it's a Stripe error or a pre-Stripe error
      const key = process.env.STRIPE_SECRET_KEY || '';
      const directRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          'payment_method_types[0]': 'card',
          'line_items[0][price_data][currency]': 'usd',
          'line_items[0][price_data][product_data][name]': 'Direct Test',
          'line_items[0][price_data][unit_amount]': '10000',
          'line_items[0][quantity]': '1',
          mode: 'payment',
          success_url: 'https://waaiio.com/success',
          cancel_url: 'https://waaiio.com',
        }).toString(),
      });
      const directData = await directRes.json();
      result.directStripeWorks = !!directData.url;
      result.directStripeError = directData.error?.message;

      // Check what the gateway selection returns
      const { getPaymentGateway } = await import('@/lib/payments/factory');
      const gw = getPaymentGateway('US');
      result.selectedGateway = gw.name;

      // Check business payout config
      const { data: payout } = await supabase.from('payout_accounts').select('gateway, subaccount_code, stripe_account_id').eq('business_id', 'adea3e0c-47b0-4976-b961-2709b512ab04').eq('is_active', true).maybeSingle();
      result.payoutAccount = payout;

      const { data: biz } = await supabase.from('businesses').select('payout_mode').eq('id', 'adea3e0c-47b0-4976-b961-2709b512ab04').single();
      result.payoutMode = biz?.payout_mode;
    }
  } catch (err) {
    result.status = 'ERROR';
    result.error = (err as Error).message;
    result.stack = (err as Error).stack?.split('\n').slice(0, 5);
  }

  return NextResponse.json(result);
}
