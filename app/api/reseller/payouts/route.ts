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
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!reseller) return NextResponse.json({ error: 'Reseller profile not found' }, { status: 404 });

    const { data: payouts, error } = await supabase
      .from('reseller_payouts')
      .select('id, period_start, period_end, gross_commission, holdback, deductions, net_amount, currency, status, paid_at, notes, created_at')
      .eq('reseller_id', reseller.id)
      .order('period_end', { ascending: false });

    if (error) {
      logger.error('[RESELLER_PAYOUTS] Fetch error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch payouts' }, { status: 500 });
    }

    return NextResponse.json({ payouts: payouts || [] });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
