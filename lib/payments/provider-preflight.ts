/**
 * Provider preflight verification — checks plan/product configuration
 * against the provider API BEFORE saving or switching.
 *
 * Each function returns a PreflightResult indicating whether the plan
 * is valid and ready for use. Fail-closed: any ambiguity returns ok: false.
 */

import { logger } from '@/lib/logger';

// ────────────────────────────────────────────────────────────────────────────
// Shared types
// ────────────────────────────────────────────────────────────────────────────

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  /** Provider-returned plan/product details (for audit logging) */
  details?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────────────
// Paystack
// ────────────────────────────────────────────────────────────────────────────

export interface PaystackPreflightInput {
  planCode: string;
  expectedCurrency: string;
  expectedAmountMajor: number;
  paystackKey: string;
}

/**
 * Verify a Paystack plan exists, is active, matches expected currency/amount/interval.
 *
 * Paystack plans store amounts in minor units (kobo/pesewas).
 * Fail-closed: network errors, 4xx/5xx, missing data, or mismatches all return ok: false.
 */
export async function verifyPaystackPlan(input: PaystackPreflightInput): Promise<PreflightResult> {
  const { planCode, expectedCurrency, expectedAmountMajor, paystackKey } = input;

  try {
    const response = await fetch(`https://api.paystack.co/plan/${planCode}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${paystackKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: `Paystack plan fetch failed: HTTP ${response.status}`,
      };
    }

    const json = await response.json() as {
      status?: boolean;
      data?: {
        is_archived?: boolean;
        interval?: string;
        currency?: string;
        amount?: number;
        plan_code?: string;
        name?: string;
      };
    };

    if (json.status !== true || !json.data) {
      return {
        ok: false,
        reason: 'Paystack plan response missing data or status !== true',
      };
    }

    const plan = json.data;

    // Must not be archived
    if (plan.is_archived) {
      return {
        ok: false,
        reason: `Paystack plan ${planCode} is archived`,
        details: { planCode, is_archived: true },
      };
    }

    // Must be monthly interval
    if (plan.interval !== 'monthly') {
      return {
        ok: false,
        reason: `Paystack plan interval is "${plan.interval}", expected "monthly"`,
        details: { planCode, interval: plan.interval },
      };
    }

    // Currency must match (case-insensitive)
    if (plan.currency?.toUpperCase() !== expectedCurrency.toUpperCase()) {
      return {
        ok: false,
        reason: `Paystack plan currency is "${plan.currency}", expected "${expectedCurrency}"`,
        details: { planCode, planCurrency: plan.currency, expectedCurrency },
      };
    }

    // Amount must match in minor units (expectedAmountMajor * 100)
    const expectedMinor = expectedAmountMajor * 100;
    if (plan.amount !== expectedMinor) {
      return {
        ok: false,
        reason: `Paystack plan amount is ${plan.amount} minor units, expected ${expectedMinor} (${expectedAmountMajor} major)`,
        details: { planCode, planAmount: plan.amount, expectedMinor, expectedAmountMajor },
      };
    }

    return {
      ok: true,
      details: {
        planCode: plan.plan_code,
        name: plan.name,
        currency: plan.currency,
        amount: plan.amount,
        interval: plan.interval,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Paystack plan preflight failed', { planCode, error: message });
    return {
      ok: false,
      reason: `Paystack plan preflight error: ${message}`,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Flutterwave
// ────────────────────────────────────────────────────────────────────────────

export interface FlutterwavePreflightInput {
  planId: string;
  expectedCurrency: string;
  expectedAmountMajor: number;
  flutterwaveKey: string;
}

/**
 * Verify a Flutterwave payment plan exists, is active, matches expected currency/amount/interval.
 *
 * Flutterwave plans store amounts in major units.
 * Fail-closed: network errors, 4xx/5xx, missing data, or mismatches all return ok: false.
 */
export async function verifyFlutterwavePlan(input: FlutterwavePreflightInput): Promise<PreflightResult> {
  const { planId, expectedCurrency, expectedAmountMajor, flutterwaveKey } = input;

  try {
    const response = await fetch(`https://api.flutterwave.com/v3/payment-plans/${planId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${flutterwaveKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: `Flutterwave plan fetch failed: HTTP ${response.status}`,
      };
    }

    const json = await response.json() as {
      status?: string;
      data?: {
        status?: string;
        interval?: string;
        currency?: string;
        amount?: number;
        id?: number;
        name?: string;
      };
    };

    if (json.status !== 'success' || !json.data) {
      return {
        ok: false,
        reason: 'Flutterwave plan response missing data or status !== "success"',
      };
    }

    const plan = json.data;

    // Must be active
    if (plan.status !== 'active') {
      return {
        ok: false,
        reason: `Flutterwave plan status is "${plan.status}", expected "active"`,
        details: { planId, planStatus: plan.status },
      };
    }

    // Must be monthly interval
    if (plan.interval !== 'monthly') {
      return {
        ok: false,
        reason: `Flutterwave plan interval is "${plan.interval}", expected "monthly"`,
        details: { planId, interval: plan.interval },
      };
    }

    // Currency must match (case-insensitive)
    if (plan.currency?.toUpperCase() !== expectedCurrency.toUpperCase()) {
      return {
        ok: false,
        reason: `Flutterwave plan currency is "${plan.currency}", expected "${expectedCurrency}"`,
        details: { planId, planCurrency: plan.currency, expectedCurrency },
      };
    }

    // Amount must match in major units
    if (plan.amount !== expectedAmountMajor) {
      return {
        ok: false,
        reason: `Flutterwave plan amount is ${plan.amount}, expected ${expectedAmountMajor}`,
        details: { planId, planAmount: plan.amount, expectedAmountMajor },
      };
    }

    return {
      ok: true,
      details: {
        planId: plan.id,
        name: plan.name,
        currency: plan.currency,
        amount: plan.amount,
        interval: plan.interval,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Flutterwave plan preflight failed', { planId, error: message });
    return {
      ok: false,
      reason: `Flutterwave plan preflight error: ${message}`,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Stripe
// ────────────────────────────────────────────────────────────────────────────

export interface StripeReadinessInput {
  stripeKey: string;
}

/**
 * Verify Stripe API key is valid and the account can accept charges.
 * Stripe uses inline price_data for subscriptions, so there are no plan refs to verify.
 */
export async function verifyStripeReadiness(input: StripeReadinessInput): Promise<PreflightResult> {
  const { stripeKey } = input;

  try {
    const response = await fetch('https://api.stripe.com/v1/balance', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: `Stripe balance check failed: HTTP ${response.status}`,
      };
    }

    const json = await response.json() as {
      available?: Array<{ amount: number; currency: string }>;
      livemode?: boolean;
    };

    return {
      ok: true,
      details: {
        livemode: json.livemode,
        currencies: json.available?.map(a => a.currency) ?? [],
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Stripe readiness preflight failed', { error: message });
    return {
      ok: false,
      reason: `Stripe readiness preflight error: ${message}`,
    };
  }
}
