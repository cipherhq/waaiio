import { NextResponse } from 'next/server';

export async function GET() {
  const clientId = process.env.PAYPAL_CLIENT_ID || '';
  const secret = process.env.PAYPAL_CLIENT_SECRET || '';
  const env = process.env.PAYPAL_ENVIRONMENT || 'not-set';
  const webhookId = process.env.PAYPAL_WEBHOOK_ID || '';

  const baseUrl = env === 'production'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

  const result: Record<string, unknown> = {
    clientIdPresent: !!clientId,
    clientIdLength: clientId.length,
    clientIdPrefix: clientId.slice(0, 10),
    secretPresent: !!secret,
    secretLength: secret.length,
    environment: env,
    webhookIdPresent: !!webhookId,
    baseUrl,
  };

  // Try to get a token
  if (clientId && secret) {
    try {
      const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      result.tokenSuccess = !!data.access_token;
      result.tokenError = data.error || null;
      result.tokenErrorDesc = data.error_description || null;

      // Try to create a test order
      if (data.access_token) {
        const orderRes = await fetch(`${baseUrl}/v2/checkout/orders`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${data.access_token}`,
            'Content-Type': 'application/json',
            'PayPal-Request-Id': `test-${Date.now()}`,
          },
          body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [{
              reference_id: 'DEBUG-TEST',
              amount: { currency_code: 'USD', value: '1.00' },
            }],
            payment_source: {
              paypal: {
                experience_context: {
                  return_url: 'https://www.waaiio.com/payment-success?ref=DEBUG',
                  cancel_url: 'https://www.waaiio.com',
                },
              },
            },
          }),
          signal: AbortSignal.timeout(10000),
        });
        const orderData = await orderRes.json();
        result.orderSuccess = !!orderData.id;
        result.orderId = orderData.id || null;
        result.orderStatus = orderData.status || null;
        result.orderError = orderData.name || null;
        result.orderErrorMessage = orderData.message || null;
        if (orderData.details) result.orderDetails = orderData.details;
      }
    } catch (err) {
      result.fetchError = (err as Error).message;
    }
  }

  return NextResponse.json(result);
}
