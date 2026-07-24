import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import {
  classifyIntent,
  FINANCE_REPORTS, FINANCE_ROLES,
  type ReportId, type FollowUpContext,
} from '@/lib/copilot/classify-intent';

// ─── Timezone helpers ────────────────────────────────────
function getBusinessDates(timezone: string) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = formatter.format(now); // YYYY-MM-DD

  const parts = today.split('-').map(Number);
  const year = parts[0];
  const month = parts[1];

  // Calendar week: Monday of this week
  const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const dayOfWeek = nowInTz.getDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(nowInTz);
  monday.setDate(monday.getDate() - mondayOffset);
  monday.setHours(0, 0, 0, 0);
  const weekStart = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(monday);

  // Calendar month start
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;

  // Previous week (Mon–Sun)
  const prevMonday = new Date(monday);
  prevMonday.setDate(prevMonday.getDate() - 7);
  const prevSunday = new Date(monday);
  prevSunday.setDate(prevSunday.getDate() - 1);
  const prevWeekStart = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(prevMonday);
  const prevWeekEnd = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(prevSunday);

  // Previous month
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevMonthYear = month === 1 ? year - 1 : year;
  const prevMonthStart = `${prevMonthYear}-${String(prevMonth).padStart(2, '0')}-01`;
  const prevMonthEnd = `${year}-${String(month).padStart(2, '0')}-01`; // exclusive

  // Tomorrow for upcoming
  const tomorrow = new Date(nowInTz);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);

  // 7 days ahead for upcoming
  const nextWeek = new Date(nowInTz);
  nextWeek.setDate(nextWeek.getDate() + 7);
  const nextWeekStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(nextWeek);

  // 30 days ago for metrics
  const thirtyDaysAgo = new Date(nowInTz);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(thirtyDaysAgo);

  return {
    today, weekStart, monthStart,
    prevWeekStart, prevWeekEnd, prevMonthStart, prevMonthEnd,
    tomorrowStr, nextWeekStr, thirtyDaysAgoStr,
  };
}

// ─── Report handlers ─────────────────────────────────────
type ReportResult = { answer: string; reportId: ReportId };

