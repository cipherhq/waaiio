-- Migration 357: Owner-bound booking cancellation
--
-- Replaces cancel_booking_with_release with a version that REQUIRES
-- p_expected_user_id (no default). The RPC verifies the booking's
-- user_id matches the caller's expected user_id before cancelling.
-- This prevents a user from cancelling another user's booking via
-- a forged UUID postback.
--
-- The legacy 2-arg overload (uuid, text) is dropped to prevent
-- any caller from bypassing the ownership check.

-- Drop legacy 2-arg overload so no caller can bypass the owner check
DROP FUNCTION IF EXISTS public.cancel_booking_with_release(UUID);
DROP FUNCTION IF EXISTS public.cancel_booking_with_release(UUID, TEXT);

-- Create the new 3-arg version with REQUIRED p_expected_user_id
CREATE OR REPLACE FUNCTION cancel_booking_with_release(
  p_booking_id uuid,
  p_cancelled_by text,
  p_expected_user_id uuid
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking RECORD;
  v_redemption RECORD;
  v_session_released boolean := false;
BEGIN
  -- Belt-and-suspenders: reject NULL expected user_id even though the param is NOT NULL
  IF p_expected_user_id IS NULL THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_owner');
  END IF;

  -- Lock the booking (fetch all fields needed for slot release + ownership check)
  SELECT id, status, user_id, business_id, date, time, staff_id, location_id
  INTO v_booking FROM bookings
    WHERE id = p_booking_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  -- Ownership check: expected user_id must match booking's user_id
  IF v_booking.user_id IS DISTINCT FROM p_expected_user_id THEN
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
