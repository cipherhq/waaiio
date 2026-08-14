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
      -- Skip if instructor is assigned but unavailable on this date/time
      IF v_rule.staff_id IS NOT NULL THEN
        DECLARE v_staff_ok boolean;
        BEGIN
          SELECT csa.allowed INTO v_staff_ok
          FROM check_staff_availability(
            v_rule.staff_id, v_svc.business_id,
            v_date, v_rule.start_time::text,
            COALESCE(v_svc.duration_minutes, 60)
          ) csa;
          IF v_staff_ok IS NOT TRUE THEN
            v_date := v_date + 7;
            CONTINUE;
          END IF;
        END;
      END IF;

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
    SELECT id, business_id, service_id, date, start_time, capacity, status, staff_id, location_id
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

    -- 5b. Session instructor authority
    --     Session.staff_id is the canonical instructor. Caller p_staff_id
    --     cannot override it. If session has an instructor, validate availability.
    IF v_cs.staff_id IS NOT NULL THEN
      -- Reject caller attempt to override session instructor
      IF p_staff_id IS NOT NULL AND p_staff_id != v_cs.staff_id THEN
        RETURN QUERY SELECT NULL::uuid, NULL::text, false;
        RETURN;
      END IF;

      -- Validate session instructor availability using P1-STAFF-1 authority
      DECLARE v_cs_duration integer;
      BEGIN
        SELECT COALESCE(duration_minutes, 60) INTO v_cs_duration
        FROM services WHERE id = v_cs.service_id;

        SELECT csa.allowed INTO v_sched_allowed
        FROM check_staff_availability(
          v_cs.staff_id, p_business_id,
          v_cs.date, v_cs.start_time::text, v_cs_duration
        ) csa;

        IF v_sched_allowed IS NOT TRUE THEN
          RETURN QUERY SELECT NULL::uuid, NULL::text, false;
          RETURN;
        END IF;
      END;
    END IF;

    -- 5c. Advisory lock on CLASS SESSION (not business+date+time)
    v_lock_key := abs(hashtext('class_session:' || p_class_session_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- 5d. Capacity check using SUM(party_size) — seats, not rows
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied
    FROM bookings b
    WHERE b.class_session_id = p_class_session_id
      AND b.status IN ('confirmed', 'pending', 'in_progress');

    IF v_occupied + p_party_size > v_cs.capacity THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- 5e. Insert class booking — use session instructor, not caller staff
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
      v_cs.staff_id, p_staff_name,
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
    SELECT id, business_id, service_id, date, start_time, end_time, capacity, status, staff_id, location_id
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


-- ═══════════════════════════════════════════════════════
-- 9. CTO CORRECTIONS — Final Authority
-- ═══════════════════════════════════════════════════════


-- 9a. Atomic class creation: service + recurrence + generation in ONE transaction
CREATE OR REPLACE FUNCTION create_class_atomic(
  p_business_id uuid,
  p_name text,
  p_price integer DEFAULT 0,
  p_duration_minutes integer DEFAULT 60,
  p_max_capacity integer DEFAULT 10,
  p_weekday text DEFAULT NULL,
  p_start_time time DEFAULT NULL,
  p_staff_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_capacity_override integer DEFAULT NULL,
  p_description text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_service_id uuid;
  v_rule_id uuid;
  v_generated integer;
BEGIN
  -- Validate weekday
  IF p_weekday IS NOT NULL AND p_weekday NOT IN ('mon','tue','wed','thu','fri','sat','sun') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_weekday');
  END IF;

  -- Validate staff belongs to business and is active
  IF p_staff_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM business_staff WHERE id = p_staff_id AND business_id = p_business_id AND is_active = true) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'invalid_staff');
    END IF;
  END IF;

  -- Validate location belongs to business
  IF p_location_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM business_locations WHERE id = p_location_id AND business_id = p_business_id AND is_active = true) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'invalid_location');
    END IF;
  END IF;

  -- Create the class service
  INSERT INTO services (business_id, name, description, price, duration_minutes, max_capacity, is_class, is_active)
  VALUES (p_business_id, p_name, p_description, p_price, p_duration_minutes, p_max_capacity, true, true)
  RETURNING id INTO v_service_id;

  -- Create recurrence rule if schedule provided
  IF p_weekday IS NOT NULL AND p_start_time IS NOT NULL THEN
    INSERT INTO class_recurrence_rules (
      business_id, service_id, weekday, start_time,
      staff_id, location_id, capacity_override
    ) VALUES (
      p_business_id, v_service_id, p_weekday, p_start_time,
      p_staff_id, p_location_id, p_capacity_override
    ) RETURNING id INTO v_rule_id;

    -- Generate sessions
    SELECT generate_class_sessions(v_service_id, 28) INTO v_generated;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'service_id', v_service_id,
    'rule_id', v_rule_id,
    'sessions_generated', COALESCE(v_generated, 0)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION create_class_atomic FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_class_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION create_class_atomic FROM authenticated;
GRANT EXECUTE ON FUNCTION create_class_atomic TO service_role;


