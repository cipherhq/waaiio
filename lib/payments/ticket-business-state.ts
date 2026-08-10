/**
 * Paid ticket business-state finalization (Stage 2).
 *
 * Ensures ticket inventory counters and canonical ticket rows are durable
 * WITHOUT performing customer delivery (WhatsApp/PDF/email).
 *
 * Reuses PR #122 canonical functions:
 * - finalize_free_ticket_booking (idempotent inventory counters)
 * - sendTicketsAfterPurchase (canonical row creation with UNIQUE convergence)
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

  if (bookingErr) {
    logger.withContext({ op: 'ticket-biz-state.booking-lookup', ...safeLogErrorContext(bookingErr) })
      .error(`${logPfx} Booking lookup failed`);
    return { success: false, error: 'booking_lookup_failed', inventoryFinalized: false, canonicalRowsComplete: false };
  }

  if (!booking || booking.flow_type !== 'ticketing' || !booking.event_id) {
    // Not a ticketing booking — nothing to do
    return { success: true, inventoryFinalized: true, canonicalRowsComplete: true };
  }

  const ticketQty = booking.party_size || 1;

  // 2. Resolve ticket type (same logic as PR #122 send-confirmation)
  const { data: ticketTypes, error: typeQueryError } = await supabase
    .from('event_ticket_types')
    .select('id')
    .eq('event_id', booking.event_id)
    .limit(1);

  if (typeQueryError) {
    return { success: false, error: 'ticket_type_query_failed', inventoryFinalized: false, canonicalRowsComplete: false };
  }

  const isTypedEvent = (ticketTypes?.length ?? 0) > 0;
  let ticketTypeId: string | null = null;
  let typeResolutionFailed = false;

  if (booking.bot_session_id) {
    const { data: session, error: sessionErr } = await supabase
      .from('bot_sessions')
      .select('session_data')
      .eq('id', booking.bot_session_id)
      .single();
    if (sessionErr) {
      typeResolutionFailed = true;
    } else {
      ticketTypeId = (session?.session_data as Record<string, unknown>)?.ticket_type_id as string || null;
    }
  } else if (isTypedEvent) {
    typeResolutionFailed = true;
  }

  // Validate ownership for typed events
  if (isTypedEvent && ticketTypeId && !typeResolutionFailed) {
    const { data: typeOwnership, error: ownershipErr } = await supabase
      .from('event_ticket_types')
      .select('id')
      .eq('id', ticketTypeId)
      .eq('event_id', booking.event_id)
      .maybeSingle();
    if (ownershipErr || !typeOwnership) {
      typeResolutionFailed = true;
    }
  }

  if (isTypedEvent && (!ticketTypeId || typeResolutionFailed)) {
    return { success: false, error: 'typed_ticket_type_unresolvable', inventoryFinalized: false, canonicalRowsComplete: false };
  }

  // 3. Finalize inventory counters (idempotent via tickets_finalized)
  const { data: finResult, error: finError } = await supabase.rpc('finalize_free_ticket_booking', {
    p_booking_id: opts.paymentBookingId,
    p_event_id: booking.event_id,
    p_ticket_type_id: ticketTypeId,
    p_quantity: ticketQty,
  });

  if (finError) {
    logger.withContext({ op: 'ticket-biz-state.finalize', ...safeLogErrorContext(finError) })
      .error(`${logPfx} finalize_free_ticket_booking RPC error`);
    return { success: false, error: 'inventory_finalization_failed', inventoryFinalized: false, canonicalRowsComplete: false };
  }

  const inventoryFinalized = true;
  if (finResult?.already_finalized) {
    logger.info(`${logPfx} Inventory already finalized for booking ${opts.paymentBookingId}`);
  }

  // 4. Ensure canonical ticket rows exist (without delivery)
  // Use sendTicketsAfterPurchase with no sender — it creates rows but skips WhatsApp/PDF
  const { sendTicketsAfterPurchase } = await import('@/lib/bot/flows/shared/send-tickets');
  const ticketResult = await sendTicketsAfterPurchase({
    supabase,
    sender: undefined, // No delivery in Stage 2
    businessId: '', // Not needed for row creation
    bookingId: opts.paymentBookingId,
    eventId: booking.event_id,
    eventName: '', // Display only — not needed for rows
    eventDate: '', eventTime: undefined, venue: '',
    guestName: '', guestPhone: '',
    referenceCode: '',
    quantity: ticketQty,
  });

  if (!ticketResult.success || ticketResult.tickets.length < ticketQty) {
    return {
      success: false,
      error: ticketResult.error || 'canonical_ticket_rows_incomplete',
      inventoryFinalized,
      canonicalRowsComplete: false,
    };
  }

  return { success: true, inventoryFinalized, canonicalRowsComplete: true };
}
