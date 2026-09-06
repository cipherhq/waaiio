/**
 * Cron: Reservation Expiry Processor (#261)
 *
 * Scans message_send_attempts with expired reservations and delegates
 * to the DB-atomic safe_release_expired_reservation() function which
 * revalidates ALL safety predicates at the same linearization point
 * as release, preventing race conditions with concurrent send paths.
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
  let errors = 0;

  try {
    // 1. Find all reserved attempts with expired deadlines
    const { data: expiredAttempts, error: queryErr } = await supabase
      .from('message_send_attempts')
      .select('id')
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
      .select('id')
      .eq('financial_disposition', 'reserved')
      .is('reservation_expires_at', null)
      .limit(500);

    if (nullQueryErr) {
      logger.error('[RESERVATION-EXPIRY] Failed to query null-deadline attempts:', nullQueryErr.message);
      return NextResponse.json({ error: 'Query failed' }, { status: 500 });
    }

    // 3. Process null-deadline attempts via the atomic function (it will flag them)
    for (const attempt of nullDeadlineAttempts || []) {
      scanned++;
      const { data, error } = await supabase.rpc('safe_release_expired_reservation', {
        p_attempt_id: attempt.id,
      });
      if (error) {
        logger.error(`[RESERVATION-EXPIRY] RPC failed for null-deadline ${attempt.id}:`, error.message);
        errors++;
      } else {
        const result = data as Record<string, unknown>;
        if (result.released === true) {
          released++;
        } else {
          flagged++;
        }
      }
    }

    // 4. Process expired attempts via the DB-atomic function
    //    The function revalidates ALL safety predicates (reserved + pending_authorization +
    //    expired + no WAMID + !needs_reconciliation) atomically under FOR UPDATE.
    //    If any predicate changed between our query and the function, it does NOT release.
    for (const attempt of expiredAttempts || []) {
      scanned++;
      const { data, error } = await supabase.rpc('safe_release_expired_reservation', {
        p_attempt_id: attempt.id,
      });

      if (error) {
        logger.error(`[RESERVATION-EXPIRY] RPC failed for ${attempt.id}:`, error.message);
        errors++;
        continue;
      }

      const result = data as Record<string, unknown>;
      if (result.released === true) {
        released++;
      } else {
        // Not released — the function either flagged it or it was already handled
        flagged++;
        logger.info(`[RESERVATION-EXPIRY] Not released ${attempt.id}: ${result.reason}`);
      }
    }

    logger.info(`[RESERVATION-EXPIRY] Scanned ${scanned}, released ${released}, flagged ${flagged}, errors ${errors}`);
    return NextResponse.json({ status: 'ok', scanned, released, flagged, errors });
  } catch (err) {
    logger.error('[RESERVATION-EXPIRY] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
