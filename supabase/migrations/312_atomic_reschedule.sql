-- Migration 312: Atomic booking reschedule with capacity enforcement
--
-- Prevents concurrent oversubscription during rescheduling.
-- Uses advisory lock on the TARGET slot (same pattern as book_slot_atomic)
-- to serialize all operations on the same logical slot.
-- Validates capacity, buffer overlap, and booking ownership atomically.

CREATE OR REPLACE FUNCTION reschedule_booking_atomic(
  p_booking_id uuid,
  p_business_id uuid,
  p_new_date date,
  p_new_time text,
  p_new_party_size integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking record;
  v_lock_key bigint;
  v_count integer;
  v_max_capacity integer;
  v_buffer_minutes integer;
  v_duration integer;
  v_buffer_count integer;
BEGIN
  -- 1. Load and validate booking
  SELECT id, business_id, service_id, appointment_id, staff_id, date, time,
         party_size, status, location_id
  INTO v_booking FROM bookings WHERE id = p_booking_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('rescheduled', false, 'reason', 'booking_not_found');
  END IF;
  IF v_booking.business_id != p_business_id THEN
    RETURN jsonb_build_object('rescheduled', false, 'reason', 'business_mismatch');
  END IF;
  IF v_booking.status NOT IN ('pending', 'confirmed') THEN
    RETURN jsonb_build_object('rescheduled', false, 'reason', 'not_reschedulable',
      'status', v_booking.status);
  END IF;

  -- 2. Resolve capacity and buffer from service or appointment
  IF v_booking.service_id IS NOT NULL THEN
    SELECT COALESCE(max_capacity, 1), COALESCE(buffer_minutes, 0), COALESCE(duration_minutes, 30)
    INTO v_max_capacity, v_buffer_minutes, v_duration
    FROM services WHERE id = v_booking.service_id;
  ELSIF v_booking.appointment_id IS NOT NULL THEN
    SELECT COALESCE(max_capacity, 1), 0, COALESCE(duration_minutes, 30)
    INTO v_max_capacity, v_buffer_minutes, v_duration
    FROM appointments WHERE id = v_booking.appointment_id;
  ELSE
    v_max_capacity := 1;
    v_buffer_minutes := 0;
    v_duration := 30;
  END IF;

  IF v_max_capacity IS NULL THEN v_max_capacity := 1; END IF;
  IF v_buffer_minutes IS NULL THEN v_buffer_minutes := 0; END IF;
  IF v_duration IS NULL THEN v_duration := 30; END IF;

  -- 3. Advisory lock on TARGET slot (same pattern as book_slot_atomic)
  v_lock_key := abs(hashtext(
    p_business_id::text || '|' || p_new_date::text || '|' || p_new_time
  ));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- 4. Idempotent: if booking is already at this date/time, return success
  IF v_booking.date = p_new_date AND v_booking.time = p_new_time::time THEN
    RETURN jsonb_build_object('rescheduled', true, 'already_at_target', true);
  END IF;

  -- 5. Capacity check at new slot (excluding this booking)
  SELECT COUNT(*) INTO v_count FROM bookings
  WHERE business_id = p_business_id
    AND date = p_new_date
    AND time = p_new_time::time
    AND status IN ('confirmed', 'pending', 'in_progress')
    AND id != p_booking_id
    AND (v_booking.staff_id IS NULL OR staff_id = v_booking.staff_id);

  IF v_count >= v_max_capacity THEN
    RETURN jsonb_build_object('rescheduled', false, 'reason', 'slot_full');
  END IF;

  -- 6. Buffer overlap check (if buffer_minutes > 0)
  IF v_buffer_minutes > 0 THEN
    SELECT COUNT(*) INTO v_buffer_count
    FROM bookings
    WHERE business_id = p_business_id
      AND date = p_new_date
      AND status IN ('pending', 'confirmed', 'in_progress')
      AND id != p_booking_id
      AND (v_booking.staff_id IS NULL OR staff_id = v_booking.staff_id)
      AND time != p_new_time::time
      AND (
        p_new_time::time < (time + make_interval(mins => v_duration + v_buffer_minutes))
        AND (p_new_time::time + make_interval(mins => v_duration)) > (time - make_interval(mins => v_buffer_minutes))
      );

    IF v_buffer_count > 0 THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'buffer_conflict');
    END IF;
  END IF;

  -- 7. Atomic move: update booking to new slot
  UPDATE bookings
  SET date = p_new_date,
      time = p_new_time::time,
      party_size = COALESCE(p_new_party_size, party_size),
      original_date = CASE WHEN original_date IS NULL THEN v_booking.date ELSE original_date END,
      original_time = CASE WHEN original_time IS NULL THEN v_booking.time::text ELSE original_time END,
      rescheduled_at = NOW()
  WHERE id = p_booking_id;

  RETURN jsonb_build_object(
    'rescheduled', true,
    'old_date', v_booking.date,
    'old_time', v_booking.time,
    'new_date', p_new_date,
    'new_time', p_new_time
  );
END;
$$;

-- Restrict to service_role
REVOKE ALL ON FUNCTION reschedule_booking_atomic(uuid, uuid, date, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION reschedule_booking_atomic(uuid, uuid, date, text, integer) FROM anon;
REVOKE ALL ON FUNCTION reschedule_booking_atomic(uuid, uuid, date, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION reschedule_booking_atomic(uuid, uuid, date, text, integer) TO service_role;
