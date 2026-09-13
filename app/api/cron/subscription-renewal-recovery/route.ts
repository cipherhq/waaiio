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
        const flwSubId = sub.flutterwave_subscription_id as string;
        const flwEmail = sub.flutterwave_subscriber_email as string;
        const flwPlanId = sub.flutterwave_plan_id as number;

        if (!flwSubId || !flwEmail) { skipped++; continue; }

        // Step 1: Verify subscription status
        const { verifySubscriptionStatus } = await import('@/lib/payments/flutterwave-subscription');
        const statusResult = await verifySubscriptionStatus(flwSubId, flwEmail, flwKey, flwPlanId);

        if (!statusResult.ok) {
          // Provider unavailable
          await supabase.rpc('record_reconciliation_evidence', {
            p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
            p_period_boundary: periodEnd, p_outcome: 'unavailable', p_source_key: `renewal_recovery_${Date.now()}`,
          });
          evidenceRecorded++; continue;
        }

        if (statusResult.status === 'cancelled' || statusResult.status === 'deactivated') {
          // Provider cancelled — record terminal evidence
          await supabase.rpc('record_reconciliation_evidence', {
            p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
            p_period_boundary: periodEnd, p_outcome: 'terminal_no_payment', p_source_key: `renewal_recovery_cancelled_${Date.now()}`,
            p_evidence_provider_status: statusResult.status,
          });
          evidenceRecorded++; continue;
        }

        // Provider active — may still be retrying
        await supabase.rpc('record_reconciliation_evidence', {
          p_subscription_id: subId, p_gateway: 'flutterwave', p_provider_subscription_id: flwSubId,
          p_period_boundary: periodEnd, p_outcome: 'provider_active_or_retrying', p_source_key: `renewal_recovery_active_${Date.now()}`,
          p_evidence_provider_status: statusResult.status,
        });
        evidenceRecorded++;

      } else if (gateway === 'stripe') {
        const stripeSubId = sub.stripe_subscription_id as string;
        if (!stripeSubId) { skipped++; continue; }

        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) { skipped++; continue; }

        try {
          // Check Stripe subscription status
          const stripeRes = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(stripeSubId)}`, {
            headers: { Authorization: `Bearer ${stripeKey}` },
            signal: AbortSignal.timeout(10000),
          });
          if (!stripeRes.ok) {
            await supabase.rpc('record_reconciliation_evidence', {
              p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
              p_period_boundary: periodEnd, p_outcome: 'unavailable', p_source_key: `renewal_stripe_${Date.now()}`,
            });
            evidenceRecorded++; continue;
          }

          const stripeSub = await stripeRes.json() as { status?: string; latest_invoice?: string };

          if (stripeSub.status === 'canceled') {
            await supabase.rpc('record_reconciliation_evidence', {
              p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
              p_period_boundary: periodEnd, p_outcome: 'terminal_no_payment', p_source_key: `renewal_stripe_canceled_${Date.now()}`,
              p_evidence_provider_status: 'canceled',
            });
            evidenceRecorded++;
          } else if (stripeSub.status === 'past_due' || stripeSub.status === 'unpaid') {
            await supabase.rpc('record_reconciliation_evidence', {
              p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
              p_period_boundary: periodEnd, p_outcome: 'provider_active_or_retrying', p_source_key: `renewal_stripe_${stripeSub.status}_${Date.now()}`,
              p_evidence_provider_status: stripeSub.status,
            });
            evidenceRecorded++;
          } else {
            // active/trialing — check for paid invoice
            await supabase.rpc('record_reconciliation_evidence', {
              p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
              p_period_boundary: periodEnd, p_outcome: 'provider_active_or_retrying', p_source_key: `renewal_stripe_active_${Date.now()}`,
              p_evidence_provider_status: stripeSub.status || 'active',
            });
            evidenceRecorded++;
          }
        } catch {
          await supabase.rpc('record_reconciliation_evidence', {
            p_subscription_id: subId, p_gateway: 'stripe', p_provider_subscription_id: stripeSubId,
            p_period_boundary: periodEnd, p_outcome: 'unavailable', p_source_key: `renewal_stripe_err_${Date.now()}`,
          });
          evidenceRecorded++;
        }
      } else {
        skipped++;
      }
    } catch (err) {
      logger.error('[CRON:RENEWAL-RECOVERY] Error', { subId: sub.sub_id, error: String(err) });
      skipped++;
    }
  }

  return NextResponse.json({ ok: true, finalized, evidenceRecorded, skipped, batchSize: (batch as unknown[]).length });
}
