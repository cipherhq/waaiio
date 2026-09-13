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
  let recovered = 0, terminalized = 0, skipped = 0;

  // Claim batch of stale FLW checkout intents
  const { data: batch, error: claimErr } = await supabase.rpc('claim_stale_checkout_batch', { p_batch_size: 20 });
  if (claimErr || !batch) {
    logger.error('[CRON:CHECKOUT-RECOVERY] Claim failed', { error: claimErr?.message });
    return NextResponse.json({ error: 'Claim failed' }, { status: 500 });
  }

  for (const intent of batch as Array<{ intent_id: string; idempotency_key: string; created_at: string; gateway: string }>) {
    try {
      // Discover and verify transaction
      const { discoverAndVerifyTransaction } = await import('@/lib/payments/flutterwave-verify');
      const verifyResult = await discoverAndVerifyTransaction(intent.idempotency_key, flwKey, { fromDate: intent.created_at });

      if (verifyResult.ok && verifyResult.tx.status === 'successful') {
        // Found paid tx — correlate and finalize
        const { correlateProviderSubscription } = await import('@/lib/payments/flutterwave-subscription');
        const { decideSubscriptionCorrelation } = await import('@/lib/payments/flutterwave-decisions');
        const subCorrelation = await correlateProviderSubscription(verifyResult.tx.id, flwKey);
        const subDecision = decideSubscriptionCorrelation(subCorrelation);
        if (subDecision.action === 'fail_closed') {
          skipped++;
          continue;
        }
        const verifiedAmountMinor = Math.round(verifyResult.tx.amount * 100);
        const { data: finResult, error: finErr } = await supabase.rpc('finalize_flutterwave_subscription_checkout', {
          p_intent_id: intent.intent_id,
          p_provider_tx_id: String(verifyResult.tx.id),
          p_provider_subscription_id: subDecision.subscriptionId,
          p_provider_plan_id: subDecision.planId,
          p_verified_amount_minor: verifiedAmountMinor,
          p_verified_currency: verifyResult.tx.currency,
          p_provider_paid_at: verifyResult.tx.created_at,
        });
        if (!finErr && (finResult as Record<string, unknown>)?.finalized === true) recovered++;
        else skipped++;
      } else if (verifyResult.ok && (verifyResult.tx.status === 'failed' || verifyResult.tx.status === 'cancelled')) {
        // Provider-proven terminal — terminalize without replacement
        await supabase.rpc('terminalize_stale_checkout_intent', {
          p_intent_id: intent.intent_id,
          p_reason: 'provider_terminal',
        });
        terminalized++;
      } else {
        // Unavailable/ambiguous/pending — leave unchanged
        skipped++;
      }
    } catch (err) {
      logger.error('[CRON:CHECKOUT-RECOVERY] Error processing intent', { intentId: intent.intent_id, error: String(err) });
      skipped++;
    }
  }

  return NextResponse.json({ ok: true, recovered, terminalized, skipped, batchSize: (batch as unknown[]).length });
}
