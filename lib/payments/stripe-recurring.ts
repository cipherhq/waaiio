/**
 * Stripe Subscriptions API for recurring payments.
 * Used in US/GB/CA markets where Stripe is the primary gateway.
 */

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

async function stripeRequest(
  path: string,
  method: 'POST' | 'DELETE' = 'POST',
  body?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    ...(body && { body: new URLSearchParams(body).toString() }),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Create a Stripe Checkout Session in subscription mode.
 * Returns a URL the customer can use to set up recurring billing.
 */
export async function createRecurringCheckout(opts: {
  businessName: string;
  serviceName: string;
  amount: number; // in base currency (dollars) — will be converted to cents
  currency: string;
  interval: 'week' | 'month';
  customerEmail?: string;
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, string>;
  stripeAccountId?: string;
  platformFeePercent?: number;
}): Promise<{ sessionId: string; url: string } | null> {
  if (!stripeSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Stripe secret key');
    }
    const mockId = `mock_stripe_sub_${Date.now()}`;
    return { sessionId: mockId, url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/pay?ref=${mockId}` };
  }

  const amountInCents = Math.round(opts.amount * 100);
  const callbackUrl = opts.successUrl || process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

  const params: Record<string, string> = {
    'payment_method_types[0]': 'card',
    'line_items[0][price_data][currency]': opts.currency.toLowerCase(),
    'line_items[0][price_data][product_data][name]': `${opts.businessName} - ${opts.serviceName}`,
    'line_items[0][price_data][unit_amount]': String(amountInCents),
    'line_items[0][price_data][recurring][interval]': opts.interval,
    'line_items[0][quantity]': '1',
    mode: 'subscription',
    success_url: `${callbackUrl}/payment-success?type=recurring`,
    cancel_url: opts.cancelUrl || callbackUrl,
  };

  if (opts.customerEmail) {
    params.customer_email = opts.customerEmail;
  }

  // Add metadata
  if (opts.metadata) {
    for (const [key, value] of Object.entries(opts.metadata)) {
      params[`metadata[${key}]`] = value;
    }
  }

  // Stripe Connect split
  if (opts.stripeAccountId) {
    const { loadPlatformSettings } = await import('@/lib/platformSettings');
    const psSettings = await loadPlatformSettings({ useServiceClient: true });
    const feePercent = opts.platformFeePercent ?? psSettings.default_platform_fee_percent;
    const feeAmount = Math.round(amountInCents * feePercent / 100);
    params['subscription_data[application_fee_percent]'] = String(feePercent);
    params['subscription_data[transfer_data][destination]'] = opts.stripeAccountId;
  }

  const data = await stripeRequest('/checkout/sessions', 'POST', params);

  if (!data.id || !data.url) {
    console.error('Stripe recurring checkout failed:', data);
    return null;
  }

  return {
    sessionId: data.id as string,
    url: data.url as string,
  };
}

/**
 * Cancel a Stripe subscription immediately.
 */
export async function cancelSubscription(subscriptionId: string): Promise<boolean> {
  if (!stripeSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Stripe secret key');
    }
    return true;
  }

  const data = await stripeRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, 'DELETE');
  return (data.status as string) === 'canceled';
}

/**
 * Pause a Stripe subscription (void upcoming invoices).
 */
export async function pauseSubscription(subscriptionId: string): Promise<boolean> {
  if (!stripeSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Stripe secret key');
    }
    return true;
  }

  const data = await stripeRequest(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    'POST',
    { 'pause_collection[behavior]': 'void' },
  );
  return !!data.id;
}

/**
 * Resume a paused Stripe subscription.
 */
export async function resumeSubscription(subscriptionId: string): Promise<boolean> {
  if (!stripeSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Stripe secret key');
    }
    return true;
  }

  const data = await stripeRequest(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    'POST',
    { 'pause_collection': '' },
  );
  return !!data.id;
}
