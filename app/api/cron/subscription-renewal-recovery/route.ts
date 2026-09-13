import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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

  // ── Flutterwave renewal recovery ──
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

    if (!flwSubId || !flwEmail) { skipped++; return; }

    // Step 1: Verify subscription status
    const { verifySubscriptionStatus } = await import('@/lib/payments/flutterwave-subscription');
    const statusResult = await verifySubscriptionStatus(flwSubId, flwEmail, flwSecretKey, flwPlanId);

    if (!statusResult.ok) {
      // Provider unavailable — never terminal
      await svc.rpc('record_reconciliation_evidence', {
        p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
        p_period_boundary: periodEnd, p_outcome: 'unavailable',
        p_source_key: `renewal_recovery_flw_${subId}`,
      });
      evidenceRecorded++; return;
    }

    if (statusResult.status === 'cancelled' || statusResult.status === 'deactivated') {
      // Step 2: Cancelled/deactivated — do bounded tx search BEFORE recording terminal
      const paidCandidate = await searchFlutterwaveBoundedTransactions(
        flwEmail, sub.currency as string || 'NGN', periodEnd, flwSecretKey,
      );

      if (paidCandidate === 'search_error') {
        // Search failed — record unavailable, never terminal
        await svc.rpc('record_reconciliation_evidence', {
          p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
          p_period_boundary: periodEnd, p_outcome: 'unavailable',
          p_source_key: `renewal_recovery_flw_${subId}`,
          p_evidence_provider_status: statusResult.status,
        });
        evidenceRecorded++; return;
      }

      if (paidCandidate) {
        // Verify candidate: correlate via provider subscription lookup, match stored IDs
        const { correlateProviderSubscription } = await import('@/lib/payments/flutterwave-subscription');
        const correlation = await correlateProviderSubscription(paidCandidate.id, flwSecretKey);

        if (correlation.ok
          && correlation.sub.subscriptionId === flwSubId
          && (flwPlanId ? correlation.sub.planId === flwPlanId : true)
          && paidCandidate.amount > 0
        ) {
          // Valid renewal payment found after cancellation — finalize
          const { error: renewErr } = await svc.rpc('finalize_flutterwave_subscription_renewal', {
            p_subscription_id: subId,
            p_provider_tx_id: String(paidCandidate.id),
            p_verified_amount_minor: paidCandidate.amount,
            p_verified_currency: paidCandidate.currency,
            p_provider_paid_at: paidCandidate.created_at,
          });

          if (!renewErr) {
            await svc.rpc('record_reconciliation_evidence', {
              p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
              p_period_boundary: periodEnd, p_outcome: 'paid_finalized',
              p_source_key: `renewal_recovery_flw_${subId}`,
              p_evidence_provider_status: statusResult.status,
              p_evidence_tx_count: 1, p_evidence_matched_count: 1,
            });
            finalized++; return;
          }
          // Renewal RPC failed — fall through to terminal_no_payment
          logger.error('[CRON:RENEWAL-RECOVERY] FLW renewal RPC failed', { subId, err: String(renewErr) });
        }
        // Correlation failed or mismatch — no valid candidate, fall through to terminal
      }

      // Zero valid candidates + cancelled → terminal_no_payment
      await svc.rpc('record_reconciliation_evidence', {
        p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
        p_period_boundary: periodEnd, p_outcome: 'terminal_no_payment',
        p_source_key: `renewal_recovery_flw_${subId}`,
        p_evidence_provider_status: statusResult.status,
      });
      evidenceRecorded++; return;
    }

    // Provider active — may still be retrying
    await svc.rpc('record_reconciliation_evidence', {
      p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
      p_period_boundary: periodEnd, p_outcome: 'provider_active_or_retrying',
      p_source_key: `renewal_recovery_flw_${subId}`,
      p_evidence_provider_status: statusResult.status,
    });
    evidenceRecorded++;
  }

  // ── Stripe renewal recovery ──
  async function processStripeRenewal(
    svc: ReturnType<typeof createServiceClient>,
    sub: Record<string, unknown>,
    subId: string,
    periodEnd: string,
  ) {
    const stripeSubId = sub.stripe_subscription_id as string;
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
          p_source_key: `renewal_recovery_stripe_${subId}`,
        });
        evidenceRecorded++; return;
      }

      const stripeSub = await stripeRes.json() as { status?: string };

      if (stripeSub.status === 'canceled') {
        // Step 2: Cancelled — search for paid invoices for the next period
        const invoiceResult = await searchStripePaidInvoices(stripeSubId, periodEnd, stripeKey);

        if (invoiceResult === 'search_error') {
          await svc.rpc('record_reconciliation_evidence', {
            p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
            p_period_boundary: periodEnd, p_outcome: 'unavailable',
            p_source_key: `renewal_recovery_stripe_${subId}`,
            p_evidence_provider_status: 'canceled',
          });
          evidenceRecorded++; return;
        }

        if (invoiceResult) {
          // Found a paid invoice for the renewal period — finalize
          // Resolve config version at provider payment time
          const providerPaidAt = invoiceResult.created
            ? new Date(invoiceResult.created * 1000).toISOString()
            : new Date(invoiceResult.period_start * 1000).toISOString();

          const { data: renewalConfig } = await svc
            .from('platform_config_versions')
            .select('id')
            .lte('effective_from', providerPaidAt)
            .order('effective_from', { ascending: false })
            .limit(1)
            .single();

          if (renewalConfig) {
            const { finalizeStripeRenewal } = await import('@/lib/payments/stripe-renewal-finalization');
            const result = await finalizeStripeRenewal(svc, {
              subscriptionId: subId,
              businessId: sub.business_id as string || '',
              plan: sub.plan as string || 'growth',
              providerInvoiceId: invoiceResult.id,
              providerReference: invoiceResult.payment_intent || invoiceResult.id,
              amountMinor: invoiceResult.amount_paid,
              currency: (invoiceResult.currency || 'usd').toUpperCase(),
              periodStart: new Date(invoiceResult.period_start * 1000).toISOString(),
              periodEnd: new Date(invoiceResult.period_end * 1000).toISOString(),
              providerPaidAt,
              configVersionId: renewalConfig.id,
            });

            if (result.finalized) {
              await svc.rpc('record_reconciliation_evidence', {
                p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
                p_period_boundary: periodEnd, p_outcome: 'paid_finalized',
                p_source_key: `renewal_recovery_stripe_${subId}`,
                p_evidence_provider_status: 'canceled',
                p_evidence_tx_count: 1, p_evidence_matched_count: 1,
              });
              finalized++; return;
            }
            logger.error('[CRON:RENEWAL-RECOVERY] Stripe finalization failed', { subId, reason: result.reason });
          }
          // Config version missing or finalization failed — fall through to terminal
        }

        // Zero valid invoices + canceled → terminal_no_payment
        await svc.rpc('record_reconciliation_evidence', {
          p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
          p_period_boundary: periodEnd, p_outcome: 'terminal_no_payment',
          p_source_key: `renewal_recovery_stripe_${subId}`,
          p_evidence_provider_status: 'canceled',
        });
        evidenceRecorded++;
      } else {
        // active/past_due/unpaid/trialing — provider still managing
        await svc.rpc('record_reconciliation_evidence', {
          p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
          p_period_boundary: periodEnd, p_outcome: 'provider_active_or_retrying',
          p_source_key: `renewal_recovery_stripe_${subId}`,
          p_evidence_provider_status: stripeSub.status || 'active',
        });
        evidenceRecorded++;
      }
    } catch {
      await svc.rpc('record_reconciliation_evidence', {
        p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
        p_period_boundary: periodEnd, p_outcome: 'unavailable',
        p_source_key: `renewal_recovery_stripe_${subId}`,
      });
      evidenceRecorded++;
    }
  }
}

