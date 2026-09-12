/**
 * Provider Preflight Validation (M378 Phase 2).
 *
 * Validates that provider-side plan/configuration matches Waaiio's expectations
 * BEFORE initiating a checkout. Fail-closed on any provider unavailability.
 *
 * Flutterwave: GET /v3/payment-plans/{planId} — plan exists, active, currency/amount/cadence match.
 * Stripe: Validate API key reachable via GET /v1/balance (lightweight, no side effects).
 */

import { logger } from '@/lib/logger';

// ═══ Types ═══

export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface FlutterwavePreflightInput {
  planRef: string;
  expectedCurrency: string;
  expectedAmountMajor: number;
  expectedInterval: 'monthly' | 'yearly';
  flutterwaveKey: string;
}

export interface StripePreflightInput {
  stripeKey: string;
}

// ═══ Flutterwave Preflight ═══

/**
 * Verify a Flutterwave payment plan exists, is active, and that its currency,
 * amount, and cadence exactly match the configured expectations.
 *
 * Uses GET /v3/payment-plans/{id} — documented endpoint.
 * Fail-closed: any non-success, network error, or mismatch → rejection.
 */
export async function verifyFlutterwavePlan(
  input: FlutterwavePreflightInput,
): Promise<PreflightResult> {
  try {
    const response = await fetch(
      `https://api.flutterwave.com/v3/payment-plans/${input.planRef}`,
      {
        headers: { 'Authorization': `Bearer ${input.flutterwaveKey}` },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!response.ok) {
      logger.error('[PREFLIGHT-FLW] Plan lookup HTTP error', {
        planRef: input.planRef, status: response.status,
      });
      return { ok: false, reason: `provider_http_${response.status}` };
    }

    const data = await response.json() as {
      status?: string;
      data?: {
        id?: number;
        name?: string;
        amount?: number;
        currency?: string;
        interval?: string;
        status?: string;
      };
    };

    if (data.status !== 'success' || !data.data) {
      logger.error('[PREFLIGHT-FLW] Plan lookup non-success', {
        planRef: input.planRef, status: data.status,
      });
      return { ok: false, reason: 'provider_non_success' };
    }

    const plan = data.data;

    // Plan must exist and be active
    if (plan.status !== 'active') {
      logger.error('[PREFLIGHT-FLW] Plan not active', {
        planRef: input.planRef, planStatus: plan.status,
      });
      return { ok: false, reason: `plan_not_active:${plan.status}` };
    }

    // Currency must exactly match (case-insensitive)
    if (plan.currency?.toUpperCase() !== input.expectedCurrency.toUpperCase()) {
      logger.error('[PREFLIGHT-FLW] Currency mismatch', {
        planRef: input.planRef,
        expected: input.expectedCurrency,
        actual: plan.currency,
      });
      return { ok: false, reason: `currency_mismatch:expected=${input.expectedCurrency},actual=${plan.currency}` };
    }

    // Amount must exactly match (major units)
    if (plan.amount !== input.expectedAmountMajor) {
      logger.error('[PREFLIGHT-FLW] Amount mismatch', {
        planRef: input.planRef,
        expected: input.expectedAmountMajor,
        actual: plan.amount,
      });
      return { ok: false, reason: `amount_mismatch:expected=${input.expectedAmountMajor},actual=${plan.amount}` };
    }

    // Cadence must match
    if (plan.interval !== input.expectedInterval) {
      logger.error('[PREFLIGHT-FLW] Interval mismatch', {
        planRef: input.planRef,
        expected: input.expectedInterval,
        actual: plan.interval,
      });
      return { ok: false, reason: `interval_mismatch:expected=${input.expectedInterval},actual=${plan.interval}` };
    }

    return { ok: true };
  } catch (error) {
    logger.error('[PREFLIGHT-FLW] Plan verification error', {
      planRef: input.planRef, error: String(error),
    });
    return { ok: false, reason: 'provider_unavailable' };
  }
}

// ═══ Stripe Preflight ═══

/**
 * Verify Stripe API key is valid and the API is reachable.
 * Uses GET /v1/balance — lightweight, read-only, no side effects.
 * This is a real runtime check, not a placeholder.
 */
export async function verifyStripeReadiness(
  input: StripePreflightInput,
): Promise<PreflightResult> {
  try {
    const response = await fetch('https://api.stripe.com/v1/balance', {
      headers: { 'Authorization': `Bearer ${input.stripeKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: { message?: string } };
      logger.error('[PREFLIGHT-STRIPE] API check failed', {
        status: response.status,
        error: data.error?.message,
      });
      return { ok: false, reason: `stripe_http_${response.status}` };
    }

    return { ok: true };
  } catch (error) {
    logger.error('[PREFLIGHT-STRIPE] API check error', { error: String(error) });
    return { ok: false, reason: 'stripe_unavailable' };
  }
}
