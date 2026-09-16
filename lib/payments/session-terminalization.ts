import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

export type TerminalizationResult =
  | { status: 'deactivated' }
  | { status: 'already_inactive' }
  | { status: 'no_origin' }
  | { status: 'legacy_null' }
  | { status: 'error'; retryable: true };

export async function terminalizeOriginatingSession(
  supabase: SupabaseClient,
  entityIds: {
    bookingId?: string | null;
    orderId?: string | null;
    reservationId?: string | null;
    invoiceId?: string | null;
    campaignId?: string | null;
  },
): Promise<TerminalizationResult> {
  // Invoice and campaign entities do not carry bot_session_id — skip exact terminalization
  if (!entityIds.bookingId && !entityIds.orderId && !entityIds.reservationId) {
    return { status: 'no_origin' };
  }

  try {
    // Resolve bot_session_id from the linked entity
    let botSessionId: string | null = null;

    if (entityIds.bookingId) {
      const { data, error } = await supabase
        .from('bookings')
        .select('bot_session_id')
        .eq('id', entityIds.bookingId)
        .maybeSingle();
      if (error) {
        logger.withContext({ op: 'payment.session-terminalization', entityType: 'booking', ...safeLogErrorContext(error) })
          .error('[PAYMENT] Session terminalization: booking lookup failed');
        return { status: 'error', retryable: true };
      }
      botSessionId = data?.bot_session_id ?? null;
    } else if (entityIds.orderId) {
      const { data, error } = await supabase
        .from('orders')
        .select('bot_session_id')
        .eq('id', entityIds.orderId)
        .maybeSingle();
      if (error) {
        logger.withContext({ op: 'payment.session-terminalization', entityType: 'order', ...safeLogErrorContext(error) })
          .error('[PAYMENT] Session terminalization: order lookup failed');
        return { status: 'error', retryable: true };
      }
      botSessionId = data?.bot_session_id ?? null;
    } else if (entityIds.reservationId) {
      const { data, error } = await supabase
        .from('reservations')
        .select('bot_session_id')
        .eq('id', entityIds.reservationId)
        .maybeSingle();
      if (error) {
        logger.withContext({ op: 'payment.session-terminalization', entityType: 'reservation', ...safeLogErrorContext(error) })
          .error('[PAYMENT] Session terminalization: reservation lookup failed');
        return { status: 'error', retryable: true };
      }
      botSessionId = data?.bot_session_id ?? null;
    }

    if (!botSessionId) {
      logger.withContext({ op: 'payment.session-terminalization-legacy', bookingId: entityIds.bookingId, orderId: entityIds.orderId, reservationId: entityIds.reservationId })
        .warn('[PAYMENT] Session terminalization: no bot_session_id on entity — legacy row, skipping broad deactivation');
      return { status: 'legacy_null' };
    }

    // Attempt exact session deactivation
    const { data: updateResult, error: updateError } = await supabase
      .from('bot_sessions')
      .update({ is_active: false, current_step: 'complete' })
      .eq('id', botSessionId)
      .eq('is_active', true)
      .select('id');

    if (updateError) {
      logger.withContext({ op: 'payment.session-terminalization', botSessionId, ...safeLogErrorContext(updateError) })
        .error('[PAYMENT] Session terminalization: UPDATE failed');
      return { status: 'error', retryable: true };
    }

    if (updateResult && updateResult.length > 0) {
      return { status: 'deactivated' };
    }

    // Zero rows updated — re-read to prove the session is actually inactive
    const { data: session, error: readError } = await supabase
      .from('bot_sessions')
      .select('id, is_active')
      .eq('id', botSessionId)
      .maybeSingle();

    if (readError) {
      logger.withContext({ op: 'payment.session-terminalization', botSessionId, ...safeLogErrorContext(readError) })
        .error('[PAYMENT] Session terminalization: re-read failed after zero-row UPDATE');
      return { status: 'error', retryable: true };
    }

    if (!session) {
      // Session row doesn't exist (deleted) — treat as already handled
      return { status: 'already_inactive' };
    }

    if (!session.is_active) {
      return { status: 'already_inactive' };
    }

    // Session exists and is active but our UPDATE didn't match — unexpected
    logger.withContext({ op: 'payment.session-terminalization', botSessionId })
      .error('[PAYMENT] Session terminalization: session active but UPDATE did not match — possible step filter issue');
    return { status: 'error', retryable: true };
  } catch (err) {
    logger.withContext({ op: 'payment.session-terminalization-threw', ...safeLogErrorContext(err) })
      .error('[PAYMENT] Session terminalization threw');
    return { status: 'error', retryable: true };
  }
}
