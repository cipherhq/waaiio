import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: reseller } = await supabase
      .from('resellers')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!reseller) return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });

    // Fetch sub-accounts for this reseller
    const { data: businesses } = await supabase
      .from('businesses')
      .select('id, name, category, status, created_at')
      .eq('reseller_id', reseller.id);

    const accountList = businesses || [];
    const accountIds = accountList.map((b) => b.id);

    // Fetch all platform_fees for this reseller
    const { data: fees } = await supabase
      .from('platform_fees')
      .select('business_id, transaction_amount, reseller_commission, created_at')
      .eq('reseller_id', reseller.id);

    const allFees = fees || [];

    // Fetch bookings and orders counts per business
    let bookingCounts: Record<string, number> = {};
    let orderCounts: Record<string, number> = {};

    if (accountIds.length > 0) {
      const { data: bookings } = await supabase
        .from('bookings')
        .select('business_id')
        .in('business_id', accountIds);

      for (const b of bookings || []) {
        bookingCounts[b.business_id] = (bookingCounts[b.business_id] || 0) + 1;
      }

      const { data: orders } = await supabase
        .from('orders')
        .select('business_id')
        .in('business_id', accountIds);

      for (const o of orders || []) {
        orderCounts[o.business_id] = (orderCounts[o.business_id] || 0) + 1;
      }
    }

    // Build fee aggregates per business
    const feesByBusiness: Record<string, { revenue: number; commission: number; lastActivity: string | null }> = {};
    for (const fee of allFees) {
      const bid = fee.business_id;
      if (!bid) continue;
      if (!feesByBusiness[bid]) {
        feesByBusiness[bid] = { revenue: 0, commission: 0, lastActivity: null };
      }
      feesByBusiness[bid].revenue += fee.transaction_amount || 0;
      feesByBusiness[bid].commission += fee.reseller_commission || 0;
      if (!feesByBusiness[bid].lastActivity || fee.created_at > feesByBusiness[bid].lastActivity!) {
        feesByBusiness[bid].lastActivity = fee.created_at;
      }
    }

    // Build per-account breakdown
    const accounts = accountList.map((biz) => ({
      id: biz.id,
      name: biz.name,
      category: biz.category,
      status: biz.status,
      total_revenue: feesByBusiness[biz.id]?.revenue ?? 0,
      total_bookings: bookingCounts[biz.id] ?? 0,
      total_orders: orderCounts[biz.id] ?? 0,
      commission_generated: feesByBusiness[biz.id]?.commission ?? 0,
      last_activity: feesByBusiness[biz.id]?.lastActivity ?? null,
    }));

    // Monthly trend (last 6 months)
    const now = new Date();
    const monthlyTrend: { month: string; revenue: number; commission: number; new_accounts: number }[] = [];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1);

      let revenue = 0;
      let commission = 0;
      for (const fee of allFees) {
        const feeDate = new Date(fee.created_at);
        if (feeDate >= monthStart && feeDate < monthEnd) {
          revenue += fee.transaction_amount || 0;
          commission += fee.reseller_commission || 0;
        }
      }

      let newAccounts = 0;
      for (const biz of accountList) {
        const bizDate = new Date(biz.created_at);
        if (bizDate >= monthStart && bizDate < monthEnd) {
          newAccounts++;
        }
      }

      monthlyTrend.push({ month: monthStr, revenue, commission, new_accounts: newAccounts });
    }

    // Top 5 accounts by revenue
    const topAccounts = [...accounts]
      .sort((a, b) => b.total_revenue - a.total_revenue)
      .slice(0, 5)
      .map((a) => ({ id: a.id, name: a.name, revenue: a.total_revenue }));

    return NextResponse.json({ accounts, monthly_trend: monthlyTrend, top_accounts: topAccounts });
  } catch (err) {
    logger.error('Reseller analytics error', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
