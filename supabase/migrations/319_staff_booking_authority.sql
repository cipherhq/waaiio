-- ═══════════════════════════════════════════════════════
-- 319: Staff booking authority — canonical provider availability
--
-- P1-STAFF-1: Staff/provider schedules are not enforced during booking.
--
-- Defects fixed:
-- 1. check_staff_availability helper validates staff ownership, active
--    status, and schedule (day + [start, end) window including duration).
-- 2. book_slot_atomic rejects bookings when staff is unavailable.
-- 3. book_slot_atomic rejects requires_staff bookings with NULL staff.
-- 4. reschedule_booking_atomic validates staff availability at new time.
--
-- Day-key compatibility: supports BOTH short (mon,tue,...) and long
-- (monday,tuesday,...) forms at the read boundary. Dashboard stores
-- short keys; bot historically used long keys. No data migration needed.
--
-- Backward compatibility: NULL or empty schedule = unrestricted.
--
-- Architecture: follows the proven check_appointment_schedule pattern.
-- Called from book_slot_atomic and reschedule_booking_atomic.
-- ═══════════════════════════════════════════════════════


-- 1. Canonical staff availability helper
--    Returns TRUE if the staff member can accept a booking on the given date/time/duration.
--    Uses PostgreSQL EXTRACT(DOW ...) for deterministic day-of-week (no server-TZ dependence).
CREATE OR REPLACE FUNCTION check_staff_availability(
  p_staff_id uuid,
  p_business_id uuid,
  p_date date,
  p_time text,
  p_duration integer DEFAULT 30
) RETURNS TABLE(allowed boolean, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_staff record;
  v_short_key text;
  v_long_key text;
  v_day_schedule jsonb;
  v_start time;
  v_end time;
  v_booking_end time;
BEGIN
  -- Look up the staff member
  SELECT id, business_id, is_active, schedule
  INTO v_staff
  FROM business_staff WHERE id = p_staff_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'staff_not_found'::text;
    RETURN;
  END IF;

  IF v_staff.business_id != p_business_id THEN
    RETURN QUERY SELECT false, 'staff_business_mismatch'::text;
    RETURN;
  END IF;

  IF NOT v_staff.is_active THEN
    RETURN QUERY SELECT false, 'staff_inactive'::text;
    RETURN;
  END IF;

  -- NULL or empty schedule = unrestricted (backward compatibility)
  IF v_staff.schedule IS NULL
     OR v_staff.schedule = '{}'::jsonb
     OR jsonb_typeof(v_staff.schedule) != 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(v_staff.schedule)) = 0
  THEN
    RETURN QUERY SELECT true, NULL::text;
    RETURN;
  END IF;

  -- Deterministic day-of-week using PostgreSQL EXTRACT(DOW ...)
  -- DOW: 0=Sunday, 1=Monday, ... 6=Saturday
  -- Generate BOTH short and long key forms for compatibility
  v_short_key := CASE EXTRACT(DOW FROM p_date)
    WHEN 0 THEN 'sun'
    WHEN 1 THEN 'mon'
    WHEN 2 THEN 'tue'
    WHEN 3 THEN 'wed'
    WHEN 4 THEN 'thu'
    WHEN 5 THEN 'fri'
    WHEN 6 THEN 'sat'
  END;
  v_long_key := CASE EXTRACT(DOW FROM p_date)
    WHEN 0 THEN 'sunday'
    WHEN 1 THEN 'monday'
    WHEN 2 THEN 'tuesday'
    WHEN 3 THEN 'wednesday'
    WHEN 4 THEN 'thursday'
    WHEN 5 THEN 'friday'
    WHEN 6 THEN 'saturday'
  END;

  -- Try short key first (dashboard canonical), then long key (legacy)
  v_day_schedule := COALESCE(
    v_staff.schedule -> v_short_key,
    v_staff.schedule -> v_long_key
  );

  -- If no schedule entry for this day, staff is unavailable
  IF v_day_schedule IS NULL THEN
    RETURN QUERY SELECT false, 'staff_day_unavailable'::text;
    RETURN;
  END IF;

  -- Extract start/end from the day schedule
  -- Expected format: { "start": "09:00", "end": "17:00" }
  IF v_day_schedule ->> 'start' IS NULL THEN
    -- Malformed entry without start = unavailable
    RETURN QUERY SELECT false, 'staff_day_unavailable'::text;
    RETURN;
  END IF;

  v_start := (v_day_schedule ->> 'start')::time;
  -- If end is missing, treat as end-of-day (23:59)
  v_end := COALESCE((v_day_schedule ->> 'end')::time, '23:59'::time);

  -- Booking start must be >= staff start
  IF p_time::time < v_start THEN
    RETURN QUERY SELECT false, 'staff_before_start'::text;
    RETURN;
  END IF;

  -- Booking END (start + duration) must be <= staff end
  v_booking_end := p_time::time + make_interval(mins => COALESCE(p_duration, 30));
  IF v_booking_end > v_end THEN
    RETURN QUERY SELECT false, 'staff_past_end'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, NULL::text;
