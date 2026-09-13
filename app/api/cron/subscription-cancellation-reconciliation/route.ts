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
  let cancelled = 0, skipped = 0;

  // Atomic claim via dedicated cancellation RPC (separate cooldown from renewal recovery)
  const { data: subs, error: claimErr } = await supabase.rpc('claim_active_subscriptions_for_cancellation_check', { p_batch_size: 50 });

  if (claimErr || !subs) {
    logger.error('[CRON:CANCEL-RECON] Claim RPC failed', { error: claimErr?.message });
    return NextResponse.json({ error: 'Claim failed' }, { status: 500 });
  }

  const subsList = subs as Array<Record<string, unknown>>;

  for (const sub of subsList) {
    try {
      const subGateway = (sub.gateway as string) || '';
      const subId = (sub.sub_id as string) || '';

      if (subGateway === 'flutterwave' && sub.flutterwave_subscription_id) {
        const { verifySubscriptionStatus } = await import('@/lib/payments/flutterwave-subscription');
        const result = await verifySubscriptionStatus(
          sub.flutterwave_subscription_id as string,
          (sub.flutterwave_subscriber_email as string) || '',
          flwKey,
          (sub.flutterwave_plan_id as number) || undefined,
        );
        if (result.ok && (result.status === 'cancelled' || result.status === 'deactivated')) {
          // Stable event ID: deterministic, idempotent across retries
          const { error: cancelErr } = await supabase.rpc('finalize_subscription_cancellation', {
            p_subscription_id: subId,
            p_gateway: 'flutterwave',
            p_provider_subscription_id: sub.flutterwave_subscription_id as string,
            p_provider_event_id: `reconciliation_cancel_flutterwave_${subId}`,
            p_reason: 'missed_provider_cancellation',
          });
          if (!cancelErr) cancelled++;
          else skipped++;
        } else {
          skipped++;
        }
      } else if (subGateway === 'stripe' && sub.stripe_subscription_id) {
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) { skipped++; continue; }
        try {
          const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription_id as string)}`, {
            headers: { Authorization: `Bearer ${stripeKey}` },
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) { skipped++; continue; }
          const stripeSub = await res.json() as { status?: string };
          if (stripeSub.status === 'canceled') {
            // Stable event ID: deterministic, idempotent across retries
            const { error: cancelErr } = await supabase.rpc('finalize_subscription_cancellation', {
              p_subscription_id: subId,
              p_gateway: 'stripe',
              p_provider_subscription_id: sub.stripe_subscription_id as string,
              p_provider_event_id: `reconciliation_cancel_stripe_${subId}`,
              p_reason: 'missed_provider_cancellation',
            });
            if (!cancelErr) cancelled++;
            else skipped++;
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
      } else {
        skipped++;
      }
    } catch (err) {
      logger.error('[CRON:CANCEL-RECON] Error', { subId: sub.sub_id, error: String(err) });
      skipped++;
    }
  }

  return NextResponse.json({ ok: true, cancelled, skipped, total: subsList.length });
}
