import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

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

  const admin = await requirePlatformAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });
  }

  const supabase = createServiceClient();

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
    const allowedTables = TABLE_MAP[admin.role] || SUPPORT_TABLES;

    // FIN-001: Column-level allowlists for sensitive tables (non-admin roles)
    // These tables contain provider credentials or bank details that must not
    // be returned through the generic query route for non-admin roles.
    const APPROVED_COLUMNS: Record<string, string[]> = {
      payout_accounts: [
        'id', 'business_id', 'gateway', 'bank_name', 'account_name',
        'platform_percentage', 'is_active', 'verified_at', 'created_at',
        'updated_at', 'country_code',
      ],
      whatsapp_channels: [
        'id', 'business_id', 'phone_number', 'display_name', 'quality_rating',
        'status', 'channel_type', 'is_active', 'country_code', 'waba_id',
        'phone_number_id', 'created_at', 'updated_at',
      ],
      businesses: [
        'id', 'name', 'slug', 'category', 'country_code', 'currency',
        'owner_id', 'status', 'payout_mode', 'verification_level',
        'payout_limit_monthly', 'created_at', 'updated_at',
        'description', 'address', 'city', 'state', 'zip_code',
        'phone', 'email', 'website', 'logo_url', 'cover_url',
        'timezone', 'booking_advance_days', 'booking_cancel_hours',
      ],
    };

    // FIN-001: Columns that must never be returned through the generic query
    // route, even for admin. Access to these requires a dedicated purpose-built route.
    const CREDENTIAL_COLUMNS = new Set([
      'meta_access_token', 'square_access_token', 'square_refresh_token',
      'stripe_account_id', 'google_calendar_token', 'google_calendar_refresh_token',
    ]);

    if (!allowedTables.includes(table)) {
      return NextResponse.json({ error: 'Table not allowed' }, { status: 403, headers: cors });
    }

    // Non-admin roles: restrict select to prevent relationship traversal (e.g., '*, profiles(*)')
    let safeSelect = select;
    if (admin.role !== 'admin') {
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
      const safeLimited = Math.min(Math.max(1, Number(limit) || 100), 1000);
      query = query.limit(safeLimited);
    }

    const { data, error, count: rowCount } = await query;

    if (error) {
      logger.withContext({ op: 'admin-query', table, ...safeLogErrorContext(error) })
        .error('[ADMIN QUERY] db error');
      return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
    }

    // FIN-001: Strip credential columns from all responses (including admin)
    // and enforce column allowlists for non-admin roles
    if (Array.isArray(data)) {
      const approvedCols = admin.role !== 'admin' ? APPROVED_COLUMNS[table] : null;
      const approvedSet = approvedCols ? new Set(approvedCols) : null;

      for (const row of data) {
        for (const key of Object.keys(row)) {
          // Always strip credential columns regardless of role
          if (CREDENTIAL_COLUMNS.has(key)) {
            delete row[key];
          }
          // For non-admin roles with column allowlists, strip unapproved columns
          else if (approvedSet && !approvedSet.has(key)) {
            delete row[key];
          }
        }
      }
    }

    return NextResponse.json({ data, count: rowCount }, { headers: cors });
  } catch (error) {
    logger.withContext({ op: 'admin-query', ...safeLogErrorContext(error) })
      .error('[ADMIN QUERY] error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
  }
}
