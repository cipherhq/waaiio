-- ═══════════════════════════════════════════════════════
-- 321: Class session booking authority
--
-- P1-CLASS-1: Dedicated class session lifecycle + canonical booking authority.
--
-- Architecture:
--   services (is_class=true) = class definition
--   class_recurrence_rules = recurring schedule
--   class_sessions = concrete occurrences
--   bookings.class_session_id = session identity
--   book_slot_atomic(p_class_session_id) = canonical authority
--
-- No second booking engine. No class_definitions table.
-- ═══════════════════════════════════════════════════════


-- 1. Class recurrence rules
CREATE TABLE IF NOT EXISTS class_recurrence_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  weekday TEXT NOT NULL CHECK (weekday IN ('mon','tue','wed','thu','fri','sat','sun')),
  start_time TIME NOT NULL,
  staff_id UUID REFERENCES business_staff(id) ON DELETE SET NULL,
  location_id UUID REFERENCES business_locations(id) ON DELETE SET NULL,
  capacity_override INTEGER,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_until DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recurrence_rules_business ON class_recurrence_rules(business_id);
CREATE INDEX idx_recurrence_rules_service ON class_recurrence_rules(service_id);
CREATE INDEX idx_recurrence_rules_active ON class_recurrence_rules(business_id, is_active) WHERE is_active = true;

ALTER TABLE class_recurrence_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY crr_owner_select ON class_recurrence_rules FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY crr_owner_insert ON class_recurrence_rules FOR INSERT
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY crr_owner_update ON class_recurrence_rules FOR UPDATE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY crr_owner_delete ON class_recurrence_rules FOR DELETE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY crr_service_all ON class_recurrence_rules FOR ALL TO service_role
  USING (true) WITH CHECK (true);


-- 2. Class sessions (concrete occurrences)
CREATE TABLE IF NOT EXISTS class_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  recurrence_rule_id UUID REFERENCES class_recurrence_rules(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  staff_id UUID REFERENCES business_staff(id) ON DELETE SET NULL,
  location_id UUID REFERENCES business_locations(id) ON DELETE SET NULL,
  capacity INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Idempotency: prevent duplicate generated sessions
  UNIQUE(recurrence_rule_id, date, start_time)
);

CREATE INDEX idx_class_sessions_business ON class_sessions(business_id, date);
CREATE INDEX idx_class_sessions_service ON class_sessions(service_id, date);
CREATE INDEX idx_class_sessions_upcoming ON class_sessions(business_id, date, status) WHERE status = 'scheduled';
CREATE INDEX idx_class_sessions_staff ON class_sessions(staff_id, date) WHERE staff_id IS NOT NULL;

ALTER TABLE class_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY cs_owner_select ON class_sessions FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY cs_owner_insert ON class_sessions FOR INSERT
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY cs_owner_update ON class_sessions FOR UPDATE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY cs_owner_delete ON class_sessions FOR DELETE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY cs_service_all ON class_sessions FOR ALL TO service_role
  USING (true) WITH CHECK (true);


-- 3. bookings.class_session_id FK
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS class_session_id UUID REFERENCES class_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_class_session ON bookings(class_session_id) WHERE class_session_id IS NOT NULL;