-- 9b. Atomic session mutation (cancel, capacity, instructor change)
--     Uses same advisory lock as booking path.
CREATE OR REPLACE FUNCTION update_class_session_atomic(
  p_session_id uuid,
  p_business_id uuid,
  p_new_status text DEFAULT NULL,
  p_cancellation_reason text DEFAULT NULL,
  p_new_capacity integer DEFAULT NULL,
  p_new_staff_id uuid DEFAULT NULL,
  p_clear_staff boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_session record;
  v_lock_key bigint;
  v_occupied bigint;
  v_duration integer;
  v_sched_allowed boolean;
BEGIN
  -- Lock session with same key as booking path
  v_lock_key := abs(hashtext('class_session:' || p_session_id::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Re-read under lock
  SELECT cs.*, s.duration_minutes, s.requires_staff
  INTO v_session
  FROM class_sessions cs
  JOIN services s ON s.id = cs.service_id
  WHERE cs.id = p_session_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'session_not_found');
  END IF;
  IF v_session.business_id != p_business_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'business_mismatch');
  END IF;

  -- Cancel
  IF p_new_status = 'cancelled' THEN
    IF v_session.status = 'completed' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'cannot_cancel_completed');
    END IF;
    UPDATE class_sessions SET status = 'cancelled', cancellation_reason = p_cancellation_reason
    WHERE id = p_session_id;
    RETURN jsonb_build_object('success', true, 'action', 'cancelled');
  END IF;

  -- Capacity change
  IF p_new_capacity IS NOT NULL THEN
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied
    FROM bookings b WHERE b.class_session_id = p_session_id
      AND b.status IN ('confirmed', 'pending', 'in_progress');
    IF p_new_capacity < v_occupied THEN
      RETURN jsonb_build_object('success', false, 'reason', 'capacity_below_occupancy',
        'occupancy', v_occupied, 'requested', p_new_capacity);
    END IF;
    UPDATE class_sessions SET capacity = p_new_capacity WHERE id = p_session_id;
  END IF;

  -- Instructor change
  IF p_new_staff_id IS NOT NULL OR p_clear_staff THEN
    IF p_new_staff_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM business_staff WHERE id = p_new_staff_id AND business_id = p_business_id AND is_active = true) THEN
        RETURN jsonb_build_object('success', false, 'reason', 'invalid_staff');
      END IF;
      v_duration := COALESCE(v_session.duration_minutes, 60);
      SELECT csa.allowed INTO v_sched_allowed
      FROM check_staff_availability(p_new_staff_id, p_business_id, v_session.date, v_session.start_time::text, v_duration) csa;
      IF v_sched_allowed IS NOT TRUE THEN
        RETURN jsonb_build_object('success', false, 'reason', 'staff_unavailable');
      END IF;
      UPDATE class_sessions SET staff_id = p_new_staff_id WHERE id = p_session_id;
    ELSE
      UPDATE class_sessions SET staff_id = NULL WHERE id = p_session_id;
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION update_class_session_atomic FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_class_session_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION update_class_session_atomic FROM authenticated;
GRANT EXECUTE ON FUNCTION update_class_session_atomic TO service_role;


-- 9c. Atomic recurrence reconciliation
CREATE OR REPLACE FUNCTION reconcile_class_recurrence(
  p_rule_id uuid,
  p_business_id uuid,
  p_action text, -- 'update' or 'delete'
  -- Update fields (ignored for delete)
  p_weekday text DEFAULT NULL,
  p_start_time time DEFAULT NULL,
  p_staff_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_capacity_override integer DEFAULT NULL,
  p_effective_from date DEFAULT NULL,
  p_effective_until date DEFAULT NULL,
  p_is_active boolean DEFAULT NULL,
  p_clear_staff boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rule record;
  v_session record;
  v_booked_count integer := 0;
  v_lock_key bigint;
  v_today date := CURRENT_DATE;
BEGIN
  -- Load and validate rule
  SELECT * INTO v_rule FROM class_recurrence_rules WHERE id = p_rule_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'rule_not_found');
  END IF;
  IF v_rule.business_id != p_business_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'business_mismatch');
  END IF;

  -- Validate new values
  IF p_weekday IS NOT NULL AND p_weekday NOT IN ('mon','tue','wed','thu','fri','sat','sun') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_weekday');
  END IF;
  IF p_staff_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM business_staff WHERE id = p_staff_id AND business_id = p_business_id AND is_active = true) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'invalid_staff');
    END IF;
  END IF;
  IF p_location_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM business_locations WHERE id = p_location_id AND business_id = p_business_id AND is_active = true) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'invalid_location');
    END IF;
  END IF;
  IF p_capacity_override IS NOT NULL AND p_capacity_override < 1 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_capacity');
  END IF;

  -- Lock ALL affected future sessions to coordinate with booking path
  FOR v_session IN
    SELECT cs.id FROM class_sessions cs
    WHERE cs.recurrence_rule_id = p_rule_id
      AND cs.status = 'scheduled'
      AND cs.date >= v_today
    ORDER BY cs.date
  LOOP
    v_lock_key := abs(hashtext('class_session:' || v_session.id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);
  END LOOP;

  -- Count booked future sessions under lock
  SELECT count(DISTINCT cs.id) INTO v_booked_count
  FROM class_sessions cs
  JOIN bookings b ON b.class_session_id = cs.id AND b.status IN ('confirmed', 'pending', 'in_progress')
  WHERE cs.recurrence_rule_id = p_rule_id
    AND cs.status = 'scheduled'
    AND cs.date >= v_today;

  IF v_booked_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'booked_sessions_exist',
      'booked_session_count', v_booked_count);
  END IF;

  -- Remove unbooked future scheduled sessions
  DELETE FROM class_sessions
  WHERE recurrence_rule_id = p_rule_id
    AND status = 'scheduled'
    AND date >= v_today;

  IF p_action = 'delete' THEN
    DELETE FROM class_recurrence_rules WHERE id = p_rule_id;
    RETURN jsonb_build_object('success', true, 'action', 'deleted');
  END IF;

  -- Update rule
  UPDATE class_recurrence_rules SET
    weekday = COALESCE(p_weekday, weekday),
    start_time = COALESCE(p_start_time, start_time),
    staff_id = CASE WHEN p_clear_staff THEN NULL WHEN p_staff_id IS NOT NULL THEN p_staff_id ELSE staff_id END,
    location_id = COALESCE(p_location_id, location_id),
    capacity_override = COALESCE(p_capacity_override, capacity_override),
    effective_from = COALESCE(p_effective_from, effective_from),
    effective_until = CASE WHEN p_effective_until IS NOT NULL THEN p_effective_until ELSE effective_until END,
    is_active = COALESCE(p_is_active, is_active),
    updated_at = NOW()
  WHERE id = p_rule_id;

  -- Regenerate future sessions
  PERFORM generate_class_sessions(v_rule.service_id, 28);

  RETURN jsonb_build_object('success', true, 'action', 'updated');
