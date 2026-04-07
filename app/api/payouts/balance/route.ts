import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!businessId) {
    return NextResponse.json({ error: 'Missing business_id' }, { status: 400 });
  }

  // Verify the user owns this business
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  try {
    // Get total successful payments for this business
    const { data: payments } = await supabase
      .from('payments')
      .select('amount')
      .eq('business_id', businessId)
      .eq('status', 'success');

    const gross = (payments || []).reduce((sum, p) => sum + Number(p.amount || 0), 0);

    // Get platform fees
    const { data: fees } = await supabase
      .from('platform_fees')
      .select('fee_total')
      .eq('business_id', businessId)
      .eq('waived', false);

    const totalFees = (fees || []).reduce((sum, f) => sum + Number(f.fee_total || 0), 0);

    // Get already paid out amounts
    const { data: payouts } = await supabase
      .from('business_payouts')
      .select('net_amount, status')
      .eq('business_id', businessId)
      .in('status', ['paid', 'processing']);

    const paidOut = (payouts || []).reduce((sum, p) => sum + Number(p.net_amount || 0), 0);

    // Get pending payouts
    const { data: pendingPayouts } = await supabase
      .from('business_payouts')
      .select('net_amount')
      .eq('business_id', businessId)
      .in('status', ['pending', 'approved']);

    const pending = (pendingPayouts || []).reduce((sum, p) => sum + Number(p.net_amount || 0), 0);

    const netAvailable = Math.max(0, gross - totalFees - paidOut - pending);

    return NextResponse.json({
      gross,
      fees: totalFees,
      net_available: netAvailable,
      paid_out: paidOut,
      pending_payouts: pending,
    });
  } catch (error) {
    console.error('Balance error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to calculate balance' }, { status: 500 });
  }
}
