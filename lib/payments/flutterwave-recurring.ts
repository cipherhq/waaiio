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

import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { safeProviderError } from '@/lib/redact';

const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET_KEY || '';
const BASE_URL = 'https://api.flutterwave.com';

// Flutterwave recurring split payments are gated behind FLUTTERWAVE_RECURRING_SPLIT_VERIFIED.
// Direct-split Flutterwave businesses will have recurring charges SKIPPED (not charged unsplit)
// until sandbox verification is completed and this env var is set to 'true'.
// The warning is logged on first skip in the retry cron, not at module load, to avoid
// noisy repeated logs in serverless environments.

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
  interval: 'weekly' | 'monthly' | 'yearly',
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
      logger.withContext({ op: 'flutterwave.create-plan', gateway: 'flutterwave', providerInfo: safeProviderError(data) }).error('Flutterwave create plan failed');
      return null;
    }

    const planData = data.data as Record<string, unknown>;
    return { planId: String(planData.id) };
  } catch (error) {
    logger.withContext({ op: 'flutterwave.create-plan', ...safeLogErrorContext(error) }).error('Flutterwave create plan error');
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
      logger.withContext({ op: 'flutterwave.get-plan', gateway: 'flutterwave', providerInfo: safeProviderError(planRes) }).error('Flutterwave get plan failed');
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
      logger.withContext({ op: 'flutterwave.subscription-charge', gateway: 'flutterwave', providerInfo: safeProviderError(chargeData) }).error('Flutterwave subscription charge failed');
      return null;
    }

    const chargeResult = chargeData.data as Record<string, unknown>;
    const txId = chargeResult.id ? String(chargeResult.id) : null;

    // Resolve the REAL Flutterwave subscription ID from this specific transaction.
    // Use Flutterwave's subscription lookup filtered by the exact transaction ID.
    if (txId) {
      try {
        const subsRes = await flutterwaveRequest(`/v3/subscriptions?transaction_id=${txId}`, 'GET');
        if (subsRes.status === 'success' && Array.isArray(subsRes.data) && subsRes.data.length > 0) {
          const realSub = subsRes.data[0] as Record<string, unknown>;
          return { subscriptionId: String(realSub.id) };
        }
      } catch { /* fall through to failure */ }
    }

    // Cannot resolve real subscription ID — fail safely
    logger.error('[FLUTTERWAVE] Could not resolve subscription ID from transaction', { txId, planId });
    return null;
  } catch (error) {
    logger.withContext({ op: 'flutterwave.create-subscription', ...safeLogErrorContext(error) }).error('Flutterwave create subscription error');
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
    logger.withContext({ op: 'flutterwave.cancel-subscription', ...safeLogErrorContext(error) }).error('Flutterwave cancel subscription error');
    return false;
  }
}

/**
 * Activate (resume) a Flutterwave subscription.
 * PUT /v3/subscriptions/{id}/activate
 */
export async function activateSubscription(subscriptionId: string): Promise<boolean> {
  if (!flutterwaveSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Flutterwave secret key');
    }
    return true;
  }

  try {
    const data = await flutterwaveRequest(
      `/v3/subscriptions/${encodeURIComponent(subscriptionId)}/activate`,
      'PUT',
    );
    return data.status === 'success';
  } catch (error) {
    logger.withContext({ op: 'flutterwave.activate-subscription', ...safeLogErrorContext(error) }).error('Flutterwave activate subscription error');
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
    logger.withContext({ op: 'flutterwave.get-subscription', ...safeLogErrorContext(error) }).error('Flutterwave get subscription error');
    return null;
  }
}

/**
 * Verify a Flutterwave transaction by tx_ref.
 * Used to reconcile provider state before finalization.
 */
export type FlwVerificationOutcome = 'successful' | 'pending' | 'failed' | 'unknown';

