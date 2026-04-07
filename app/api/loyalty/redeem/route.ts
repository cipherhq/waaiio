import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

export async function POST(request: NextRequest) {
  try {
    const { businessId, customerPhone, points, reason } = await request.json();
    if (!businessId || !customerPhone || !points) {
      return NextResponse.json({ error: 'businessId, customerPhone, and points required' }, { status: 400 });
    }

    if (points <= 0) {
      return NextResponse.json({ error: 'Points must be positive' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Get current loyalty balance
    const { data: loyalty } = await supabase
      .from('loyalty_points')
      .select('id, points_balance, total_redeemed')
      .eq('business_id', businessId)
      .eq('customer_phone', customerPhone)
      .single();

    if (!loyalty) {
      return NextResponse.json({ error: 'Customer not found in loyalty program' }, { status: 404 });
    }

    if (loyalty.points_balance < points) {
      return NextResponse.json({ error: 'Insufficient points balance' }, { status: 400 });
    }

    // Deduct points
    await supabase
      .from('loyalty_points')
      .update({
        points_balance: loyalty.points_balance - points,
        total_redeemed: loyalty.total_redeemed + points,
      })
      .eq('id', loyalty.id);

    // Record transaction
    await supabase.from('loyalty_transactions').insert({
      business_id: businessId,
      customer_phone: customerPhone,
      points_change: -points,
      reason: reason || 'redemption',
    });

    return NextResponse.json({
      success: true,
      new_balance: loyalty.points_balance - points,
    });
  } catch (error) {
    console.error('[LOYALTY] Redeem error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
