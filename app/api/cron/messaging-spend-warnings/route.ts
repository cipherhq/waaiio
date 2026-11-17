/**
 * Cron: Messaging Spend Threshold Warnings (#261 Blocker 7, #992)
 *
 * Hourly safety net for the merchant spend-cap alerts: the bot checks after each reply, but
 * broadcasts, reminders and other sends use up the same monthly cap without a check.
 * Scans this month's spend periods and raises the alert through the same shared logic as the
 * bot (lib/messaging/spend-cap-alerts.ts), so the two never duplicate or skip an alert.
 *
 * Does NOT send WhatsApp messages (no recursive consumption).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';
import { checkSpendCapPeriod, type SpendPeriod } from '@/lib/messaging/spend-cap-alerts';
import { reportFailure } from '@/lib/observability/report-failure';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let alertsCreated = 0;
  let periodsScanned = 0;

  try {
    const periodStart = new Date();
    periodStart.setUTCDate(1);
    periodStart.setUTCHours(0, 0, 0, 0);

    const { data: periods, error: periodsErr } = await supabase
      .from('messaging_spend_periods')
      .select('business_id, currency_code, period_start, cap_minor, reserved_minor, spent_minor')
      .gte('period_start', periodStart.toISOString())
      .gt('cap_minor', 0);

    if (periodsErr) {
      logger.error('[SPEND-WARNINGS] Failed to query spend periods:', periodsErr.message);
      reportFailure(periodsErr, { area: 'cron', op: 'periods_query', job: 'messaging-spend-warnings' });
      return NextResponse.json({ error: 'Failed to query periods' }, { status: 500 });
    }

    for (const period of (periods || []) as Array<SpendPeriod & { business_id: string }>) {
      periodsScanned++;
      if (await checkSpendCapPeriod(supabase, period.business_id, period)) alertsCreated++;
    }

    logger.info(`[SPEND-WARNINGS] Scanned ${periodsScanned} periods, created ${alertsCreated} alerts`);
    return NextResponse.json({ status: 'ok', periodsScanned, alertsCreated });
  } catch (err) {
    logger.error('[SPEND-WARNINGS] Unexpected error:', err);
    reportFailure(err, { area: 'cron', op: 'run', job: 'messaging-spend-warnings' });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
