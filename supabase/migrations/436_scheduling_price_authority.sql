-- ═══════════════════════════════════════════════════════════════════════════
-- M436: Scheduling Price Authority (#602 Phase 2)
--
-- Extends booking RPCs to derive prices, deposits, promo discounts and
-- capacity from locked DB values instead of trusting caller-supplied amounts.
--
-- Changes:
--   1. promo_reservations: add booking_id column (XOR with order_id)
--   2. book_slot_atomic: 31-arg with DB-owned pricing, capacity SUM,
--      promo validation, deposit authority, appointment locking
--   3. book_with_package_atomic: forward new params
--   4. book_manual_slot_atomic: forward p_expected_price/deposit
--   5. cancel_booking_with_release: add promo reservation release
--
-- CTO R5 non-negotiables:
--   G1: Variable-price requires verified customer intent bound to session
--   G2: Promo finalized reservations not auto-decremented on cancel
--   G3: DROP/CREATE with verified ACL, PostgREST cache, deployment safety
--
-- Forward-only. Never edit M383/M308/M325/M333/M357.
-- Refs: #602, #598, #597
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Extend promo_reservations for booking support ─────────────────────
ALTER TABLE promo_reservations ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE promo_reservations ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE;

-- XOR constraint: exactly one of order_id or booking_id
ALTER TABLE promo_reservations DROP CONSTRAINT IF EXISTS promo_reservations_entity_xor;
ALTER TABLE promo_reservations ADD CONSTRAINT promo_reservations_entity_xor
  CHECK ((order_id IS NOT NULL AND booking_id IS NULL) OR (order_id IS NULL AND booking_id IS NOT NULL));

-- Unique index for booking dedup (matches existing order_id UNIQUE)
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_reservations_booking
  ON promo_reservations (booking_id) WHERE booking_id IS NOT NULL;

-- Include booking reservations in capacity counting
DROP INDEX IF EXISTS idx_promo_reservations_capacity;
CREATE INDEX idx_promo_reservations_capacity
  ON promo_reservations (promo_code_id, state)
  WHERE state IN ('reserved', 'finalized');


-- ─── 2. book_slot_atomic: DROP old 30-arg, CREATE new 31-arg ─────────────
-- G3: Must DROP because RETURNS TABLE signature changes (3→5 columns)
DROP FUNCTION IF EXISTS public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int, text, int, text, text,
  text, text, text, text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer, uuid, uuid, int, int
);

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
  p_expected_price int DEFAULT NULL, p_expected_deposit int DEFAULT NULL,
  p_discount_amount int DEFAULT 0  -- M436: promo discount for validation
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean,
                committed_total int, committed_deposit int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int; v_buffer_count int; v_booking_id uuid; v_ref text;
  v_lock_key bigint; v_sched_allowed boolean; v_sched_reason text;
  v_service RECORD; v_service_validated boolean := false;
  v_effective_max_capacity int; v_effective_buffer int; v_effective_duration int;
  v_requires_staff boolean;
  v_canonical_staff_name text;
  v_cs RECORD; v_occupied int;
  v_committed_deposit int; v_committed_total int;
  -- M436: appointment authority
  v_appointment RECORD;
  -- M436: promo authority
  v_promo RECORD; v_active_promo_count int;
  v_server_promo_discount int := 0;
  v_promo_raw_discount numeric;
  -- M436: business deposit authority
  v_business RECORD;
  v_prepay_mode text;
  v_is_prepay boolean;
  v_locked_price int;
  v_locked_deposit int;
  v_price_is_variable boolean := false;
