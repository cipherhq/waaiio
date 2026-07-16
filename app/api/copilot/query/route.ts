import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'copilot'), 20, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { question, business_id } = await request.json();
    if (!question || !business_id) {
      return NextResponse.json({ error: 'question and business_id required' }, { status: 400 });
    }

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

    const serviceDb = createServiceClient();
    const lower = question.toLowerCase();
    let answer = '';

    // Route to appropriate query
    if (/booking|appointment/i.test(lower) && /today|now/i.test(lower)) {
      const { count } = await serviceDb
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', business_id)
        .gte('created_at', new Date().toISOString().split('T')[0]);
      answer = `You have ${count || 0} bookings today.`;
    } else if (/revenue|earn|income|money/i.test(lower)) {
      const period = /week/i.test(lower) ? 7 : /month/i.test(lower) ? 30 : 1;
      const since = new Date();
      since.setDate(since.getDate() - period);
      const { data: payments } = await serviceDb
        .from('payments')
        .select('amount')
        .eq('business_id', business_id)
        .eq('payment_status', 'success')
        .gte('created_at', since.toISOString());
      const total = (payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
      const periodLabel = period === 1 ? 'today' : period === 7 ? 'this week' : 'this month';
      answer = `Your revenue ${periodLabel} is ${total.toLocaleString()}.`;
    } else if (/order/i.test(lower) && /today|recent/i.test(lower)) {
      const { count } = await serviceDb
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', business_id)
        .gte('created_at', new Date().toISOString().split('T')[0]);
      answer = `You have ${count || 0} orders today.`;
    } else if (/unpaid|outstanding/i.test(lower)) {
      const { count } = await serviceDb
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', business_id)
        .eq('payment_status', 'pending');
      answer = `You have ${count || 0} unpaid bookings.`;
    } else if (/top.*product|best.*sell|popular.*product/i.test(lower)) {
      const { data } = await serviceDb
        .from('order_items')
        .select('product_id, quantity')
        .eq('business_id', business_id)
        .order('quantity', { ascending: false })
        .limit(3);
      if (data?.length) {
        answer = `Your top ${data.length} products by quantity sold are being calculated. Check the Analytics page for details.`;
      } else {
        answer = 'No product sales data found yet.';
      }
    } else if (/check.?in|attendance/i.test(lower)) {
      const { count } = await serviceDb
        .from('attendance_log')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', business_id)
        .gte('checked_in_at', new Date().toISOString().split('T')[0]);
      answer = `You have ${count || 0} check-ins today.`;
    } else {
      answer = "I can help with bookings, revenue, orders, unpaid bookings, top products, and check-ins. Try asking something like \"How many bookings today?\" or \"What was my revenue this week?\"";
    }

    return NextResponse.json({ answer });
  } catch (err) {
    logger.error('[COPILOT] Error:', err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
