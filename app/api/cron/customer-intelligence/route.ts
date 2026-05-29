import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Daily cron — recalculate customer lifetime value, churn risk,
 * and segment for all customer profiles.
 * Runs at 4 AM daily (configured in vercel.json).
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const now = new Date();
  let updated = 0;

  try {
    // Process in batches of 100 customer profiles
    let offset = 0;
    const batchSize = 100;

    while (true) {
      const { data: profiles } = await supabase
        .from('customer_profiles')
        .select('id, business_id, customer_phone, total_visits, total_spent, last_seen_at')
        .range(offset, offset + batchSize - 1);

      if (!profiles || profiles.length === 0) break;

      const updates: { id: string; lifetime_value: number; churn_risk: number; customer_segment: string }[] = [];

      for (const profile of profiles) {
        const totalVisits = profile.total_visits || 0;
        const totalSpent = profile.total_spent || 0;
        const lastSeen = profile.last_seen_at ? new Date(profile.last_seen_at) : null;
        const daysSince = lastSeen
          ? Math.floor((now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60 * 24))
          : null;

        // Churn risk (0-100)
        let churnRisk = 0;
        if (daysSince !== null) {
          if (daysSince > 90) churnRisk += 40;
          else if (daysSince > 60) churnRisk += 30;
          else if (daysSince > 30) churnRisk += 20;
          else if (daysSince > 14) churnRisk += 10;
        }
        if (totalVisits <= 1) churnRisk += 30;
        else if (totalVisits <= 3) churnRisk += 20;
        else if (totalVisits <= 5) churnRisk += 10;
        if (totalSpent === 0) churnRisk += 20;
        churnRisk = Math.max(0, Math.min(100, churnRisk));

        // CLV: avg spend * estimated future visits * retention probability
        const avgSpend = totalVisits > 0 ? totalSpent / totalVisits : 0;
        const retentionProb = (100 - churnRisk) / 100;
        const clv = Math.round(avgSpend * 12 * retentionProb);

        // Segment
        let segment = 'new';
        if (daysSince !== null && daysSince > 90) segment = 'churned';
        else if (daysSince !== null && daysSince > 30) segment = 'at_risk';
        else if (totalVisits >= 5) segment = 'loyal';
        else if (totalVisits >= 2) segment = 'returning';

        updates.push({
          id: profile.id,
          lifetime_value: clv,
          churn_risk: churnRisk,
          customer_segment: segment,
        });
      }

      // Batch update
      for (const u of updates) {
        await supabase
          .from('customer_profiles')
          .update({
            lifetime_value: u.lifetime_value,
            churn_risk: u.churn_risk,
            customer_segment: u.customer_segment,
            intelligence_updated_at: now.toISOString(),
          })
          .eq('id', u.id);
      }

      updated += updates.length;
      offset += batchSize;

      if (profiles.length < batchSize) break;
    }

    return NextResponse.json({ status: 'ok', updated });
  } catch (error) {
    return NextResponse.json({ status: 'error', message: (error as Error).message }, { status: 500 });
  }
}
