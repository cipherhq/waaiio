/**
 * Paystack Provider-Managed Deferred Reconciliation (#176)
 *
 * Consumes parked reconciliation_required webhook evidence where invoice
 * identity was unresolved at charge.success time.
 *
 * Two paths:
 * 1. Known subscription_code → direct lookup
 * 2. No subscription_code → hint enumeration (auth_code/customer_code)
 *    then per-candidate provider correlation
 *
 * In both cases: requires exactly ONE mutually consistent provider tuple
 * (subscription_code + invoice_code + transaction_id + reference + amount + currency)
 * before converging through finalize_paystack_recurring_charge.
 *
 * Hints enumerate candidates. They never select financial authority.
 *
 * Provider uncertainty rules:
 * - If ANY candidate correlation is indeterminate → no finalization
 * - Missing transaction ID from verification → indeterminate
 * - Webhook evidence amount/currency must match verified amount/currency
 * - Transient finalizer failure → reuse same attempt on next pass
 */

import { logger } from '@/lib/logger';
import type { PaystackInvoiceCorrelation } from '@/lib/payments/paystack-recurring';

export interface ReconciliationEvidence {
  reference?: string;
  subscription_code?: string;
  subscription_id?: string;
  amount_kobo?: number;
  currency?: string;
  transaction_id?: string;
  auth_code?: string;
  customer_code?: string;
}

