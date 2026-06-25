import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { loadPlatformSettings } from '@/lib/platformSettings';

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
    .select('id, payout_mode')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  try {
    // Get total successful payments via bookings and orders
    const [{ data: bookingPayments }, { data: orderPayments }, { data: invoicePayments }] = await Promise.all([
      supabase
        .from('bookings')
        .select('total_amount, deposit_amount, deposit_status')
        .eq('business_id', businessId)
        .eq('deposit_status', 'paid'),
      supabase
        .from('orders')
        .select('total_amount, status')
        .eq('business_id', businessId)
        .in('status', ['confirmed', 'delivered']),
      supabase
        .from('invoices')
        .select('total_amount, status')
        .eq('business_id', businessId)
        .eq('status', 'paid'),
    ]);

    const bookingGross = (bookingPayments || []).reduce((sum, b) => sum + Number(b.deposit_amount || b.total_amount || 0), 0);
    const orderGross = (orderPayments || []).reduce((sum, o) => sum + Number(o.total_amount || 0), 0);
    const invoiceGross = (invoicePayments || []).reduce((sum, i) => sum + Number(i.total_amount || 0), 0);

    // Subtract successful refunds
    const { data: refunds } = await supabase
      .from('refunds')
      .select('amount')
      .eq('business_id', businessId)
      .eq('status', 'success');

    const totalRefunds = (refunds || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const gross = bookingGross + orderGross + invoiceGross - totalRefunds;

    // Get platform fees
    let totalFees = 0;
    if (biz.payout_mode === 'direct_split') {
      // For direct_split, Paystack deducts the fee at gateway level.
      // Calculate from the payout account's platform_percentage instead.
      const { data: payoutAccount } = await supabase
        .from('payout_accounts')
        .select('platform_percentage')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .maybeSingle();

      const settings = await loadPlatformSettings({ useServiceClient: true });
      const pct = payoutAccount?.platform_percentage ?? settings.default_platform_fee_percent;
      totalFees = Math.round(gross * (pct / 100));
    } else {
      const { data: fees } = await supabase
        .from('platform_fees')
        .select('fee_total')
        .eq('business_id', businessId)
        .eq('waived', false)
        .is('refunded_at', null);

      totalFees = (fees || []).reduce((sum, f) => sum + Number(f.fee_total || 0), 0);
    }

    // Get already paid out amounts
    const { data: payouts } = await supabase
      .from('business_payouts')
      .select('net_amount, status')
      .eq('business_id', businessId)
      .in('status', ['paid', 'processing']);

    const paidOut = (payouts || []).reduce((sum, p) => sum + Number(p.net_amount || 0), 0);

    // Get unapplied payout adjustments (e.g. post-payout refunds pending deduction)
    const { data: adjustments } = await supabase
      .from('payout_adjustments')
      .select('amount')
      .eq('business_id', businessId)
      .is('applied_to_payout_id', null);

    const pendingAdjustments = (adjustments || []).reduce((sum, a) => sum + Number(a.amount || 0), 0);

    // Get pending payouts
    const { data: pendingPayouts } = await supabase
      .from('business_payouts')
      .select('net_amount')
      .eq('business_id', businessId)
      .in('status', ['pending', 'approved']);

    const pending = (pendingPayouts || []).reduce((sum, p) => sum + Number(p.net_amount || 0), 0);

    const netAvailable = Math.max(0, gross - totalFees - paidOut - pending + pendingAdjustments);

    // Get pending revenue from orders (confirmed but not yet paid)
    const { data: pendingOrders } = await supabase
      .from('orders')
      .select('total_amount')
      .eq('business_id', businessId)
      .in('status', ['confirmed', 'processing', 'shipped', 'ready']);

    const pendingOrderRevenue = (pendingOrders || []).reduce((sum, o) => sum + Number(o.total_amount || 0), 0);

    // Get pending revenue from bookings (confirmed but payment pending)
    const { data: pendingBookings } = await supabase
      .from('bookings')
      .select('total_amount')
      .eq('business_id', businessId)
      .eq('status', 'confirmed');

    const pendingBookingRevenue = (pendingBookings || []).reduce((sum, b) => sum + Number(b.total_amount || 0), 0);

    // Total completed orders and bookings count
    const { count: completedOrderCount } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .in('status', ['confirmed', 'processing', 'shipped', 'ready', 'delivered']);

    const { count: completedBookingCount } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .eq('status', 'confirmed');

    return NextResponse.json({
      gross,
      fees: totalFees,
      net_available: netAvailable,
      paid_out: paidOut,
      pending_payouts: pending,
      pending_adjustments: pendingAdjustments,
      pending_order_revenue: pendingOrderRevenue,
      pending_booking_revenue: pendingBookingRevenue,
      total_orders: completedOrderCount || 0,
      total_bookings: completedBookingCount || 0,
    });
  } catch (error) {
    logger.error('Balance error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to calculate balance' }, { status: 500 });
  }
}
