-- ═══════════════════════════════════════════════════════
-- Migration 475: Exclude table reservations from service slot capacity
-- Issue: #730 — CTO R19 P1 booking isolation
--
-- book_slot_atomic (M383) counts ALL bookings for capacity.
-- Table reservations (seating_resource_id IS NOT NULL) must not
-- consume service/appointment slot capacity.
--
-- Additive replacement — does NOT modify M383 in place.
-- ═══════════════════════════════════════════════════════

-- Replace book_slot_atomic to exclude table reservations from capacity count.
-- Preserves all existing parameters, return type, security mode, grants,
-- advisory locking, idempotency, service revalidation, class-session,
-- staff, buffer, and appointment logic.
--
-- Only change: capacity and buffer queries add
--   AND seating_resource_id IS NULL
-- to exclude table reservation bookings.

CREATE OR REPLACE FUNCTION public.book_slot_atomic(
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
  p_guest_name text, p_guest_phone text, p_guest_email text,
  p_special_requests text, p_venue_address text, p_end_date date,
  p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
  p_location_id uuid DEFAULT NULL, p_appointment_id uuid DEFAULT NULL,
  p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30,
  p_bot_session_id uuid DEFAULT NULL, p_class_session_id uuid DEFAULT NULL,
  p_expected_price int DEFAULT NULL, p_expected_deposit int DEFAULT NULL
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int; v_buffer_count int; v_booking_id uuid; v_ref text;
  v_lock_key bigint; v_sched_allowed boolean; v_sched_reason text;
  v_requires_staff boolean; v_cs record; v_occupied bigint;
  v_cs_duration integer; v_canonical_staff_name text;
  v_service RECORD;
  v_effective_max_capacity int;
  v_effective_buffer int;
  v_effective_duration int;
  v_committed_deposit int;
  v_committed_total int;
  v_service_validated boolean := false;
BEGIN
  -- ── Bot session idempotency ──
  IF p_bot_session_id IS NOT NULL THEN
    SELECT id, bookings.reference_code INTO v_booking_id, v_ref
    FROM bookings WHERE bot_session_id = p_bot_session_id AND status IN ('pending', 'confirmed') LIMIT 1;
    IF FOUND THEN RETURN QUERY SELECT v_booking_id, v_ref, true; RETURN; END IF;
  END IF;

  -- ── Service revalidation (when p_expected_price IS NOT NULL) ──
  IF p_expected_price IS NOT NULL AND p_service_id IS NOT NULL THEN
    SELECT id, price, deposit_amount, is_active, max_capacity, duration_minutes,
           business_id, metadata
    INTO v_service
    FROM services WHERE id = p_service_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'service_not_found:Service % does not exist', p_service_id;
    END IF;
    IF NOT v_service.is_active THEN
      RAISE EXCEPTION 'service_unavailable:Service % is not active', p_service_id;
    END IF;
    IF v_service.business_id != p_business_id THEN
      RAISE EXCEPTION 'service_wrong_business:Service % does not belong to this business', p_service_id;
    END IF;
    IF v_service.price != p_expected_price THEN
      RAISE EXCEPTION 'price_changed:Service price changed from % to %', p_expected_price, v_service.price;
    END IF;
    IF p_expected_deposit IS NOT NULL AND v_service.deposit_amount != p_expected_deposit THEN
      RAISE EXCEPTION 'deposit_changed:Service deposit changed from % to %', p_expected_deposit, v_service.deposit_amount;
    END IF;

    v_effective_max_capacity := COALESCE(v_service.max_capacity, p_max_capacity);
    v_effective_buffer := COALESCE((v_service.metadata->>'buffer_minutes')::int, p_buffer_minutes);
    v_effective_duration := COALESCE(v_service.duration_minutes, p_duration);
    v_service_validated := true;
  ELSE
    v_effective_max_capacity := p_max_capacity;
    v_effective_buffer := p_buffer_minutes;
    v_effective_duration := p_duration;
  END IF;

  -- ── Class session path (unchanged) ──
  IF p_class_session_id IS NOT NULL THEN
    IF p_service_id IS NULL THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF p_appointment_id IS NOT NULL THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    v_lock_key := abs(hashtext('class_session:' || p_class_session_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);
    SELECT cs.id, cs.business_id, cs.service_id, cs.date, cs.start_time,
           cs.capacity, cs.status, cs.staff_id, cs.location_id,
           s.is_class, s.requires_staff, s.duration_minutes, s.is_active AS svc_active,
           s.price AS svc_price, s.deposit_amount AS svc_deposit
    INTO v_cs FROM class_sessions cs JOIN services s ON s.id = cs.service_id
    WHERE cs.id = p_class_session_id;
    IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.business_id != p_business_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.service_id != p_service_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF NOT COALESCE(v_cs.is_class, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF NOT COALESCE(v_cs.svc_active, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.status != 'scheduled' THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    v_cs_duration := COALESCE(v_cs.duration_minutes, 60);
    IF v_cs.staff_id IS NOT NULL THEN
      IF p_staff_id IS NOT NULL AND p_staff_id != v_cs.staff_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(v_cs.staff_id, p_business_id, v_cs.date, v_cs.start_time::text, v_cs_duration) csa;
      IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      SELECT bs.name INTO v_canonical_staff_name FROM business_staff bs WHERE bs.id = v_cs.staff_id;
    ELSE
      IF COALESCE(v_cs.requires_staff, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      v_canonical_staff_name := NULL;
    END IF;
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied FROM bookings b WHERE b.class_session_id = p_class_session_id AND b.status IN ('confirmed', 'pending', 'in_progress');
    IF v_occupied + p_party_size > v_cs.capacity THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    v_committed_deposit := CASE WHEN p_expected_price IS NOT NULL
      THEN COALESCE(v_cs.svc_deposit, 0) ELSE p_deposit_amount END;
    v_committed_total := CASE WHEN p_expected_price IS NOT NULL
      THEN COALESCE(v_cs.svc_price, 0) ELSE p_total_amount END;
    INSERT INTO bookings (business_id, user_id, service_id, appointment_id, staff_id, staff_name, date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status, guest_name, guest_phone, guest_email, special_requests, venue_address, end_date, addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id, class_session_id)
    VALUES (p_business_id, p_user_id, v_cs.service_id, NULL, v_cs.staff_id, v_canonical_staff_name, v_cs.date, v_cs.start_time, p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel, v_committed_deposit, p_deposit_status::deposit_status, p_status::reservation_status, p_guest_name, p_guest_phone, p_guest_email, p_special_requests, p_venue_address, p_end_date, p_addons_snapshot, p_promo_code_id, v_committed_total, p_party_size, v_cs.location_id, p_bot_session_id, p_class_session_id)
    RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;
    RETURN QUERY SELECT v_booking_id, v_ref, true; RETURN;
  END IF;

  -- ── Standard booking path ──
  IF p_service_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM services WHERE id = p_service_id AND is_class = true) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_appointment_id IS NOT NULL THEN
    SELECT cas.allowed INTO v_sched_allowed FROM check_appointment_schedule(p_appointment_id, p_business_id, p_date, p_time) cas;
    IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_staff_id IS NOT NULL THEN
    SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(p_staff_id, p_business_id, p_date, p_time, COALESCE(v_effective_duration, 30)) csa;
    IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_staff_id IS NULL THEN
    v_requires_staff := false;
    IF p_appointment_id IS NOT NULL THEN SELECT COALESCE(a.requires_staff, false) INTO v_requires_staff FROM appointments a WHERE a.id = p_appointment_id;
    ELSIF p_service_id IS NOT NULL THEN SELECT COALESCE(s.requires_staff, false) INTO v_requires_staff FROM services s WHERE s.id = p_service_id;
    END IF;
    IF v_requires_staff THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  v_lock_key := abs(hashtext(p_business_id::text || '|' || p_date::text || '|' || p_time::time::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- ── Capacity check: EXCLUDE table reservations (seating_resource_id IS NOT NULL) ──
  SELECT COUNT(*) INTO v_count FROM bookings
  WHERE business_id = p_business_id AND date = p_date AND time = p_time::time
    AND status IN ('confirmed', 'pending', 'in_progress')
    AND seating_resource_id IS NULL
    AND (p_staff_id IS NULL OR staff_id = p_staff_id);
  IF v_count >= v_effective_max_capacity THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;

  -- ── Buffer check: EXCLUDE table reservations ──
  IF v_effective_buffer > 0 THEN
    SELECT COUNT(*) INTO v_buffer_count FROM bookings
    WHERE business_id = p_business_id AND date = p_date
      AND status IN ('pending', 'confirmed', 'in_progress')
      AND seating_resource_id IS NULL
      AND (p_staff_id IS NULL OR staff_id = p_staff_id)
      AND time != p_time::time
      AND (p_time::time < (time + make_interval(mins => COALESCE(v_effective_duration, 30) + v_effective_buffer))
       AND (p_time::time + make_interval(mins => COALESCE(v_effective_duration, 30))) > (time - make_interval(mins => v_effective_buffer)));
    IF v_buffer_count > 0 THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;

  IF v_service_validated THEN
    v_committed_deposit := v_service.deposit_amount;
    v_committed_total := v_service.price;
  ELSE
    v_committed_deposit := p_deposit_amount;
    v_committed_total := p_total_amount;
  END IF;

  INSERT INTO bookings (business_id, user_id, service_id, appointment_id, staff_id, staff_name, date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status, guest_name, guest_phone, guest_email, special_requests, venue_address, end_date, addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id)
  VALUES (p_business_id, p_user_id, CASE WHEN p_appointment_id IS NOT NULL THEN NULL ELSE p_service_id END, p_appointment_id, p_staff_id, p_staff_name, p_date, p_time::time, p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel, v_committed_deposit, p_deposit_status::deposit_status, p_status::reservation_status, p_guest_name, p_guest_phone, p_guest_email, p_special_requests, p_venue_address, p_end_date, p_addons_snapshot, p_promo_code_id, v_committed_total, p_party_size, p_location_id, p_bot_session_id)
  RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;
  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- Self-check: verify the replacement includes table isolation
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE proname = 'book_slot_atomic'
    AND pronamespace = 'public'::regnamespace;
  IF v_src NOT ILIKE '%seating_resource_id IS NULL%' THEN
    RAISE EXCEPTION '477 SELF-CHECK FAILED: book_slot_atomic missing table-reservation exclusion';
  END IF;
  RAISE NOTICE '477 SELF-CHECK PASSED: book_slot_atomic excludes table reservations from capacity';
END;
$$;
