import { NextResponse } from 'next/server';

export async function GET() {
  const key = process.env.STRIPE_SECRET_KEY || '';

  const result: Record<string, unknown> = {
    keyPresent: !!key,
    keyPrefix: key ? key.slice(0, 12) + '...' : 'MISSING',
    keyLength: key.length,
  };

  if (!key) {
    return NextResponse.json({ ...result, error: 'No Stripe key' });
  }

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'payment_method_types[0]': 'card',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': 'Debug Test',
        'line_items[0][price_data][unit_amount]': '1000',
        'line_items[0][quantity]': '1',
        mode: 'payment',
        success_url: 'https://waaiio.com/success',
        cancel_url: 'https://waaiio.com',
      }).toString(),
    });

    const data = await res.json();

    if (data.url) {
      result.status = 'SUCCESS';
      result.checkoutUrl = (data.url as string).slice(0, 60) + '...';
    } else {
      result.status = 'FAILED';
      result.stripeError = data.error?.message || JSON.stringify(data).slice(0, 200);
    }
  } catch (err) {
    result.status = 'ERROR';
    result.error = (err as Error).message;
  }

  return NextResponse.json(result);
}
