import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: reseller } = await supabase
      .from('resellers')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!reseller) return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });

    // Count sub-accounts by status
    const { count: totalAccounts } = await supabase
      .from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('reseller_id', reseller.id);

    const { count: activeAccounts } = await supabase
      .from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('reseller_id', reseller.id)
      .eq('status', 'active');

    const suspendedAccounts = (totalAccounts ?? 0) - (activeAccounts ?? 0);

    // Revenue + commission from platform_fees
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const lastMonthEnd = thisMonthStart;

    // All-time totals
    const { data: allTimeFees } = await supabase
      .from('platform_fees')
      .select('transaction_amount, reseller_commission')
      .eq('reseller_id', reseller.id);

    const totalRevenue = (allTimeFees || []).reduce((sum, f) => sum + (f.transaction_amount || 0), 0);
    const totalCommission = (allTimeFees || []).reduce((sum, f) => sum + (f.reseller_commission || 0), 0);

    // This month
    const { data: thisMonthFees } = await supabase
      .from('platform_fees')
      .select('transaction_amount, reseller_commission')
      .eq('reseller_id', reseller.id)
      .gte('created_at', thisMonthStart);

    const thisMonthRevenue = (thisMonthFees || []).reduce((sum, f) => sum + (f.transaction_amount || 0), 0);
    const thisMonthCommission = (thisMonthFees || []).reduce((sum, f) => sum + (f.reseller_commission || 0), 0);

    // Last month
    const { data: lastMonthFees } = await supabase
      .from('platform_fees')
      .select('transaction_amount, reseller_commission')
      .eq('reseller_id', reseller.id)
      .gte('created_at', lastMonthStart)
      .lt('created_at', lastMonthEnd);

    const lastMonthRevenue = (lastMonthFees || []).reduce((sum, f) => sum + (f.transaction_amount || 0), 0);
    const lastMonthCommission = (lastMonthFees || []).reduce((sum, f) => sum + (f.reseller_commission || 0), 0);

    return NextResponse.json({
      stats: {
        accounts: {
          total: totalAccounts ?? 0,
          active: activeAccounts ?? 0,
          suspended: suspendedAccounts,
        },
        revenue: {
          total: totalRevenue,
          this_month: thisMonthRevenue,
          last_month: lastMonthRevenue,
        },
        commission: {
          total: totalCommission,
          this_month: thisMonthCommission,
          last_month: lastMonthCommission,
        },
        reseller: {
          commission_percentage: reseller.commission_percentage,
          billing_type: reseller.billing_type,
          max_sub_accounts: reseller.max_sub_accounts,
        },
      },
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
