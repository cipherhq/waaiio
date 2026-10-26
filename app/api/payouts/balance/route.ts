import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { loadPlatformSettings } from '@/lib/platformSettings';
import { computePlatformHeldTotals, getEligibleCurrencies, getUnknownCurrencyFeeRows, hasUnreconciledCurrencyRecords } from '@/lib/payments/payable-fees';
import { getCurrencyCode, type CountryCode } from '@/lib/constants';
import { loadCountries } from '@/lib/countries';

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
    .select('id, payout_mode, country_code')
    .eq('id', businessId)
    .eq('owner_id', user.id)
    .single();

  if (!biz) {
    return NextResponse.json({ error: 'Business not found' }, { status: 404 });
  }

  try {
    await loadCountries();
    // Total business revenue from completed bookings/orders/invoices (display metric — all modes)
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

    const { data: refunds } = await supabase
      .from('refunds')
      .select('amount')
      .eq('business_id', businessId)
      .eq('status', 'success');

    const totalRefunds = (refunds || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
    // total_revenue: all completed business revenue regardless of custody (display only)
    const total_revenue = bookingGross + orderGross + invoiceGross - totalRefunds;

    // Payout basis: already-paid and pending payouts (shared across both modes)
    // Adjustments: fetch ALL for the lifetime balance, unapplied-only for display.
    // Prior payouts' net_amount already includes applied adjustments; including them
    // again in the lifetime sum cancels correctly (P1-2 fix).
    const [{ data: payouts, error: paidError }, { data: pendingPayouts, error: pendingError }, { data: allAdjustments, error: adjustmentsError }, { data: pendingAdjustmentRows, error: pendingAdjustmentsError }] = await Promise.all([
      supabase
        .from('business_payouts')
        .select('net_amount, status, currency')
        .eq('business_id', businessId)
        .in('status', ['paid', 'processing']),
      supabase
        .from('business_payouts')
        .select('net_amount, currency')
        .eq('business_id', businessId)
        .in('status', ['pending', 'approved']),
      supabase
        .from('payout_adjustments')
        .select('amount, currency')
        .eq('business_id', businessId),
      supabase
        .from('payout_adjustments')
        .select('amount, currency')
        .eq('business_id', businessId)
        .is('applied_to_payout_id', null),
    ]);

    if (paidError || pendingError || adjustmentsError || pendingAdjustmentsError) {
      return NextResponse.json({ error: 'Unable to verify payout and adjustment balances' }, { status: 503 });
    }

    let paidOut = (payouts || []).reduce((sum, p) => sum + Number(p.net_amount || 0), 0);
    let pending = (pendingPayouts || []).reduce((sum, p) => sum + Number(p.net_amount || 0), 0);
    let allAdjustmentSum = (allAdjustments || []).reduce((sum, a) => sum + Number(a.amount || 0), 0);
    let pendingAdjustments = (pendingAdjustmentRows || []).reduce((sum, a) => sum + Number(a.amount || 0), 0);

    // Payout-basis gross, fees, and net — derived from platform_fees custody classification
    let gross: number;
    let totalFees: number;
    let netAvailable: number;

    if (biz.payout_mode === 'direct_split') {
      // For direct_split, Paystack deducts the fee at gateway level.
      // Use total_revenue as gross and compute the platform percentage as the fee estimate.
      gross = total_revenue;
      const { data: payoutAccount } = await supabase
        .from('payout_accounts')
        .select('platform_percentage')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .maybeSingle();

      const settings = await loadPlatformSettings({ useServiceClient: true });
      const pct = payoutAccount?.platform_percentage ?? settings.default_platform_fee_percent;
      totalFees = Math.round(gross * (pct / 100));
      netAvailable = Math.max(0, gross - totalFees - paidOut - pending + allAdjustmentSum);
    } else {
      // platform_managed: derive gross and net from custody-classified platform_fees rows.
      // This is the authoritative payout basis — matches generate and auto-payout exactly.
      // M466: Include currency via payments join
      const { data: platformFeesRaw, error: platformFeesError } = await supabase
        .from('platform_fees')
        .select('transaction_amount, fee_total, gateway_fee, waived, is_direct_transfer, payments(currency)')
        .eq('business_id', businessId)
        .is('refunded_at', null);
      const platformFees = (platformFeesRaw || []).map(f => ({
        ...f,
        currency: (f as unknown as { payments: { currency: string } }).payments?.currency ?? null,
      }));

      const allPriorPayouts = [...(payouts || []), ...(pendingPayouts || [])].map(p => ({
        ...p, currency: (p as unknown as { currency?: string }).currency ?? null,
      }));
      const adjRows = (allAdjustments || []).map(a => ({
        ...a, currency: (a as unknown as { currency?: string }).currency ?? null,
      }));

      // M468: A scalar balance must never silently mix or omit monetary currencies.
      // Mixed-currency merchants require a dedicated per-currency dashboard contract.
      const currencies = getEligibleCurrencies(platformFees);
      let homeCurrency: string | undefined;
      try { homeCurrency = getCurrencyCode((biz.country_code || '') as CountryCode); } catch { /* unknown country */ }
      if (platformFeesError || !homeCurrency || getUnknownCurrencyFeeRows(platformFees).length > 0 ||
          currencies.length > 1 || (currencies.length === 1 && currencies[0] !== homeCurrency) ||
          hasUnreconciledCurrencyRecords(allPriorPayouts, adjRows)) {
        return NextResponse.json({ error: 'Currency reconciliation required. Available balance cannot safely be represented as one currency.' }, { status: 409 });
      }
      paidOut = (payouts || []).filter(p => p.currency === homeCurrency).reduce((sum, p) => sum + Number(p.net_amount || 0), 0);
      pending = (pendingPayouts || []).filter(p => p.currency === homeCurrency).reduce((sum, p) => sum + Number(p.net_amount || 0), 0);
      allAdjustmentSum = adjRows.filter(a => a.currency === homeCurrency).reduce((sum, a) => sum + Number(a.amount || 0), 0);
      pendingAdjustments = (pendingAdjustmentRows || []).filter(a => a.currency === homeCurrency).reduce((sum, a) => sum + Number(a.amount || 0), 0);
      const totals = computePlatformHeldTotals(platformFees, homeCurrency, adjRows, allPriorPayouts);
      gross = totals.gross;
      totalFees = totals.totalFees + totals.gatewayFees;
      netAvailable = totals.netAvailable;
    }

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
      total_revenue,      // all completed business revenue (bookings + orders + invoices − refunds)
      gross,              // platform-held gross from platform_fees (platform_managed) or = total_revenue (direct_split)
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