END;
$$;

REVOKE EXECUTE ON FUNCTION reconcile_class_recurrence FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reconcile_class_recurrence FROM anon;
REVOKE EXECUTE ON FUNCTION reconcile_class_recurrence FROM authenticated;
GRANT EXECUTE ON FUNCTION reconcile_class_recurrence TO service_role;


-- 9d. Correct book_slot_atomic class path: lock FIRST, then validate session + instructor
--     Also enforce requires_staff for NULL session instructor.
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
  v_cs_duration integer;
BEGIN
  -- 1. Idempotent retry check
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

  -- ═══════════════════════════════════════════════════════
  -- CLASS SESSION BOOKING PATH
  -- Lock FIRST, then validate everything under the lock.
  -- ═══════════════════════════════════════════════════════
  IF p_class_session_id IS NOT NULL THEN
    -- Advisory lock FIRST — before any validation
    v_lock_key := abs(hashtext('class_session:' || p_class_session_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Load session under lock
    SELECT cs.id, cs.business_id, cs.service_id, cs.date, cs.start_time,
           cs.capacity, cs.status, cs.staff_id, cs.location_id,
           s.is_class, s.requires_staff, s.duration_minutes
    INTO v_cs
    FROM class_sessions cs
    JOIN services s ON s.id = cs.service_id
    WHERE cs.id = p_class_session_id;

    IF NOT FOUND THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- Business match
    IF v_cs.business_id != p_business_id THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- Service identity match
    IF p_service_id IS NOT NULL AND v_cs.service_id != p_service_id THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- Must be a class service
    IF NOT COALESCE(v_cs.is_class, false) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- Must be scheduled
    IF v_cs.status != 'scheduled' THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- SESSION INSTRUCTOR AUTHORITY
    v_cs_duration := COALESCE(v_cs.duration_minutes, 60);

    IF v_cs.staff_id IS NOT NULL THEN
      -- Reject caller override
      IF p_staff_id IS NOT NULL AND p_staff_id != v_cs.staff_id THEN
        RETURN QUERY SELECT NULL::uuid, NULL::text, false;
        RETURN;
      END IF;
      -- Validate instructor availability
      SELECT csa.allowed INTO v_sched_allowed
      FROM check_staff_availability(v_cs.staff_id, p_business_id, v_cs.date, v_cs.start_time::text, v_cs_duration) csa;
      IF v_sched_allowed IS NOT TRUE THEN
        RETURN QUERY SELECT NULL::uuid, NULL::text, false;
        RETURN;
      END IF;
      -- Derive canonical staff name from DB
      DECLARE v_canonical_staff_name text;
      BEGIN
        SELECT bs.name INTO v_canonical_staff_name FROM business_staff bs WHERE bs.id = v_cs.staff_id;
      END;
    ELSE
      -- Session has no instructor
      IF COALESCE(v_cs.requires_staff, false) THEN
        -- requires_staff but no session instructor — reject
        RETURN QUERY SELECT NULL::uuid, NULL::text, false;
        RETURN;
      END IF;
    END IF;

    -- Capacity check using SUM(party_size)
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied
    FROM bookings b
    WHERE b.class_session_id = p_class_session_id
      AND b.status IN ('confirmed', 'pending', 'in_progress');

    IF v_occupied + p_party_size > v_cs.capacity THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;

    -- Insert class booking — derive staff identity from session, not caller
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
      v_cs.staff_id, (SELECT bs.name FROM business_staff bs WHERE bs.id = v_cs.staff_id),
      v_cs.date, v_cs.start_time, p_party_size,
      p_flow_type::flow_type,
      'whatsapp'::booking_channel,
      p_deposit_amount,
      p_deposit_status::deposit_status,
      p_status::reservation_status,
      p_guest_name, p_guest_phone, p_guest_email,
      p_special_requests, p_venue_address, p_end_date,
      p_addons_snapshot, p_promo_code_id, p_total_amount, p_party_size,
      v_cs.location_id, p_bot_session_id, p_class_session_id
    )
    RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

    RETURN QUERY SELECT v_booking_id, v_ref, true;
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════
  -- NON-CLASS BOOKING PATH (preserved)
  -- ═══════════════════════════════════════════════════════

  -- Appointment schedule validation
  IF p_appointment_id IS NOT NULL THEN
    SELECT cas.allowed, cas.reason
    INTO v_sched_allowed, v_sched_reason
    FROM check_appointment_schedule(p_appointment_id, p_business_id, p_date, p_time) cas;
    IF v_sched_allowed IS NOT TRUE THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;
  END IF;

  -- Staff availability (non-class)
  IF p_staff_id IS NOT NULL THEN
    SELECT csa.allowed, csa.reason
    INTO v_sched_allowed, v_sched_reason
    FROM check_staff_availability(p_staff_id, p_business_id, p_date, p_time, COALESCE(p_duration, 30)) csa;
    IF v_sched_allowed IS NOT TRUE THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;
  END IF;

  -- requires_staff (non-class)
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

  -- Advisory lock on logical slot
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

  -- Buffer overlap
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

  -- Insert normal booking
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

-- Re-apply permissions (28-arg signature)
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


-- 9e. Correct reschedule: enforce same-service, use target staff/location directly
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
  -- CLASS BOOKING RESCHEDULE
  -- ═══════════════════════════════════════════════════════
  IF v_booking.class_session_id IS NOT NULL THEN
    IF p_target_class_session_id IS NULL THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_required');
    END IF;
    IF v_booking.class_session_id = p_target_class_session_id THEN
      RETURN jsonb_build_object('rescheduled', true, 'already_at_target', true);
    END IF;

    -- Lock target
    v_lock_key := abs(hashtext('class_session:' || p_target_class_session_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Load and validate target under lock
    SELECT cs.id, cs.business_id, cs.service_id, cs.date, cs.start_time,
           cs.end_time, cs.capacity, cs.status, cs.staff_id, cs.location_id,
           s.is_class, s.requires_staff, s.duration_minutes
    INTO v_target_cs
    FROM class_sessions cs
    JOIN services s ON s.id = cs.service_id
    WHERE cs.id = p_target_class_session_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_not_found');
    END IF;
    IF v_target_cs.business_id != p_business_id THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_business_mismatch');
    END IF;
    -- Enforce same service (no cross-class reschedule)
    IF v_target_cs.service_id != v_booking.service_id THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'cross_class_not_allowed');
    END IF;
    IF NOT COALESCE(v_target_cs.is_class, false) THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_not_class');
    END IF;
    IF v_target_cs.status != 'scheduled' THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_not_bookable');
    END IF;

    -- Target instructor authority
    IF v_target_cs.staff_id IS NOT NULL THEN
      SELECT csa.allowed INTO v_sched_allowed
      FROM check_staff_availability(
        v_target_cs.staff_id, p_business_id,
        v_target_cs.date, v_target_cs.start_time::text,
        COALESCE(v_target_cs.duration_minutes, 60)
      ) csa;
      IF v_sched_allowed IS NOT TRUE THEN
        RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_staff_unavailable');
      END IF;
    ELSIF COALESCE(v_target_cs.requires_staff, false) THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_requires_staff');
    END IF;

    -- Capacity
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied
    FROM bookings b
    WHERE b.class_session_id = p_target_class_session_id
      AND b.status IN ('confirmed', 'pending', 'in_progress')
      AND b.id != p_booking_id;

    IF v_occupied + v_party > v_target_cs.capacity THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_full');
    END IF;

    -- Move — use target session's staff/location directly (not COALESCE)
    UPDATE bookings
    SET class_session_id = p_target_class_session_id,
        date = v_target_cs.date,
        time = v_target_cs.start_time,
        party_size = v_party,
        staff_id = v_target_cs.staff_id,
        staff_name = (SELECT bs.name FROM business_staff bs WHERE bs.id = v_target_cs.staff_id),
        location_id = v_target_cs.location_id,
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
  -- NORMAL BOOKING RESCHEDULE (preserved)
  -- ═══════════════════════════════════════════════════════
  IF v_booking.service_id IS NOT NULL THEN
    SELECT COALESCE(max_capacity, 1), COALESCE(buffer_minutes, 0), COALESCE(duration_minutes, 30)
    INTO v_max_capacity, v_buffer_minutes, v_duration
    FROM services WHERE id = v_booking.service_id;
  ELSIF v_booking.appointment_id IS NOT NULL THEN
    SELECT COALESCE(max_capacity, 1), COALESCE(buffer_minutes, 0), COALESCE(duration_minutes, 30)
    INTO v_max_capacity, v_buffer_minutes, v_duration
    FROM appointments WHERE id = v_booking.appointment_id;
    SELECT cas.allowed, cas.reason INTO v_sched_allowed, v_sched_reason
    FROM check_appointment_schedule(v_booking.appointment_id, p_business_id, p_new_date, p_new_time) cas;
    IF v_sched_allowed IS NOT TRUE THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', COALESCE(v_sched_reason, 'appointment_schedule_conflict'));
    END IF;
  ELSE
    v_max_capacity := 1; v_buffer_minutes := 0; v_duration := 30;
  END IF;

  IF v_max_capacity IS NULL THEN v_max_capacity := 1; END IF;
  IF v_buffer_minutes IS NULL THEN v_buffer_minutes := 0; END IF;
  IF v_duration IS NULL THEN v_duration := 30; END IF;

  IF v_booking.staff_id IS NOT NULL THEN
    SELECT csa.allowed, csa.reason INTO v_sched_allowed, v_sched_reason
    FROM check_staff_availability(v_booking.staff_id, p_business_id, p_new_date, p_new_time, v_duration) csa;
    IF v_sched_allowed IS NOT TRUE THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', COALESCE(v_sched_reason, 'staff_unavailable'));
    END IF;
  ELSE
    DECLARE v_req_staff boolean := false;
    BEGIN
      IF v_booking.service_id IS NOT NULL THEN
        SELECT COALESCE(s.requires_staff, false) INTO v_req_staff FROM services s WHERE s.id = v_booking.service_id;
      ELSIF v_booking.appointment_id IS NOT NULL THEN
        SELECT COALESCE(a.requires_staff, false) INTO v_req_staff FROM appointments a WHERE a.id = v_booking.appointment_id;
      END IF;
      IF v_req_staff THEN
        RETURN jsonb_build_object('rescheduled', false, 'reason', 'staff_required');
      END IF;
    END;
  END IF;

  v_lock_key := abs(hashtext(p_business_id::text || '|' || p_new_date::text || '|' || p_new_time::time::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  IF v_booking.date = p_new_date AND v_booking.time = p_new_time::time THEN
    RETURN jsonb_build_object('rescheduled', true, 'already_at_target', true);
  END IF;

  SELECT COUNT(*) INTO v_count FROM bookings
  WHERE business_id = p_business_id AND date = p_new_date AND time = p_new_time::time
    AND status IN ('confirmed', 'pending', 'in_progress') AND id != p_booking_id
    AND (v_booking.staff_id IS NULL OR staff_id = v_booking.staff_id);
  IF v_count >= v_max_capacity THEN
    RETURN jsonb_build_object('rescheduled', false, 'reason', 'slot_full');
  END IF;

  IF v_buffer_minutes > 0 THEN
    SELECT COUNT(*) INTO v_buffer_count FROM bookings
    WHERE business_id = p_business_id AND date = p_new_date
      AND status IN ('pending', 'confirmed', 'in_progress') AND id != p_booking_id
      AND (v_booking.staff_id IS NULL OR staff_id = v_booking.staff_id)
      AND time != p_new_time::time
      AND (p_new_time::time < (time + make_interval(mins => v_duration + v_buffer_minutes))
        AND (p_new_time::time + make_interval(mins => v_duration)) > (time - make_interval(mins => v_buffer_minutes)));
    IF v_buffer_count > 0 THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'buffer_conflict');
    END IF;
  END IF;

  UPDATE bookings SET date = p_new_date, time = p_new_time::time,
    party_size = COALESCE(p_new_party_size, party_size),
    original_date = CASE WHEN original_date IS NULL THEN v_booking.date ELSE original_date END,
    original_time = CASE WHEN original_time IS NULL THEN v_booking.time::text ELSE original_time END,
    rescheduled_at = NOW()
  WHERE id = p_booking_id;

  RETURN jsonb_build_object('rescheduled', true,
    'old_date', v_booking.date, 'old_time', v_booking.time,
    'new_date', p_new_date, 'new_time', p_new_time);
END;
$$;

REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) TO service_role;


-- ═══════════════════════════════════════════════════════
-- 10. INTEGRITY CORRECTIONS
-- ═══════════════════════════════════════════════════════
-- See inline comments for each fix.
-- Functions are CREATE OR REPLACE, overriding earlier definitions.

-- 10a. Fix update_class_session_atomic: validate ALL then mutate once
CREATE OR REPLACE FUNCTION update_class_session_atomic(
  p_session_id uuid, p_business_id uuid,
  p_new_status text DEFAULT NULL, p_cancellation_reason text DEFAULT NULL,
  p_new_capacity integer DEFAULT NULL, p_new_staff_id uuid DEFAULT NULL,
  p_clear_staff boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_session record; v_lock_key bigint; v_occupied bigint;
  v_duration integer; v_sched_allowed boolean;
  v_active_attendee_count integer; v_final_capacity integer; v_final_staff_id uuid;
BEGIN
  v_lock_key := abs(hashtext('class_session:' || p_session_id::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);
  SELECT cs.*, s.duration_minutes, s.requires_staff INTO v_session
  FROM class_sessions cs JOIN services s ON s.id = cs.service_id WHERE cs.id = p_session_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'reason', 'session_not_found'); END IF;
  IF v_session.business_id != p_business_id THEN RETURN jsonb_build_object('success', false, 'reason', 'business_mismatch'); END IF;

  SELECT count(*), COALESCE(SUM(b.party_size), 0) INTO v_active_attendee_count, v_occupied
  FROM bookings b WHERE b.class_session_id = p_session_id AND b.status IN ('confirmed', 'pending', 'in_progress');

  -- Validate cancel
  IF p_new_status = 'cancelled' AND v_session.status = 'completed' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'cannot_cancel_completed');
  END IF;
  -- Validate capacity
  v_final_capacity := v_session.capacity;
  IF p_new_capacity IS NOT NULL THEN
    IF p_new_capacity < v_occupied THEN
      RETURN jsonb_build_object('success', false, 'reason', 'capacity_below_occupancy', 'occupancy', v_occupied);
    END IF;
    v_final_capacity := p_new_capacity;
  END IF;
  -- Validate instructor
  v_final_staff_id := v_session.staff_id;
  IF p_new_staff_id IS NOT NULL OR p_clear_staff THEN
    IF p_clear_staff AND COALESCE(v_session.requires_staff, false) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'requires_staff_cannot_clear');
    END IF;
    IF v_active_attendee_count > 0 THEN
      RETURN jsonb_build_object('success', false, 'reason', 'attendees_exist_cannot_change_instructor', 'active_attendee_count', v_active_attendee_count);
    END IF;
    IF p_new_staff_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM business_staff WHERE id = p_new_staff_id AND business_id = p_business_id AND is_active = true) THEN
        RETURN jsonb_build_object('success', false, 'reason', 'invalid_staff');
      END IF;
      v_duration := COALESCE(v_session.duration_minutes, 60);
      SELECT csa.allowed INTO v_sched_allowed
      FROM check_staff_availability(p_new_staff_id, p_business_id, v_session.date, v_session.start_time::text, v_duration) csa;
      IF v_sched_allowed IS NOT TRUE THEN
        RETURN jsonb_build_object('success', false, 'reason', 'staff_unavailable');
      END IF;
      v_final_staff_id := p_new_staff_id;
    ELSE v_final_staff_id := NULL;
    END IF;
  END IF;

  -- ALL valid — single mutation
  IF p_new_status = 'cancelled' THEN
    UPDATE class_sessions SET status = 'cancelled', cancellation_reason = p_cancellation_reason WHERE id = p_session_id;
    RETURN jsonb_build_object('success', true, 'action', 'cancelled');
  END IF;
  UPDATE class_sessions SET capacity = v_final_capacity, staff_id = v_final_staff_id WHERE id = p_session_id;
  RETURN jsonb_build_object('success', true);
