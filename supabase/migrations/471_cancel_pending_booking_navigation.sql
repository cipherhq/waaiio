-- M471: Atomic payment-safe navigation cancellation for bookings and reservations
--
-- Navigation commands (Cancel, Menu, Exit, Restart) must only cancel
-- PENDING bookings/reservations that have NO successful linked payment.
--
-- Follows the same payment-fencing pattern as cancel_order_immediate:
-- locks payment rows FOR UPDATE, checks for success or active finalization.
--
-- Confirmed bookings, paid bookings, and bookings with active finalization
-- are atomically preserved. Existing intentional booking-management
-- cancellation (cancel_booking_with_release) retains full authority.
--
-- Lock ordering: entity FOR UPDATE → payments FOR UPDATE (same as cancel_order_immediate).
-- claim_payment_finalization locks payments first in a SEPARATE transaction
-- (webhook → claim → app-level entity update), so no nested deadlock.
-- Concurrent payment INSERT after lock: a new 'pending' payment does not block
-- cancellation — the gateway has not confirmed it yet. If the gateway later
-- confirms (webhook → status='success'), finalization finds a cancelled entity
-- and handles it at the application layer.
--
-- Related: #671, PR #708
-- Invariants: DB-003 (no new tables), DB-001 (no digest calls)

-- ── Booking cancellation with payment fence ──

CREATE OR REPLACE FUNCTION public.cancel_pending_booking_for_navigation(
  p_booking_id UUID,
  p_expected_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_booking RECORD;
  v_has_payment BOOLEAN;
BEGIN
  IF p_booking_id IS NULL OR p_expected_user_id IS NULL THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'missing_params');
  END IF;

  -- Atomic status + ownership check with FOR UPDATE lock
  SELECT id, status, user_id
  INTO v_booking
  FROM bookings
  WHERE id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  IF v_booking.user_id IS DISTINCT FROM p_expected_user_id THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_owner');
  END IF;

  IF v_booking.status != 'pending' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_pending', 'status', v_booking.status);
  END IF;

  -- Payment authority fence (mirrors cancel_order_immediate):
  -- Lock payment rows, check for successful or actively finalizing payments.
  PERFORM id FROM payments WHERE booking_id = p_booking_id FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM payments
    WHERE booking_id = p_booking_id
      AND (status = 'success'
           OR (finalization_processing_at IS NOT NULL
               AND finalization_processing_at > NOW() - INTERVAL '5 minutes'))
  ) INTO v_has_payment;

  IF v_has_payment THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'has_successful_payment');
  END IF;

  -- All safety checks passed — delegate to canonical cancellation authority
  RETURN cancel_booking_with_release(p_booking_id, 'guest', p_expected_user_id);
END;
$$;

-- ── Reservation cancellation with payment fence ──

CREATE OR REPLACE FUNCTION public.cancel_pending_reservation_for_navigation(
  p_reservation_id UUID,
  p_expected_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservation RECORD;
  v_has_payment BOOLEAN;
BEGIN
  IF p_reservation_id IS NULL OR p_expected_user_id IS NULL THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'missing_params');
  END IF;

  SELECT id, status, user_id, business_id
  INTO v_reservation
  FROM reservations
  WHERE id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  IF v_reservation.user_id IS DISTINCT FROM p_expected_user_id THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_owner');
  END IF;

  IF v_reservation.status != 'pending' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_pending', 'status', v_reservation.status);
  END IF;

  -- Payment authority fence
  PERFORM id FROM payments WHERE reservation_id = p_reservation_id FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM payments
    WHERE reservation_id = p_reservation_id
      AND (status = 'success'
           OR (finalization_processing_at IS NOT NULL
               AND finalization_processing_at > NOW() - INTERVAL '5 minutes'))
  ) INTO v_has_payment;

  IF v_has_payment THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'has_successful_payment');
  END IF;

  UPDATE reservations
  SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = 'guest'::cancelled_by
  WHERE id = p_reservation_id AND status = 'pending';

  RETURN jsonb_build_object('cancelled', true);
END;
$$;

-- Least-privilege: service_role only
REVOKE ALL ON FUNCTION public.cancel_pending_booking_for_navigation(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_pending_booking_for_navigation(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_pending_booking_for_navigation(UUID, UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.cancel_pending_booking_for_navigation(UUID, UUID) FROM service_role;
GRANT EXECUTE ON FUNCTION public.cancel_pending_booking_for_navigation(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.cancel_pending_reservation_for_navigation(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_pending_reservation_for_navigation(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_pending_reservation_for_navigation(UUID, UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.cancel_pending_reservation_for_navigation(UUID, UUID) FROM service_role;
GRANT EXECUTE ON FUNCTION public.cancel_pending_reservation_for_navigation(UUID, UUID) TO service_role;

-- Verification
DO $$
DECLARE v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM pg_proc
  WHERE proname = 'cancel_pending_booking_for_navigation' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN RAISE EXCEPTION 'M471: booking RPC count %', v_count; END IF;

  SELECT COUNT(*) INTO v_count FROM pg_proc
  WHERE proname = 'cancel_pending_reservation_for_navigation' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN RAISE EXCEPTION 'M471: reservation RPC count %', v_count; END IF;
END $$;
