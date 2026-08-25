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
    // Use raw fetch for HTTP fidelity (#172 pattern) — paystackRequest doesn't preserve HTTP status
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${paystackSecretKey}` }, signal: AbortSignal.timeout(15000) },
    );

    if (!response.ok) {
      // HTTP error — NOT the same as "transaction not found"
      if (response.status === 401 || response.status === 403) {
        return { status: 'indeterminate', reason: `http_${response.status}_config` };
      }
      return { status: 'indeterminate', reason: `http_${response.status}` };
    }

    const data = await response.json();

    if (!data.status || !data.data) {
      // Paystack says the reference was not found or invalid
      return { status: 'not_found' };
    }

    const txData = data.data as Record<string, unknown> | undefined;
    if (!txData) {
      return { status: 'not_found' };
    }
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
 * Typed outcome for Paystack charge_authorization (#176).
 * Preserves #168/#172 HTTP fidelity and fail-closed semantics.
 *
 * Post-dispatch semantics:
 * - success → mark charged (webhook will finalize)
 * - pending → leave dispatched (reconcile next run)
 * - terminal_failure → mark failed (allow retry next cycle)
 * - indeterminate → leave dispatched (reconcile next run, NEVER authorize replacement)
 */
export type PaystackChargeOutcome =
  | { status: 'success'; reference: string; transactionId?: string }
  | { status: 'pending'; providerStatus: string; reference: string }
  | { status: 'terminal_failure'; reason: string; reference: string }
  | { status: 'indeterminate'; reason: string };

/**
 * Charge an authorization with typed outcome boundary (#176).
 * Uses raw fetch for HTTP fidelity (#172 pattern).
 * Amount is in kobo (multiply by 100 before calling).
 */
export async function chargeAuthorization(
  authorizationCode: string,
  amountKobo: number,
  email: string,
  reference: string,
  splitParams?: { subaccount: string; transaction_charge: number },
): Promise<PaystackChargeOutcome> {
  if (!paystackSecretKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Payment gateway not configured: missing Paystack secret key');
    }
    return { status: 'success', reference: `mock_${Date.now()}` };
  }

  try {
    const response = await fetch('https://api.paystack.co/transaction/charge_authorization', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${paystackSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        authorization_code: authorizationCode,
        amount: amountKobo,
        email,
        reference,
        ...(splitParams || {}),
      }),
      signal: AbortSignal.timeout(30000),
    });

    // #172: HTTP error is NOT charge failure — preserve as indeterminate
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { status: 'indeterminate', reason: `http_${response.status}_config` };
      }
      return { status: 'indeterminate', reason: `http_${response.status}` };
    }

    let data: Record<string, unknown>;
    try {
      data = await response.json() as Record<string, unknown>;
    } catch {
      return { status: 'indeterminate', reason: 'malformed_json' };
    }

    if (!data.status || !data.data) {
      const message = (data.message as string) || 'unknown';
      return { status: 'terminal_failure', reason: `api_rejected: ${message}`, reference };
    }

    const txData = data.data as Record<string, unknown>;
    const txStatus = txData.status as string;

    if (txStatus === 'success') {
      return {
        status: 'success',
        reference: (txData.reference as string) || reference,
        transactionId: txData.id ? String(txData.id) : undefined,
      };
    }

    if (txStatus === 'failed' || txStatus === 'abandoned') {
      return {
        status: 'terminal_failure',
        reason: `paystack_charge_${txStatus}`,
        reference: (txData.reference as string) || reference,
      };
    }

    // pending, processing, ongoing, queued
    return {
      status: 'pending',
      providerStatus: txStatus,
      reference: (txData.reference as string) || reference,
    };
  } catch {
    // Network error, timeout, AbortError
    return { status: 'indeterminate', reason: 'network_error' };
  }
}

/**
 * Fetch the invoice for a Paystack subscription charge.
 * Used to obtain the authoritative invoice_code for provider-managed billing cycles.
 *
 * Two modes:
 * - Explicit-match (transactionId provided): searches invoices for exact transaction
 *   association. Returns null if no match — does NOT fall back to most_recent_invoice.
 *   An unrelated invoice must never be bound to a specific transaction.
 * - Discovery (no transactionId): returns most_recent_invoice as a cycle hint.
 *   Caller must hold another authoritative identity and must not use the result
 *   as sole financial authority.
 *
 * Returns null on any error — fail-closed, caller decides how to handle.
 */
export async function fetchSubscriptionInvoice(
  subscriptionCode: string,
  transactionId?: string,
): Promise<{ invoiceCode: string; amount: number; status: string } | null> {
  if (!paystackSecretKey) return null;

  try {
    const response = await fetch(
      `https://api.paystack.co/subscription/${encodeURIComponent(subscriptionCode)}`,
      {
        headers: { Authorization: `Bearer ${paystackSecretKey}` },
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!response.ok) return null;

    let data: Record<string, unknown>;
    try {
      data = await response.json() as Record<string, unknown>;
    } catch {
      return null;
    }

    if (!data.status || !data.data) return null;

    const subData = data.data as Record<string, unknown>;
    const invoices = (subData.invoices || []) as Array<Record<string, unknown>>;

    if (transactionId) {
      // Explicit-match mode: only return an invoice demonstrably associated
      // with this transaction. Never fall back to most_recent_invoice.
      for (const inv of invoices) {
        if (String(inv.transaction) === transactionId) {
          return {
            invoiceCode: inv.invoice_code as string,
            amount: inv.amount as number,
            status: (inv.status as string) || 'unknown',
          };
        }
      }
      // No exact match — return null (unresolved). Do NOT guess.
      return null;
    }

    // Discovery mode (no explicit transaction): most_recent_invoice as hint.
    // Caller must not use this as sole financial cycle authority.
    const mostRecent = subData.most_recent_invoice as Record<string, unknown> | undefined;
    if (mostRecent?.invoice_code) {
      return {
        invoiceCode: mostRecent.invoice_code as string,
        amount: mostRecent.amount as number,
        status: (mostRecent.status as string) || 'unknown',
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Typed exact invoice-transaction correlation for reconciliation (#176 R7).
 *
 * Unlike fetchSubscriptionInvoice (which collapses all failures to null),
 * this preserves the distinction between:
 * - exact_match: well-formed provider response, invoice's transaction matches
 * - definitive_no_match: well-formed provider response, no invoice matches
 * - indeterminate: provider error, network/timeout, malformed data
 *
 * Used ONLY by the deferred reconciliation worker.
 */
export type PaystackInvoiceCorrelation =
  | { status: 'exact_match'; invoiceCode: string; amount: number; invoiceStatus: string }
  | { status: 'definitive_no_match' }
  | { status: 'indeterminate'; reason: string };

export async function correlateInvoiceExact(
  subscriptionCode: string,
  transactionId: string,
): Promise<PaystackInvoiceCorrelation> {
  if (!paystackSecretKey) {
    return { status: 'indeterminate', reason: 'no_credentials' };
  }

  try {
    const response = await fetch(
      `https://api.paystack.co/subscription/${encodeURIComponent(subscriptionCode)}`,
      {
        headers: { Authorization: `Bearer ${paystackSecretKey}` },
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!response.ok) {
      return { status: 'indeterminate', reason: `http_${response.status}` };
    }

    let data: Record<string, unknown>;
    try {
      data = await response.json() as Record<string, unknown>;
    } catch {
      return { status: 'indeterminate', reason: 'malformed_json' };
    }

    if (!data.status || !data.data) {
      return { status: 'indeterminate', reason: 'invalid_provider_response' };
    }

    const subData = data.data as Record<string, unknown>;
    const invoices = (subData.invoices || []) as Array<Record<string, unknown>>;

    if (!Array.isArray(invoices)) {
      return { status: 'indeterminate', reason: 'invoices_not_array' };
    }

    for (const inv of invoices) {
      if (String(inv.transaction) === transactionId) {
        // Runtime shape validation — malformed evidence is indeterminate, not no-match
        const invoiceCode = inv.invoice_code;
        if (typeof invoiceCode !== 'string' || !invoiceCode) {
          return { status: 'indeterminate', reason: 'invoice_missing_code' };
        }

        const amount = inv.amount;
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
          return { status: 'indeterminate', reason: 'invoice_invalid_amount' };
        }

        const invoiceStatus = inv.status;
        if (typeof invoiceStatus !== 'string' || !invoiceStatus) {
          return { status: 'indeterminate', reason: 'invoice_missing_status' };
        }

        return {
          status: 'exact_match',
          invoiceCode,
          amount,
          invoiceStatus,
        };
      }
    }

    // Well-formed response, searched all invoices, no transaction match
    return { status: 'definitive_no_match' };
  } catch {
    return { status: 'indeterminate', reason: 'network_error' };
  }
}