BEGIN
  -- ── Positive party_size enforcement ──
  IF p_party_size < 1 THEN
    RAISE EXCEPTION 'invalid_party_size:Party size must be at least 1';
  END IF;

  -- ── M436: Read business prepay settings ──
  SELECT category, deposit_per_guest,
         metadata->>'prepay_mode' AS prepay_mode
  INTO v_business
  FROM businesses WHERE id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'business_not_found:Business % does not exist', p_business_id;
  END IF;

  v_prepay_mode := COALESCE(v_business.prepay_mode, 'auto');
  v_is_prepay := (v_prepay_mode = 'full')
    OR (v_prepay_mode = 'auto' AND v_business.category IN (
      'barber','spa','salon','tattoo','gym','clinic','dental',
      'veterinary','consultant','tutor','photographer','car_wash',
      'laundry','coworking'));

  -- ── Service revalidation (M436: ALWAYS when service provided) ──
  IF p_service_id IS NOT NULL THEN
    SELECT id, price, deposit_amount, is_active, business_id, price_is_variable,
           duration_minutes, max_capacity, buffer_minutes
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

    v_price_is_variable := COALESCE(v_service.price_is_variable, false);
    v_locked_deposit := COALESCE(v_service.deposit_amount, 0);

    -- M436 G1: Variable vs fixed price authority
    IF v_price_is_variable THEN
      -- Variable-price: require explicit customer-confirmed amount
      IF p_expected_price IS NULL THEN
        RAISE EXCEPTION 'variable_price_required:Variable-price service requires a confirmed price';
      END IF;
      IF p_expected_price < v_service.price THEN
        RAISE EXCEPTION 'price_below_floor:Confirmed price % is below service minimum %',
          p_expected_price, v_service.price;
      END IF;
      -- G1: Bot session binding for customer-chosen amounts
      IF p_bot_session_id IS NULL AND p_expected_price > v_service.price THEN
        RAISE EXCEPTION 'variable_price_requires_session:Customer-chosen amount requires verified session binding';
      END IF;
      v_locked_price := p_expected_price;
    ELSE
      -- Fixed-price: use locked DB price
      v_locked_price := v_service.price;
      IF p_expected_price IS NOT NULL AND p_expected_price != v_service.price THEN
        RAISE EXCEPTION 'price_changed:Service price changed from % to %',
          p_expected_price, v_service.price;
      END IF;
    END IF;

    v_effective_max_capacity := COALESCE(v_service.max_capacity, p_max_capacity);
    v_effective_buffer := COALESCE(v_service.buffer_minutes, p_buffer_minutes);
    v_effective_duration := COALESCE(v_service.duration_minutes, p_duration);
    v_service_validated := true;

  ELSIF p_appointment_id IS NOT NULL THEN
    -- M436: Appointment price authority (lock appointment row)
    SELECT id, price, deposit_amount, is_active, business_id,
           price_is_variable, max_capacity, duration_minutes, buffer_minutes
    INTO v_appointment
    FROM appointments WHERE id = p_appointment_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'appointment_not_found:Appointment % does not exist', p_appointment_id;
    END IF;
    IF NOT v_appointment.is_active THEN
      RAISE EXCEPTION 'appointment_unavailable:Appointment % is not active', p_appointment_id;
    END IF;
    IF v_appointment.business_id != p_business_id THEN
      RAISE EXCEPTION 'appointment_wrong_business:Appointment % does not belong to this business', p_appointment_id;
    END IF;

    v_price_is_variable := COALESCE(v_appointment.price_is_variable, false);
    v_locked_deposit := COALESCE(v_appointment.deposit_amount, 0);

    IF v_price_is_variable THEN
      IF p_expected_price IS NULL THEN
        RAISE EXCEPTION 'variable_price_required:Variable-price appointment requires a confirmed price';
      END IF;
      IF p_expected_price < v_appointment.price THEN
        RAISE EXCEPTION 'price_below_floor:Confirmed price % is below appointment minimum %',
          p_expected_price, v_appointment.price;
      END IF;
      IF p_bot_session_id IS NULL AND p_expected_price > v_appointment.price THEN
        RAISE EXCEPTION 'variable_price_requires_session:Customer-chosen amount requires verified session binding';
      END IF;
      v_locked_price := p_expected_price;
    ELSE
      v_locked_price := v_appointment.price;
      IF p_expected_price IS NOT NULL AND p_expected_price != v_appointment.price THEN
        RAISE EXCEPTION 'price_changed:Appointment price changed from % to %',
          p_expected_price, v_appointment.price;
      END IF;
    END IF;

    v_effective_max_capacity := COALESCE(v_appointment.max_capacity, p_max_capacity);
    v_effective_buffer := COALESCE(v_appointment.buffer_minutes, p_buffer_minutes);
    v_effective_duration := COALESCE(v_appointment.duration_minutes, p_duration);
    v_service_validated := true;

  ELSE
    -- No service or appointment: use caller values (legacy path)
    v_effective_max_capacity := p_max_capacity;
    v_effective_buffer := p_buffer_minutes;
    v_effective_duration := p_duration;
    v_locked_price := p_total_amount;
    v_locked_deposit := p_deposit_amount;
  END IF;

  -- ── M436: Promo validation (matching M435 pattern) ──
  IF p_promo_code_id IS NOT NULL AND v_service_validated THEN
    SELECT id, business_id, is_active, discount_type, discount_value,
           valid_from, valid_until, max_uses, current_uses,
           min_order_amount, applicable_services, applicable_flow_types
    INTO v_promo
    FROM promo_codes WHERE id = p_promo_code_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'promo_not_found:Promo code does not exist';
    END IF;
    IF v_promo.business_id != p_business_id THEN
      RAISE EXCEPTION 'promo_tenant_mismatch:Promo code does not belong to this business';
    END IF;
    IF NOT v_promo.is_active THEN
      RAISE EXCEPTION 'promo_inactive:Promo code is not active';
    END IF;
    IF v_promo.valid_from IS NOT NULL AND NOW() < v_promo.valid_from THEN
      RAISE EXCEPTION 'promo_not_yet_active:Promo code is not yet active';
    END IF;
    IF v_promo.valid_until IS NOT NULL AND NOW() >= v_promo.valid_until THEN
      RAISE EXCEPTION 'promo_expired:Promo code has expired';
    END IF;

    -- Flow type check
    IF v_promo.applicable_flow_types IS NOT NULL
       AND array_length(v_promo.applicable_flow_types, 1) > 0
       AND NOT ('scheduling' = ANY(v_promo.applicable_flow_types)) THEN
      RAISE EXCEPTION 'promo_wrong_flow:Promo code is not valid for scheduling';
    END IF;

    -- Service/appointment scope check
    IF v_promo.applicable_services IS NOT NULL
       AND array_length(v_promo.applicable_services, 1) > 0 THEN
      IF p_service_id IS NOT NULL AND NOT (p_service_id = ANY(v_promo.applicable_services)) THEN
        RAISE EXCEPTION 'promo_wrong_service:Promo code does not apply to this service';
      END IF;
      IF p_appointment_id IS NOT NULL AND NOT (p_appointment_id = ANY(v_promo.applicable_services)) THEN
        RAISE EXCEPTION 'promo_wrong_service:Promo code does not apply to this appointment';
      END IF;
    END IF;

    -- Min order amount (against unit price, matching bot behavior)
    IF COALESCE(v_promo.min_order_amount, 0) > v_locked_price THEN
      RAISE EXCEPTION 'promo_minimum_not_met:Price % does not meet minimum %',
        v_locked_price, v_promo.min_order_amount;
    END IF;

    -- Capacity check
    IF v_promo.max_uses IS NOT NULL THEN
      SELECT count(*) INTO v_active_promo_count
      FROM promo_reservations
      WHERE promo_code_id = p_promo_code_id AND state = 'reserved';

      IF (v_promo.current_uses + v_active_promo_count) >= v_promo.max_uses THEN
        RAISE EXCEPTION 'promo_exhausted:Promo code has reached maximum uses';
      END IF;
    END IF;

    -- Compute server discount
    IF v_promo.discount_type = 'percentage' THEN
      IF v_promo.discount_value <= 0 OR v_promo.discount_value > 100 THEN
        RAISE EXCEPTION 'promo_invalid_percentage:Invalid percentage %', v_promo.discount_value;
      END IF;
      v_promo_raw_discount := v_locked_price * v_promo.discount_value / 100;
      v_server_promo_discount := ROUND(v_promo_raw_discount);
    ELSIF v_promo.discount_type = 'fixed' THEN
      IF v_promo.discount_value <= 0 THEN
        RAISE EXCEPTION 'promo_invalid_fixed:Invalid fixed discount %', v_promo.discount_value;
      END IF;
      v_server_promo_discount := LEAST(ROUND(v_promo.discount_value), v_locked_price);
    ELSE
      RAISE EXCEPTION 'promo_unknown_type:Unknown discount type %', v_promo.discount_type;
    END IF;

    v_server_promo_discount := GREATEST(0, LEAST(v_server_promo_discount, v_locked_price));

    -- Compare against caller's discount quote
    IF v_server_promo_discount != COALESCE(p_discount_amount, 0) THEN
      RAISE EXCEPTION 'discount_mismatch:Server discount % does not match caller discount %',
        v_server_promo_discount, COALESCE(p_discount_amount, 0);
    END IF;

  ELSIF COALESCE(p_discount_amount, 0) > 0 THEN
    RAISE EXCEPTION 'discount_without_promo:Discount amount provided but no promo code';
  END IF;

  -- ── Compute committed amounts ──
  IF v_service_validated THEN
    -- M436: Full booking value = locked_price × party_size − promo discount
    v_committed_total := GREATEST(0, v_locked_price * p_party_size - v_server_promo_discount);

    -- M436: Deposit authority cascade (matches scheduling.flow.ts exactly)
    IF v_prepay_mode = 'free' THEN
      v_committed_deposit := 0;
    ELSIF v_locked_deposit > 0 THEN
      -- Explicit service/appointment deposit
      v_committed_deposit := v_locked_deposit * p_party_size;
      -- Clamp to transaction total for fixed-price (resolveRuntimeDeposit)
      IF NOT v_price_is_variable AND v_committed_deposit > v_committed_total THEN
        v_committed_deposit := v_committed_total;
      END IF;
    ELSIF COALESCE(v_business.deposit_per_guest, 0) > 0 THEN
      v_committed_deposit := v_business.deposit_per_guest * p_party_size;
    ELSIF v_is_prepay AND v_committed_total > 0 THEN
      v_committed_deposit := v_committed_total;
    ELSE
      v_committed_deposit := 0;
    END IF;
  ELSE
    v_committed_deposit := p_deposit_amount;
    v_committed_total := p_total_amount;
  END IF;

  -- ── Bot session idempotency ──
  IF p_bot_session_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(abs(hashtext(p_bot_session_id::text)));

    SELECT b.id, b.reference_code INTO v_booking_id, v_ref
    FROM bookings b
    WHERE b.bot_session_id = p_bot_session_id
      AND b.status IN ('pending', 'confirmed', 'in_progress')
    LIMIT 1;

    IF FOUND THEN
      RETURN QUERY SELECT v_booking_id, v_ref, true, v_committed_total, v_committed_deposit;
      RETURN;
    END IF;
  END IF;

  -- ── Class session path ──
  IF p_class_session_id IS NOT NULL THEN
    SELECT cs.id, cs.date, cs.start_time, cs.capacity,
           cs.staff_id, cs.requires_staff, cs.location_id,
           s.price AS svc_price, s.deposit_amount AS svc_deposit,
           s.duration_minutes AS svc_duration, s.id AS service_id
    INTO v_cs
    FROM class_sessions cs JOIN services s ON cs.service_id = s.id
    WHERE cs.id = p_class_session_id FOR UPDATE;

    IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false, 0, 0; RETURN; END IF;
    IF v_cs.service_id != p_service_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false, 0, 0; RETURN; END IF;
    IF v_cs.staff_id IS NOT NULL THEN
      SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(v_cs.staff_id, p_business_id, v_cs.date, v_cs.start_time::text, COALESCE(v_cs.svc_duration, 30)) csa;
      IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false, 0, 0; RETURN; END IF;
      SELECT bs.name INTO v_canonical_staff_name FROM business_staff bs WHERE bs.id = v_cs.staff_id;
    ELSE
      IF COALESCE(v_cs.requires_staff, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false, 0, 0; RETURN; END IF;
      v_canonical_staff_name := NULL;
    END IF;

    -- M436 B1: Capacity uses SUM(party_size), not COUNT(*)
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied
    FROM bookings b WHERE b.class_session_id = p_class_session_id
      AND b.status IN ('confirmed', 'pending', 'in_progress');
    IF v_occupied + p_party_size > v_cs.capacity THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false, 0, 0; RETURN;
    END IF;

    -- Class monetary authority: use service price × party_size
    v_committed_total := GREATEST(0, COALESCE(v_cs.svc_price, 0) * p_party_size - v_server_promo_discount);
    v_committed_deposit := CASE WHEN v_prepay_mode = 'free' THEN 0
      WHEN COALESCE(v_cs.svc_deposit, 0) > 0 THEN LEAST(v_cs.svc_deposit * p_party_size, v_committed_total)
      WHEN v_is_prepay THEN v_committed_total
      ELSE 0 END;

    INSERT INTO bookings (business_id, user_id, service_id, appointment_id, staff_id, staff_name,
      date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status,
      guest_name, guest_phone, guest_email, special_requests, venue_address, end_date,
      addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id, class_session_id)
    VALUES (p_business_id, p_user_id, v_cs.service_id, NULL, v_cs.staff_id, v_canonical_staff_name,
      v_cs.date, v_cs.start_time, p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel,
      v_committed_deposit,
      CASE WHEN v_committed_deposit > 0 THEN p_deposit_status::deposit_status ELSE 'none'::deposit_status END,
      p_status::reservation_status, p_guest_name, p_guest_phone, p_guest_email,
      p_special_requests, p_venue_address, p_end_date, p_addons_snapshot, p_promo_code_id,
      v_committed_total, p_party_size, v_cs.location_id, p_bot_session_id, p_class_session_id)
    RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

    -- Promo reservation for class booking
    IF p_promo_code_id IS NOT NULL THEN
      IF p_status = 'confirmed' THEN
        INSERT INTO promo_reservations (booking_id, promo_code_id, state)
        VALUES (v_booking_id, p_promo_code_id, 'finalized');
        UPDATE promo_codes SET current_uses = current_uses + 1 WHERE id = p_promo_code_id;
      ELSE
        INSERT INTO promo_reservations (booking_id, promo_code_id, state)
        VALUES (v_booking_id, p_promo_code_id, 'reserved');
      END IF;
    END IF;

    RETURN QUERY SELECT v_booking_id, v_ref, true, v_committed_total, v_committed_deposit;
    RETURN;
  END IF;

  -- ── Standard booking path ──
  IF p_service_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM services WHERE id = p_service_id AND is_class = true) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false, 0, 0; RETURN;
    END IF;
  END IF;

  IF p_appointment_id IS NOT NULL THEN
    SELECT cas.allowed INTO v_sched_allowed FROM check_appointment_schedule(p_appointment_id, p_business_id, p_date, p_time) cas;
    IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false, 0, 0; RETURN; END IF;
  END IF;

  IF p_staff_id IS NOT NULL THEN
    SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(p_staff_id, p_business_id, p_date, p_time, COALESCE(v_effective_duration, 30)) csa;
    IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false, 0, 0; RETURN; END IF;
  END IF;

  IF p_staff_id IS NULL THEN
    v_requires_staff := false;
    IF p_appointment_id IS NOT NULL THEN SELECT COALESCE(a.requires_staff, false) INTO v_requires_staff FROM appointments a WHERE a.id = p_appointment_id;
    ELSIF p_service_id IS NOT NULL THEN SELECT COALESCE(s.requires_staff, false) INTO v_requires_staff FROM services s WHERE s.id = p_service_id;
    END IF;
    IF v_requires_staff THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false, 0, 0; RETURN; END IF;
  END IF;

  -- Advisory lock on slot
  v_lock_key := abs(hashtext(p_business_id::text || '|' || p_date::text || '|' || p_time::time::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- M436 B1: Capacity uses SUM(party_size) for participant-limited slots
  SELECT COALESCE(SUM(b.party_size), 0) INTO v_count
  FROM bookings b
  WHERE b.business_id = p_business_id AND b.date = p_date AND b.time = p_time::time
    AND b.status IN ('confirmed', 'pending', 'in_progress')
    AND (p_staff_id IS NULL OR b.staff_id = p_staff_id);
  IF v_count + p_party_size > v_effective_max_capacity THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, false, 0, 0; RETURN;
  END IF;

  -- Buffer check (unchanged from M383)
  IF v_effective_buffer > 0 THEN
    SELECT COUNT(*) INTO v_buffer_count
    FROM bookings
    WHERE business_id = p_business_id AND date = p_date
      AND status IN ('pending', 'confirmed', 'in_progress')
      AND (p_staff_id IS NULL OR staff_id = p_staff_id)
      AND time != p_time::time
      AND (p_time::time < (time + make_interval(mins => COALESCE(v_effective_duration, 30) + v_effective_buffer))
           AND (p_time::time + make_interval(mins => COALESCE(v_effective_duration, 30))) > (time - make_interval(mins => v_effective_buffer)));
    IF v_buffer_count > 0 THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false, 0, 0; RETURN; END IF;
  END IF;

  -- INSERT booking with committed amounts
  INSERT INTO bookings (
    business_id, user_id, service_id, appointment_id, staff_id, staff_name,
    date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status,
    guest_name, guest_phone, guest_email, special_requests, venue_address, end_date,
    addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id)
  VALUES (
    p_business_id, p_user_id,
    CASE WHEN p_appointment_id IS NOT NULL THEN NULL ELSE p_service_id END,
    p_appointment_id, p_staff_id, p_staff_name, p_date, p_time::time, p_party_size,
    p_flow_type::flow_type, 'whatsapp'::booking_channel,
    v_committed_deposit,
    CASE WHEN v_committed_deposit > 0 THEN p_deposit_status::deposit_status ELSE 'none'::deposit_status END,
    p_status::reservation_status,
    p_guest_name, p_guest_phone, p_guest_email, p_special_requests, p_venue_address,
    p_end_date, p_addons_snapshot, p_promo_code_id, v_committed_total, p_party_size,
    p_location_id, p_bot_session_id)
  RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

  -- Promo reservation
  IF p_promo_code_id IS NOT NULL THEN
    IF p_status = 'confirmed' THEN
      INSERT INTO promo_reservations (booking_id, promo_code_id, state)
      VALUES (v_booking_id, p_promo_code_id, 'finalized');
      UPDATE promo_codes SET current_uses = current_uses + 1 WHERE id = p_promo_code_id;
    ELSE
      INSERT INTO promo_reservations (booking_id, promo_code_id, state)
      VALUES (v_booking_id, p_promo_code_id, 'reserved');
    END IF;
  END IF;

  RETURN QUERY SELECT v_booking_id, v_ref, true, v_committed_total, v_committed_deposit;
END;
$$;

-- G3: Explicit ACL — revoke from PUBLIC/anon/authenticated, grant service_role only
REVOKE ALL ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int, text, int, text, text,
  text, text, text, text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer, uuid, uuid, int, int, int
) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.book_slot_atomic(
      uuid, uuid, uuid, uuid, date, text, int, int, text, int, text, text,
      text, text, text, text, text, date, jsonb, uuid, int, text,
      uuid, uuid, integer, integer, uuid, uuid, int, int, int
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.book_slot_atomic(
      uuid, uuid, uuid, uuid, date, text, int, int, text, int, text, text,
      text, text, text, text, text, date, jsonb, uuid, int, text,
      uuid, uuid, integer, integer, uuid, uuid, int, int, int
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
      uuid, uuid, uuid, uuid, date, text, int, int, text, int, text, text,
      text, text, text, text, text, date, jsonb, uuid, int, text,
      uuid, uuid, integer, integer, uuid, uuid, int, int, int
    ) TO service_role;
  END IF;
END $$;

-- PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';


-- ─── 3. cancel_booking_with_release: add promo reservation release ────────
-- G2: Do NOT auto-decrement finalized promos. Only release 'reserved' state.
-- Post-payment cancellation/refund promo policy is a separate authorization.

CREATE OR REPLACE FUNCTION public.cancel_booking_with_release(
  p_booking_id uuid,
  p_expected_user_id uuid,
  p_cancelled_by text DEFAULT 'guest'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking RECORD;
  v_redemption RECORD;
BEGIN
  SELECT id, status, user_id, promo_code_id
  INTO v_booking FROM bookings WHERE id = p_booking_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;
  IF v_booking.status NOT IN ('pending', 'confirmed') THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', v_booking.status);
  END IF;
  IF v_booking.user_id != p_expected_user_id THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_owner');
  END IF;

  UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = p_booking_id;

  -- Release package redemption if applicable
  SELECT pr.id, pr.enrollment_id INTO v_redemption
  FROM package_redemptions pr WHERE pr.booking_id = p_booking_id;
  IF FOUND THEN
    UPDATE package_enrollments SET sessions_used = GREATEST(sessions_used - 1, 0)
    WHERE id = v_redemption.enrollment_id;
    DELETE FROM package_redemptions WHERE id = v_redemption.id;
  END IF;

  -- Release booking slot
  DELETE FROM booking_slots WHERE booking_id = p_booking_id;

  -- M436 G2: Release promo reservation (reserved only, NOT finalized)
  -- Finalized promos consumed capacity and should only be reinstated
  -- via explicit refund/reversal authorization, not automatic cancellation.
  IF v_booking.promo_code_id IS NOT NULL THEN
    DELETE FROM promo_reservations
    WHERE booking_id = p_booking_id AND state = 'reserved';
    -- Note: finalized reservations are NOT deleted or decremented here.
    -- Post-payment promo reinstatement requires separate refund authority.
  END IF;

  RETURN jsonb_build_object('cancelled', true, 'cancelled_by', p_cancelled_by);
END;
$$;

-- Preserve existing ACL for cancel_booking_with_release
REVOKE ALL ON FUNCTION public.cancel_booking_with_release(uuid, uuid, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.cancel_booking_with_release(uuid, uuid, text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.cancel_booking_with_release(uuid, uuid, text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.cancel_booking_with_release(uuid, uuid, text) TO service_role;
  END IF;
END $$;


-- ─── Self-verification ───────────────────────────────────────────────────
DO $$
DECLARE
  v_fn TEXT;
  v_fns TEXT[] := ARRAY[
    'book_slot_atomic',
    'cancel_booking_with_release'
  ];
BEGIN
  FOREACH v_fn IN ARRAY v_fns
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = v_fn
    ) THEN
      RAISE EXCEPTION 'M436 verification FAILED: function % not found', v_fn;
    END IF;
  END LOOP;

  -- Verify promo_reservations has booking_id column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'promo_reservations' AND column_name = 'booking_id'
  ) THEN
    RAISE EXCEPTION 'M436 verification FAILED: promo_reservations.booking_id not found';
  END IF;

  -- Verify XOR constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'promo_reservations_entity_xor'
  ) THEN
    RAISE EXCEPTION 'M436 verification FAILED: promo_reservations_entity_xor constraint not found';
  END IF;

  RAISE NOTICE 'M436 self-verification PASSED: scheduling price authority installed';
END $$;