END;
$$;

-- Restrict to service_role (called internally by SECURITY DEFINER functions)
REVOKE EXECUTE ON FUNCTION check_staff_availability(uuid,uuid,date,text,integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION check_staff_availability(uuid,uuid,date,text,integer) FROM anon;
REVOKE EXECUTE ON FUNCTION check_staff_availability(uuid,uuid,date,text,integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION check_staff_availability(uuid,uuid,date,text,integer) TO service_role;


-- 2. Update book_slot_atomic: add staff availability + requires_staff enforcement.
--    Preserves ALL existing logic: idempotency, appointment schedule, advisory locks,
--    capacity, buffer. Only adds staff checks after appointment check.
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
  v_sched_allowed boolean;
  v_sched_reason text;
  v_requires_staff boolean;
BEGIN
  -- 1. Idempotent retry check — MUST come before validation.
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

  -- 2. Appointment schedule validation (preserved from migration 318)
  IF p_appointment_id IS NOT NULL THEN
    SELECT cas.allowed, cas.reason
    INTO v_sched_allowed, v_sched_reason
    FROM check_appointment_schedule(p_appointment_id, p_business_id, p_date, p_time) cas;

    IF v_sched_allowed IS NOT TRUE THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;
  END IF;

  -- 3. Staff availability validation (P1-STAFF-1 canonical authority)
  IF p_staff_id IS NOT NULL THEN
    SELECT csa.allowed, csa.reason
    INTO v_sched_allowed, v_sched_reason
    FROM check_staff_availability(p_staff_id, p_business_id, p_date, p_time, COALESCE(p_duration, 30)) csa;

    IF v_sched_allowed IS NOT TRUE THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;
  END IF;

  -- 4. requires_staff enforcement: resolve from authoritative record
  IF p_staff_id IS NULL THEN
    v_requires_staff := false;
    IF p_appointment_id IS NOT NULL THEN
      SELECT COALESCE(a.requires_staff, false) INTO v_requires_staff
      FROM appointments a WHERE a.id = p_appointment_id;
    ELSIF p_service_id IS NOT NULL THEN
      SELECT COALESCE(s.requires_staff, false) INTO v_requires_staff
      FROM services s WHERE s.id = p_service_id;
    END IF;

    IF v_requires_staff THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;
  END IF;

  -- 5. Advisory lock on logical slot
  v_lock_key := abs(hashtext(
    p_business_id::text || '|' || p_date::text || '|' || p_time::time::text
  ));
  PERFORM pg_advisory_xact_lock(v_lock_key);

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

-- Re-apply permissions (27-arg signature unchanged)
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


-- 3. Update reschedule_booking_atomic: staff availability at target date/time.
--    Preserves ALL existing logic. Adds staff check after capacity resolution.
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
  v_sched_allowed boolean;
  v_sched_reason text;
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
    SELECT COALESCE(max_capacity, 1), COALESCE(buffer_minutes, 0), COALESCE(duration_minutes, 30)
    INTO v_max_capacity, v_buffer_minutes, v_duration
    FROM appointments WHERE id = v_booking.appointment_id;

    -- Appointment schedule validation (preserved from migration 318)
    SELECT cas.allowed, cas.reason
    INTO v_sched_allowed, v_sched_reason
    FROM check_appointment_schedule(v_booking.appointment_id, p_business_id, p_new_date, p_new_time) cas;

    IF v_sched_allowed IS NOT TRUE THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', COALESCE(v_sched_reason, 'appointment_schedule_conflict'));
    END IF;
  ELSE
    v_max_capacity := 1;
    v_buffer_minutes := 0;
    v_duration := 30;
  END IF;

  IF v_max_capacity IS NULL THEN v_max_capacity := 1; END IF;
  IF v_buffer_minutes IS NULL THEN v_buffer_minutes := 0; END IF;
  IF v_duration IS NULL THEN v_duration := 30; END IF;

  -- 2b. Staff availability at target date/time (P1-STAFF-1)
  IF v_booking.staff_id IS NOT NULL THEN
    SELECT csa.allowed, csa.reason
    INTO v_sched_allowed, v_sched_reason
    FROM check_staff_availability(v_booking.staff_id, p_business_id, p_new_date, p_new_time, v_duration) csa;

    IF v_sched_allowed IS NOT TRUE THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', COALESCE(v_sched_reason, 'staff_unavailable'));
    END IF;
  END IF;

  -- 3. Advisory lock on TARGET slot
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

-- Re-apply permissions for reschedule_booking_atomic
REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer) FROM anon;
REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer) TO service_role;