async function runReport(
  reportId: ReportId,
  db: ReturnType<typeof createServiceClient>,
  businessId: string,
  countryCode: CountryCode,
  timezone: string,
): Promise<ReportResult> {
  const dates = getBusinessDates(timezone);
  const fmt = (amount: number) => formatCurrency(amount, countryCode);

  switch (reportId) {
    // ── Bookings ──
    case 'bookings_today': {
      const { count } = await db
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .eq('date', dates.today)
        .not('status', 'in', '(cancelled,no_show)');
      return { answer: `You have ${count || 0} bookings today.`, reportId };
    }

    case 'bookings_upcoming': {
      const { data } = await db
        .from('bookings')
        .select('date, time, guest_name, status')
        .eq('business_id', businessId)
        .gte('date', dates.tomorrowStr)
        .lte('date', dates.nextWeekStr)
        .not('status', 'in', '(cancelled,no_show)')
        .order('date', { ascending: true })
        .order('time', { ascending: true })
        .limit(10);
      if (!data?.length) return { answer: 'No upcoming bookings in the next 7 days.', reportId };
      const lines = data.map(b => `• ${b.date} ${b.time ? `at ${b.time}` : ''} — ${b.guest_name || 'Guest'} (${b.status})`);
      return { answer: `${data.length} upcoming booking${data.length > 1 ? 's' : ''} this week:\n${lines.join('\n')}`, reportId };
    }

    case 'bookings_week': {
      const { count } = await db
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .gte('date', dates.weekStart)
        .not('status', 'in', '(cancelled,no_show)');
      return { answer: `You have ${count || 0} bookings this week (since Monday).`, reportId };
    }

    case 'bookings_month': {
      const { count } = await db
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .gte('date', dates.monthStart)
        .not('status', 'in', '(cancelled,no_show)');
      return { answer: `You have ${count || 0} bookings this month.`, reportId };
    }

    // ── Orders ──
    case 'orders_today': {
      const { count } = await db
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .gte('created_at', `${dates.today}T00:00:00`)
        .not('status', 'eq', 'cancelled');
      return { answer: `You have ${count || 0} orders placed today.`, reportId };
    }

    case 'orders_pending': {
      const { count } = await db
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .in('status', ['pending', 'confirmed', 'processing']);
      return { answer: `You have ${count || 0} pending/in-progress orders.`, reportId };
    }

    // ── Revenue ──
    case 'revenue_today': {
      const { data: payments } = await db
        .from('payments')
        .select('amount')
        .eq('business_id', businessId)
        .eq('status', 'success')
        .gte('paid_at', `${dates.today}T00:00:00`);
      const total = (payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
      return { answer: `Today's revenue: ${fmt(total)}.`, reportId };
    }

    case 'revenue_week': {
      const { data: payments } = await db
        .from('payments')
        .select('amount')
        .eq('business_id', businessId)
        .eq('status', 'success')
        .gte('paid_at', `${dates.weekStart}T00:00:00`);
      const total = (payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
      return { answer: `This week's revenue (Mon–today): ${fmt(total)}.`, reportId };
    }

    case 'revenue_month': {
      const { data: payments } = await db
        .from('payments')
        .select('amount')
        .eq('business_id', businessId)
        .eq('status', 'success')
        .gte('paid_at', `${dates.monthStart}T00:00:00`);
      const total = (payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
      return { answer: `This month's revenue: ${fmt(total)}.`, reportId };
    }

    case 'revenue_compare': {
      // This week vs last week
      const [thisWeek, lastWeek] = await Promise.all([
        db.from('payments').select('amount')
          .eq('business_id', businessId).eq('status', 'success')
          .gte('paid_at', `${dates.weekStart}T00:00:00`),
        db.from('payments').select('amount')
          .eq('business_id', businessId).eq('status', 'success')
          .gte('paid_at', `${dates.prevWeekStart}T00:00:00`)
          .lte('paid_at', `${dates.prevWeekEnd}T23:59:59`),
      ]);
      const thisTotal = (thisWeek.data || []).reduce((s, p) => s + (p.amount || 0), 0);
      const lastTotal = (lastWeek.data || []).reduce((s, p) => s + (p.amount || 0), 0);
      const diff = thisTotal - lastTotal;
      const pct = lastTotal > 0 ? Math.round((diff / lastTotal) * 100) : thisTotal > 0 ? 100 : 0;
      const direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
      return {
        answer: `This week: ${fmt(thisTotal)} | Last week: ${fmt(lastTotal)}\n${direction === 'flat' ? 'No change' : `${direction === 'up' ? 'Up' : 'Down'} ${Math.abs(pct)}%`} week over week.`,
        reportId,
      };
    }

    // ── Unpaid ──
    case 'unpaid_bookings': {
      const { count } = await db
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .eq('deposit_status', 'pending')
        .not('status', 'in', '(cancelled,no_show)');
      return { answer: `You have ${count || 0} unpaid bookings (excluding cancelled and no-shows).`, reportId };
    }

    case 'unpaid_invoices': {
      const { count } = await db
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .in('status', ['sent', 'viewed', 'overdue']);
      return { answer: `You have ${count || 0} unpaid invoices.`, reportId };
    }

    // ── Products & Services ──
    case 'top_products': {
      const { data } = await db
        .from('order_items')
        .select('product_id, quantity, unit_price, products!inner(name)')
        .eq('products.business_id', businessId)
        .order('quantity', { ascending: false })
        .limit(50);
      if (!data?.length) return { answer: 'No product sales data yet.', reportId };
      // Aggregate by product
      const agg = new Map<string, { name: string; qty: number; revenue: number }>();
      for (const item of data) {
        const name = (item.products as unknown as { name: string })?.name || 'Unknown';
        const existing = agg.get(item.product_id) || { name, qty: 0, revenue: 0 };
        existing.qty += item.quantity;
        existing.revenue += item.quantity * item.unit_price;
        agg.set(item.product_id, existing);
      }
      const sorted = [...agg.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
      const lines = sorted.map((p, i) => `${i + 1}. ${p.name} — ${p.qty} sold (${fmt(p.revenue)})`);
      return { answer: `Top products by quantity:\n${lines.join('\n')}`, reportId };
    }

    case 'top_services': {
      const { data } = await db
        .from('bookings')
        .select('service_id, services!inner(name)')
        .eq('business_id', businessId)
        .not('status', 'in', '(cancelled,no_show)')
        .gte('date', dates.thirtyDaysAgoStr)
        .limit(200);
      if (!data?.length) return { answer: 'No booking data in the last 30 days.', reportId };
      const agg = new Map<string, { name: string; count: number }>();
      for (const b of data) {
        if (!b.service_id) continue;
        const name = (b.services as unknown as { name: string })?.name || 'Unknown';
        const existing = agg.get(b.service_id) || { name, count: 0 };
        existing.count++;
        agg.set(b.service_id, existing);
      }
      const sorted = [...agg.values()].sort((a, b) => b.count - a.count).slice(0, 5);
      const lines = sorted.map((s, i) => `${i + 1}. ${s.name} — ${s.count} bookings`);
      return { answer: `Most booked services (last 30 days):\n${lines.join('\n')}`, reportId };
    }

    // ── Customers ──
    case 'customers_new': {
      const { count } = await db
        .from('customer_profiles')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .gte('created_at', `${dates.monthStart}T00:00:00`);
      return { answer: `${count || 0} new customers this month.`, reportId };
    }

    case 'customers_returning': {
      const { count } = await db
        .from('customer_profiles')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .gt('total_visits', 1);
      return { answer: `${count || 0} returning customers (2+ visits).`, reportId };
    }

    // ── Cancellations ──
    case 'cancellation_rate': {
      const [total, cancelled] = await Promise.all([
        db.from('bookings').select('id', { count: 'exact', head: true })
          .eq('business_id', businessId).gte('date', dates.monthStart),
        db.from('bookings').select('id', { count: 'exact', head: true })
          .eq('business_id', businessId).eq('status', 'cancelled').gte('date', dates.monthStart),
      ]);
      const totalCount = total.count || 0;
      const cancelledCount = cancelled.count || 0;
      const rate = totalCount > 0 ? Math.round((cancelledCount / totalCount) * 100) : 0;
      return { answer: `This month: ${cancelledCount} cancelled out of ${totalCount} bookings (${rate}% cancellation rate).`, reportId };
    }

    // ── Check-ins ──
    case 'checkins_today': {
      const { count } = await db
        .from('attendance_log')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .gte('checked_in_at', `${dates.today}T00:00:00`);
      return { answer: `${count || 0} check-ins today.`, reportId };
    }

    // ── Low stock ──
    case 'low_stock': {
      const { data } = await db
        .from('products')
        .select('name, stock_quantity')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .eq('track_inventory', true)
        .lte('stock_quantity', 5)
        .order('stock_quantity', { ascending: true })
        .limit(10);
      if (!data?.length) return { answer: 'No low-stock products. Inventory looks good.', reportId };
      const lines = data.map(p => `• ${p.name}: ${p.stock_quantity ?? 0} left`);
      return { answer: `${data.length} low-stock product${data.length > 1 ? 's' : ''}:\n${lines.join('\n')}`, reportId };
    }

    // ── Attention items ──
    case 'attention_items': {
      const [pendingBookings, pendingOrders, overdueInvoices, lowStock] = await Promise.all([
        db.from('bookings').select('id', { count: 'exact', head: true })
          .eq('business_id', businessId).eq('status', 'pending').eq('date', dates.today),
        db.from('orders').select('id', { count: 'exact', head: true })
          .eq('business_id', businessId).in('status', ['pending', 'confirmed']),
        db.from('invoices').select('id', { count: 'exact', head: true })
          .eq('business_id', businessId).eq('status', 'overdue'),
        db.from('products').select('id', { count: 'exact', head: true })
          .eq('business_id', businessId).eq('is_active', true).eq('track_inventory', true).lte('stock_quantity', 5),
      ]);
      const items: string[] = [];
      if (pendingBookings.count) items.push(`• ${pendingBookings.count} pending booking${pendingBookings.count > 1 ? 's' : ''} today`);
      if (pendingOrders.count) items.push(`• ${pendingOrders.count} order${pendingOrders.count > 1 ? 's' : ''} to fulfill`);
      if (overdueInvoices.count) items.push(`• ${overdueInvoices.count} overdue invoice${overdueInvoices.count > 1 ? 's' : ''}`);
      if (lowStock.count) items.push(`• ${lowStock.count} product${lowStock.count > 1 ? 's' : ''} running low on stock`);
      if (!items.length) return { answer: 'Nothing needs your attention right now. All clear.', reportId };
      return { answer: `Items needing attention:\n${items.join('\n')}`, reportId };
    }

    default:
      return { answer: 'Report not available.', reportId };
  }
}

// ─── Main handler ────────────────────────────────────────
export async function POST(request: NextRequest) {
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'copilot'), 20, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { question, business_id, context } = await request.json() as {
      question?: string;
      business_id?: string;
      context?: FollowUpContext;
    };
    if (!question || !business_id) {
      return NextResponse.json({ error: 'question and business_id required' }, { status: 400 });
    }

    // Verify ownership or team membership
    const serviceDb = createServiceClient();
    const [bizResult, memberResult] = await Promise.all([
      supabase
        .from('businesses')
        .select('id, name, timezone, country_code')
        .eq('id', business_id)
        .eq('owner_id', user.id)
        .maybeSingle(),
      serviceDb
        .from('business_members')
        .select('role')
        .eq('business_id', business_id)
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle(),
    ]);

    const biz = bizResult.data;
    const member = memberResult.data;
    const userRole = biz ? 'owner' : (member?.role as string | undefined);

    if (!biz && !member) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    // Get business details (if member, fetch separately)
    let bizData = biz;
    if (!bizData) {
      const { data } = await serviceDb
        .from('businesses')
        .select('id, name, timezone, country_code')
        .eq('id', business_id)
        .maybeSingle();
      bizData = data;
    }
    if (!bizData) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

    const timezone = bizData.timezone || 'UTC';
    const countryCode = (bizData.country_code || 'NG') as CountryCode;

    // Classify intent
    const { report, followUp } = classifyIntent(question, context);

    if (!report) {
      return NextResponse.json({
        answer: "I can help with bookings, revenue, orders, customers, products, services, invoices, cancellations, stock levels, and check-ins. Try asking something like:\n\n• How many bookings today?\n• What's my revenue this week?\n• Any unpaid invoices?\n• What are my top products?\n• Anything needing attention?",
        context: context || {},
      });
    }

    // Permission check: staff/support can't see financial reports
    if (FINANCE_REPORTS.includes(report) && userRole && !FINANCE_ROLES.includes(userRole)) {
      return NextResponse.json({
        answer: 'You don\'t have permission to view financial reports. Please ask your business owner or manager.',
        context: context || {},
      });
    }

    // Execute report
    const result = await runReport(report, serviceDb, business_id, countryCode, timezone);

    return NextResponse.json({
      answer: result.answer,
      context: {
        lastReport: result.reportId,
        lastPeriod: followUp ? context?.lastPeriod : undefined,
      } satisfies FollowUpContext,
    });
  } catch (err) {
    logger.error('[COPILOT] Error:', err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