export async function verifyTransaction(txRef: string): Promise<{
  outcome: FlwVerificationOutcome;
  amount?: number;
  currency?: string;
  providerStatus?: string;
} | null> {
  if (!flutterwaveSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Flutterwave secret key');
    }
    return { outcome: 'successful', amount: 0, currency: 'NGN', providerStatus: 'successful' };
  }

  try {
    const data = await flutterwaveRequest(`/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`, 'GET');
    if (data.status !== 'success') {
      // API returned error — could mean tx doesn't exist yet (not found) or server error
      return { outcome: 'unknown', providerStatus: 'api_error' };
    }
    const txData = data.data as Record<string, unknown>;
    const providerStatus = txData.status as string;

    if (providerStatus === 'successful') {
      return { outcome: 'successful', amount: txData.amount as number, currency: txData.currency as string, providerStatus };
    }
    if (providerStatus === 'pending' || providerStatus === 'processing') {
      return { outcome: 'pending', providerStatus };
    }
    const TERMINAL_FAILURES = ['failed', 'declined', 'cancelled', 'error'];
    if (TERMINAL_FAILURES.includes(providerStatus)) {
      return { outcome: 'failed', providerStatus };
    }
    // Unrecognized status — unknown, not failed
    return { outcome: 'unknown', providerStatus: providerStatus || 'missing_status' };
  } catch {
    return null; // network/timeout — truly unknown
  }
}

/**
 * Charge a saved card token (for manual recurring charges or retries).
 *
 * POST /v3/tokenized-charges
 *
 * Split params (subaccounts) are accepted but GATED behind FLUTTERWAVE_RECURRING_SPLIT_VERIFIED.
 * Set this env var to 'true' only after confirming via Flutterwave sandbox that
 * POST /v3/tokenized-charges actually applies the subaccounts split to settlement.
 * Without verification, split params are silently omitted and the charge falls back
 * to platform collection (fail-open for unverified provider behavior).
 */
export type ChargeOutcome = 'successful' | 'pending' | 'failed' | 'unknown';

export async function chargeToken(
  token: string,
  amount: number,
  email: string,
  reference: string,
  currency?: string,
  splitParams?: { subaccounts: Array<{ id: string; transaction_charge_type: string; transaction_charge: number }> },
): Promise<{ outcome: ChargeOutcome; reference?: string }> {
  if (!flutterwaveSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Flutterwave secret key');
    }
    return { outcome: 'successful', reference: `mock_flw_charge_${Date.now()}` };
  }

  try {
    const verifiedSplit = process.env.FLUTTERWAVE_RECURRING_SPLIT_VERIFIED === 'true'
      ? splitParams
      : undefined;

    const data = await flutterwaveRequest('/v3/tokenized-charges', 'POST', {
      token,
      email,
      currency: currency || 'NGN',
      amount,
      tx_ref: reference,
      ...(verifiedSplit || {}),
    });

    const chargeData = data.data as Record<string, unknown> | undefined;
    const providerStatus = (chargeData?.status as string) || '';
    const ref = (chargeData?.tx_ref as string) || reference;

    // Only classify as successful/failed when the provider gives a definitive transaction status
    if (data.status === 'success' && providerStatus === 'successful') {
      return { outcome: 'successful', reference: ref };
    }
    if (providerStatus === 'pending' || providerStatus === 'processing') {
      return { outcome: 'pending', reference: ref };
    }
    // Definitive terminal failures only
    const TERMINAL_FAILURES = ['failed', 'declined', 'cancelled', 'error'];
    if (TERMINAL_FAILURES.includes(providerStatus)) {
      return { outcome: 'failed', reference: ref };
    }
    // Any other response (API error without transaction status, unrecognized status, missing data)
    // → unknown. Do NOT treat as definitive failure.
    return { outcome: 'unknown', reference: ref };
  } catch (error) {
    // Timeout, network error, malformed response — unknown whether charged
    logger.withContext({ op: 'flutterwave.charge-token', ...safeLogErrorContext(error) }).error('Flutterwave charge token error');
    return { outcome: 'unknown' };
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
    logger.withContext({ op: 'flutterwave.get-card-token', ...safeLogErrorContext(error) }).error('Flutterwave get card token error');
    return null;
  }
}