END;
$$;


-- 10b. Fix reconcile: protect sessions with ANY booking history + recurrence lock
CREATE OR REPLACE FUNCTION reconcile_class_recurrence(
  p_rule_id uuid, p_business_id uuid, p_action text,
  p_weekday text DEFAULT NULL, p_start_time time DEFAULT NULL,
  p_staff_id uuid DEFAULT NULL, p_location_id uuid DEFAULT NULL,
  p_capacity_override integer DEFAULT NULL, p_effective_from date DEFAULT NULL,
  p_effective_until date DEFAULT NULL, p_is_active boolean DEFAULT NULL,
  p_clear_staff boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rule record; v_session record; v_lock_key bigint;
  v_today date := CURRENT_DATE; v_referenced_count integer;
BEGIN
  -- Lock recurrence rule to serialize with generation
  v_lock_key := abs(hashtext('recurrence_rule:' || p_rule_id::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT * INTO v_rule FROM class_recurrence_rules WHERE id = p_rule_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'reason', 'rule_not_found'); END IF;
  IF v_rule.business_id != p_business_id THEN RETURN jsonb_build_object('success', false, 'reason', 'business_mismatch'); END IF;

  IF p_weekday IS NOT NULL AND p_weekday NOT IN ('mon','tue','wed','thu','fri','sat','sun') THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_weekday'); END IF;
  IF p_staff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_staff WHERE id = p_staff_id AND business_id = p_business_id AND is_active = true) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_staff');
  END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_locations WHERE id = p_location_id AND business_id = p_business_id AND is_active = true) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_location');
  END IF;
  IF p_capacity_override IS NOT NULL AND p_capacity_override < 1 THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_capacity'); END IF;

  -- Lock all affected future sessions
  FOR v_session IN SELECT cs.id FROM class_sessions cs WHERE cs.recurrence_rule_id = p_rule_id AND cs.status = 'scheduled' AND cs.date >= v_today ORDER BY cs.date
  LOOP
    PERFORM pg_advisory_xact_lock(abs(hashtext('class_session:' || v_session.id::text)));
  END LOOP;

  -- Protect sessions with ANY booking history (not just active)
  SELECT count(DISTINCT cs.id) INTO v_referenced_count
  FROM class_sessions cs WHERE cs.recurrence_rule_id = p_rule_id AND cs.date >= v_today
    AND EXISTS (SELECT 1 FROM bookings b WHERE b.class_session_id = cs.id);
  IF v_referenced_count > 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'booked_sessions_exist', 'booked_session_count', v_referenced_count);
  END IF;

  -- Remove only unreferenced future scheduled sessions
  DELETE FROM class_sessions WHERE recurrence_rule_id = p_rule_id AND status = 'scheduled' AND date >= v_today
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.class_session_id = class_sessions.id);

  IF p_action = 'delete' THEN
    DELETE FROM class_recurrence_rules WHERE id = p_rule_id;
    RETURN jsonb_build_object('success', true, 'action', 'deleted');
  END IF;

  UPDATE class_recurrence_rules SET
    weekday = COALESCE(p_weekday, weekday), start_time = COALESCE(p_start_time, start_time),
    staff_id = CASE WHEN p_clear_staff THEN NULL WHEN p_staff_id IS NOT NULL THEN p_staff_id ELSE staff_id END,
    location_id = COALESCE(p_location_id, location_id), capacity_override = COALESCE(p_capacity_override, capacity_override),
    effective_from = COALESCE(p_effective_from, effective_from),
    effective_until = CASE WHEN p_effective_until IS NOT NULL THEN p_effective_until ELSE effective_until END,
    is_active = COALESCE(p_is_active, is_active), updated_at = NOW()
  WHERE id = p_rule_id;

  PERFORM generate_class_sessions(v_rule.service_id, 28);
  RETURN jsonb_build_object('success', true, 'action', 'updated');
