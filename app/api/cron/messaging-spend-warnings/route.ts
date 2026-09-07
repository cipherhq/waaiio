/**
 * Cron: Messaging Spend Threshold Warnings (#261 Blocker 7)
 *
 * Scans active messaging_spend_periods and fires threshold alerts
 * at 50%, 75%, 90%, 100% utilization. Uses structural dedupe via
 * UNIQUE(business_id, currency_code, period_start, threshold_pct)
 * and ON CONFLICT DO NOTHING.
 *
 * Does NOT send WhatsApp messages (no recursive consumption).
 * Inserts into both messaging_spend_threshold_alerts (financial audit)
 * and alerts (in-app notification).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const THRESHOLDS = [50, 75, 90, 100] as const;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let alertsCreated = 0;
  let periodsScanned = 0;

  try {
    // Query all active spend periods (current month)
    const periodStart = new Date();
    periodStart.setUTCDate(1);
    periodStart.setUTCHours(0, 0, 0, 0);

    const { data: periods, error: periodsErr } = await supabase
      .from('messaging_spend_periods')
      .select('id, business_id, currency_code, period_start, cap_minor, reserved_minor, spent_minor')
      .gte('period_start', periodStart.toISOString())
      .gt('cap_minor', 0);

    if (periodsErr) {
      logger.error('[SPEND-WARNINGS] Failed to query spend periods:', periodsErr.message);
      return NextResponse.json({ error: 'Failed to query periods' }, { status: 500 });
    }

    if (!periods || periods.length === 0) {
      return NextResponse.json({ status: 'ok', periodsScanned: 0, alertsCreated: 0 });
    }

    for (const period of periods) {
      periodsScanned++;
      const utilization = (period.reserved_minor + period.spent_minor) / period.cap_minor;

      for (const threshold of THRESHOLDS) {
        if (utilization >= threshold / 100) {
          // Structural dedupe: ON CONFLICT DO NOTHING
          const { error: alertErr, data: alertData } = await supabase
            .from('messaging_spend_threshold_alerts')
            .insert({
              business_id: period.business_id,
              currency_code: period.currency_code,
              period_start: period.period_start,
              threshold_pct: threshold,
              utilization_at_alert: Math.round(utilization * 10000) / 100, // 2 decimal places
              cap_minor: period.cap_minor,
              reserved_minor: period.reserved_minor,
              spent_minor: period.spent_minor,
            })
            .select('id')
            .maybeSingle();

          // 23505 = unique violation (already exists) — expected, not an error
          if (alertErr && alertErr.code !== '23505') {
            logger.warn(`[SPEND-WARNINGS] Alert insert failed for biz=${period.business_id} threshold=${threshold}:`, alertErr.message);
            continue;
          }

          // Only create in-app alert if the threshold alert was newly inserted (not a duplicate)
          if (alertData?.id) {
            alertsCreated++;

            // Insert in-app notification (alerts table)
            const { error: inAppErr } = await supabase
              .from('alerts')
              .insert({
                business_id: period.business_id,
                type: 'messaging_spend_warning',
                severity: threshold >= 100 ? 'critical' : threshold >= 90 ? 'error' : 'warning',
                title: `Messaging spend at ${threshold}%`,
                message: `Your ${period.currency_code} messaging spend has reached ${Math.round(utilization * 100)}% of your ${period.cap_minor} minor-unit cap for this period.`,
                metadata: {
                  threshold_pct: threshold,
                  utilization_pct: Math.round(utilization * 100),
                  cap_minor: period.cap_minor,
                  reserved_minor: period.reserved_minor,
                  spent_minor: period.spent_minor,
                  currency_code: period.currency_code,
                  period_start: period.period_start,
                },
              });

            if (inAppErr) {
              logger.warn(`[SPEND-WARNINGS] In-app alert insert failed for biz=${period.business_id}:`, inAppErr.message);
            }
          }
        }
      }
    }

    logger.info(`[SPEND-WARNINGS] Scanned ${periodsScanned} periods, created ${alertsCreated} alerts`);
    return NextResponse.json({ status: 'ok', periodsScanned, alertsCreated });
  } catch (err) {
    logger.error('[SPEND-WARNINGS] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
