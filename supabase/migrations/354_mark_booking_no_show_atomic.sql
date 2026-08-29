-- ═══════════════════════════════════════════════════════
-- Atomic no-show RPC — counterpart to cancel_booking_with_release (migration 309).
--
-- Marks a booking as no-show and releases the booking slot in a single
-- transaction, preventing race conditions between the status update and
-- slot counter decrement.
--
-- Key difference from cancel_booking_with_release:
--   - Package sessions are intentionally NOT released on no-show.
--     A no-show consumes the session — this is deliberate business logic.
--     The customer used a session slot by failing to attend; releasing it
--     would effectively reward no-shows.
--
--   - no_show_count on profiles is NOT incremented here. That requires a
--     phone-to-profile lookup best handled in the application layer (the
--     API route at /api/bookings/[id]/status already does this).
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION mark_booking_no_show(
  p_booking_id uuid,
  p_reason text DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking RECORD;
  v_slot_released boolean := false;
BEGIN
  -- Lock the booking row (fetch fields needed for slot release)
  SELECT id, status, business_id, date, time, staff_id, location_id, guest_phone
  INTO v_booking FROM bookings
    WHERE id = p_booking_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'not_found');
  END IF;

  -- Only allow no-show from active statuses.
  -- pending/confirmed: customer never showed up.
  -- in_progress: customer checked in but left mid-service.
  -- Already no_show/cancelled/completed are not valid source states.
  IF v_booking.status NOT IN ('pending', 'confirmed', 'in_progress') THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'invalid_status', 'status', v_booking.status);
  END IF;

  -- Mark booking as no-show
  UPDATE bookings
  SET status = 'no_show',
      no_show_at = NOW(),
      no_show_reason = p_reason
  WHERE id = p_booking_id
    AND status IN ('pending', 'confirmed', 'in_progress');

  -- Release booking slot capacity (keeps booking_slots counter accurate).
  -- Uses GREATEST(0, ...) to prevent negative counters.
  -- Safe even when no matching booking_slots row exists (UPDATE matches 0 rows).
  UPDATE booking_slots
  SET current_bookings = GREATEST(0, current_bookings - 1)
  WHERE business_id = v_booking.business_id
    AND date = v_booking.date
    AND start_time = v_booking.time
    AND COALESCE(staff_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(v_booking.staff_id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(v_booking.location_id, '00000000-0000-0000-0000-000000000000'::uuid);

  -- Track whether slot release actually matched a row
  IF FOUND THEN
    v_slot_released := true;
  END IF;

  -- Note: package sessions are NOT released — no-show consumes the session.
  -- Note: no_show_count on profiles is handled by the application layer.

  RETURN jsonb_build_object('marked', true, 'slot_released', v_slot_released);
END;
$$;

-- Lock down access: service_role only (called from API routes via service client)
REVOKE ALL ON FUNCTION mark_booking_no_show(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_booking_no_show(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION mark_booking_no_show(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION mark_booking_no_show(uuid, text) TO service_role;
