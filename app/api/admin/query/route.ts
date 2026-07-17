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

    // ── Column security for non-admin roles ──
    // Allowlist approach: only approved columns can be selected.
    // New/unknown columns are rejected by default (safe against schema changes).
    // Tables without an explicit allowlist get select=* (bookings, orders, etc.
    // do not contain credentials — only the tables below have secrets).
    const APPROVED_COLUMNS: Record<string, string[]> = {
      payout_accounts: [
        'id', 'business_id', 'gateway', 'bank_name', 'account_name',
        'platform_percentage', 'is_active', 'verified_at', 'created_at', 'updated_at',
        'country_code',
        // EXCLUDED: account_number, square_access_token, stripe_account_id,
        //           routing_number, subaccount_code, iban, swift_code, square_merchant_id
      ],
      subscriptions: [
        'id', 'business_id', 'plan', 'status', 'amount', 'currency',
        'current_period_start', 'current_period_end', 'cancelled_at',
        'created_at', 'updated_at', 'gateway', 'billing_interval', 'cancellation_reason',
        // EXCLUDED: paystack_subscription_code, paystack_customer_code,
        //           stripe_subscription_id, stripe_customer_id
      ],
      payments: [
        'id', 'booking_id', 'user_id', 'amount', 'currency', 'gateway',
        'payment_method', 'card_last_four', 'card_brand', 'status',
        'paid_at', 'created_at', 'business_id', 'refund_amount',
        'reservation_id', 'invoice_id', 'campaign_id', 'order_id', 'gateway_fee',
        // EXCLUDED: gateway_reference, gateway_status, metadata, payer_ip,
        //           payer_country, payer_device_fingerprint, fraud_score, fraud_flags
      ],
    };

    // Non-admin roles: enforce column allowlist
    let safeSelect = select;
    if (profile.role !== 'admin') {
      // Strip relationship traversal patterns
      safeSelect = select.replace(/\w+[!]?\w*\([^)]*\)/g, '').replace(/,\s*,/g, ',').replace(/^,|,$/g, '').trim() || '*';

      const approvedCols = APPROVED_COLUMNS[table];
      if (approvedCols) {
        if (safeSelect === '*' || safeSelect === '') {
          // Replace * with approved columns only
          safeSelect = approvedCols.join(', ');
        } else {
          // Validate each requested column against the allowlist
          const requestedCols = safeSelect.split(',').map((c: string) => c.trim()).filter(Boolean);
          const forbidden = requestedCols.filter((c: string) => !approvedCols.includes(c));
          if (forbidden.length > 0) {
            return NextResponse.json(
              { error: `Columns not permitted: ${forbidden.join(', ')}` },
              { status: 403, headers: cors },
            );
          }
        }
      }
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
      logger.error('[ADMIN QUERY] db error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
    }

    // Defense in depth: for tables with an approved column list, strip any
    // column from the response that isn't in the allowlist. This catches
    // edge cases where the DB returns extra columns (e.g., schema changes).
    if (profile.role !== 'admin' && Array.isArray(data)) {
      const approvedCols = APPROVED_COLUMNS[table];
      if (approvedCols) {
        const approvedSet = new Set(approvedCols);
        for (const row of data as Record<string, unknown>[]) {
          for (const key of Object.keys(row)) {
            if (!approvedSet.has(key)) {
              delete row[key];
            }
          }
        }
      }
    }

    return NextResponse.json({ data, count: rowCount }, { headers: cors });
  } catch (error) {
    logger.error('[ADMIN QUERY] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: cors });
  }
}
