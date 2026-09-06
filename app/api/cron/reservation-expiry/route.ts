/**
 * Cron: Reservation Expiry Processor (#261 Blocker 8)
 *
 * Scans message_send_attempts with expired reservations and either
 * auto-releases safe ones or flags unsafe ones for reconciliation.
 *
 * Safety rules:
 * - SAFE to release: status = 'pending_authorization' AND needs_reconciliation = false AND meta_message_id IS NULL
 * - UNSAFE (flag only): status IN ('sending', 'accepted', 'ambiguous', 'review_required')
 *   OR needs_reconciliation = true OR meta_message_id IS NOT NULL
 * - Missing deadline (reservation_expires_at IS NULL): flag, do NOT synthesize
 *
 * Uses service client for admin-level access.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let released = 0;
  let flagged = 0;
  let scanned = 0;

  try {
    // 1. Find all reserved attempts with expired deadlines
    const { data: expiredAttempts, error: queryErr } = await supabase
      .from('message_send_attempts')
      .select('id, status, needs_reconciliation, meta_message_id, reservation_expires_at')
      .eq('financial_disposition', 'reserved')
      .lt('reservation_expires_at', new Date().toISOString())
      .limit(500);

    if (queryErr) {
      logger.error('[RESERVATION-EXPIRY] Failed to query expired attempts:', queryErr.message);
      return NextResponse.json({ error: 'Query failed' }, { status: 500 });
    }

    // 2. Find reserved attempts with NULL deadline (should not happen, but safety net)
    const { data: nullDeadlineAttempts, error: nullQueryErr } = await supabase
      .from('message_send_attempts')
      .select('id, status, needs_reconciliation, meta_message_id, reservation_expires_at')
      .eq('financial_disposition', 'reserved')
      .is('reservation_expires_at', null)
      .limit(500);

    if (nullQueryErr) {
      logger.error('[RESERVATION-EXPIRY] Failed to query null-deadline attempts:', nullQueryErr.message);
      return NextResponse.json({ error: 'Query failed' }, { status: 500 });
    }

    // 3. Flag null-deadline attempts — do NOT synthesize a deadline
    for (const attempt of nullDeadlineAttempts || []) {
      scanned++;
      const { error: flagErr } = await supabase
        .from('message_send_attempts')
        .update({ needs_reconciliation: true })
        .eq('id', attempt.id);
      if (flagErr) {
        logger.error(`[RESERVATION-EXPIRY] Failed to flag null-deadline attempt ${attempt.id}:`, flagErr.message);
      } else {
        flagged++;
      }
    }

    // 4. Process expired attempts
    for (const attempt of expiredAttempts || []) {
      scanned++;

      const isSafe =
        attempt.status === 'pending_authorization' &&
        attempt.needs_reconciliation !== true &&
        attempt.meta_message_id === null;

      if (isSafe) {
        // Safe to auto-release
        const { data: settleData, error: settleErr } = await supabase.rpc('settle_message_cost', {
          p_attempt_id: attempt.id,
          p_outcome: 'released',
        });

        if (settleErr) {
          logger.error(`[RESERVATION-EXPIRY] settle_message_cost(released) failed for ${attempt.id}:`, settleErr.message);
          // Settlement failed — flag for reconciliation
          const { error: flagErr } = await supabase
            .from('message_send_attempts')
            .update({ needs_reconciliation: true })
            .eq('id', attempt.id);
          if (flagErr) {
            logger.error(`[RESERVATION-EXPIRY] Failed to flag attempt ${attempt.id}:`, flagErr.message);
          }
          flagged++;
        } else {
          released++;
        }
      } else {
        // NOT safe — flag for reconciliation, do NOT release
        if (!attempt.needs_reconciliation) {
          const { error: flagErr } = await supabase
            .from('message_send_attempts')
            .update({ needs_reconciliation: true })
            .eq('id', attempt.id);
          if (flagErr) {
            logger.error(`[RESERVATION-EXPIRY] Failed to flag unsafe attempt ${attempt.id}:`, flagErr.message);
          }
        }
        flagged++;
      }
    }

    logger.info(`[RESERVATION-EXPIRY] Scanned ${scanned}, released ${released}, flagged ${flagged}`);
    return NextResponse.json({ status: 'ok', scanned, released, flagged });
  } catch (err) {
    logger.error('[RESERVATION-EXPIRY] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
