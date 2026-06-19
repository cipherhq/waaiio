/**
 * Flutterwave Payment Plans, Subscriptions & Tokenized Charges for recurring payments.
 * Used when a business has payment_gateway = 'flutterwave'.
 *
 * Recurring flow:
 * 1. First payment captures card token via standard charge
 * 2. createPlan() creates a payment plan (amount + interval)
 * 3. chargeToken() charges the saved card token on each interval
 * 4. cancelSubscription() cancels via PUT /v3/subscriptions/{id}/cancel
 *
 * Flutterwave API docs: https://developer.flutterwave.com/reference
 */

const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY || '';
const BASE_URL = 'https://api.flutterwave.com';

async function flutterwaveRequest(
  path: string,
  method: 'GET' | 'POST' | 'PUT' = 'POST',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${flutterwaveSecretKey}`,
      'Content-Type': 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Create a Flutterwave payment plan for recurring billing.
 * Plans define the interval and amount for subscriptions.
 *
 * POST /v3/payment-plans
 * duration: 0 = infinite (until cancelled)
 */
export async function createPlan(
  name: string,
  amount: number,
  interval: 'weekly' | 'monthly',
): Promise<{ planId: string } | null> {
  if (!flutterwaveSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Flutterwave secret key');
    }
    return { planId: `mock_flw_plan_${Date.now()}` };
  }

  try {
    const data = await flutterwaveRequest('/v3/payment-plans', 'POST', {
      amount,
      name,
      interval,
      duration: 0, // infinite — runs until cancelled
    });

    if (data.status !== 'success') {
      console.error('Flutterwave create plan failed:', data.message);
      return null;
    }

    const planData = data.data as Record<string, unknown>;
    return { planId: String(planData.id) };
  } catch (error) {
    console.error('Flutterwave create plan error:', (error as Error).message);
    return null;
  }
}

/**
 * Subscribe a customer to a plan using their card token.
 * Uses tokenized charges to initiate the first recurring charge,
 * then Flutterwave auto-charges on the plan interval.
 *
 * POST /v3/tokenized-charges
 * The token comes from a previous successful charge (card.token in webhook data).
 */
export async function createSubscription(
  planId: string,
  customerEmail: string,
  cardToken: string,
): Promise<{ subscriptionId: string } | null> {
  if (!flutterwaveSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Flutterwave secret key');
    }
    return { subscriptionId: `mock_flw_sub_${Date.now()}` };
  }

  try {
    // Fetch the plan to get the amount
    const planRes = await flutterwaveRequest(`/v3/payment-plans/${encodeURIComponent(planId)}`, 'GET');
    if (planRes.status !== 'success') {
      console.error('Flutterwave get plan failed:', planRes.message);
      return null;
    }

    const planData = planRes.data as Record<string, unknown>;
    const planAmount = planData.amount as number;

    // Create a tokenized charge linked to the payment plan
    const txRef = `flw_sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const chargeData = await flutterwaveRequest('/v3/tokenized-charges', 'POST', {
      token: cardToken,
      email: customerEmail,
      currency: (planData.currency as string) || 'NGN',
      amount: planAmount,
      tx_ref: txRef,
      payment_plan: planId,
    });

    if (chargeData.status !== 'success') {
      console.error('Flutterwave subscription charge failed:', chargeData.message);
      return null;
    }

    const chargeResult = chargeData.data as Record<string, unknown>;
    // The subscription ID is created by Flutterwave when the charge is linked to a plan.
    // We use the tx_ref as our subscription identifier; Flutterwave will auto-charge on schedule.
    return { subscriptionId: (chargeResult.id ? String(chargeResult.id) : txRef) };
  } catch (error) {
    console.error('Flutterwave create subscription error:', (error as Error).message);
    return null;
  }
}

/**
 * Cancel a Flutterwave subscription.
 *
 * PUT /v3/subscriptions/{id}/cancel
 */
export async function cancelSubscription(subscriptionId: string): Promise<boolean> {
  if (!flutterwaveSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Flutterwave secret key');
    }
    return true;
  }

  try {
    const data = await flutterwaveRequest(
      `/v3/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      'PUT',
    );
    return data.status === 'success';
  } catch (error) {
    console.error('Flutterwave cancel subscription error:', (error as Error).message);
    return false;
  }
}

/**
 * Get subscription details from Flutterwave.
 *
 * GET /v3/subscriptions/{id}
 */
export async function getSubscription(subscriptionId: string): Promise<{
  id: string;
  status: string;
  amount: number;
  planId: string;
} | null> {
  if (!flutterwaveSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Flutterwave secret key');
    }
    return {
      id: subscriptionId,
      status: 'active',
      amount: 0,
      planId: `mock_flw_plan_${Date.now()}`,
    };
  }

  try {
    const data = await flutterwaveRequest(
      `/v3/subscriptions/${encodeURIComponent(subscriptionId)}`,
      'GET',
    );

    if (data.status !== 'success') return null;

    const subData = data.data as Record<string, unknown>;
    return {
      id: String(subData.id),
      status: (subData.status as string) || 'unknown',
      amount: (subData.amount as number) || 0,
      planId: String((subData.plan as number) || ''),
    };
  } catch (error) {
    console.error('Flutterwave get subscription error:', (error as Error).message);
    return null;
  }
}

/**
 * Charge a saved card token (for manual recurring charges or retries).
 *
 * POST /v3/tokenized-charges
 */
export async function chargeToken(
  token: string,
  amount: number,
  email: string,
  reference: string,
  currency?: string,
): Promise<{ success: boolean; reference?: string }> {
  if (!flutterwaveSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Flutterwave secret key');
    }
    return { success: true, reference: `mock_flw_charge_${Date.now()}` };
  }

  try {
    const data = await flutterwaveRequest('/v3/tokenized-charges', 'POST', {
      token,
      email,
      currency: currency || 'NGN',
      amount,
      tx_ref: reference,
    });

    const chargeData = data.data as Record<string, unknown> | undefined;
    return {
      success: data.status === 'success' && chargeData?.status === 'successful',
      reference: (chargeData?.tx_ref as string) || reference,
    };
  } catch (error) {
    console.error('Flutterwave charge token error:', (error as Error).message);
    return { success: false };
  }
}

/**
 * Extract card token from a completed Flutterwave transaction.
 * Called after a successful payment to capture the card token for recurring charges.
 *
 * GET /v3/transactions/verify_by_reference?tx_ref={reference}
 */
export async function getCardToken(reference: string): Promise<{
  token: string;
  last4: string;
  brand: string;
  email: string;
} | null> {
  if (!flutterwaveSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Flutterwave secret key');
    }
    return {
      token: `mock_flw_token_${Date.now()}`,
      last4: '4242',
      brand: 'visa',
      email: 'mock@example.com',
    };
  }

  try {
    const data = await flutterwaveRequest(
      `/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      'GET',
    );

    if (data.status !== 'success') return null;

    const txData = data.data as Record<string, unknown>;
    const card = txData.card as Record<string, string> | undefined;

    if (!card?.token) return null;

    return {
      token: card.token,
      last4: card.last_4digits || card.last4 || '',
      brand: card.type || card.brand || '',
      email: (txData.customer as Record<string, string>)?.email || '',
    };
  } catch (error) {
    console.error('Flutterwave get card token error:', (error as Error).message);
    return null;
  }
}
