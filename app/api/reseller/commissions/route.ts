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

    // Fetch recent commission entries from platform_fees with business name
    const { data: fees, error } = await supabase
      .from('platform_fees')
      .select('id, reseller_commission, transaction_amount, fee_total, created_at, business_id, booking_id, invoice_id, campaign_id, order_id, reservation_id')
      .eq('reseller_id', reseller.id)
      .gt('reseller_commission', 0)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      logger.error('[RESELLER_COMMISSIONS] Fetch error:', error.message);
      return NextResponse.json({ error: 'Failed to fetch commissions' }, { status: 500 });
    }

    if (!fees || fees.length === 0) {
      return NextResponse.json({ commissions: [] });
    }

    // Resolve business names
    const businessIds = [...new Set(fees.map(f => f.business_id).filter(Boolean))];
    const { data: businesses } = await supabase
      .from('businesses')
      .select('id, name')
      .in('id', businessIds);

    const nameMap = new Map((businesses || []).map(b => [b.id, b.name]));

    const commissions = fees.map(f => {
      // Build description from entity type
      let description = 'Platform fee commission';
      if (f.booking_id) description = 'Booking commission';
      else if (f.invoice_id) description = 'Invoice commission';
      else if (f.campaign_id) description = 'Campaign commission';
      else if (f.order_id) description = 'Order commission';
      else if (f.reservation_id) description = 'Reservation commission';

      return {
        id: f.id,
        amount: f.reseller_commission,
        description,
        sub_account_name: nameMap.get(f.business_id) || 'Unknown',
        created_at: f.created_at,
      };
    });

    return NextResponse.json({ commissions });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
