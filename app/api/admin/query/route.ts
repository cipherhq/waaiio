import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

function corsHeaders(origin?: string | null) {
  const allowedOrigins = [
    process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
    'http://localhost:8083',
  ];
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) });
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
  const origin = request.headers.get('origin');
  const cors = corsHeaders(origin);

  // Verify admin auth
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  const supabase = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !['admin', 'support', 'finance', 'operations'].includes(profile.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  try {
    const body = await request.json();
    const { table, select = '*', filters = [], order, limit, count } = body;

    if (!table || typeof table !== 'string') {
      return NextResponse.json({ error: 'Missing table' }, { status: 400, headers: cors });
    }

    // Whitelist allowed tables — admin gets full access, support gets restricted
    const ADMIN_TABLES = [
      'profiles', 'businesses', 'bookings', 'payments', 'orders', 'order_items', 'services',
      'products', 'business_payouts', 'platform_fees', 'support_tickets', 'support_ticket_messages',
      'bot_sessions', 'business_capabilities', 'capability_overrides',
      'business_documents', 'customer_subscriptions', 'events', 'event_tickets', 'tickets',
      'impersonation_logs', 'whatsapp_config', 'business_staff',
      'category_templates', 'canned_responses', 'feedback', 'loyalty_points',
      'referrals', 'invoices', 'quote_requests', 'campaigns',
      'refunds', 'delivery_zones', 'audit_logs', 'admin_audit_logs', 'alerts',
      'service_addons', 'whatsapp_channels', 'llm_classifications',
      'notification_logs', 'notifications', 'bot_keywords', 'payout_accounts',
      'surveys', 'survey_responses', 'subscriptions', 'admin_broadcasts',
      'ai_usage', 'conversation_usage', 'countries', 'customer_reports',
      'platform_settings', 'queue_entries', 'site_pages', 'verification_requests',
      'refund_requests', 'campaign_donations', 'reservations',
      'customer_profiles',
    ];

    // Support role: read-only access to non-sensitive tables only
    const SUPPORT_TABLES = [
      'businesses', 'bookings', 'orders', 'order_items', 'services', 'products',
      'support_tickets', 'support_ticket_messages', 'events', 'event_tickets',
      'feedback', 'invoices', 'quote_requests', 'campaigns', 'alerts',
      'notifications', 'queue_entries', 'customer_subscriptions', 'surveys', 'survey_responses',
    ];

    // Finance role: access to payment/revenue tables
    const FINANCE_TABLES = [
      ...SUPPORT_TABLES,
      'payments', 'platform_fees', 'business_payouts', 'refunds', 'refund_requests',
      'subscriptions', 'payout_accounts', 'campaign_donations', 'customer_profiles',
    ];

    // Operations role: access to business ops tables
    const OPERATIONS_TABLES = [
      ...SUPPORT_TABLES,
      'whatsapp_channels', 'whatsapp_config', 'bot_sessions', 'bot_keywords',
      'business_capabilities', 'capability_overrides', 'business_staff',
      'delivery_zones', 'reservations', 'loyalty_points',
    ];

    const TABLE_MAP: Record<string, string[]> = {
      admin: ADMIN_TABLES,
      finance: FINANCE_TABLES,
      operations: OPERATIONS_TABLES,
      support: SUPPORT_TABLES,
    };
    const allowedTables = TABLE_MAP[profile.role] || SUPPORT_TABLES;

    if (!allowedTables.includes(table)) {
      return NextResponse.json({ error: 'Table not allowed' }, { status: 403, headers: cors });
    }

    // Non-admin roles: restrict select to prevent relationship traversal (e.g., '*, profiles(*)')
    let safeSelect = select;
    if (profile.role !== 'admin') {
      // Strip any relationship traversal patterns like "table(*)" or "table!inner(*)"
      safeSelect = select.replace(/\w+[!]?\w*\([^)]*\)/g, '').replace(/,\s*,/g, ',').replace(/^,|,$/g, '').trim() || '*';
    }

    let query: any = count === 'exact'
      ? supabase.from(table).select(safeSelect, { count: 'exact', head: true })
      : supabase.from(table).select(safeSelect);

    // Apply filters
    for (const f of filters) {
      const { column, op, value } = f;

      // Validate column name — alphanumeric + underscores only (prevents JSONB operator injection)
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
        continue; // Skip invalid column names silently
      }

      switch (op) {
        case 'eq': query = query.eq(column, value); break;
        case 'neq': query = query.neq(column, value); break;
        case 'gt': query = query.gt(column, value); break;
        case 'gte': query = query.gte(column, value); break;
        case 'lt': query = query.lt(column, value); break;
        case 'lte': query = query.lte(column, value); break;
        case 'like': query = query.like(column, String(value).replace(/\\/g, '\\\\')); break;
        case 'ilike': query = query.ilike(column, String(value).replace(/\\/g, '\\\\')); break;
        case 'in': query = query.in(column, value); break;
        case 'is': query = query.is(column, value); break;
      }
    }

    if (order) {
      // Validate order column name — alphanumeric + underscores only
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(order.column)) {
        query = query.order(order.column, { ascending: order.ascending ?? false });
      }
    }

    if (limit) {
      query = query.limit(limit);
    }

    const { data, error, count: rowCount } = await query;

    if (error) {
      logger.error('[ADMIN QUERY] db error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
    }

    return NextResponse.json({ data, count: rowCount }, { headers: cors });
  } catch (error) {
    logger.error('[ADMIN QUERY] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
  }
}
