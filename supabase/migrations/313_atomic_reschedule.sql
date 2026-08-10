-- Migration 313: Atomic booking reschedule with capacity enforcement
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

  -- 3. Advisory lock on TARGET slot (same canonical key as book_slot_atomic)
  -- Cast time to PostgreSQL time type then back to text to canonicalize:
  -- '15:00' and '15:00:00' both become '15:00:00' → same hash → same lock.
  v_lock_key := abs(hashtext(
    p_business_id::text || '|' || p_new_date::text || '|' || p_new_time::time::text
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

-- ── Canonicalize book_slot_atomic lock key to match reschedule_booking_atomic ──
-- Both RPCs accept p_time as TEXT. Callers may send '15:00' or '15:00:00'.
-- Without canonicalization, these produce different hashtext values → different
-- advisory locks → the two paths can race on the same logical slot.
-- Fix: cast to time then back to text before hashing, so both forms
-- produce the same canonical key ('15:00:00').
-- This is a CREATE OR REPLACE — only the lock key line changes.

CREATE OR REPLACE FUNCTION public.book_slot_atomic(
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
  p_guest_name text, p_guest_phone text, p_guest_email text,
  p_special_requests text, p_venue_address text, p_end_date date,
  p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
  p_location_id uuid DEFAULT NULL,
  p_appointment_id uuid DEFAULT NULL,
  p_buffer_minutes integer DEFAULT 0,
  p_duration integer DEFAULT 30,
  p_bot_session_id uuid DEFAULT NULL
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int; v_buffer_count int; v_booking_id uuid; v_ref text;
  v_lock_key bigint;
BEGIN
  -- Advisory lock on logical slot — canonicalize time to prevent '15:00' vs '15:00:00' mismatch
  v_lock_key := abs(hashtext(
    p_business_id::text || '|' || p_date::text || '|' || p_time::time::text
  ));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Idempotent retry check
  IF p_bot_session_id IS NOT NULL THEN
    SELECT id, bookings.reference_code INTO v_booking_id, v_ref
    FROM bookings
    WHERE bot_session_id = p_bot_session_id
      AND status IN ('pending', 'confirmed')
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_booking_id, v_ref, true;
      RETURN;
    END IF;
  END IF;

  -- Capacity check
  SELECT COUNT(*) INTO v_count FROM bookings
  WHERE business_id = p_business_id AND date = p_date AND time = p_time::time
    AND status IN ('confirmed', 'pending', 'in_progress')
    AND (p_staff_id IS NULL OR staff_id = p_staff_id);

  IF v_count >= p_max_capacity THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, false;
    RETURN;
  END IF;

  -- Buffer overlap check
  IF p_buffer_minutes > 0 THEN
    SELECT COUNT(*) INTO v_buffer_count
    FROM bookings
    WHERE business_id = p_business_id
      AND date = p_date
      AND status IN ('pending', 'confirmed', 'in_progress')
      AND (p_staff_id IS NULL OR staff_id = p_staff_id)
      AND time != p_time::time
      AND (
        p_time::time < (time + make_interval(mins => COALESCE(p_duration, 30) + p_buffer_minutes))
        AND (p_time::time + make_interval(mins => COALESCE(p_duration, 30))) > (time - make_interval(mins => p_buffer_minutes))
      );

    IF v_buffer_count > 0 THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;
  END IF;

  -- Insert the booking
  INSERT INTO bookings (
    business_id, user_id, service_id, appointment_id, staff_id, staff_name,
    date, time, party_size, flow_type, channel,
    deposit_amount, deposit_status, status,
    guest_name, guest_phone, guest_email,
    special_requests, venue_address, end_date,
    addons_snapshot, promo_code_id, total_amount, quantity,
    location_id, bot_session_id
  ) VALUES (
    p_business_id, p_user_id,
    CASE WHEN p_appointment_id IS NOT NULL THEN NULL ELSE p_service_id END,
    p_appointment_id,
    p_staff_id, p_staff_name,
    p_date, p_time::time, p_party_size,
    p_flow_type::flow_type,
    'whatsapp'::booking_channel,
    p_deposit_amount,
    p_deposit_status::deposit_status,
    p_status::reservation_status,
    p_guest_name, p_guest_phone, p_guest_email,
    p_special_requests, p_venue_address, p_end_date,
    p_addons_snapshot, p_promo_code_id, p_total_amount, p_party_size,
    p_location_id, p_bot_session_id
  )
  RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- Re-apply permissions for the updated 27-arg signature
REVOKE ALL ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer, uuid
) TO service_role;
