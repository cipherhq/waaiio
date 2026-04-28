import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

interface FraudCheckInput {
  paymentId: string;
  businessId: string;
  amount: number;
  currency: string;
  customerPhone: string;
  payerIp?: string;
  payerCountry?: string;
  gatewayData?: Record<string, unknown>;
}

interface FraudFlag {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
}

/**
 * Run fraud checks on a payment after it's been processed.
 * Returns a fraud score (0-100) and list of flags.
 * Non-blocking — should be called after payment confirmation.
 */
export async function checkPaymentFraud(
  supabase: SupabaseClient,
  input: FraudCheckInput,
): Promise<{ score: number; flags: FraudFlag[] }> {
  const flags: FraudFlag[] = [];
  let score = 0;

  try {
    // ── 1. Velocity check: too many payments in short time ──
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentCount } = await supabase
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', input.businessId)
      .gte('created_at', oneHourAgo);

    if ((recentCount || 0) > 20) {
      flags.push({ type: 'high_velocity', severity: 'high', description: `${recentCount} payments in last hour` });
      score += 30;
    } else if ((recentCount || 0) > 10) {
      flags.push({ type: 'elevated_velocity', severity: 'medium', description: `${recentCount} payments in last hour` });
      score += 15;
    }

    // ── 2. Unusual amount: significantly higher than average ──
    const { data: avgData } = await supabase
      .from('payments')
      .select('amount')
      .eq('business_id', input.businessId)
      .eq('status', 'success')
      .order('created_at', { ascending: false })
      .limit(50);

    if (avgData && avgData.length >= 5) {
      const amounts = avgData.map(p => Number(p.amount));
      const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const stdDev = Math.sqrt(amounts.reduce((s, a) => s + Math.pow(a - avg, 2), 0) / amounts.length);

      if (input.amount > avg + 3 * stdDev && input.amount > avg * 3) {
        flags.push({ type: 'unusual_amount', severity: 'high', description: `Amount ${input.amount} is ${Math.round(input.amount / avg)}x the average (${Math.round(avg)})` });
        score += 25;
      } else if (input.amount > avg + 2 * stdDev && input.amount > avg * 2) {
        flags.push({ type: 'elevated_amount', severity: 'medium', description: `Amount ${input.amount} is ${Math.round(input.amount / avg)}x the average` });
        score += 10;
      }
    }

    // ── 3. Duplicate payment: same phone + same amount in last 10 minutes ──
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count: dupeCount } = await supabase
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', input.businessId)
      .eq('status', 'success')
      .gte('created_at', tenMinAgo);

    // Check by matching amount in recent payments
    if (avgData) {
      const recentSameAmount = avgData.filter(p => Math.abs(Number(p.amount) - input.amount) < 0.01).length;
      if (recentSameAmount >= 3) {
        flags.push({ type: 'duplicate_amount', severity: 'medium', description: `Same amount (${input.amount}) appears ${recentSameAmount} times recently` });
        score += 15;
      }
    }

    // ── 4. Country mismatch: payer country doesn't match business country ──
    if (input.payerCountry) {
      const { data: biz } = await supabase
        .from('businesses')
        .select('country_code')
        .eq('id', input.businessId)
        .single();

      if (biz && input.payerCountry !== biz.country_code) {
        flags.push({ type: 'country_mismatch', severity: 'low', description: `Payer from ${input.payerCountry}, business in ${biz.country_code}` });
        score += 5;
      }
    }

    // ── 5. New business with large transaction ──
    const { data: bizAge } = await supabase
      .from('businesses')
      .select('created_at')
      .eq('id', input.businessId)
      .single();

    if (bizAge) {
      const daysOld = (Date.now() - new Date(bizAge.created_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld < 7 && input.amount > 100) {
        flags.push({ type: 'new_business_large_tx', severity: 'medium', description: `Business is ${Math.round(daysOld)} days old with ${input.currency} ${input.amount} transaction` });
        score += 15;
      }
    }

    // ── 6. Off-hours transaction ──
    const hour = new Date().getUTCHours();
    if (hour >= 1 && hour <= 5) {
      flags.push({ type: 'off_hours', severity: 'low', description: `Transaction at ${hour}:00 UTC` });
      score += 5;
    }

    // Cap score at 100
    score = Math.min(score, 100);

    // Save fraud data to payment record
    await supabase.from('payments').update({
      payer_ip: input.payerIp || null,
      payer_country: input.payerCountry || null,
      fraud_score: score,
      fraud_flags: flags,
    }).eq('id', input.paymentId);

    // Log high-severity fraud events
    if (score >= 30) {
      for (const flag of flags.filter(f => f.severity === 'high' || f.severity === 'critical')) {
        await supabase.from('fraud_events').insert({
          payment_id: input.paymentId,
          business_id: input.businessId,
          event_type: flag.type,
          severity: flag.severity,
          description: flag.description,
          metadata: { amount: input.amount, currency: input.currency, phone: input.customerPhone, ip: input.payerIp },
        });
      }
    }

    if (score > 0) {
      logger.debug(`[FRAUD] Payment ${input.paymentId}: score=${score}, flags=${flags.map(f => f.type).join(',')}`);
    }
  } catch (err) {
    logger.error('[FRAUD] Check failed:', err);
  }

  return { score, flags };
}
