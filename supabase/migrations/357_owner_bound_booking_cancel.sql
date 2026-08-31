-- Migration 357: Owner-bound booking cancellation
--
-- Adds p_expected_user_id parameter to cancel_booking_with_release.
-- The RPC now verifies that the booking's user_id matches the caller's
-- user_id before proceeding with cancellation. This prevents a user
-- from cancelling another user's booking via a forged UUID postback.
--
-- Backward-compatible: p_expected_user_id defaults to NULL, which
-- skips the ownership check (preserving behavior for admin/cron callers).

CREATE OR REPLACE FUNCTION cancel_booking_with_release(
  p_booking_id uuid,
  p_cancelled_by text DEFAULT 'guest',
  p_expected_user_id uuid DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking RECORD;
  v_redemption RECORD;
  v_session_released boolean := false;
BEGIN
  -- Lock the booking (fetch all fields needed for slot release + ownership check)
  SELECT id, status, user_id, business_id, date, time, staff_id, location_id
  INTO v_booking FROM bookings
    WHERE id = p_booking_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  -- Ownership check: if caller supplied an expected user_id, verify it matches
  IF p_expected_user_id IS NOT NULL AND v_booking.user_id IS DISTINCT FROM p_expected_user_id THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_owner');
  END IF;

  -- Only cancellable statuses
  IF v_booking.status NOT IN ('pending', 'confirmed') THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_cancellable', 'status', v_booking.status);
  END IF;

  -- Cancel the booking
  UPDATE bookings
  SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = p_cancelled_by
  WHERE id = p_booking_id AND status IN ('pending', 'confirmed');

  -- Release any active package redemption atomically
  SELECT * INTO v_redemption FROM package_redemptions
    WHERE booking_id = p_booking_id AND status = 'active'
    FOR UPDATE;

  IF FOUND THEN
    v_session_released := true;

    UPDATE package_redemptions
    SET status = 'released', released_at = NOW()
    WHERE id = v_redemption.id AND status = 'active';

    UPDATE package_enrollments
    SET sessions_used = GREATEST(0, sessions_used - 1)
    WHERE id = v_redemption.enrollment_id;
  END IF;

  -- Release booking slot capacity (keeps booking_slots counter accurate)
  -- Uses GREATEST(0, ...) to prevent negative counters.
  -- Safe even when no matching booking_slots row exists (UPDATE matches 0 rows).
  UPDATE booking_slots
  SET current_bookings = GREATEST(0, current_bookings - 1)
  WHERE business_id = v_booking.business_id
    AND date = v_booking.date
    AND start_time = v_booking.time
    AND COALESCE(staff_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(v_booking.staff_id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(v_booking.location_id, '00000000-0000-0000-0000-000000000000'::uuid);

  RETURN jsonb_build_object('cancelled', true, 'session_released', v_session_released);
END;
$$;

-- Maintain ACL from migration 351: only service_role can call this
REVOKE ALL ON FUNCTION public.cancel_booking_with_release(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_booking_with_release(uuid, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_booking_with_release(uuid, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking_with_release(uuid, text, uuid) TO service_role;
