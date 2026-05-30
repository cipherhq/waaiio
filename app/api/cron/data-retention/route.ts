import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Data retention cron — enforces privacy policy retention limits.
 * Runs weekly (Sunday 1am UTC).
 *
 * - bot_sessions: purge older than 2 years
 * - bookings: anonymize (not delete) older than 3 years
 * - notification_logs: purge older than 1 year
 * - impersonation_logs: purge older than 1 year
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const summary: Record<string, number> = {};

  // ── 1. Purge bot_sessions older than 2 years ──
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

  const { data: purgedSessions } = await supabase
    .from('bot_sessions')
    .delete()
    .lt('created_at', twoYearsAgo.toISOString())
    .select('id');

  summary.purgedBotSessions = purgedSessions?.length || 0;

  // ── 2. Anonymize bookings older than 3 years (keep financial data) ──
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

  const { data: anonymizedBookings } = await supabase
    .from('bookings')
    .update({
      guest_name: null,
      guest_phone: null,
      guest_email: null,
    })
    .lt('created_at', threeYearsAgo.toISOString())
    // Only anonymize rows that still have PII (idempotent)
    .not('guest_name', 'is', null)
    .select('id');

  summary.anonymizedBookings = anonymizedBookings?.length || 0;

  // ── 3. Purge notification_logs older than 1 year ──
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const { data: purgedNotifications } = await supabase
    .from('notification_logs')
    .delete()
    .lt('created_at', oneYearAgo.toISOString())
    .select('id');

  summary.purgedNotificationLogs = purgedNotifications?.length || 0;

  // ── 4. Purge impersonation_logs older than 1 year ──
  const { data: purgedImpersonation } = await supabase
    .from('impersonation_logs')
    .delete()
    .lt('created_at', oneYearAgo.toISOString())
    .select('id');

  summary.purgedImpersonationLogs = purgedImpersonation?.length || 0;

  return NextResponse.json({ ok: true, ...summary });
}
