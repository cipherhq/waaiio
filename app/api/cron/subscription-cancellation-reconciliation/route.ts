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

  // Query active subscriptions with provider identity
  const { data: subs, error: queryErr } = await supabase
    .from('subscriptions')
    .select('id, gateway, flutterwave_subscription_id, flutterwave_subscriber_email, flutterwave_plan_id, stripe_subscription_id')
    .eq('status', 'active')
    .in('gateway', ['flutterwave', 'stripe'])
    .order('last_reconciliation_attempt_at', { ascending: true, nullsFirst: true })
    .limit(50);

  if (queryErr || !subs) {
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }

  for (const sub of subs) {
    try {
      if (sub.gateway === 'flutterwave' && sub.flutterwave_subscription_id) {
        const { verifySubscriptionStatus } = await import('@/lib/payments/flutterwave-subscription');
        const result = await verifySubscriptionStatus(
          sub.flutterwave_subscription_id, sub.flutterwave_subscriber_email || '', flwKey, sub.flutterwave_plan_id || undefined,
        );
        if (result.ok && (result.status === 'cancelled' || result.status === 'deactivated')) {
          const { error: cancelErr } = await supabase.rpc('finalize_subscription_cancellation', {
            p_subscription_id: sub.id,
            p_gateway: 'flutterwave',
            p_provider_subscription_id: sub.flutterwave_subscription_id,
            p_provider_event_id: `reconciliation_cron_${sub.id}_${Date.now()}`,
            p_reason: 'missed_provider_cancellation',
          });
          if (!cancelErr) cancelled++;
          else skipped++;
        } else {
          skipped++;
        }
      } else if (sub.gateway === 'stripe' && sub.stripe_subscription_id) {
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) { skipped++; continue; }
        try {
          const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription_id)}`, {
            headers: { Authorization: `Bearer ${stripeKey}` },
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) { skipped++; continue; }
          const stripeSub = await res.json() as { status?: string };
          if (stripeSub.status === 'canceled') {
            const { error: cancelErr } = await supabase.rpc('finalize_subscription_cancellation', {
              p_subscription_id: sub.id,
              p_gateway: 'stripe',
              p_provider_subscription_id: sub.stripe_subscription_id,
              p_provider_event_id: `reconciliation_cron_stripe_${sub.id}_${Date.now()}`,
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
      logger.error('[CRON:CANCEL-RECON] Error', { subId: sub.id, error: String(err) });
      skipped++;
    }
  }

  return NextResponse.json({ ok: true, cancelled, skipped, total: subs.length });
}
