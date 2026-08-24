/**
 * Paystack Plans & Subscriptions API for recurring payments.
 * Used in NG/GH markets where Paystack is the primary gateway.
 */

import { logger } from '@/lib/logger';
import { safeProviderError } from '@/lib/redact';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';

async function paystackRequest(
  path: string,
  method: 'GET' | 'POST' = 'POST',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${paystackSecretKey}`,
      'Content-Type': 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Create a Paystack plan for recurring billing.
 * Plans define the interval and amount for subscriptions.
 */
export async function createPlan(opts: {
  name: string;
  interval: 'weekly' | 'monthly' | 'yearly'; // Waaiio canonical values
  amount: number; // in base currency (naira) — will be converted to kobo
  currency?: string;
}): Promise<{ planCode: string } | null> {
  if (!paystackSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Paystack secret key');
    }
    return { planCode: `mock_plan_${Date.now()}` };
  }

  // Paystack API uses 'annually' not 'yearly' — map the canonical Waaiio interval
  const PAYSTACK_INTERVAL_MAP: Record<string, string> = { weekly: 'weekly', monthly: 'monthly', yearly: 'annually' };
  const data = await paystackRequest('/plan', 'POST', {
    name: opts.name,
    interval: PAYSTACK_INTERVAL_MAP[opts.interval] || opts.interval,
    amount: Math.round(opts.amount * 100), // kobo
    currency: opts.currency || 'NGN',
  });

  if (!data.status) {
    logger.withContext({ op: 'paystack.create-plan', gateway: 'paystack', providerInfo: safeProviderError(data) }).error('Paystack create plan failed');
    return null;
  }

  const planData = data.data as Record<string, string>;
  return { planCode: planData.plan_code };
}

/**
 * Create a Paystack subscription using an existing authorization.
 * The customer's card will be charged automatically on each interval.
 */
export async function createSubscription(opts: {
  customer: string; // email or customer_code
  planCode: string;
  authorizationCode: string;
  startDate?: string; // ISO date string
}): Promise<{ subscriptionCode: string; emailToken: string } | null> {
  if (!paystackSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Paystack secret key');
    }
    return {
      subscriptionCode: `mock_sub_${Date.now()}`,
      emailToken: `mock_token_${Date.now()}`,
    };
  }

  const body: Record<string, unknown> = {
    customer: opts.customer,
    plan: opts.planCode,
    authorization: opts.authorizationCode,
  };
  if (opts.startDate) body.start_date = opts.startDate;

  const data = await paystackRequest('/subscription', 'POST', body);

  if (!data.status) {
    logger.withContext({ op: 'paystack.create-subscription', gateway: 'paystack', providerInfo: safeProviderError(data) }).error('Paystack create subscription failed');
    return null;
  }

  const subData = data.data as Record<string, string>;
  return {
    subscriptionCode: subData.subscription_code,
    emailToken: subData.email_token,
  };
}

/**
 * Typed Paystack transaction verification outcome (#176).
 * Preserves #168/#172 fail-closed semantics.
 */
export type PaystackVerifyOutcome =
  | { status: 'success'; amountMinor: number; currency: string; transactionId?: string }
  | { status: 'terminal_failure'; reason: string }
  | { status: 'pending'; txStatus: string }
  | { status: 'reversed' }
  | { status: 'not_found' }
  | { status: 'indeterminate'; reason: string };

/**
 * Verify a Paystack transaction by reference with typed outcomes.
 * Does NOT collapse results to boolean — preserves provider fidelity.
 */
export async function verifyPaystackTransaction(reference: string): Promise<PaystackVerifyOutcome> {
  if (!paystackSecretKey) {
    return { status: 'indeterminate', reason: 'no_credentials' };
  }

  try {
    const data = await paystackRequest(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      'GET',
    );

    if (!data.status) {
      // Paystack says the reference was not found or invalid
      return { status: 'not_found' };
    }

    const txData = data.data as Record<string, unknown>;
    const txStatus = txData.status as string;
    const txAmount = txData.amount as number; // kobo

    if (txStatus === 'success') {
      return {
        status: 'success',
        amountMinor: txAmount,
        currency: ((txData.currency as string) || 'NGN').toUpperCase(),
        transactionId: txData.id ? String(txData.id) : undefined,
      };
    }

    if (txStatus === 'failed' || txStatus === 'abandoned') {
      return { status: 'terminal_failure', reason: `paystack_tx_${txStatus}` };
    }

    if (txStatus === 'reversed') {
      return { status: 'reversed' };
    }

    // pending, processing, ongoing, queued, unknown
    return { status: 'pending', txStatus };
  } catch (err) {
    return { status: 'indeterminate', reason: 'network_error' };
  }
}

/**
 * Cancel (disable) a Paystack subscription.
 */
export async function cancelSubscription(
  subscriptionCode: string,
  emailToken: string,
): Promise<boolean> {
  if (!paystackSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Paystack secret key');
    }
    return true;
  }

  const data = await paystackRequest('/subscription/disable', 'POST', {
    code: subscriptionCode,
    token: emailToken,
  });

  return data.status === true;
}

/**
 * Extract authorization details from a completed Paystack transaction.
 * Called after a successful one-time payment to capture the card auth for recurring.
 */
export async function getAuthorization(reference: string): Promise<{
  authorizationCode: string;
  last4: string;
  brand: string;
  customerCode: string;
  email: string;
} | null> {
  if (!paystackSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Paystack secret key');
    }
    return {
      authorizationCode: `mock_auth_${Date.now()}`,
      last4: '4242',
      brand: 'visa',
      customerCode: `mock_cust_${Date.now()}`,
      email: 'mock@example.com',
    };
  }

  const data = await paystackRequest(
    `/transaction/verify/${encodeURIComponent(reference)}`,
    'GET',
  );

  if (!data.status) return null;

  const txData = data.data as Record<string, unknown>;
  const auth = txData.authorization as Record<string, string> | undefined;
  const customer = txData.customer as Record<string, string> | undefined;

  if (!auth?.authorization_code) return null;

  return {
    authorizationCode: auth.authorization_code,
    last4: auth.last4 || '',
    brand: auth.brand || '',
    customerCode: customer?.customer_code || '',
    email: customer?.email || '',
  };
}

/**
 * Re-enable a previously disabled Paystack subscription.
 */
export async function enableSubscription(
  subscriptionCode: string,
  emailToken: string,
): Promise<boolean> {
  if (!paystackSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Paystack secret key');
    }
    return true;
  }

  const data = await paystackRequest('/subscription/enable', 'POST', {
    code: subscriptionCode,
    token: emailToken,
  });

  return data.status === true;
}

/**
 * Charge an authorization (for retrying failed recurring charges).
 * Amount is in kobo (multiply by 100 before calling).
 */
export async function chargeAuthorization(
  authorizationCode: string,
  amountKobo: number,
  email: string,
  reference: string,
  splitParams?: { subaccount: string; transaction_charge: number },
): Promise<{ success: boolean; reference?: string }> {
  if (!paystackSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Paystack secret key');
    }
    return { success: true, reference: `mock_${Date.now()}` };
  }

  const data = await paystackRequest('/transaction/charge_authorization', 'POST', {
    authorization_code: authorizationCode,
    amount: amountKobo,
    email,
    reference,
    ...(splitParams || {}),
  });

  const txData = data.data as Record<string, unknown> | undefined;
  return {
    success: data.status === true && txData?.status === 'success',
    reference: (txData?.reference as string) || reference,
  };
}