export interface ReconciliationDeps {
  supabase: {
    from: (table: string) => any;
    rpc: (fn: string, params: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;
  };
  correlateInvoiceExact: (subscriptionCode: string, transactionId: string) =>
    Promise<PaystackInvoiceCorrelation>;
  verifyPaystackTransaction: (reference: string) =>
    Promise<{ status: string; amountMinor?: number; currency?: string; transactionId?: string; reason?: string; txStatus?: string }>;
}

export type ReconciliationResult =
  | { action: 'finalized'; paymentId: string; alreadyFinalized: boolean }
  | { action: 'skipped'; reason: string }
  | { action: 'error'; reason: string };

/**
 * Reconcile a single parked Paystack provider-managed charge.success event.
 *
 * This is the PRODUCTION implementation called by the cron.
 * Tests invoke this same function with injected deps.
 */
export async function reconcilePaystackEvent(
  deps: ReconciliationDeps,
  evidence: ReconciliationEvidence,
): Promise<ReconciliationResult> {
  const { supabase, correlateInvoiceExact, verifyPaystackTransaction } = deps;

  if (!evidence.reference) {
    return { action: 'skipped', reason: 'no_reference' };
  }

  // Step 1: Verify the original provider transaction
  let verifiedTransactionId: string | undefined;
  let verifiedAmount: number | undefined;
  let verifiedCurrency: string | undefined;

  try {
    const verifyResult = await verifyPaystackTransaction(evidence.reference);
    if (verifyResult.status !== 'success') {
      return { action: 'skipped', reason: `verify_${verifyResult.status}` };
    }
    verifiedTransactionId = verifyResult.transactionId;
    verifiedAmount = verifyResult.amountMinor;
    verifiedCurrency = verifyResult.currency;
  } catch {
    return { action: 'skipped', reason: 'verify_error' };
  }

  // Require non-empty exact transaction ID
  if (!verifiedTransactionId) {
    return { action: 'skipped', reason: 'verify_missing_transaction_id' };
  }

  // Validate verified evidence against durable webhook evidence
  if (evidence.amount_kobo !== undefined && verifiedAmount !== evidence.amount_kobo) {
    return { action: 'skipped', reason: 'evidence_amount_mismatch' };
  }
  if (evidence.currency && verifiedCurrency &&
      verifiedCurrency.toUpperCase() !== evidence.currency.toUpperCase()) {
    return { action: 'skipped', reason: 'evidence_currency_mismatch' };
  }

  // Step 2: Enumerate candidates
  type CandidateSub = { id: string; amount: number; currency: string; gateway_subscription_code: string };
  let candidates: CandidateSub[] = [];

  if (evidence.subscription_code) {
    // Known subscription_code → direct lookup
    const { data: subsByCode } = await supabase
      .from('customer_subscriptions')
      .select('id, amount, currency, gateway_subscription_code')
      .eq('gateway', 'paystack')
      .eq('gateway_subscription_code', evidence.subscription_code)
      .in('status', ['active', 'past_due']);
    candidates = (subsByCode || []).filter((s: CandidateSub) => s.gateway_subscription_code);
  } else {
    // No subscription_code — use auth/customer hints to enumerate.
    // Hints are NOT financial authority — they only build the candidate set.
    const hintCandidates: CandidateSub[] = [];

    if (evidence.auth_code) {
      const { data: byAuth } = await supabase
        .from('customer_subscriptions')
        .select('id, amount, currency, gateway_subscription_code')
        .eq('gateway', 'paystack')
        .eq('authorization_code', evidence.auth_code)
        .in('status', ['active', 'past_due'])
        .limit(50);
      if (byAuth) hintCandidates.push(...byAuth);
    }

    if (evidence.customer_code) {
      const { data: byCust } = await supabase
        .from('customer_subscriptions')
        .select('id, amount, currency, gateway_subscription_code')
        .eq('gateway', 'paystack')
        .eq('gateway_customer_code', evidence.customer_code)
        .in('status', ['active', 'past_due'])
        .limit(50);
      if (byCust) hintCandidates.push(...byCust);
    }

    // Deduplicate by subscription ID
    const seen = new Set<string>();
    for (const c of hintCandidates) {
      if (c.gateway_subscription_code && !seen.has(c.id)) {
        seen.add(c.id);
        candidates.push(c);
      }
    }

    // Bound check — if too many candidates, fail closed
    if (candidates.length > 20) {
      return { action: 'skipped', reason: 'too_many_candidates' };
    }
  }

  if (candidates.length === 0) {
    return { action: 'skipped', reason: 'no_candidate' };
  }

  // Step 3: Correlate each candidate with authoritative provider evidence
  type AuthoritativeTuple = {
    subscriptionId: string;
    subscriptionCode: string;
    invoiceCode: string;
    transactionId: string;
    amount: number;
    currency: string;
  };

  const authoritativeMatches: AuthoritativeTuple[] = [];
  let hasIndeterminate = false;

  for (const candidate of candidates) {
    const expectedAmountMinor = Math.round(candidate.amount * 100);
    const expectedCurrency = (candidate.currency || 'NGN').toUpperCase();

    // Definitive no-match: amount/currency don't align
    if (verifiedAmount !== expectedAmountMinor) continue;
    if (verifiedCurrency && verifiedCurrency.toUpperCase() !== expectedCurrency) continue;

    // Typed exact invoice correlation — preserves uncertainty
    const correlation = await correlateInvoiceExact(
      candidate.gateway_subscription_code,
      verifiedTransactionId,
    );

    if (correlation.status === 'indeterminate') {
      hasIndeterminate = true;
      continue;
    }

    if (correlation.status === 'definitive_no_match') {
      continue;
    }

    if (correlation.status === 'exact_match') {
      // correlateInvoiceExact guarantees invoiceCode, amount (finite number), invoiceStatus (string)
      // on exact_match — unconditional validation here

      // Invoice amount must match verified transaction amount exactly
      if (correlation.amount !== verifiedAmount) {
        continue; // Contradictory invoice amount vs verified transaction
      }

      // Invoice amount must match local subscription intent exactly
      if (correlation.amount !== expectedAmountMinor) {
        continue;
      }

      // Only explicitly successful/paid invoice status may authorize finalization
      const acceptableStatuses = ['success', 'paid'];
      if (!acceptableStatuses.includes(correlation.invoiceStatus.toLowerCase())) {
        continue; // Non-success invoice — fail closed
      }

      authoritativeMatches.push({
        subscriptionId: candidate.id,
        subscriptionCode: candidate.gateway_subscription_code,
        invoiceCode: correlation.invoiceCode,
        transactionId: verifiedTransactionId,
        amount: verifiedAmount!,
        currency: (verifiedCurrency || expectedCurrency).toUpperCase(),
      });
    }
  }

  // ALL candidates must be determinate, exactly ONE match
  if (hasIndeterminate) {
    return { action: 'skipped', reason: 'candidate_indeterminate' };
  }
  if (authoritativeMatches.length === 0) {
    return { action: 'skipped', reason: 'zero_authoritative_match' };
  }

  if (authoritativeMatches.length > 1) {
    logger.warn(`[RECONCILE] Multiple authoritative matches for ref ${evidence.reference}: ${authoritativeMatches.map(m => m.subscriptionId).join(', ')}`);
    return { action: 'skipped', reason: 'multiple_authoritative_matches' };
  }

  const match = authoritativeMatches[0];
  const providerCycleKey = `ps-auto-${match.subscriptionId}-${match.invoiceCode}`;

  // Step 5: Check if already finalized for this cycle
  const { data: existingFinalized } = await supabase
    .from('paystack_billing_attempts')
    .select('id, canonical_payment_id')
    .eq('customer_subscription_id', match.subscriptionId)
    .eq('cycle_key', providerCycleKey)
    .eq('status', 'finalized')
    .maybeSingle();

  if (existingFinalized) {
    return {
      action: 'finalized',
      paymentId: existingFinalized.canonical_payment_id,
      alreadyFinalized: true,
    };
  }

  // Step 6: Reuse existing eligible attempt or create new
  const { data: existingCharged } = await supabase
    .from('paystack_billing_attempts')
    .select('id, provider_reference, provider_transaction_id, provider_invoice_code, intended_amount_minor, intended_currency')
    .eq('customer_subscription_id', match.subscriptionId)
    .eq('cycle_key', providerCycleKey)
    .in('status', ['charged', 'dispatched'])
    .maybeSingle();

  let attemptId: string;

  if (existingCharged) {
    if (existingCharged.provider_reference !== evidence.reference) {
      return { action: 'skipped', reason: 'existing_attempt_reference_conflict' };
    }
    if (existingCharged.provider_transaction_id && existingCharged.provider_transaction_id !== match.transactionId) {
      return { action: 'skipped', reason: 'existing_attempt_transaction_conflict' };
    }
    if (existingCharged.provider_invoice_code && existingCharged.provider_invoice_code !== match.invoiceCode) {
      return { action: 'skipped', reason: 'existing_attempt_invoice_conflict' };
    }
    if (existingCharged.intended_amount_minor !== match.amount) {
      return { action: 'skipped', reason: 'existing_attempt_amount_conflict' };
    }
    if (existingCharged.intended_currency &&
        existingCharged.intended_currency.toUpperCase() !== match.currency.toUpperCase()) {
      return { action: 'skipped', reason: 'existing_attempt_currency_conflict' };
    }
    attemptId = existingCharged.id;
  } else {
    const { error: insertErr } = await supabase.from('paystack_billing_attempts').insert({
    customer_subscription_id: match.subscriptionId,
    cycle_key: providerCycleKey,
    scheduled_at: new Date().toISOString(),
    attempt_number: 1,
    provider_reference: evidence.reference,
    intended_amount_minor: match.amount,
    intended_currency: match.currency,
    status: 'charged',
    charged_at: new Date().toISOString(),
    provider_transaction_id: match.transactionId,
    provider_invoice_code: match.invoiceCode,
  });

    if (insertErr) {
      const { data: raceFinalized } = await supabase
        .from('paystack_billing_attempts')
        .select('id, canonical_payment_id')
        .eq('customer_subscription_id', match.subscriptionId)
        .eq('cycle_key', providerCycleKey)
        .eq('status', 'finalized')
        .maybeSingle();
      if (raceFinalized) {
        return { action: 'finalized', paymentId: raceFinalized.canonical_payment_id, alreadyFinalized: true };
      }
      return { action: 'skipped', reason: 'attempt_insert_conflict' };
    }

    const { data: newAttempt } = await supabase
      .from('paystack_billing_attempts')
      .select('id')
      .eq('provider_reference', evidence.reference)
      .single();

    if (!newAttempt) return { action: 'skipped', reason: 'attempt_lookup_failed' };
    attemptId = newAttempt.id;
  }

  const { data: finResult, error: finErr } = await supabase.rpc('finalize_paystack_recurring_charge', {
    p_attempt_id: attemptId,
    p_provider_amount_minor: match.amount,
    p_provider_currency: match.currency,
    p_provider_transaction_id: match.transactionId,
    p_provider_invoice_code: match.invoiceCode,
  });

  if (finErr) {
    return { action: 'error', reason: `finalizer_rpc_error: ${finErr.message || 'unknown'}` };
  }

  if (finResult?.success) {
    return {
      action: 'finalized',
      paymentId: finResult.payment_id || finResult.canonical_payment_id,
      alreadyFinalized: finResult.already_finalized || false,
    };
  }

  return { action: 'error', reason: `finalizer_rejected: ${finResult?.reason || 'unknown'}` };
}
