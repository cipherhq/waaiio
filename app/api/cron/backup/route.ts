import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Daily backup cron — exports critical table counts and metadata
 * to verify database health. Full backups are handled by Supabase's
 * built-in backup system.
 *
 * This endpoint logs a health snapshot so you can detect data anomalies
 * (e.g., sudden drops in row counts that might indicate accidental deletion).
 */
export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const now = new Date().toISOString();

  try {
    // Snapshot critical table counts
    const [businesses, payments, bookings, profiles, subscriptions] = await Promise.all([
      supabase.from('businesses').select('id', { count: 'exact', head: true }),
      supabase.from('payments').select('id', { count: 'exact', head: true }),
      supabase.from('bookings').select('id', { count: 'exact', head: true }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('subscriptions').select('id', { count: 'exact', head: true }),
    ]);

    const snapshot = {
      timestamp: now,
      counts: {
        businesses: businesses.count || 0,
        payments: payments.count || 0,
        bookings: bookings.count || 0,
        profiles: profiles.count || 0,
        subscriptions: subscriptions.count || 0,
      },
    };

    // Store snapshot in a simple audit log
    await supabase.from('admin_audit_logs').insert({
      admin_id: null,
      action: 'database_health_snapshot',
      entity_type: 'system',
      entity_id: null,
      details: snapshot,
    });

    return NextResponse.json({ status: 'ok', snapshot });
  } catch (error) {
    return NextResponse.json({ status: 'error', message: (error as Error).message }, { status: 500 });
  }
}