-- 4. Session generation function — deterministic, idempotent
--    Generates sessions for a service's active recurrence rules over a bounded window.
--    Uses INSERT ... ON CONFLICT DO NOTHING for idempotency.
CREATE OR REPLACE FUNCTION generate_class_sessions(
  p_service_id UUID,
  p_days_ahead INTEGER DEFAULT 28
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rule RECORD;
  v_date DATE;
  v_end_date DATE;
  v_dow INTEGER;
  v_target_dow INTEGER;
  v_svc RECORD;
  v_capacity INTEGER;
  v_end_time TIME;
  v_generated INTEGER := 0;
BEGIN
  -- Validate service exists and is a class
  SELECT id, business_id, duration_minutes, max_capacity, is_class
  INTO v_svc FROM services WHERE id = p_service_id;

  IF NOT FOUND OR NOT COALESCE(v_svc.is_class, false) THEN
    RETURN 0;
  END IF;

  v_end_date := CURRENT_DATE + p_days_ahead;

  -- Process each active recurrence rule for this service
  FOR v_rule IN
    SELECT * FROM class_recurrence_rules
    WHERE service_id = p_service_id
      AND is_active = true
      AND effective_from <= v_end_date
      AND (effective_until IS NULL OR effective_until >= CURRENT_DATE)
    ORDER BY weekday, start_time
  LOOP
    -- Map weekday to DOW (0=Sun, 1=Mon, ..., 6=Sat)
    v_target_dow := CASE v_rule.weekday
      WHEN 'sun' THEN 0
      WHEN 'mon' THEN 1
      WHEN 'tue' THEN 2
      WHEN 'wed' THEN 3
      WHEN 'thu' THEN 4
      WHEN 'fri' THEN 5
      WHEN 'sat' THEN 6
    END;

    -- Resolve capacity: rule override > service default
    v_capacity := COALESCE(v_rule.capacity_override, v_svc.max_capacity, 10);

    -- Calculate end_time from service duration
    v_end_time := v_rule.start_time + make_interval(mins => COALESCE(v_svc.duration_minutes, 60));

    -- Find first matching date >= max(effective_from, today)
    v_date := GREATEST(v_rule.effective_from, CURRENT_DATE);
    -- Advance to next occurrence of target weekday
    v_dow := EXTRACT(DOW FROM v_date)::INTEGER;
    IF v_dow != v_target_dow THEN
      v_date := v_date + ((v_target_dow - v_dow + 7) % 7);
    END IF;

    -- Generate sessions week by week
    WHILE v_date <= v_end_date AND (v_rule.effective_until IS NULL OR v_date <= v_rule.effective_until) LOOP
      INSERT INTO class_sessions (
        business_id, service_id, recurrence_rule_id,
        date, start_time, end_time,
        staff_id, location_id, capacity, status
      ) VALUES (
        v_svc.business_id, p_service_id, v_rule.id,
        v_date, v_rule.start_time, v_end_time,
        v_rule.staff_id, v_rule.location_id, v_capacity, 'scheduled'
      ) ON CONFLICT (recurrence_rule_id, date, start_time) DO NOTHING;

      IF FOUND THEN
        v_generated := v_generated + 1;
      END IF;

      v_date := v_date + 7; -- next week
    END LOOP;
  END LOOP;

  RETURN v_generated;
END;
$$;

REVOKE EXECUTE ON FUNCTION generate_class_sessions(UUID, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION generate_class_sessions(UUID, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION generate_class_sessions(UUID, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION generate_class_sessions(UUID, INTEGER) TO service_role;


-- 5. Public session discovery RPC — least-privilege read surface
CREATE OR REPLACE FUNCTION get_upcoming_class_sessions(
  p_service_id UUID,
  p_limit INTEGER DEFAULT 10
) RETURNS TABLE(
  session_id UUID,
  session_date DATE,
  start_time TIME,
  end_time TIME,
  capacity INTEGER,
  spots_taken BIGINT,
  staff_name TEXT,
  location_name TEXT,
  status TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    cs.id AS session_id,
    cs.date AS session_date,
    cs.start_time,
    cs.end_time,
    cs.capacity,
    COALESCE(
      (SELECT SUM(b.party_size) FROM bookings b
       WHERE b.class_session_id = cs.id
         AND b.status IN ('confirmed', 'pending', 'in_progress')),
      0
    ) AS spots_taken,
    bs.name AS staff_name,
    bl.name AS location_name,
    cs.status
  FROM class_sessions cs
  LEFT JOIN business_staff bs ON bs.id = cs.staff_id
  LEFT JOIN business_locations bl ON bl.id = cs.location_id
  WHERE cs.service_id = p_service_id
    AND cs.status = 'scheduled'
    AND cs.date >= CURRENT_DATE
  ORDER BY cs.date, cs.start_time
  LIMIT p_limit;
$$;

REVOKE EXECUTE ON FUNCTION get_upcoming_class_sessions(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_upcoming_class_sessions(UUID, INTEGER) TO anon;
GRANT EXECUTE ON FUNCTION get_upcoming_class_sessions(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION get_upcoming_class_sessions(UUID, INTEGER) TO service_role;


-- 6. Drop old 27-arg book_slot_atomic to avoid overload ambiguity with new 28-arg version
DROP FUNCTION IF EXISTS public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer, uuid
);

-- Extend book_slot_atomic with p_class_session_id
--    When supplied: validates session, uses session capacity (SUM party_size),
--    locks by session ID, writes bookings.class_session_id.
--    When NULL: ALL existing behavior preserved unchanged.
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
  p_bot_session_id uuid DEFAULT NULL,
  p_class_session_id uuid DEFAULT NULL
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int; v_buffer_count int; v_booking_id uuid; v_ref text;
  v_lock_key bigint;
  v_sched_allowed boolean;
  v_sched_reason text;
  v_requires_staff boolean;
  v_cs record;
  v_occupied bigint;
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

  -- 3. Staff availability validation (preserved from migration 319)
  IF p_staff_id IS NOT NULL THEN
    SELECT csa.allowed, csa.reason
    INTO v_sched_allowed, v_sched_reason
    FROM check_staff_availability(p_staff_id, p_business_id, p_date, p_time, COALESCE(p_duration, 30)) csa;

    IF v_sched_allowed IS NOT TRUE THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;
  END IF;

  -- 4. requires_staff enforcement (preserved from migration 319)
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

  -- ═══════════════════════════════════════════════════════
  -- 5. CLASS SESSION BOOKING PATH (P1-CLASS-1)
  -- ═══════════════════════════════════════════════════════
  IF p_class_session_id IS NOT NULL THEN
    -- 5a. Validate session exists and is bookable
    SELECT id, business_id, service_id, date, start_time, capacity, status, staff_id
    INTO v_cs FROM class_sessions WHERE id = p_class_session_id;

    IF NOT FOUND THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    IF v_cs.business_id != p_business_id THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- Validate service identity
    IF p_service_id IS NOT NULL AND v_cs.service_id != p_service_id THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- Validate service is actually a class
    IF NOT EXISTS (SELECT 1 FROM services WHERE id = v_cs.service_id AND is_class = true) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- Validate session is scheduled (not cancelled/completed)
    IF v_cs.status != 'scheduled' THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- 5b. Advisory lock on CLASS SESSION (not business+date+time)
    v_lock_key := abs(hashtext('class_session:' || p_class_session_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- 5c. Capacity check using SUM(party_size) — seats, not rows
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied
    FROM bookings b
    WHERE b.class_session_id = p_class_session_id
      AND b.status IN ('confirmed', 'pending', 'in_progress');

    IF v_occupied + p_party_size > v_cs.capacity THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- 5d. Insert class booking
    INSERT INTO bookings (
      business_id, user_id, service_id, appointment_id, staff_id, staff_name,
      date, time, party_size, flow_type, channel,
      deposit_amount, deposit_status, status,
      guest_name, guest_phone, guest_email,
      special_requests, venue_address, end_date,
      addons_snapshot, promo_code_id, total_amount, quantity,
      location_id, bot_session_id, class_session_id
    ) VALUES (
      p_business_id, p_user_id, v_cs.service_id, NULL,
      COALESCE(p_staff_id, v_cs.staff_id), p_staff_name,
      v_cs.date, v_cs.start_time, p_party_size,
      p_flow_type::flow_type,
      'whatsapp'::booking_channel,
      p_deposit_amount,
      p_deposit_status::deposit_status,
      p_status::reservation_status,
      p_guest_name, p_guest_phone, p_guest_email,
      p_special_requests, p_venue_address, p_end_date,
      p_addons_snapshot, p_promo_code_id, p_total_amount, p_party_size,
      COALESCE(p_location_id, v_cs.location_id), p_bot_session_id, p_class_session_id
    )
    RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

    RETURN QUERY SELECT v_booking_id, v_ref, true;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════
  -- NORMAL BOOKING PATH (unchanged from migration 319)
  -- ═══════════════════════════════════════════════════════

  -- 6. Advisory lock on logical slot
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

  -- Insert the booking (normal path — no class_session_id)
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

-- Re-apply permissions (28-arg signature — added p_class_session_id)
REVOKE ALL ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer, uuid, uuid
) TO service_role;


-- 7. Drop old 17-arg book_manual_slot_atomic and create 18-arg version
DROP FUNCTION IF EXISTS book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid);

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
  p_appointment_id uuid DEFAULT NULL,
  p_class_session_id uuid DEFAULT NULL
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking_id uuid;
  v_ref text;
  v_available boolean;
  v_updated_rows int;
BEGIN
  -- 1. Delegate to canonical book_slot_atomic
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
    NULL,          -- p_special_requests
    NULL,          -- p_venue_address
    NULL,          -- p_end_date
    NULL,          -- p_addons_snapshot
    NULL,          -- p_promo_code_id
    p_total_amount,
    p_staff_name,
    NULL,          -- p_location_id
    p_appointment_id,
    p_buffer_minutes,
    p_duration,
    NULL,          -- p_bot_session_id
    p_class_session_id
  ) bsa;

  IF v_available IS NOT TRUE THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, false;
    RETURN;
  END IF;

  IF v_booking_id IS NULL THEN
    RAISE EXCEPTION 'book_manual_slot_atomic: book_slot_atomic returned slot_available=true but booking_id is NULL'
      USING ERRCODE = 'data_exception';
  END IF;

  -- 2. Apply manual-dashboard-specific fields
  UPDATE bookings
  SET channel = 'dashboard'::booking_channel,
      confirmed_at = NOW(),
      notes = p_notes
  WHERE id = v_booking_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION 'book_manual_slot_atomic: expected 1 row updated, got %', v_updated_rows
      USING ERRCODE = 'data_exception';
  END IF;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- Restrict execution to service_role (18-arg signature)
REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid,uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid,uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid,uuid) TO service_role;


-- 8. Drop old 5-arg reschedule_booking_atomic to avoid overload ambiguity
DROP FUNCTION IF EXISTS reschedule_booking_atomic(uuid, uuid, date, text, integer);

-- Extend reschedule for class bookings
--    Class bookings require a target class_session_id for reschedule.
CREATE OR REPLACE FUNCTION reschedule_booking_atomic(
  p_booking_id uuid,
  p_business_id uuid,
  p_new_date date,
  p_new_time text,
  p_new_party_size integer DEFAULT NULL,
  p_target_class_session_id uuid DEFAULT NULL
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
  v_target_cs record;
  v_occupied bigint;
  v_party integer;
BEGIN
  -- 1. Load and validate booking
  SELECT id, business_id, service_id, appointment_id, staff_id, date, time,
         party_size, status, location_id, class_session_id
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

  v_party := COALESCE(p_new_party_size, v_booking.party_size);

  -- ═══════════════════════════════════════════════════════
  -- CLASS BOOKING RESCHEDULE PATH
  -- ═══════════════════════════════════════════════════════
  IF v_booking.class_session_id IS NOT NULL THEN
    -- Class booking MUST provide a target session
    IF p_target_class_session_id IS NULL THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_required');
    END IF;

    -- Idempotent: already at target
    IF v_booking.class_session_id = p_target_class_session_id THEN
      RETURN jsonb_build_object('rescheduled', true, 'already_at_target', true);
    END IF;

    -- Validate target session
    SELECT id, business_id, service_id, date, start_time, end_time, capacity, status, staff_id
    INTO v_target_cs FROM class_sessions WHERE id = p_target_class_session_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_not_found');
    END IF;
    IF v_target_cs.business_id != p_business_id THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_business_mismatch');
    END IF;
    IF v_target_cs.status != 'scheduled' THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_not_bookable');
    END IF;

    -- Lock target session
    v_lock_key := abs(hashtext('class_session:' || p_target_class_session_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Capacity check at target (excluding this booking)
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied
    FROM bookings b
    WHERE b.class_session_id = p_target_class_session_id
      AND b.status IN ('confirmed', 'pending', 'in_progress')
      AND b.id != p_booking_id;

    IF v_occupied + v_party > v_target_cs.capacity THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_full');
    END IF;

    -- Staff availability at target session
    IF v_target_cs.staff_id IS NOT NULL THEN
      SELECT csa.allowed, csa.reason
      INTO v_sched_allowed, v_sched_reason
      FROM check_staff_availability(
        v_target_cs.staff_id, p_business_id,
        v_target_cs.date, v_target_cs.start_time::text,
        EXTRACT(EPOCH FROM (v_target_cs.end_time - v_target_cs.start_time))::integer / 60
      ) csa;

      IF v_sched_allowed IS NOT TRUE THEN
        RETURN jsonb_build_object('rescheduled', false, 'reason', COALESCE(v_sched_reason, 'staff_unavailable'));
      END IF;
    END IF;

    -- Move booking to target session
    UPDATE bookings
    SET class_session_id = p_target_class_session_id,
        date = v_target_cs.date,
        time = v_target_cs.start_time,
        party_size = v_party,
        staff_id = COALESCE(v_target_cs.staff_id, v_booking.staff_id),
        location_id = COALESCE(v_target_cs.location_id, v_booking.location_id),
        original_date = CASE WHEN original_date IS NULL THEN v_booking.date ELSE original_date END,
        original_time = CASE WHEN original_time IS NULL THEN v_booking.time::text ELSE original_time END,
        rescheduled_at = NOW()
    WHERE id = p_booking_id;

    RETURN jsonb_build_object(
      'rescheduled', true,
      'old_session_id', v_booking.class_session_id,
      'new_session_id', p_target_class_session_id,
      'old_date', v_booking.date,
      'new_date', v_target_cs.date
    );
  END IF;

  -- ═══════════════════════════════════════════════════════
  -- NORMAL BOOKING RESCHEDULE PATH (preserved from migration 319)
  -- ═══════════════════════════════════════════════════════

  -- 2. Resolve capacity and buffer from service or appointment
  IF v_booking.service_id IS NOT NULL THEN
    SELECT COALESCE(max_capacity, 1), COALESCE(buffer_minutes, 0), COALESCE(duration_minutes, 30)
    INTO v_max_capacity, v_buffer_minutes, v_duration
    FROM services WHERE id = v_booking.service_id;
  ELSIF v_booking.appointment_id IS NOT NULL THEN
    SELECT COALESCE(max_capacity, 1), COALESCE(buffer_minutes, 0), COALESCE(duration_minutes, 30)
    INTO v_max_capacity, v_buffer_minutes, v_duration
    FROM appointments WHERE id = v_booking.appointment_id;

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

  -- Staff availability (preserved from migration 319)
  IF v_booking.staff_id IS NOT NULL THEN
    SELECT csa.allowed, csa.reason
    INTO v_sched_allowed, v_sched_reason
    FROM check_staff_availability(v_booking.staff_id, p_business_id, p_new_date, p_new_time, v_duration) csa;

    IF v_sched_allowed IS NOT TRUE THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', COALESCE(v_sched_reason, 'staff_unavailable'));
    END IF;
  ELSE
    -- Legacy null-staff for requires_staff (preserved from migration 319)
    DECLARE v_req_staff boolean := false;
    BEGIN
      IF v_booking.service_id IS NOT NULL THEN
        SELECT COALESCE(s.requires_staff, false) INTO v_req_staff
        FROM services s WHERE s.id = v_booking.service_id;
      ELSIF v_booking.appointment_id IS NOT NULL THEN
        SELECT COALESCE(a.requires_staff, false) INTO v_req_staff
        FROM appointments a WHERE a.id = v_booking.appointment_id;
      END IF;
      IF v_req_staff THEN
        RETURN jsonb_build_object('rescheduled', false, 'reason', 'staff_required');
      END IF;
    END;
  END IF;

  -- 3. Advisory lock on TARGET slot
  v_lock_key := abs(hashtext(
    p_business_id::text || '|' || p_new_date::text || '|' || p_new_time::time::text
  ));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- 4. Idempotent
  IF v_booking.date = p_new_date AND v_booking.time = p_new_time::time THEN
    RETURN jsonb_build_object('rescheduled', true, 'already_at_target', true);
  END IF;

  -- 5. Capacity check
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

  -- 6. Buffer overlap
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

  -- 7. Atomic move
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

-- Re-apply permissions for reschedule_booking_atomic (6-arg signature)
REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) TO service_role;