/**
 * Bounded Flutterwave transaction search: GET /v3/transactions with
 * from/to date range and status=successful, filtered by email+currency.
 *
 * Used for renewal recovery when the subscription is cancelled but we
 * need to check if a payment was made in the period window.
 */
async function searchFlutterwaveBoundedTransactions(
  email: string,
  currency: string,
  periodEnd: string,
  flwKey: string,
): Promise<{ id: number; amount: number; currency: string; created_at: string } | null | 'search_error'> {
  try {
    const periodEndDate = new Date(periodEnd);
    const fromDate = new Date(periodEndDate.getTime() - 24 * 60 * 60 * 1000); // period_end - 1 day
    const toDate = new Date(); // now

    const fromStr = fromDate.toISOString().split('T')[0];
    const toStr = toDate.toISOString().split('T')[0];

    const url = `https://api.flutterwave.com/v3/transactions?from=${fromStr}&to=${toStr}&status=successful&currency=${encodeURIComponent(currency)}&customer_email=${encodeURIComponent(email)}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${flwKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return 'search_error';

    const data = await res.json() as {
      status?: string;
      data?: { id: number; amount: number; currency: string; created_at: string }[];
    };
    if (data.status !== 'success' || !data.data) return 'search_error';

    // Return the first successful transaction candidate (caller verifies via correlation)
    if (data.data.length === 0) return null;

    // If multiple candidates, return the most recent
    return data.data[0];
  } catch {
    return 'search_error';
  }
}

/**
 * Bounded Stripe invoice search: GET /v1/invoices with subscription filter
 * and status=paid. Returns the first invoice whose period_start >= the
 * subscription's current_period_end (i.e., a renewal for the next period).
 */
async function searchStripePaidInvoices(
  stripeSubId: string,
  periodEnd: string,
  stripeKey: string,
): Promise<{
  id: string;
  payment_intent: string;
  amount_paid: number;
  currency: string;
  period_start: number;
  period_end: number;
  created: number;
} | null | 'search_error'> {
  try {
    const periodEndUnix = Math.floor(new Date(periodEnd).getTime() / 1000);

    const url = `https://api.stripe.com/v1/invoices?subscription=${encodeURIComponent(stripeSubId)}&status=paid&limit=10`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${stripeKey}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return 'search_error';

    const data = await res.json() as {
      data?: {
        id: string;
        payment_intent: string;
        amount_paid: number;
        currency: string;
        period_start: number;
        period_end: number;
        created: number;
      }[];
    };
    if (!data.data) return 'search_error';

    // Find an invoice with period_start >= current_period_end (renewal for next period)
    const renewalInvoice = data.data.find(inv => inv.period_start >= periodEndUnix);
    return renewalInvoice || null;
  } catch {
    return 'search_error';
  }
}