END;
$$;


-- 10c. Fix generate: recurrence lock + requires_staff check
CREATE OR REPLACE FUNCTION generate_class_sessions(p_service_id UUID, p_days_ahead INTEGER DEFAULT 28)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rule RECORD; v_date DATE; v_end_date DATE; v_dow INTEGER; v_target_dow INTEGER;
  v_svc RECORD; v_capacity INTEGER; v_end_time TIME; v_generated INTEGER := 0; v_lock_key bigint;
BEGIN
  SELECT id, business_id, duration_minutes, max_capacity, is_class, requires_staff
  INTO v_svc FROM services WHERE id = p_service_id;
  IF NOT FOUND OR NOT COALESCE(v_svc.is_class, false) THEN RETURN 0; END IF;
  v_end_date := CURRENT_DATE + p_days_ahead;

  FOR v_rule IN SELECT * FROM class_recurrence_rules WHERE service_id = p_service_id AND is_active = true
    AND effective_from <= v_end_date AND (effective_until IS NULL OR effective_until >= CURRENT_DATE) ORDER BY weekday, start_time
  LOOP
    -- Lock per-rule
    v_lock_key := abs(hashtext('recurrence_rule:' || v_rule.id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- requires_staff + no instructor => skip entire rule
    IF COALESCE(v_svc.requires_staff, false) AND v_rule.staff_id IS NULL THEN CONTINUE; END IF;

    v_target_dow := CASE v_rule.weekday WHEN 'sun' THEN 0 WHEN 'mon' THEN 1 WHEN 'tue' THEN 2
      WHEN 'wed' THEN 3 WHEN 'thu' THEN 4 WHEN 'fri' THEN 5 WHEN 'sat' THEN 6 END;
    v_capacity := COALESCE(v_rule.capacity_override, v_svc.max_capacity, 10);
    v_end_time := v_rule.start_time + make_interval(mins => COALESCE(v_svc.duration_minutes, 60));
    v_date := GREATEST(v_rule.effective_from, CURRENT_DATE);
    v_dow := EXTRACT(DOW FROM v_date)::INTEGER;
    IF v_dow != v_target_dow THEN v_date := v_date + ((v_target_dow - v_dow + 7) % 7); END IF;

    WHILE v_date <= v_end_date AND (v_rule.effective_until IS NULL OR v_date <= v_rule.effective_until) LOOP
      IF v_rule.staff_id IS NOT NULL THEN
        DECLARE v_staff_ok boolean;
        BEGIN
          SELECT csa.allowed INTO v_staff_ok FROM check_staff_availability(
            v_rule.staff_id, v_svc.business_id, v_date, v_rule.start_time::text, COALESCE(v_svc.duration_minutes, 60)) csa;
          IF v_staff_ok IS NOT TRUE THEN v_date := v_date + 7; CONTINUE; END IF;
        END;
      END IF;
      INSERT INTO class_sessions (business_id, service_id, recurrence_rule_id, date, start_time, end_time, staff_id, location_id, capacity, status)
      VALUES (v_svc.business_id, p_service_id, v_rule.id, v_date, v_rule.start_time, v_end_time, v_rule.staff_id, v_rule.location_id, v_capacity, 'scheduled')
      ON CONFLICT (recurrence_rule_id, date, start_time) DO NOTHING;
      IF FOUND THEN v_generated := v_generated + 1; END IF;
      v_date := v_date + 7;
    END LOOP;
  END LOOP;
  RETURN v_generated;
END;
$$;


-- ═══════════════════════════════════════════════════════
-- 11. RLS HARDENING — Remove authenticated write bypass
-- ═══════════════════════════════════════════════════════
-- Mutations must go through guarded RPCs (create_class_atomic,
-- update_class_session_atomic, reconcile_class_recurrence, book_slot_atomic).
-- Authenticated owners retain SELECT only.

DROP POLICY IF EXISTS crr_owner_insert ON class_recurrence_rules;
DROP POLICY IF EXISTS crr_owner_update ON class_recurrence_rules;
DROP POLICY IF EXISTS crr_owner_delete ON class_recurrence_rules;

DROP POLICY IF EXISTS cs_owner_insert ON class_sessions;
DROP POLICY IF EXISTS cs_owner_update ON class_sessions;
DROP POLICY IF EXISTS cs_owner_delete ON class_sessions;


-- ═══════════════════════════════════════════════════════
-- 12. GENERATOR FRESH-READ UNDER LOCK
-- ═══════════════════════════════════════════════════════
-- Enumerate candidate rule IDs first, then for each:
-- acquire lock → re-read → verify → generate.
-- Prevents stale rule state after concurrent reconciliation.

CREATE OR REPLACE FUNCTION generate_class_sessions(p_service_id UUID, p_days_ahead INTEGER DEFAULT 28)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rule_id UUID;
  v_rule RECORD;
  v_date DATE; v_end_date DATE; v_dow INTEGER; v_target_dow INTEGER;
  v_svc RECORD; v_capacity INTEGER; v_end_time TIME;
  v_generated INTEGER := 0; v_lock_key bigint;
BEGIN
  SELECT id, business_id, duration_minutes, max_capacity, is_class, requires_staff
  INTO v_svc FROM services WHERE id = p_service_id;
  IF NOT FOUND OR NOT COALESCE(v_svc.is_class, false) THEN RETURN 0; END IF;
  v_end_date := CURRENT_DATE + p_days_ahead;

  -- Step 1: enumerate candidate rule IDs only (no row data used outside lock)
  FOR v_rule_id IN
    SELECT id FROM class_recurrence_rules
    WHERE service_id = p_service_id AND is_active = true
      AND effective_from <= v_end_date
      AND (effective_until IS NULL OR effective_until >= CURRENT_DATE)
    ORDER BY id
  LOOP
    -- Step 2: acquire recurrence lock
    v_lock_key := abs(hashtext('recurrence_rule:' || v_rule_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Step 3: re-read the rule AFTER acquiring the lock (fresh state)
    SELECT * INTO v_rule FROM class_recurrence_rules
    WHERE id = v_rule_id AND service_id = p_service_id AND is_active = true
      AND effective_from <= v_end_date
      AND (effective_until IS NULL OR effective_until >= CURRENT_DATE);

    -- Rule may have been deleted/deactivated/changed by concurrent reconcile
    IF NOT FOUND THEN CONTINUE; END IF;

    -- requires_staff + no instructor => skip
    IF COALESCE(v_svc.requires_staff, false) AND v_rule.staff_id IS NULL THEN CONTINUE; END IF;

    v_target_dow := CASE v_rule.weekday WHEN 'sun' THEN 0 WHEN 'mon' THEN 1 WHEN 'tue' THEN 2
      WHEN 'wed' THEN 3 WHEN 'thu' THEN 4 WHEN 'fri' THEN 5 WHEN 'sat' THEN 6 END;
    v_capacity := COALESCE(v_rule.capacity_override, v_svc.max_capacity, 10);
    v_end_time := v_rule.start_time + make_interval(mins => COALESCE(v_svc.duration_minutes, 60));
    v_date := GREATEST(v_rule.effective_from, CURRENT_DATE);
    v_dow := EXTRACT(DOW FROM v_date)::INTEGER;
    IF v_dow != v_target_dow THEN v_date := v_date + ((v_target_dow - v_dow + 7) % 7); END IF;

    WHILE v_date <= v_end_date AND (v_rule.effective_until IS NULL OR v_date <= v_rule.effective_until) LOOP
      IF v_rule.staff_id IS NOT NULL THEN
        DECLARE v_staff_ok boolean;
        BEGIN
          SELECT csa.allowed INTO v_staff_ok FROM check_staff_availability(
            v_rule.staff_id, v_svc.business_id, v_date, v_rule.start_time::text,
            COALESCE(v_svc.duration_minutes, 60)) csa;
          IF v_staff_ok IS NOT TRUE THEN v_date := v_date + 7; CONTINUE; END IF;
        END;
      END IF;
      INSERT INTO class_sessions (business_id, service_id, recurrence_rule_id, date, start_time, end_time, staff_id, location_id, capacity, status)
      VALUES (v_svc.business_id, p_service_id, v_rule.id, v_date, v_rule.start_time, v_end_time, v_rule.staff_id, v_rule.location_id, v_capacity, 'scheduled')
      ON CONFLICT (recurrence_rule_id, date, start_time) DO NOTHING;
      IF FOUND THEN v_generated := v_generated + 1; END IF;
      v_date := v_date + 7;
    END LOOP;
  END LOOP;
  RETURN v_generated;
END;
$$;


-- 12b. Grant authenticated SELECT on class tables (for RLS read path)
-- No INSERT/UPDATE/DELETE grants — service_role handles mutations via RPCs.
GRANT SELECT ON class_sessions TO authenticated;
GRANT SELECT ON class_recurrence_rules TO authenticated;
-- Ensure authenticated has DML privilege on the tables so RLS is tested
-- (without DML privilege, PostgreSQL returns "permission denied" not "RLS violation")
GRANT INSERT, UPDATE, DELETE ON class_sessions TO authenticated;
GRANT INSERT, UPDATE, DELETE ON class_recurrence_rules TO authenticated;
-- RLS policies (owner SELECT only + service_role ALL) enforce the actual authority.
-- The DROP POLICY statements above removed INSERT/UPDATE/DELETE policies for authenticated.
-- Result: authenticated has table-level DML privilege but zero matching RLS write policies
-- → any write attempt returns zero rows (for UPDATE/DELETE) or RLS violation (for INSERT).
