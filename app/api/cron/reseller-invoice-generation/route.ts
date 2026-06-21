import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TIER_FEES: Record<string, number> = {
  starter: 29900,        // $299.00
  professional: 79900,   // $799.00
  enterprise: 150000,    // $1,500.00
};

const TIER_LABELS: Record<string, string> = {
  starter: 'Starter',
  professional: 'Professional',
  enterprise: 'Enterprise',
};

/**
 * Reseller Invoice Generation Cron
 *
 * Generates monthly platform fee invoices for active resellers.
 * Runs once per month. Due date = period_end + 15 days.
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let generated = 0;

  try {
    // Current billing period: 1st of current month to last day
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day of month
    const dueDate = new Date(periodEnd);
    dueDate.setDate(dueDate.getDate() + 15);

    const periodStartStr = periodStart.toISOString().split('T')[0];
    const periodEndStr = periodEnd.toISOString().split('T')[0];
    const dueDateStr = dueDate.toISOString().split('T')[0];

    // Fetch all active resellers with a tier
    const { data: resellers, error: resErr } = await supabase
      .from('resellers')
      .select('id, company_name, tier')
      .eq('status', 'active')
      .not('tier', 'is', null);

    if (resErr) {
      logger.error('Reseller invoice generation: failed to fetch resellers', resErr);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    for (const reseller of resellers || []) {
      const tier = reseller.tier as string;
      const amount = TIER_FEES[tier];
      if (!amount) {
        logger.warn(`Unknown tier "${tier}" for reseller "${reseller.company_name}" (${reseller.id}), skipping`);
        continue;
      }

      // Check for duplicate — prevent generating twice for same period
      const { count } = await supabase
        .from('reseller_invoices')
        .select('id', { count: 'exact', head: true })
        .eq('reseller_id', reseller.id)
        .eq('period_start', periodStartStr)
        .eq('period_end', periodEndStr);

      if ((count ?? 0) > 0) {
        logger.debug(`Invoice already exists for reseller ${reseller.id} period ${periodStartStr}-${periodEndStr}`);
        continue;
      }

      const description = `Monthly platform fee - ${TIER_LABELS[tier] || tier}`;

      const { error: insertErr } = await supabase
        .from('reseller_invoices')
        .insert({
          reseller_id: reseller.id,
          amount,
          description,
          status: 'pending',
          due_date: dueDateStr,
          period_start: periodStartStr,
          period_end: periodEndStr,
        });

      if (insertErr) {
        logger.error(`Failed to create invoice for reseller ${reseller.id}`, insertErr);
        continue;
      }

      generated++;
    }

    logger.info(`Reseller invoice generation complete: ${generated} invoices created`);

    return NextResponse.json({ generated });
  } catch (err) {
    logger.error('Reseller invoice generation failed', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
