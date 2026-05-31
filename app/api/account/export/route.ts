import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * GDPR Article 20 — Right to Data Portability
 * CCPA — Right to Know
 *
 * Generates a JSON or CSV export of ALL user data.
 * Rate limited to 1 export per 24 hours per user.
 *
 * Query params:
 *   ?format=csv  — returns a ZIP of CSVs (one per table)
 *   ?format=json — returns a single JSON file (default)
 *
 * Rate limit uses platform_settings table with key `export:{userId}`
 * instead of in-memory Map (which doesn't persist across serverless invocations).
 */

const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Escape a value for CSV: quote strings containing commas, quotes, or newlines */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Convert an array of objects to a CSV string */
function arrayToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(',')),
  ];
  return lines.join('\n');
}

export async function POST(request: NextRequest) {
  const format = request.nextUrl.searchParams.get('format') || 'json';
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const serviceClient = createServiceClient();

    // Rate limit: 1 export per 24 hours (persisted in DB)
    const exportKey = `export:${user.id}`;
    const { data: exportRecord } = await serviceClient
      .from('platform_settings')
      .select('value')
      .eq('key', exportKey)
      .maybeSingle();

    if (exportRecord) {
      const lastExportTime = Number(exportRecord.value);
      if (!isNaN(lastExportTime) && Date.now() - lastExportTime < EXPORT_COOLDOWN_MS) {
        const retryAfterSecs = Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - lastExportTime)) / 1000);
        return NextResponse.json(
          { error: 'You can only request one data export every 24 hours.' },
          { status: 429, headers: { 'Retry-After': String(retryAfterSecs) } },
        );
      }
    }

    // Fetch user profile
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    // Fetch businesses owned by this user
    const { data: businesses } = await serviceClient
      .from('businesses')
      .select('*')
      .eq('owner_id', user.id);

    const businessIds = (businesses || []).map((b: { id: string }) => b.id);

    // Parallel fetch of all related data
    const [
      bookingsResult,
      ordersResult,
      paymentsResult,
      invoicesResult,
      customersResult,
      servicesResult,
      productsResult,
      botSessionsResult,
      subscriptionsResult,
    ] = await Promise.all([
      businessIds.length > 0
        ? serviceClient.from('bookings').select('*').in('business_id', businessIds)
        : Promise.resolve({ data: [] }),
      businessIds.length > 0
        ? serviceClient.from('orders').select('*').in('business_id', businessIds)
        : Promise.resolve({ data: [] }),
      businessIds.length > 0
        ? serviceClient.from('payments').select('*').in('business_id', businessIds)
        : Promise.resolve({ data: [] }),
      businessIds.length > 0
        ? serviceClient.from('invoices').select('*').in('business_id', businessIds)
        : Promise.resolve({ data: [] }),
      businessIds.length > 0
        ? serviceClient.from('customers').select('*').in('business_id', businessIds)
        : Promise.resolve({ data: [] }),
      businessIds.length > 0
        ? serviceClient.from('services').select('*').in('business_id', businessIds)
        : Promise.resolve({ data: [] }),
      businessIds.length > 0
        ? serviceClient.from('products').select('*').in('business_id', businessIds)
        : Promise.resolve({ data: [] }),
      businessIds.length > 0
        ? serviceClient.from('bot_sessions').select('id, business_id, phone, flow_type, current_step, is_active, created_at, updated_at').in('business_id', businessIds)
        : Promise.resolve({ data: [] }),
      businessIds.length > 0
        ? serviceClient.from('customer_subscriptions').select('*').in('business_id', businessIds)
        : Promise.resolve({ data: [] }),
    ]);

    const exportData = {
      exported_at: new Date().toISOString(),
      data_subject: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
      },
      profile: profile || null,
      businesses: businesses || [],
      bookings: bookingsResult.data || [],
      orders: ordersResult.data || [],
      payments: paymentsResult.data || [],
      invoices: invoicesResult.data || [],
      customers: customersResult.data || [],
      services: servicesResult.data || [],
      products: productsResult.data || [],
      bot_sessions: botSessionsResult.data || [],
      subscriptions: subscriptionsResult.data || [],
    };

    // Record export timestamp in DB for rate limiting (upsert)
    await serviceClient
      .from('platform_settings')
      .upsert(
        { key: exportKey, value: String(Date.now()) },
        { onConflict: 'key' },
      );

    // Audit log
    logger.info(`[DATA-EXPORT] User ${user.id} requested data export (${format}). Tables: ${Object.keys(exportData).length}, Records: ${
      Object.values(exportData).reduce((sum, val) => sum + (Array.isArray(val) ? val.length : val ? 1 : 0), 0)
    }`);

    if (format === 'csv') {
      // Build a simple ZIP-like multi-CSV bundle
      // We use a boundary-separated format since we don't want to add a zip library
      // Each section is a separate CSV file in a multipart response
      const dateSuffix = new Date().toISOString().split('T')[0];

      // Profile as a single-row CSV
      const csvTables: Record<string, string> = {};

      if (exportData.profile) {
        csvTables['profile.csv'] = arrayToCsv([exportData.profile]);
      }

      const tableArrays: Record<string, unknown[]> = {
        'businesses.csv': exportData.businesses,
        'bookings.csv': exportData.bookings,
        'orders.csv': exportData.orders,
        'payments.csv': exportData.payments,
        'invoices.csv': exportData.invoices,
        'customers.csv': exportData.customers,
        'services.csv': exportData.services,
        'products.csv': exportData.products,
        'bot_sessions.csv': exportData.bot_sessions,
        'subscriptions.csv': exportData.subscriptions,
      };

      for (const [filename, rows] of Object.entries(tableArrays)) {
        if (Array.isArray(rows) && rows.length > 0) {
          csvTables[filename] = arrayToCsv(rows as Record<string, unknown>[]);
        }
      }

      // If only one table has data, return it as a single CSV
      const csvEntries = Object.entries(csvTables);
      if (csvEntries.length === 1) {
        const [filename, content] = csvEntries[0];
        return new Response(content, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="waaiio-export-${dateSuffix}-${filename}"`,
            'Cache-Control': 'no-store',
          },
        });
      }

      // Multiple tables: combine into a single CSV with table separators
      const combined = csvEntries
        .map(([filename, content]) => `--- ${filename} ---\n${content}`)
        .join('\n\n');

      return new Response(combined, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="waaiio-data-export-${dateSuffix}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // Default: JSON format
    return new Response(JSON.stringify(exportData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="waaiio-data-export-${new Date().toISOString().split('T')[0]}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    logger.error('[DATA-EXPORT] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
