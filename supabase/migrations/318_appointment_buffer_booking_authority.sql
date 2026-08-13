-- ═══════════════════════════════════════════════════════
-- 318: Appointment booking authority — buffer, schedule, manual, public
--
-- P1-APPT-1: Add buffer_minutes to appointments table.
-- P1-APPT-1: Canonical appointment schedule validation in book_slot_atomic.
-- P1-APPT-1: Update reschedule_booking_atomic for buffer + schedule.
-- P1-APPT-3: Extend book_manual_slot_atomic with p_appointment_id.
-- P1-APPT-4: Public SELECT policy for appointment discovery.
--
-- Architecture: ONE shared helper (check_appointment_schedule) validates
-- available_days, available_from, available_to using PostgreSQL's
-- deterministic date functions (no server-timezone dependence).
-- book_slot_atomic and reschedule_booking_atomic both call it.
-- ═══════════════════════════════════════════════════════

-- 1. Add buffer_minutes column to appointments (matches services.buffer_minutes)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS buffer_minutes integer NOT NULL DEFAULT 0;

-- 2. Public appointment read RPC — least-privilege public read surface.
--    Returns ONLY columns needed for public booking discovery.
--    Does NOT expose: staff_ids, requires_staff, allow_staff_selection,
--    auto_approve, buffer_minutes, metadata, created_at, updated_at.
--    Inactive appointments are excluded.
--    No broad anon table SELECT — direct PostgREST callers cannot
--    request arbitrary columns from appointments.
CREATE OR REPLACE FUNCTION get_active_appointments_public(p_business_id uuid)
RETURNS TABLE(
  id uuid,
  business_id uuid,
  name varchar(200),
  description text,
  price numeric,
  price_is_variable boolean,
  duration_minutes integer,
  deposit_amount numeric,
  max_capacity integer,
  available_days text[],
  available_from time,
  available_to time,
  sort_order integer,
  image_url text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.business_id, a.name, a.description, a.price, a.price_is_variable,
         a.duration_minutes, a.deposit_amount, a.max_capacity,
         a.available_days, a.available_from, a.available_to,
         a.sort_order, a.image_url
  FROM appointments a
  WHERE a.business_id = p_business_id
    AND a.is_active = true
  ORDER BY a.sort_order;
$$;

-- Allow anon + authenticated to call the public read RPC
GRANT EXECUTE ON FUNCTION get_active_appointments_public(uuid) TO anon;
GRANT EXECUTE ON FUNCTION get_active_appointments_public(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_active_appointments_public(uuid) TO service_role;

-- 3. Shared appointment schedule validation helper.
--    Returns TRUE if the appointment allows booking on the given date/time.
--    Uses PostgreSQL EXTRACT(DOW ...) for deterministic day-of-week (0=Sun..6=Sat).
--    Called by book_slot_atomic and reschedule_booking_atomic.
CREATE OR REPLACE FUNCTION check_appointment_schedule(
  p_appointment_id uuid,
  p_business_id uuid,
  p_date date,
  p_time text
) RETURNS TABLE(allowed boolean, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_appt record;
  v_day_name text;
BEGIN
  -- Look up the appointment
  SELECT id, business_id, is_active, available_days, available_from, available_to
  INTO v_appt
  FROM appointments WHERE id = p_appointment_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'appointment_not_found'::text;
    RETURN;
  END IF;

  IF v_appt.business_id != p_business_id THEN
    RETURN QUERY SELECT false, 'appointment_business_mismatch'::text;
    RETURN;
  END IF;

  IF NOT v_appt.is_active THEN
    RETURN QUERY SELECT false, 'appointment_inactive'::text;
    RETURN;
  END IF;

  -- Deterministic day-of-week using PostgreSQL EXTRACT(DOW ...)
  -- DOW: 0=Sunday, 1=Monday, ... 6=Saturday
  v_day_name := CASE EXTRACT(DOW FROM p_date)
    WHEN 0 THEN 'sunday'
    WHEN 1 THEN 'monday'
    WHEN 2 THEN 'tuesday'
    WHEN 3 THEN 'wednesday'
    WHEN 4 THEN 'thursday'
    WHEN 5 THEN 'friday'
    WHEN 6 THEN 'saturday'
  END;

  -- Check available_days (if configured, empty = all days allowed)
  IF v_appt.available_days IS NOT NULL
     AND array_length(v_appt.available_days, 1) > 0
     AND NOT (v_day_name = ANY(v_appt.available_days))
  THEN
    RETURN QUERY SELECT false, 'appointment_day_unavailable'::text;
    RETURN;
  END IF;

  -- Check available_from (if set, requested time must be >= available_from)
  IF v_appt.available_from IS NOT NULL
     AND p_time::time < v_appt.available_from
  THEN
    RETURN QUERY SELECT false, 'appointment_before_available_from'::text;
    RETURN;
  END IF;

  -- Check available_to (if set, requested time must be < available_to)
  IF v_appt.available_to IS NOT NULL
     AND p_time::time >= v_appt.available_to
  THEN
    RETURN QUERY SELECT false, 'appointment_after_available_to'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, NULL::text;
END;
$$;

-- Restrict helper to service_role (called internally by other SECURITY DEFINER functions)
REVOKE EXECUTE ON FUNCTION check_appointment_schedule(uuid,uuid,date,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION check_appointment_schedule(uuid,uuid,date,text) FROM anon;
REVOKE EXECUTE ON FUNCTION check_appointment_schedule(uuid,uuid,date,text) FROM authenticated;
GRANT EXECUTE ON FUNCTION check_appointment_schedule(uuid,uuid,date,text) TO service_role;


-- 4. Update book_slot_atomic to validate appointment schedule.
--    Only the schedule check is added — all other logic preserved from migration 313.
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
BEGIN
  -- 1. Idempotent retry check — MUST come before schedule validation.
  --    If a booking was already committed for this bot_session_id, return it
  --    regardless of whether the appointment's schedule has since changed.
  --    This preserves canonical replay behavior: a successfully-committed
  --    booking is never retroactively invalidated by a config change.
  --    Does NOT bypass validation for genuinely new bookings.
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

  -- 2. Appointment schedule validation (canonical authority enforcement)
  --    Services retain existing semantics unchanged — no schedule check.
  IF p_appointment_id IS NOT NULL THEN
    SELECT cas.allowed, cas.reason
    INTO v_sched_allowed, v_sched_reason
    FROM check_appointment_schedule(p_appointment_id, p_business_id, p_date, p_time) cas;

    IF v_sched_allowed IS NOT TRUE THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;
  END IF;

  -- 3. Advisory lock on logical slot
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


-- 5. Replace book_manual_slot_atomic to accept p_appointment_id
DROP FUNCTION IF EXISTS book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer);

CREATE OR REPLACE FUNCTION book_manual_slot_atomic(
  p_business_id uuid,
  p_user_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_date date,
  p_time text,
  p_party_size int,
  p_max_capacity int,
  p_guest_name text,
  p_guest_phone text,
  p_guest_email text,
  p_notes text,
  p_total_amount int,
  p_staff_name text,
  p_buffer_minutes integer DEFAULT 0,
  p_duration integer DEFAULT 30,
  p_appointment_id uuid DEFAULT NULL
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking_id uuid;
  v_ref text;
  v_available boolean;
  v_updated_rows int;
BEGIN
  -- 1. Delegate to canonical book_slot_atomic for schedule + capacity + INSERT
  SELECT bsa.booking_id, bsa.reference_code, bsa.slot_available
  INTO v_booking_id, v_ref, v_available
  FROM book_slot_atomic(
    p_business_id, p_user_id, p_service_id, p_staff_id,
    p_date, p_time, p_party_size, p_max_capacity,
    'scheduling',  -- p_flow_type
    0,             -- p_deposit_amount
    'none',        -- p_deposit_status
    'confirmed',   -- p_status
    p_guest_name, p_guest_phone, p_guest_email,
    NULL,          -- p_special_requests (we use notes column instead)
    NULL,          -- p_venue_address
    NULL,          -- p_end_date
    NULL,          -- p_addons_snapshot
    NULL,          -- p_promo_code_id
    p_total_amount,
    p_staff_name,
    NULL,          -- p_location_id
    p_appointment_id,  -- pass through appointment_id
    p_buffer_minutes,
    p_duration,
    NULL           -- p_bot_session_id
  ) bsa;

  -- 2. Defensive: treat anything other than slot_available = TRUE as unavailable
  IF v_available IS NOT TRUE THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, false;
    RETURN;
  END IF;

  -- Defensive: booking_id must be valid after a successful slot claim
  IF v_booking_id IS NULL THEN
    RAISE EXCEPTION 'book_manual_slot_atomic: book_slot_atomic returned slot_available=true but booking_id is NULL'
      USING ERRCODE = 'data_exception';
  END IF;

  -- 3. Apply manual-dashboard-specific fields in the SAME transaction.
  UPDATE bookings
  SET channel = 'dashboard'::booking_channel,
      confirmed_at = NOW(),
      notes = p_notes
  WHERE id = v_booking_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION 'book_manual_slot_atomic: expected 1 row updated for manual metadata, got %', v_updated_rows
      USING ERRCODE = 'data_exception';
  END IF;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- Restrict execution to service_role only (17-arg signature)
REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid) TO service_role;


-- 6. Update reschedule_booking_atomic: buffer + schedule enforcement
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

    -- BLOCKER 2: Validate appointment schedule for the NEW date/time
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
