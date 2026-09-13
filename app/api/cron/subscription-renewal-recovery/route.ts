import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Max pages for Flutterwave tx search pagination before declaring unavailable */
const FLW_TX_PAGE_CAP = 50;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const flwKey = process.env.FLUTTERWAVE_SECRET_KEY || '';
  let finalized = 0, evidenceRecorded = 0, skipped = 0;

  const { data: batch, error: claimErr } = await supabase.rpc('claim_overdue_subscription_batch', { p_batch_size: 20 });
  if (claimErr || !batch) {
    return NextResponse.json({ error: 'Claim failed' }, { status: 500 });
  }

  for (const sub of batch as Array<Record<string, unknown>>) {
    try {
      const subId = sub.sub_id as string;
      const gateway = sub.gateway as string;
      const periodEnd = sub.current_period_end as string;

      // Blocker 2: No synthetic defaults — skip if required fields are missing
      const subCurrency = sub.currency as string;
      const bizId = sub.business_id as string;
      const plan = sub.plan as string;
      if (!subCurrency || !bizId || !plan) { skipped++; continue; }

      if (gateway === 'flutterwave') {
        await processFlutterwaveRenewal(supabase, sub, subId, periodEnd, flwKey);
      } else if (gateway === 'stripe') {
        await processStripeRenewal(supabase, sub, subId, periodEnd);
      } else {
        skipped++;
        continue;
      }
    } catch (err) {
      logger.error('[CRON:RENEWAL-RECOVERY] Error', { subId: sub.sub_id, error: String(err) });
      skipped++;
      continue;
    }
  }

  return NextResponse.json({ ok: true, finalized, evidenceRecorded, skipped, batchSize: (batch as unknown[]).length });

  // ═══════════════════════════════════════════════════════════
  // Flutterwave renewal recovery — exhaustive paginated search
  // ═══════════════════════════════════════════════════════════
  async function processFlutterwaveRenewal(
    svc: ReturnType<typeof createServiceClient>,
    sub: Record<string, unknown>,
    subId: string,
    periodEnd: string,
    flwSecretKey: string,
  ) {
    const flwSubId = sub.flutterwave_subscription_id as string;
    const flwEmail = sub.flutterwave_subscriber_email as string;
    const flwPlanId = sub.flutterwave_plan_id as number;
    const subAmount = sub.amount as number;
    const subCurrency = sub.currency as string;
    const sourceKey = `renewal_recovery_flw_${subId}`;

    if (!flwSubId || !flwEmail) { skipped++; return; }

    // Step 1: Verify subscription status (separate check from tx search)
    const { verifySubscriptionStatus } = await import('@/lib/payments/flutterwave-subscription');
    const statusResult = await verifySubscriptionStatus(flwSubId, flwEmail, flwSecretKey, flwPlanId);

    const providerCancelled = statusResult.ok && (statusResult.status === 'cancelled' || statusResult.status === 'deactivated');
    const providerActive = statusResult.ok && !providerCancelled;

    // Step 2: Bounded paginated transaction search for ALL overdue subs
    const searchResult = await searchFlutterwavePaginatedTransactions(
      flwEmail, subCurrency, periodEnd, flwSecretKey,
    );

    if (searchResult.outcome === 'search_error' || searchResult.outcome === 'page_cap') {
      // Search failed or page cap reached — unavailable, never terminal
      await svc.rpc('record_reconciliation_evidence', {
        p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
        p_period_boundary: periodEnd, p_outcome: 'unavailable',
        p_source_key: sourceKey,
        p_evidence_provider_status: statusResult.ok ? statusResult.status : 'unknown',
      });
      evidenceRecorded++; return;
    }

    // Step 3: Verify and correlate each candidate (with anomaly tracking)
    const { verifyTransactionById } = await import('@/lib/payments/flutterwave-verify');
    const { correlateProviderSubscription } = await import('@/lib/payments/flutterwave-subscription');

    const validCandidates: Array<{ id: number; tx_ref: string; amount: number; currency: string; created_at: string }> = [];
    let anomalyCount = 0;

    for (const candidate of searchResult.candidates) {
      try {
        // Strict verification by exact ID + tx_ref
        const verifyResult = await verifyTransactionById(candidate.id, candidate.tx_ref, flwSecretKey);
        if (!verifyResult.ok || verifyResult.tx.status !== 'successful') { anomalyCount++; continue; }

        // Correlate: match stored flutterwave_subscription_id + flutterwave_plan_id
        const correlation = await correlateProviderSubscription(candidate.id, flwSecretKey);
        if (!correlation.ok) { anomalyCount++; continue; }
        if (correlation.sub.subscriptionId !== flwSubId) { anomalyCount++; continue; }
        if (flwPlanId && correlation.sub.planId !== flwPlanId) { anomalyCount++; continue; }

        // Pinned validation: amount and currency must match
        const verifiedAmountMinor = Math.round(verifyResult.tx.amount * 100);
        const expectedAmountMinor = subAmount * 100;
        if (verifiedAmountMinor !== expectedAmountMinor) { anomalyCount++; continue; }
        if (verifyResult.tx.currency.toUpperCase() !== subCurrency.toUpperCase()) { anomalyCount++; continue; }

        // Period window validation — transactions before period_end - 24h are outside window, not anomalies
        const txTimestamp = new Date(verifyResult.tx.created_at).getTime();
        const periodEndMs = new Date(periodEnd).getTime();
        if (txTimestamp < periodEndMs - 24 * 60 * 60 * 1000) { continue; } // outside window, not an anomaly

        validCandidates.push({
          id: candidate.id,
          tx_ref: candidate.tx_ref,
          amount: verifyResult.tx.amount,
          currency: verifyResult.tx.currency,
          created_at: verifyResult.tx.created_at,
        });
      } catch {
        anomalyCount++; continue;
      }
    }

    // Step 4: Decision based on valid candidates
    if (validCandidates.length === 1) {
      // Exactly one valid → finalize
      const valid = validCandidates[0];
      const { data: finResult, error: finErr } = await svc.rpc('finalize_flutterwave_subscription_renewal', {
        p_subscription_id: subId,
        p_provider_tx_id: String(valid.id),
        p_verified_amount_minor: Math.round(valid.amount * 100),
        p_verified_currency: valid.currency,
        p_provider_paid_at: valid.created_at,
      });

      if (!finErr && (finResult as Record<string, unknown>)?.finalized === true) {
        await svc.rpc('record_reconciliation_evidence', {
          p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
          p_period_boundary: periodEnd, p_outcome: 'paid_finalized',
          p_source_key: sourceKey,
          p_evidence_provider_status: statusResult.ok ? statusResult.status : 'unknown',
          p_evidence_tx_count: searchResult.candidates.length, p_evidence_matched_count: 1,
        });
        finalized++; return;
      }
      // Finalization RPC failed — record unavailable (not terminal)
      logger.error('[CRON:RENEWAL-RECOVERY] FLW renewal finalization failed', { subId, err: String(finErr) });
      await svc.rpc('record_reconciliation_evidence', {
        p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
        p_period_boundary: periodEnd, p_outcome: 'unavailable',
        p_source_key: sourceKey,
      });
      evidenceRecorded++; return;
    }

    if (validCandidates.length > 1) {
      // Multiple valid → ambiguous
      await svc.rpc('record_reconciliation_evidence', {
        p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
        p_period_boundary: periodEnd, p_outcome: 'ambiguous',
        p_source_key: sourceKey,
        p_evidence_provider_status: statusResult.ok ? statusResult.status : 'unknown',
        p_evidence_tx_count: searchResult.candidates.length, p_evidence_matched_count: validCandidates.length,
      });
      evidenceRecorded++; return;
    }

    // Zero valid candidates — anomaly-aware decision
    if (validCandidates.length === 0 && anomalyCount > 0) {
      // Tainted search — anomalies prevent proving zero payment
      await svc.rpc('record_reconciliation_evidence', {
        p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
        p_period_boundary: periodEnd, p_outcome: 'unavailable',
        p_source_key: sourceKey,
        p_evidence_provider_status: statusResult.ok ? statusResult.status : 'unknown',
      });
      evidenceRecorded++; return;
    }

    if (providerCancelled && searchResult.exhaustive && anomalyCount === 0) {
      // Provider cancelled + exhaustive search + zero valid + zero anomalies → terminal
      await svc.rpc('record_reconciliation_evidence', {
        p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
        p_period_boundary: periodEnd, p_outcome: 'terminal_no_payment',
        p_source_key: sourceKey,
        p_evidence_provider_status: statusResult.status,
      });
      evidenceRecorded++; return;
    }

    if (providerActive) {
      // Provider still active → may be retrying
      await svc.rpc('record_reconciliation_evidence', {
        p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
        p_period_boundary: periodEnd, p_outcome: 'provider_active_or_retrying',
        p_source_key: sourceKey,
        p_evidence_provider_status: statusResult.status,
      });
      evidenceRecorded++; return;
    }

    // Status check failed or not found — unavailable
    await svc.rpc('record_reconciliation_evidence', {
      p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
      p_period_boundary: periodEnd, p_outcome: 'unavailable',
      p_source_key: sourceKey,
    });
    evidenceRecorded++;
  }

  // ═══════════════════════════════════════════════════════════
  // Stripe renewal recovery — exhaustive invoice search
  // ═══════════════════════════════════════════════════════════
  async function processStripeRenewal(
    svc: ReturnType<typeof createServiceClient>,
    sub: Record<string, unknown>,
    subId: string,
    periodEnd: string,
  ) {
    const stripeSubId = sub.stripe_subscription_id as string;
    const sourceKey = `renewal_recovery_stripe_${subId}`;
    if (!stripeSubId) { skipped++; return; }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) { skipped++; return; }

    try {
      // Step 1: Check Stripe subscription status
      const stripeRes = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSubId)}`, {
        headers: { Authorization: `Bearer ${stripeKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!stripeRes.ok) {
        await svc.rpc('record_reconciliation_evidence', {
          p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
          p_period_boundary: periodEnd, p_outcome: 'unavailable',
          p_source_key: sourceKey,
        });
        evidenceRecorded++; return;
      }

      const stripeSub = await stripeRes.json() as { status?: string };
      const providerCancelled = stripeSub.status === 'canceled';

      // Step 2: Exhaustive invoice search with has_more pagination
      const periodEndUnix = Math.floor(new Date(periodEnd).getTime() / 1000);
      const invoiceResult = await searchStripePaidInvoicesExhaustive(stripeSubId, periodEndUnix, stripeKey);

      if (invoiceResult.outcome === 'search_error') {
        await svc.rpc('record_reconciliation_evidence', {
          p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
          p_period_boundary: periodEnd, p_outcome: 'unavailable',
          p_source_key: sourceKey,
          p_evidence_provider_status: stripeSub.status || 'unknown',
        });
        evidenceRecorded++; return;
      }

      if (invoiceResult.invoice) {
        // Found a paid invoice — extract line period (fail closed, no top-level fallback)
        const { extractSubscriptionLinePeriod } = await import('@/lib/payments/stripe-invoice-extractors');
        const linePeriod = extractSubscriptionLinePeriod(invoiceResult.invoice, stripeSubId);
        if ('error' in linePeriod) {
          // Line extraction failed — record unavailable evidence and skip
          logger.error('[CRON:RENEWAL-RECOVERY] Stripe line-period extraction failed', {
            subId, error: linePeriod.error, detail: linePeriod.detail,
          });
          await svc.rpc('record_reconciliation_evidence', {
            p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
            p_period_boundary: periodEnd, p_outcome: 'unavailable',
            p_source_key: sourceKey,
            p_evidence_provider_status: stripeSub.status || 'unknown',
          });
          evidenceRecorded++; return;
        }
        const invPeriodStart = new Date(linePeriod.periodStart * 1000).toISOString();
        const invPeriodEnd = new Date(linePeriod.periodEnd * 1000).toISOString();

        // Blocker 3: Use status_transitions.paid_at — fail closed if missing
        const invStatusTransitions = invoiceResult.invoice.status_transitions as Record<string, unknown> | undefined;
        const invPaidAtUnix = invStatusTransitions?.paid_at as number | undefined;
        if (!invPaidAtUnix) {
          logger.error('[CRON:RENEWAL-RECOVERY] Stripe invoice missing status_transitions.paid_at', { subId });
          await svc.rpc('record_reconciliation_evidence', {
            p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
            p_period_boundary: periodEnd, p_outcome: 'unavailable',
            p_source_key: sourceKey,
            p_evidence_provider_status: stripeSub.status || 'unknown',
          });
          evidenceRecorded++; return;
        }
        const providerPaidAt = new Date(invPaidAtUnix * 1000).toISOString();

        const { data: renewalConfig } = await svc
          .from('platform_config_versions')
          .select('id')
          .lte('effective_from', providerPaidAt)
          .order('effective_from', { ascending: false })
          .limit(1)
          .single();

        // Blocker 2: No synthetic defaults — currency must come from provider
        const invCurrency = invoiceResult.invoice.currency as string | undefined;
        if (!invCurrency) {
          logger.error('[CRON:RENEWAL-RECOVERY] Stripe invoice missing currency', { subId });
          await svc.rpc('record_reconciliation_evidence', {
            p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
            p_period_boundary: periodEnd, p_outcome: 'unavailable',
            p_source_key: sourceKey,
            p_evidence_provider_status: stripeSub.status || 'unknown',
          });
          evidenceRecorded++; return;
        }

        if (renewalConfig) {
          const { finalizeStripeRenewal } = await import('@/lib/payments/stripe-renewal-finalization');
          const invoiceId = invoiceResult.invoice.id as string;
          const paymentIntent = invoiceResult.invoice.payment_intent as string;
          const result = await finalizeStripeRenewal(svc, {
            subscriptionId: subId,
            businessId: sub.business_id as string,
            plan: sub.plan as string,
            providerInvoiceId: invoiceId,
            providerReference: paymentIntent || invoiceId,
            amountMinor: invoiceResult.invoice.amount_paid as number,
            currency: invCurrency.toUpperCase(),
            periodStart: invPeriodStart,
            periodEnd: invPeriodEnd,
            providerPaidAt,
            configVersionId: renewalConfig.id,
          });

          if (result.finalized) {
            await svc.rpc('record_reconciliation_evidence', {
              p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
              p_period_boundary: periodEnd, p_outcome: 'paid_finalized',
              p_source_key: sourceKey,
              p_evidence_provider_status: stripeSub.status || 'unknown',
              p_evidence_tx_count: 1, p_evidence_matched_count: 1,
            });
            finalized++; return;
          }
          logger.error('[CRON:RENEWAL-RECOVERY] Stripe finalization failed', { subId, reason: result.reason });
        }
        // Config version missing or finalization failed — unavailable (not terminal)
        await svc.rpc('record_reconciliation_evidence', {
          p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
          p_period_boundary: periodEnd, p_outcome: 'unavailable',
          p_source_key: sourceKey,
          p_evidence_provider_status: stripeSub.status || 'unknown',
        });
        evidenceRecorded++; return;
      }

      // No matching invoice found
      if (providerCancelled && invoiceResult.exhaustive) {
        // Cancelled + exhaustive search → terminal
        await svc.rpc('record_reconciliation_evidence', {
          p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
          p_period_boundary: periodEnd, p_outcome: 'terminal_no_payment',
          p_source_key: sourceKey,
          p_evidence_provider_status: 'canceled',
        });
        evidenceRecorded++;
      } else if (!providerCancelled) {
        // active/past_due/unpaid/trialing — provider still managing
        await svc.rpc('record_reconciliation_evidence', {
          p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
          p_period_boundary: periodEnd, p_outcome: 'provider_active_or_retrying',
          p_source_key: sourceKey,
          p_evidence_provider_status: stripeSub.status || 'active',
        });
        evidenceRecorded++;
      } else {
        // Cancelled but search was not exhaustive → unavailable
        await svc.rpc('record_reconciliation_evidence', {
          p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
          p_period_boundary: periodEnd, p_outcome: 'unavailable',
          p_source_key: sourceKey,
          p_evidence_provider_status: 'canceled',
        });
        evidenceRecorded++;
      }
    } catch {
      await svc.rpc('record_reconciliation_evidence', {
        p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
        p_period_boundary: periodEnd, p_outcome: 'unavailable',
        p_source_key: sourceKey,
      });
      evidenceRecorded++;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Flutterwave paginated transaction search
// ═══════════════════════════════════════════════════════════

interface FlwTxCandidate {
  id: number;
  tx_ref: string;
  amount: number;
  currency: string;
  created_at: string;
}

type FlwSearchResult =
  | { outcome: 'found'; candidates: FlwTxCandidate[]; exhaustive: boolean }
  | { outcome: 'search_error' }
  | { outcome: 'page_cap' };

async function searchFlutterwavePaginatedTransactions(
  email: string,
  currency: string,
  periodEnd: string,
  flwKey: string,
): Promise<FlwSearchResult> {
  try {
    const periodEndDate = new Date(periodEnd);
    const fromDate = new Date(periodEndDate.getTime() - 24 * 60 * 60 * 1000); // period_end - 1 day
    const toDate = new Date(); // now

    const fromStr = fromDate.toISOString().split('T')[0];
    const toStr = toDate.toISOString().split('T')[0];

    const allCandidates: FlwTxCandidate[] = [];

    for (let page = 1; page <= FLW_TX_PAGE_CAP; page++) {
      const url = `https://api.flutterwave.com/v3/transactions?customer_email=${encodeURIComponent(email)}&from=${fromStr}&to=${toStr}&status=successful&currency=${encodeURIComponent(currency)}&page=${page}`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${flwKey}` },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return { outcome: 'search_error' };

      const data = await res.json() as {
        status?: string;
        data?: { id: number; tx_ref: string; amount: number; currency: string; created_at: string }[];
      };
      if (data.status !== 'success' || !data.data) return { outcome: 'search_error' };

      // Empty page = exhausted
      if (data.data.length === 0) {
        return { outcome: 'found', candidates: allCandidates, exhaustive: true };
      }

      for (const tx of data.data) {
        allCandidates.push({
          id: tx.id,
          tx_ref: tx.tx_ref,
          amount: tx.amount,
          currency: tx.currency,
          created_at: tx.created_at,
        });
      }
    }

    // Page cap reached → unavailable
    return { outcome: 'page_cap' };
  } catch {
    return { outcome: 'search_error' };
  }
}

// ═══════════════════════════════════════════════════════════
// Stripe exhaustive invoice search with has_more pagination
// ═══════════════════════════════════════════════════════════

interface StripeInvoiceSearchResult {
  outcome: 'found' | 'not_found' | 'search_error';
  invoice?: Record<string, unknown>;
  exhaustive: boolean;
}

async function searchStripePaidInvoicesExhaustive(
  stripeSubId: string,
  periodEndUnix: number,
  stripeKey: string,
): Promise<StripeInvoiceSearchResult> {
  try {
    let startingAfter: string | null = null;
    let exhaustive = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let url = `https://api.stripe.com/v1/invoices?subscription=${encodeURIComponent(stripeSubId)}&status=paid&limit=100`;
      if (startingAfter) {
        url += `&starting_after=${encodeURIComponent(startingAfter)}`;
      }

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${stripeKey}` },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return { outcome: 'search_error', exhaustive: false };

      const data = await res.json() as {
        data?: Array<Record<string, unknown>>;
        has_more?: boolean;
      };
      if (!data.data) return { outcome: 'search_error', exhaustive: false };

      // Use extractSubscriptionLinePeriod for each invoice to find matching period
      const { extractSubscriptionLinePeriod } = await import('@/lib/payments/stripe-invoice-extractors');

      for (const inv of data.data) {
        // Line-item period extraction only — no top-level fallback
        const linePeriod = extractSubscriptionLinePeriod(inv, stripeSubId);
        if ('error' in linePeriod) continue; // Skip invoices where line extraction fails
        const invPeriodStart: number = linePeriod.periodStart;

        // Find invoice whose period starts at or after the subscription's current_period_end
        if (invPeriodStart >= periodEndUnix) {
          return { outcome: 'found', invoice: inv, exhaustive: true };
        }
      }

      if (!data.has_more || data.data.length === 0) {
        exhaustive = true;
        break;
      }

      // Paginate: use last invoice ID as starting_after
      startingAfter = data.data[data.data.length - 1].id as string;
    }

    return { outcome: 'not_found', exhaustive };
  } catch {
    return { outcome: 'search_error', exhaustive: false };
  }
}
