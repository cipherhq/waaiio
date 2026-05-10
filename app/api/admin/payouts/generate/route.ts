import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { getCurrencyCode, type CountryCode } from '@/lib/constants';

const COOLING_PERIOD_DAYS = 7;
const VELOCITY_THRESHOLD = 50; // max transactions per day before flagging

// Minimum payout thresholds per country (in local currency)
const MINIMUM_PAYOUT: Record<string, number> = {
  NG: 5000,  // ₦5,000
  GH: 50,    // GH₵50
  US: 25,    // $25
  GB: 20,    // £20
  CA: 25,    // CA$25
  KE: 2500,  // KSh2,500
};

interface Flag {
  type: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Calculate period: last full week (Monday to Sunday)
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() - periodEnd.getDay()); // Last Sunday
    const periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - 6); // Monday before

    const periodStartStr = periodStart.toISOString().split('T')[0];
    const periodEndStr = periodEnd.toISOString().split('T')[0];

    // Get all active platform-managed businesses with verification info
    const { data: businesses } = await supabase
      .from('businesses')
      .select('id, created_at, verification_level, payout_limit_monthly, country_code')
      .eq('payout_mode', 'platform_managed')
      .eq('status', 'active');

    if (!businesses?.length) {
      return NextResponse.json({ success: true, created: 0, skipped: 0, held: 0, message: 'No platform-managed businesses' });
    }

    let created = 0;
    let skipped = 0;
    let held = 0;

    for (const biz of businesses) {
      // Check if payout already exists for this period
      const { data: existing } = await supabase
        .from('business_payouts')
        .select('id')
        .eq('business_id', biz.id)
        .eq('period_start', periodStartStr)
        .eq('period_end', periodEndStr)
        .maybeSingle();

      if (existing) continue;

      // Sum successful payments in the period
      const { data: payments } = await supabase
        .from('payments')
        .select('amount, created_at')
        .eq('business_id', biz.id)
        .eq('status', 'success')
        .gte('created_at', periodStart.toISOString())
        .lte('created_at', periodEnd.toISOString());

      const gross = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      if (gross <= 0) continue;

      // Get platform fees for this period
      const { data: fees } = await supabase
        .from('platform_fees')
        .select('fee_total')
        .eq('business_id', biz.id)
        .eq('waived', false)
        .is('refunded_at', null)
        .gte('created_at', periodStart.toISOString())
        .lte('created_at', periodEnd.toISOString());

      const totalFees = (fees || []).reduce((s, f) => s + Number(f.fee_total || 0), 0);

      // Deduct any unapplied payout adjustments (e.g. post-payout refunds)
      const { data: adjustments } = await supabase
        .from('payout_adjustments')
        .select('id, amount')
        .eq('business_id', biz.id)
        .is('applied_to_payout_id', null);

      const totalAdjustments = (adjustments || []).reduce((s, a) => s + Number(a.amount || 0), 0);
      const net = Math.max(0, gross - totalFees + totalAdjustments);

      // Minimum payout threshold — skip if amount too small
      const minPayout = MINIMUM_PAYOUT[biz.country_code || 'NG'] || 5000;
      if (net < minPayout) {
        skipped++;
        continue;
      }

      // Build flags
      const flags: Flag[] = [];
      let status = 'pending';

      // --- COOLING PERIOD CHECK ---
      const bizCreatedAt = new Date(biz.created_at);
      const daysSinceCreation = Math.floor((now.getTime() - bizCreatedAt.getTime()) / (1000 * 60 * 60 * 24));
      if (daysSinceCreation < COOLING_PERIOD_DAYS) {
        flags.push({
          type: 'cooling_period',
          message: `Business created ${daysSinceCreation} days ago (< ${COOLING_PERIOD_DAYS} day cooling period)`,
          severity: 'warning',
        });
        status = 'held';
      }

      // --- VERIFICATION CHECK ---
      const verLevel = biz.verification_level || 'unverified';
      if (verLevel === 'unverified') {
        flags.push({
          type: 'unverified',
          message: 'Business is unverified — payouts are not allowed',
          severity: 'critical',
        });
        status = 'held';
      }

      // --- PAYOUT LIMIT CHECK ---
      const monthlyLimit = Number(biz.payout_limit_monthly || 0);
      if (monthlyLimit > 0 && monthlyLimit < 999999999) {
        // Check total payouts this month
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const { data: monthPayouts } = await supabase
          .from('business_payouts')
          .select('net_amount')
          .eq('business_id', biz.id)
          .in('status', ['pending', 'approved', 'processing', 'paid'])
          .gte('created_at', monthStart);

        const monthTotal = (monthPayouts || []).reduce((s, p) => s + Number(p.net_amount || 0), 0);
        if (monthTotal + net > monthlyLimit) {
          flags.push({
            type: 'over_limit',
            message: `Monthly total (${monthTotal + net}) exceeds limit (${monthlyLimit})`,
            severity: 'warning',
          });
          status = 'held';
        }
      }

      // --- VELOCITY CHECK ---
      // Count max transactions in any single day during the period
      const dailyCounts: Record<string, number> = {};
      for (const p of payments || []) {
        const day = new Date(p.created_at).toISOString().split('T')[0];
        dailyCounts[day] = (dailyCounts[day] || 0) + 1;
      }
      const maxDaily = Math.max(0, ...Object.values(dailyCounts));
      if (maxDaily > VELOCITY_THRESHOLD) {
        flags.push({
          type: 'high_velocity',
          message: `${maxDaily} transactions in a single day (threshold: ${VELOCITY_THRESHOLD})`,
          severity: 'warning',
        });
        // Don't auto-hold for velocity, just flag for review
      }

      // --- LARGE PAYOUT CHECK ---
      const LARGE_PAYOUT_THRESHOLD = 1_000_000;
      if (net >= LARGE_PAYOUT_THRESHOLD) {
        flags.push({
          type: 'large_payout',
          message: `Net payout amount (${net.toLocaleString()}) exceeds ${LARGE_PAYOUT_THRESHOLD.toLocaleString()} — review carefully`,
          severity: 'warning',
        });
        // Informational flag only — does not auto-hold
      }

      // Get active payout account
      const { data: payoutAccount } = await supabase
        .from('payout_accounts')
        .select('id')
        .eq('business_id', biz.id)
        .eq('is_active', true)
        .maybeSingle();

      const { data: newPayout } = await supabase.from('business_payouts').insert({
        business_id: biz.id,
        payout_account_id: payoutAccount?.id || null,
        period_start: periodStartStr,
        period_end: periodEndStr,
        gross_amount: gross,
        platform_fee: totalFees,
        gateway_fee: 0,
        net_amount: net,
        currency: getCurrencyCode((biz.country_code || 'NG') as CountryCode),
        status,
        flags,
      }).select('id').single();

      // Mark adjustments as applied to this payout
      if (newPayout && adjustments && adjustments.length > 0) {
        const adjIds = adjustments.map((a) => a.id);
        await supabase
          .from('payout_adjustments')
          .update({ applied_to_payout_id: newPayout.id })
          .in('id', adjIds);
      }

      if (status === 'held') {
        held++;
      } else {
        created++;
      }
    }

    // Audit log
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action: 'generate_payouts',
      entity_type: 'business_payout',
      entity_id: null,
      details: {
        period_start: periodStartStr,
        period_end: periodEndStr,
        businesses_checked: businesses.length,
        payouts_created: created,
        payouts_held: held,
      },
    });

    return NextResponse.json({
      success: true,
      created,
      held,
      period: { start: periodStartStr, end: periodEndStr },
    });
  } catch (error) {
    logger.error('Generate payouts error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to generate payouts' }, { status: 500 });
  }
}
