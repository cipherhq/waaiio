-- Migration 313: Canonical ticket-row identity constraint
--
-- Prevents concurrent webhook + bot "I've Paid" from creating duplicate
-- event_tickets rows for the same booking. Each (booking_id, ticket_number)
-- pair must be unique — two workers generating different random ticket_codes
-- can both INSERT, but the UNIQUE constraint ensures only one wins per
-- ticket_number within a booking.
--
-- The existing UNIQUE(ticket_code) prevents code collision but does NOT
-- prevent booking-scoped duplication because each worker generates different
-- codes. This migration adds the booking-scoped identity invariant.
--
-- Precondition: no existing duplicate (booking_id, ticket_number) pairs.
-- Verified by inspecting production data before deployment.

-- ── Add booking-scoped ticket identity ──
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_tickets_booking_number
  ON event_tickets (booking_id, ticket_number);
