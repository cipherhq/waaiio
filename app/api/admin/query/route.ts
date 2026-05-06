import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/**
 * POST /api/admin/query
 * Generic admin data proxy — executes Supabase queries server-side with service key.
 *
 * Body: { table, select, filters, order, limit }
 * - table: string (required)
 * - select: string (default '*')
 * - filters: Array<{ column, op, value }> (optional)
 * - order: { column, ascending } (optional)
 * - limit: number (optional)
 * - count: 'exact' | undefined (optional — head count only)
 */
export async function POST(request: NextRequest) {
  // Verify admin auth
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
  }

  const supabase = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !['admin', 'support'].includes(profile.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
  }

  try {
    const body = await request.json();
    const { table, select = '*', filters = [], order, limit, count } = body;

    if (!table || typeof table !== 'string') {
      return NextResponse.json({ error: 'Missing table' }, { status: 400, headers: corsHeaders() });
    }

    // Whitelist allowed tables
    const ALLOWED_TABLES = [
      'profiles', 'businesses', 'bookings', 'payments', 'orders', 'services',
      'products', 'business_payouts', 'platform_fees', 'support_tickets',
      'bot_sessions', 'business_capabilities', 'capability_overrides',
      'business_documents', 'customer_subscriptions', 'events', 'tickets',
      'impersonation_logs', 'whatsapp_config', 'business_staff',
      'category_templates', 'canned_responses', 'feedback', 'loyalty_points',
      'referrals', 'invoices', 'quote_requests', 'campaigns',
      'refunds', 'delivery_zones', 'audit_logs', 'alerts',
      'service_addons', 'whatsapp_channels', 'llm_classifications',
      'notification_logs', 'bot_keywords', 'payout_accounts',
    ];

    if (!ALLOWED_TABLES.includes(table)) {
      return NextResponse.json({ error: 'Table not allowed' }, { status: 403, headers: corsHeaders() });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = count === 'exact'
      ? supabase.from(table).select(select, { count: 'exact', head: true })
      : supabase.from(table).select(select);

    // Apply filters
    for (const f of filters) {
      const { column, op, value } = f;
      switch (op) {
        case 'eq': query = query.eq(column, value); break;
        case 'neq': query = query.neq(column, value); break;
        case 'gt': query = query.gt(column, value); break;
        case 'gte': query = query.gte(column, value); break;
        case 'lt': query = query.lt(column, value); break;
        case 'lte': query = query.lte(column, value); break;
        case 'like': query = query.like(column, value); break;
        case 'ilike': query = query.ilike(column, value); break;
        case 'in': query = query.in(column, value); break;
        case 'is': query = query.is(column, value); break;
      }
    }

    if (order) {
      query = query.order(order.column, { ascending: order.ascending ?? false });
    }

    if (limit) {
      query = query.limit(limit);
    }

    const { data, error, count: rowCount } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500, headers: corsHeaders() });
    }

    return NextResponse.json({ data, count: rowCount }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500, headers: corsHeaders() });
  }
}
