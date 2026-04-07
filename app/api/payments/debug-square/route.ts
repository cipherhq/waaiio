import { NextResponse } from 'next/server';

// Temporary diagnostic endpoint — remove after debugging
export async function GET() {
  const hasToken = !!process.env.SQUARE_ACCESS_TOKEN;
  const hasLocation = !!process.env.SQUARE_LOCATION_ID;
  const env = process.env.SQUARE_ENVIRONMENT || 'not set';
  const tokenPrefix = process.env.SQUARE_ACCESS_TOKEN?.slice(0, 8) || 'empty';

  const baseUrl = env === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

  let squareTest: unknown = null;
  let squareError: string | null = null;

  if (hasToken && hasLocation) {
    try {
      const res = await fetch(`${baseUrl}/v2/online-checkout/payment-links`, {
        method: 'POST',
        headers: {
          'Square-Version': '2024-12-18',
          Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          quick_pay: {
            name: 'Debug Test - $1.00',
            price_money: { amount: 100, currency: 'USD' },
            location_id: process.env.SQUARE_LOCATION_ID,
          },
          checkout_options: {
            redirect_url: 'https://waaiio.com/debug',
            accepted_payment_methods: { cash_app_pay: true },
          },
        }),
      });
      squareTest = await res.json();
    } catch (e) {
      squareError = (e as Error).message;
    }
  }

  return NextResponse.json({
    hasToken,
    hasLocation,
    env,
    tokenPrefix,
    baseUrl,
    squareTest,
    squareError,
    appUrl: process.env.NEXT_PUBLIC_APP_URL || 'not set',
  });
}
