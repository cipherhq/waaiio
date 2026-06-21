import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TIER_LIMITS: Record<string, number> = {
  starter: 10,
  professional: 50,
  enterprise: 999,
};

/**
 * Reseller Reconciliation Cron
 *
 * Monthly checks:
 * 1. Fee reconciliation — commission earned vs paid out
 * 2. Zero-transaction detection — flag dormant sub-accounts
 * 3. Account limit check — flag resellers over tier limit
 * 4. Overdue invoices — flag past-due reseller invoices
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const alerts: string[] = [];
  let reconciled = 0;

  try {
    // Fetch all active resellers
    const { data: resellers, error: resErr } = await supabase
      .from('resellers')
      .select('id, company_name, user_id, tier, max_sub_accounts, status')
      .eq('status', 'active');

    if (resErr) {
      logger.error('Reseller reconciliation: failed to fetch resellers', resErr);
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    const allResellers = resellers || [];

    for (const reseller of allResellers) {
      // --- 1. Fee reconciliation ---
      const { data: feeRows } = await supabase
        .from('platform_fees')
        .select('reseller_commission')
        .eq('reseller_id', reseller.id);

      const totalEarned = (feeRows || []).reduce(
        (sum, f) => sum + (f.reseller_commission || 0),
        0
      );

      const { data: payoutRows } = await supabase
        .from('reseller_payouts')
        .select('gross_commission')
        .eq('reseller_id', reseller.id)
        .eq('status', 'paid');

      const totalPaid = (payoutRows || []).reduce(
        (sum, p) => sum + (p.gross_commission || 0),
        0
      );

      const diff = totalEarned - totalPaid;
      // Flag if difference exceeds $5 (500 cents)
      if (Math.abs(diff) > 500) {
        const msg = `Fee reconciliation mismatch for reseller "${reseller.company_name}" (${reseller.id}): earned=${totalEarned}, paid=${totalPaid}, diff=${diff}`;
        logger.warn(msg);
        alerts.push(msg);
      }

      // --- 2. Zero-transaction detection ---
      const { data: subAccounts } = await supabase
        .from('businesses')
        .select('id, created_at')
        .eq('reseller_id', reseller.id);

      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

      const matureAccounts = (subAccounts || []).filter(
        (b) => new Date(b.created_at) < sixtyDaysAgo
      );

      if (matureAccounts.length > 0) {
        // Check which mature accounts have zero platform_fees
        let zeroCount = 0;
        for (const biz of matureAccounts) {
          const { count } = await supabase
            .from('platform_fees')
            .select('id', { count: 'exact', head: true })
            .eq('business_id', biz.id)
            .eq('reseller_id', reseller.id);

          if ((count ?? 0) === 0) zeroCount++;
        }

        const zeroPercent = zeroCount / matureAccounts.length;
        if (zeroPercent > 0.2) {
          const msg = `Fraud alert: reseller "${reseller.company_name}" (${reseller.id}) has ${Math.round(zeroPercent * 100)}% zero-transaction accounts (${zeroCount}/${matureAccounts.length} mature accounts)`;
          logger.warn(msg);
          alerts.push(msg);
        }
      }

      // --- 3. Account limit check ---
      const totalSubAccounts = (subAccounts || []).length;
      const tierLimit = TIER_LIMITS[reseller.tier || 'starter'] ?? reseller.max_sub_accounts;
      if (totalSubAccounts > tierLimit) {
        const msg = `Account limit exceeded: reseller "${reseller.company_name}" (${reseller.id}) has ${totalSubAccounts} accounts, tier "${reseller.tier}" allows ${tierLimit}`;
        logger.warn(msg);
        alerts.push(msg);
      }

      reconciled++;
    }

    // --- 4. Overdue invoices (all resellers, not just active) ---
    const today = new Date().toISOString().split('T')[0];
    const { data: overdueInvoices } = await supabase
      .from('reseller_invoices')
      .select('id, reseller_id, amount, due_date')
      .eq('status', 'pending')
      .lt('due_date', today);

    for (const inv of overdueInvoices || []) {
      const msg = `Overdue invoice: invoice ${inv.id} for reseller ${inv.reseller_id}, amount=${inv.amount}, due=${inv.due_date}`;
      logger.warn(msg);
      alerts.push(msg);
    }

    // Insert alerts into admin_alerts if the table exists
    if (alerts.length > 0) {
      for (const alertMsg of alerts) {
        const { error: insertErr } = await supabase
          .from('admin_alerts')
          .insert({
            type: 'reseller_reconciliation',
            message: alertMsg,
            severity: 'warning',
          });

        // Table may not exist — silently continue
        if (insertErr) {
          logger.debug('admin_alerts insert skipped (table may not exist)');
          break; // No point retrying if table doesn't exist
        }
      }
    }

    logger.info(`Reseller reconciliation complete: ${reconciled} resellers, ${alerts.length} alerts`);

    return NextResponse.json({ reconciled, alerts });
  } catch (err) {
    logger.error('Reseller reconciliation failed', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
