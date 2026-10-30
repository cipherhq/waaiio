/**
 * Paid ticket business-state finalization (Stage 2).
 *
 * Ensures ticket inventory counters and canonical ticket rows are durable
 * WITHOUT performing customer delivery (WhatsApp/PDF/email).
 *
 * M481 converges inventory and ticket rows in one cancellation-aware transaction.
 *
 * Delivery belongs to Stage 3 (sendProactiveConfirmation).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

export interface TicketBusinessStateResult {
  success: boolean;
  error?: string;
  inventoryFinalized: boolean;
  canonicalRowsComplete: boolean;
  outcome?: 'issued' | 'cancelled_followup_recorded';
  followupRecorded?: boolean;
}

/**
 * Ensure paid ticket business state is durable.
 * Does NOT perform customer delivery.
 */
export async function ensurePaidTicketState(
  supabase: SupabaseClient,
  opts: {
    paymentBookingId: string;
    logPrefix?: string;
  },
): Promise<TicketBusinessStateResult> {
  const logPfx = opts.logPrefix || '[TICKET-BIZ-STATE]';

  // 1. Load booking to determine if it's a ticketing purchase
  const { data: booking, error: bookingErr } = await supabase
    .from('bookings')
    .select('flow_type, event_id, bot_session_id, party_size')
    .eq('id', opts.paymentBookingId)
    .single();

  if (bookingErr || !booking) {
    logger.withContext({ op: 'ticket-biz-state.booking-lookup', ...safeLogErrorContext(bookingErr) })
      .error(`${logPfx} Booking lookup failed`);
    return { success: false, error: 'booking_lookup_failed', inventoryFinalized: false, canonicalRowsComplete: false };
  }

  if (booking.flow_type !== 'ticketing') {
    // Not a ticketing booking — nothing to do
    return { success: true, inventoryFinalized: true, canonicalRowsComplete: true };
  }

  if (!booking.event_id) return { success: false, error: 'ticket_event_missing', inventoryFinalized: false, canonicalRowsComplete: false };
  const ticketQty = booking.party_size || 1;

  // M481 serializes inventory AND canonical rows with event cancellation.
  const { data: result, error } = await supabase.rpc('converge_event_ticket_booking', {
    p_booking_id: opts.paymentBookingId,
    p_event_id: booking.event_id,
    p_ticket_type_id: null,
    p_quantity: ticketQty,
  });
  if (error || !result) {
    return { success: false, error: 'ticket_convergence_failed', inventoryFinalized: false, canonicalRowsComplete: false };
  }
  if (result.outcome === 'cancelled_followup_recorded' && result.followup_recorded === true) {
    return {
      success: false, outcome: 'cancelled_followup_recorded', followupRecorded: true,
      error: 'event_cancelled_followup_recorded',
      inventoryFinalized: false, canonicalRowsComplete: false,
    };
  }
  if (result.success !== true || result.outcome !== 'issued' ||
      !Array.isArray(result.tickets) || result.tickets.length !== ticketQty) {
    return { success: false, error: result.reason || 'canonical_ticket_rows_incomplete', inventoryFinalized: false, canonicalRowsComplete: false };
  }
  return { success: true, outcome: 'issued', inventoryFinalized: true, canonicalRowsComplete: true };
}
