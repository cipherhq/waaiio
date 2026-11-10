import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { sendIntakeReminder } from '@/lib/intake/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * #963: one reminder about 24 hours before the session for after-booking intake
 * forms that are still unanswered. expires_at is the session start (UTC), so the
 * due window is a plain time range. Runs hourly; the 3-hour range plus the
 * reminder_sent_at claim send each reminder at most once. A reminder goes out
 * only inside the client's 24-hour window (Owner decision 2026-11-10).
 */
const REMINDER_FROM_HOURS = 22;
const REMINDER_TO_HOURS = 25;
const BATCH = 50;
const TIME_BUDGET_MS = 45_000;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const started = Date.now();
  const db = createServiceClient();
  const from = new Date(started + REMINDER_FROM_HOURS * 3_600_000).toISOString();
  const to = new Date(started + REMINDER_TO_HOURS * 3_600_000).toISOString();
  const resolver = new ChannelResolver(db);
  const counts: Record<string, number> = {};
  let due = 0;
  // Page through every due row: skipped rows keep matching, so a fixed first
  // batch could otherwise starve later clients for the whole reminder window.
  // Rows that were sent drop out of the filter, so the offset only counts the rest.
  for (let offset = 0; Date.now() - started <= TIME_BUDGET_MS;) {
    const { data, error } = await db.from('booking_intakes').select('id')
      .eq('status', 'pending').eq('timing', 'after_booking')
      .is('reminder_sent_at', null).not('sent_at', 'is', null)
      .gt('expires_at', from).lte('expires_at', to)
      .order('expires_at', { ascending: true }).order('id', { ascending: true })
      .range(offset, offset + BATCH - 1);
    if (error) {
      logger.error('[CRON intake-reminders] Due query failed:', error.code || 'unknown');
      return NextResponse.json({ error: 'query_failed', due, ...counts }, { status: 500 });
    }
    const rows = data || [];
    due += rows.length;
    let stillDue = 0;
    for (const row of rows) {
      if (Date.now() - started > TIME_BUDGET_MS) { counts.deferred = (counts.deferred || 0) + 1; stillDue++; continue; }
      const result = await sendIntakeReminder(db, row.id as string, { resolver });
      const key = result.status === 'sent' ? 'sent' : result.reason;
      counts[key] = (counts[key] || 0) + 1;
      if (result.status !== 'sent') stillDue++;
    }
    if (rows.length < BATCH) break;
    offset += stillDue;
  }
  return NextResponse.json({ due, ...counts });
}
