-- ═══════════════════════════════════════════════════════
-- Migration 478: Exclude table reservations from reschedule capacity
-- Issue: #730 — CTO R21 Blocker B
--
-- reschedule_booking_atomic (M325) counts ALL bookings including
-- table reservations in capacity and buffer checks.
-- This additive replacement adds AND seating_resource_id IS NULL
-- to the standard-path capacity and buffer queries.
-- Class-session path is unaffected (uses class_session_id).
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION reschedule_booking_atomic(
  p_booking_id uuid, p_business_id uuid, p_new_date date, p_new_time text,
  p_new_party_size integer DEFAULT NULL, p_target_class_session_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking record; v_lock_key bigint; v_count integer; v_max_capacity integer;
  v_buffer_minutes integer; v_duration integer; v_buffer_count integer;
  v_sched_allowed boolean; v_sched_reason text; v_target_cs record;
  v_occupied bigint; v_party integer;
BEGIN
  SELECT id, business_id, service_id, appointment_id, staff_id, date, time, party_size, status, location_id, class_session_id
  INTO v_booking FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'booking_not_found'); END IF;
  IF v_booking.business_id != p_business_id THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'business_mismatch'); END IF;
  IF v_booking.status NOT IN ('pending', 'confirmed') THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'not_reschedulable', 'status', v_booking.status); END IF;
  v_party := COALESCE(p_new_party_size, v_booking.party_size);

  -- ── Class-session path (unchanged) ──
  IF v_booking.class_session_id IS NOT NULL THEN
    IF p_target_class_session_id IS NULL THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_required'); END IF;
    IF v_booking.class_session_id = p_target_class_session_id THEN RETURN jsonb_build_object('rescheduled', true, 'already_at_target', true); END IF;
    v_lock_key := abs(hashtext('class_session:' || p_target_class_session_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);
    SELECT cs.id, cs.business_id, cs.service_id, cs.date, cs.start_time, cs.end_time, cs.capacity, cs.status, cs.staff_id, cs.location_id,
           s.is_class, s.requires_staff, s.duration_minutes
    INTO v_target_cs FROM class_sessions cs JOIN services s ON s.id = cs.service_id WHERE cs.id = p_target_class_session_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_not_found'); END IF;
    IF v_target_cs.business_id != p_business_id THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_business_mismatch'); END IF;
    IF v_target_cs.service_id != v_booking.service_id THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'cross_class_not_allowed'); END IF;
    IF NOT COALESCE(v_target_cs.is_class, false) THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_not_class'); END IF;
    IF v_target_cs.status != 'scheduled' THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_not_bookable'); END IF;
    IF v_target_cs.staff_id IS NOT NULL THEN
      SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(v_target_cs.staff_id, p_business_id, v_target_cs.date, v_target_cs.start_time::text, COALESCE(v_target_cs.duration_minutes, 60)) csa;
      IF v_sched_allowed IS NOT TRUE THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_staff_unavailable'); END IF;
    ELSIF COALESCE(v_target_cs.requires_staff, false) THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_requires_staff');
    END IF;
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied FROM bookings b WHERE b.class_session_id = p_target_class_session_id AND b.status IN ('confirmed', 'pending', 'in_progress') AND b.id != p_booking_id;
    IF v_occupied + v_party > v_target_cs.capacity THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_full'); END IF;
    UPDATE bookings SET class_session_id = p_target_class_session_id, date = v_target_cs.date, time = v_target_cs.start_time, party_size = v_party,
      staff_id = v_target_cs.staff_id, staff_name = (SELECT bs.name FROM business_staff bs WHERE bs.id = v_target_cs.staff_id),
      location_id = v_target_cs.location_id,
      original_date = CASE WHEN original_date IS NULL THEN v_booking.date ELSE original_date END,
      original_time = CASE WHEN original_time IS NULL THEN v_booking.time::text ELSE original_time END, rescheduled_at = NOW()
    WHERE id = p_booking_id;
    RETURN jsonb_build_object('rescheduled', true, 'old_session_id', v_booking.class_session_id, 'new_session_id', p_target_class_session_id, 'old_date', v_booking.date, 'new_date', v_target_cs.date);
  END IF;

  -- ── Standard reschedule path ──
  IF v_booking.service_id IS NOT NULL THEN
    SELECT COALESCE(max_capacity, 1), COALESCE(buffer_minutes, 0), COALESCE(duration_minutes, 30) INTO v_max_capacity, v_buffer_minutes, v_duration FROM services WHERE id = v_booking.service_id;
  ELSIF v_booking.appointment_id IS NOT NULL THEN
    SELECT COALESCE(max_capacity, 1), COALESCE(buffer_minutes, 0), COALESCE(duration_minutes, 30) INTO v_max_capacity, v_buffer_minutes, v_duration FROM appointments WHERE id = v_booking.appointment_id;
    SELECT cas.allowed, cas.reason INTO v_sched_allowed, v_sched_reason FROM check_appointment_schedule(v_booking.appointment_id, p_business_id, p_new_date, p_new_time) cas;
    IF v_sched_allowed IS NOT TRUE THEN RETURN jsonb_build_object('rescheduled', false, 'reason', COALESCE(v_sched_reason, 'appointment_schedule_conflict')); END IF;
  ELSE v_max_capacity := 1; v_buffer_minutes := 0; v_duration := 30;
  END IF;
  IF v_max_capacity IS NULL THEN v_max_capacity := 1; END IF;
  IF v_buffer_minutes IS NULL THEN v_buffer_minutes := 0; END IF;
  IF v_duration IS NULL THEN v_duration := 30; END IF;
  IF v_booking.staff_id IS NOT NULL THEN
    SELECT csa.allowed, csa.reason INTO v_sched_allowed, v_sched_reason FROM check_staff_availability(v_booking.staff_id, p_business_id, p_new_date, p_new_time, v_duration) csa;
    IF v_sched_allowed IS NOT TRUE THEN RETURN jsonb_build_object('rescheduled', false, 'reason', COALESCE(v_sched_reason, 'staff_unavailable')); END IF;
  ELSE
    DECLARE v_req_staff boolean := false;
    BEGIN
      IF v_booking.service_id IS NOT NULL THEN SELECT COALESCE(s.requires_staff, false) INTO v_req_staff FROM services s WHERE s.id = v_booking.service_id;
      ELSIF v_booking.appointment_id IS NOT NULL THEN SELECT COALESCE(a.requires_staff, false) INTO v_req_staff FROM appointments a WHERE a.id = v_booking.appointment_id;
      END IF;
      IF v_req_staff THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'staff_required'); END IF;
    END;
  END IF;
  v_lock_key := abs(hashtext(p_business_id::text || '|' || p_new_date::text || '|' || p_new_time::time::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);
  IF v_booking.date = p_new_date AND v_booking.time = p_new_time::time THEN RETURN jsonb_build_object('rescheduled', true, 'already_at_target', true); END IF;

  -- ── Capacity check: EXCLUDE table reservations ──
  SELECT COUNT(*) INTO v_count FROM bookings WHERE business_id = p_business_id AND date = p_new_date AND time = p_new_time::time AND status IN ('confirmed', 'pending', 'in_progress') AND id != p_booking_id AND seating_resource_id IS NULL AND (v_booking.staff_id IS NULL OR staff_id = v_booking.staff_id);
  IF v_count >= v_max_capacity THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'slot_full'); END IF;

  -- ── Buffer check: EXCLUDE table reservations ──
  IF v_buffer_minutes > 0 THEN
    SELECT COUNT(*) INTO v_buffer_count FROM bookings WHERE business_id = p_business_id AND date = p_new_date AND status IN ('pending', 'confirmed', 'in_progress') AND id != p_booking_id AND seating_resource_id IS NULL AND (v_booking.staff_id IS NULL OR staff_id = v_booking.staff_id) AND time != p_new_time::time AND (p_new_time::time < (time + make_interval(mins => v_duration + v_buffer_minutes)) AND (p_new_time::time + make_interval(mins => v_duration)) > (time - make_interval(mins => v_buffer_minutes)));
    IF v_buffer_count > 0 THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'buffer_conflict'); END IF;
  END IF;

  UPDATE bookings SET date = p_new_date, time = p_new_time::time, party_size = COALESCE(p_new_party_size, party_size),
    original_date = CASE WHEN original_date IS NULL THEN v_booking.date ELSE original_date END,
    original_time = CASE WHEN original_time IS NULL THEN v_booking.time::text ELSE original_time END, rescheduled_at = NOW()
  WHERE id = p_booking_id;
  RETURN jsonb_build_object('rescheduled', true, 'old_date', v_booking.date, 'old_time', v_booking.time, 'new_date', p_new_date, 'new_time', p_new_time);
END;
$$;

-- Self-check
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE proname = 'reschedule_booking_atomic'
    AND pronamespace = 'public'::regnamespace
    AND pronargs = 6;
  IF v_src IS NULL THEN
    RAISE EXCEPTION '478 SELF-CHECK FAILED: 6-arg reschedule_booking_atomic not found';
  END IF;
  IF v_src NOT ILIKE '%seating_resource_id IS NULL%' THEN
    RAISE EXCEPTION '478 SELF-CHECK FAILED: reschedule_booking_atomic missing table-reservation exclusion';
  END IF;
  RAISE NOTICE '478 SELF-CHECK PASSED: reschedule_booking_atomic excludes table reservations';
END;
$$;
