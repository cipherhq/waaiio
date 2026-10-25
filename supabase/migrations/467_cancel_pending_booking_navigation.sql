-- M467: Atomic pending-only booking cancellation for navigation cleanup
--
-- Navigation commands (Cancel, Menu, Exit, Restart) must only cancel
-- PENDING bookings — confirmed bookings represent completed customer
-- actions that should not be undone by typing a navigation word.
--
-- The existing cancel_booking_with_release RPC (M357) correctly cancels
-- both pending AND confirmed bookings — that is the intentional behavior
-- for dedicated booking-management cancellation flows (my-bookings.ts).
--
-- This RPC wraps cancel_booking_with_release with an atomic pending-only
-- status guard, using FOR UPDATE to prevent TOCTOU races.
--
-- Related: #671, PR #708
-- Invariants: DB-003 (RLS — no new tables), DB-001 (no digest calls)

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
BEGIN
  IF p_booking_id IS NULL OR p_expected_user_id IS NULL THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'missing_params');
  END IF;

  -- Atomic status check with FOR UPDATE lock — prevents TOCTOU race
  SELECT id, status, user_id
  INTO v_booking
  FROM bookings
  WHERE id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  -- Ownership check
  IF v_booking.user_id IS DISTINCT FROM p_expected_user_id THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_owner');
  END IF;

  -- Navigation cleanup ONLY cancels pending bookings
  IF v_booking.status != 'pending' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_pending', 'status', v_booking.status);
  END IF;

  -- Delegate to canonical cancellation authority for actual resource release
  RETURN cancel_booking_with_release(p_booking_id, 'guest', p_expected_user_id);
END;
$$;

-- Least-privilege: service_role only
REVOKE ALL ON FUNCTION public.cancel_pending_booking_for_navigation(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_pending_booking_for_navigation(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_pending_booking_for_navigation(UUID, UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.cancel_pending_booking_for_navigation(UUID, UUID) FROM service_role;
GRANT EXECUTE ON FUNCTION public.cancel_pending_booking_for_navigation(UUID, UUID) TO service_role;

-- Verification
DO $$
DECLARE v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count FROM pg_proc
  WHERE proname = 'cancel_pending_booking_for_navigation' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'M467: Expected 1 cancel_pending_booking_for_navigation, found %', v_count;
  END IF;
END $$;
