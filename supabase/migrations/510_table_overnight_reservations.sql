-- ═══════════════════════════════════════════════════════
-- Migration 510: late-night (overnight) table reservations
--
-- Owner decisions 2026-11-04 (table bookings only):
--   * A business day whose closing time is earlier than or equal to its opening
--     time (businesses.operating_hours) closes on the next calendar day.
--   * A late booking belongs to its start date: it must start before midnight
--     and end at or before closing. Example: Fri 23:00-00:30 with Fri hours
--     18:00-02:00 is allowed and stored as Friday 23:00.
--   * The database enforces this. An end past 1440 minutes is allowed only when
--     the start date's hours cross midnight AND end <= close + 1440 AND the
--     start is before 24:00. Every other day keeps the past_midnight rejection.
--   * Seating resources' own windows stay non-overnight (seating_no_overnight
--     is unchanged) and the 1-480 minute duration CHECK is unchanged.
--   * (Second decision, same day.) The database rejects a start outside the
--     business's opening hours even when the table has no window of its own.
--     A closed day is rejected. A day without usable hours ({} hours, missing
--     or malformed entries) gets no business-hours check, exactly as M476.
--
-- Changes to book_table_atomic (M476 body otherwise copied verbatim):
--   1. Advisory lock is per (business, resource), without the date, so bookings
--      on neighbouring dates of the same resource serialise.
--   2. Reads that weekday's businesses.operating_hours: closed (closed = true or
--      is_open = false), usable (closed absent/false, is_open absent/true, open
--      and close both match ^([01]\d|2[0-3]):[0-5]\d$; overnight when
--      close <= open), or no usable hours. Only usable overnight hours allow an
--      end past midnight (fail closed).
--   3. Business hours: closed day -> day_unavailable; usable hours -> start must
--      be >= open and < 24:00 (before_opening), and on a daytime day the end
--      must be <= close (after_closing). These run after the midnight checks
--      and in addition to the table's own available_days/from/to checks.
--   4. Overlap check uses an absolute-minute axis over b.date in
--      [p_date - 1, p_date + 1], so a late booking on D blocks D+1 00:xx and
--      vice versa.
--
-- Unchanged: signature, return shape, SECURITY INVOKER, no SET/proconfig,
-- idempotency, resource validation, deposit/duration revalidation, party size,
-- day_unavailable / before_opening / after_closing (resource window), insert
-- columns, error codes (no new code). Payments and deposits are not touched. ACL is restated
-- exactly as in M476 (service_role only). book_slot_atomic and
-- reschedule_booking_atomic are not touched.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.book_table_atomic(
  p_bot_session_id UUID,
  p_business_id UUID,
  p_user_id UUID,
  p_seating_resource_id UUID,
  p_date DATE,
  p_time TEXT,
  p_party_size INTEGER,
  p_duration_minutes INTEGER DEFAULT 90,
  p_guest_name TEXT DEFAULT NULL,
  p_guest_phone TEXT DEFAULT NULL,
  p_guest_email TEXT DEFAULT NULL,
  p_special_requests TEXT DEFAULT NULL,
  p_deposit_amount INTEGER DEFAULT 0,
  p_deposit_status TEXT DEFAULT 'none',
  p_status TEXT DEFAULT 'confirmed',
  p_total_amount INTEGER DEFAULT 0,
  p_expected_deposit INTEGER DEFAULT NULL,
  p_expected_duration INTEGER DEFAULT NULL
)
RETURNS TABLE(booking_id UUID, reference_code TEXT, slot_available BOOLEAN)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_booking_id UUID;
  v_ref TEXT;
  v_lock_key BIGINT;
  v_resource RECORD;
  v_overlap_count INTEGER;
  v_req_start_min INTEGER;  -- minutes since midnight (avoids TIME wrap)
  v_req_end_min INTEGER;
  v_day_name TEXT;
  v_committed_deposit INTEGER;
  v_committed_duration INTEGER;
  v_committed_total INTEGER;
  v_from_min INTEGER;
  v_to_min INTEGER;
  v_b_start_min INTEGER;
  v_b_end_min INTEGER;
  -- M510: overnight business hours for p_date's weekday
  v_day_hours JSONB;
  v_open_text TEXT;
  v_close_text TEXT;
  v_open_min INTEGER;
  v_close_min INTEGER;
  v_overnight BOOLEAN := false;
  v_hours_usable BOOLEAN := false;
  v_day_closed BOOLEAN := false;
BEGIN
  -- ── Advisory lock FIRST: serialize ALL reservations for the same resource ──
  -- M510: no date in the key — a late booking on D and an early booking on D+1
  -- can overlap, so neighbouring dates must serialise too.
  -- Must precede idempotency lookup so concurrent retries see each other's inserts.
  v_lock_key := abs(hashtext(
    p_business_id::text || '|sr|' || p_seating_resource_id::text
  ));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- ── Bot session idempotency (full selection match, AFTER lock) ──
  IF p_bot_session_id IS NOT NULL THEN
    SELECT b.id, b.reference_code INTO v_booking_id, v_ref
    FROM bookings b
    WHERE b.bot_session_id = p_bot_session_id
      AND b.business_id = p_business_id
      AND b.user_id = p_user_id
      AND b.seating_resource_id = p_seating_resource_id
      AND b.date = p_date
      AND b.time = p_time::TIME
      AND b.party_size = p_party_size
      AND b.status IN ('pending', 'confirmed', 'in_progress')
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_booking_id, v_ref, true;
      RETURN;
    END IF;
  END IF;

  -- ── Validate seating resource ──
  SELECT sr.id, sr.business_id, sr.capacity, sr.min_party_size,
         sr.is_active, sr.reservation_duration_minutes, sr.deposit_amount,
         sr.available_days, sr.available_from, sr.available_to
  INTO v_resource
  FROM seating_resources sr
  WHERE sr.id = p_seating_resource_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'seating_resource_not_found:Resource % does not exist', p_seating_resource_id;
  END IF;
  IF NOT v_resource.is_active THEN
    RAISE EXCEPTION 'seating_resource_inactive:Resource % is not active', p_seating_resource_id;
  END IF;
  IF v_resource.business_id != p_business_id THEN
    RAISE EXCEPTION 'seating_resource_wrong_business:Resource % does not belong to business %',
      p_seating_resource_id, p_business_id;
  END IF;

  -- ── Commit-time deposit/duration revalidation (M383 pattern) ──
  IF p_expected_deposit IS NOT NULL AND v_resource.deposit_amount != p_expected_deposit THEN
    RAISE EXCEPTION 'deposit_changed:Resource deposit changed from % to %',
      p_expected_deposit, v_resource.deposit_amount;
  END IF;
  IF p_expected_duration IS NOT NULL AND v_resource.reservation_duration_minutes != p_expected_duration THEN
    RAISE EXCEPTION 'duration_changed:Resource duration changed from % to %',
      p_expected_duration, v_resource.reservation_duration_minutes;
  END IF;

  -- DB-authoritative values: flat deposit per reservation (Owner decision 2026-10-27)
  v_committed_deposit := CASE WHEN p_expected_deposit IS NOT NULL
    THEN v_resource.deposit_amount ELSE p_deposit_amount END;
  v_committed_duration := CASE WHEN p_expected_duration IS NOT NULL
    THEN v_resource.reservation_duration_minutes ELSE COALESCE(p_duration_minutes, v_resource.reservation_duration_minutes) END;
  -- Total = flat deposit (not multiplied by party_size)
  v_committed_total := v_committed_deposit;

  -- ── Party size validation ──
  IF p_party_size < v_resource.min_party_size THEN
    RAISE EXCEPTION 'party_too_small:Minimum party size is %', v_resource.min_party_size;
  END IF;
  IF p_party_size > v_resource.capacity THEN
    RAISE EXCEPTION 'party_too_large:Maximum capacity is %', v_resource.capacity;
  END IF;

  -- ── Availability enforcement (day + time window) ──
  -- Weekday: use p_date directly — the date represents the local calendar day
  -- the customer selected. AT TIME ZONE on DATE shifts midnight to a different
  -- day for non-UTC timezones (confirmed PG 16.13 bug reproduction).
  v_day_name := lower(to_char(p_date, 'fmday'));

  IF v_resource.available_days IS NOT NULL AND array_length(v_resource.available_days, 1) > 0 THEN
    IF NOT (v_day_name = ANY(v_resource.available_days)) THEN
      RAISE EXCEPTION 'day_unavailable:This resource is not available on %', initcap(v_day_name);
    END IF;
  END IF;

  -- All time comparisons use minutes-since-midnight to avoid TIME wrap at 24:00.
  -- TIME '23:30' + 90min = '01:00' in PG, but 23*60+30+90 = 1470 > 22*60 = 1320.
  v_req_start_min := EXTRACT(HOUR FROM p_time::TIME)::int * 60
                   + EXTRACT(MINUTE FROM p_time::TIME)::int;
  v_req_end_min := v_req_start_min + v_committed_duration;

  IF v_resource.available_from IS NOT NULL THEN
    v_from_min := EXTRACT(HOUR FROM v_resource.available_from)::int * 60
                + EXTRACT(MINUTE FROM v_resource.available_from)::int;
    IF v_req_start_min < v_from_min THEN
      RAISE EXCEPTION 'before_opening:Earliest reservation time is %', v_resource.available_from::text;
    END IF;
  END IF;

  -- ── M510: p_date's business hours (weekday entry of operating_hours) ──
  -- Three outcomes:
  --   closed: the entry is an object with closed = true or is_open = false;
  --   usable: an object, closed absent/false, is_open absent/true, and both
  --           open/close are "HH:MM" (overnight when close <= open);
  --   anything else (missing business, {} hours, missing keys, bad shapes):
  --           no business-hours check and NOT overnight, exactly as M476.
  SELECT b.operating_hours -> v_day_name INTO v_day_hours
  FROM businesses b
  WHERE b.id = p_business_id;

  IF jsonb_typeof(v_day_hours) = 'object' THEN
    IF v_day_hours -> 'closed' = 'true'::jsonb OR v_day_hours -> 'is_open' = 'false'::jsonb THEN
      v_day_closed := true;
    ELSIF (NOT (v_day_hours ? 'closed') OR v_day_hours -> 'closed' = 'false'::jsonb)
      AND (NOT (v_day_hours ? 'is_open') OR v_day_hours -> 'is_open' = 'true'::jsonb)
    THEN
      -- (A non-string open/close can never match the HH:MM pattern below.)
      v_open_text := v_day_hours ->> 'open';
      v_close_text := v_day_hours ->> 'close';
      IF v_open_text ~ '^([01]\d|2[0-3]):[0-5]\d$' AND v_close_text ~ '^([01]\d|2[0-3]):[0-5]\d$' THEN
        v_open_min := split_part(v_open_text, ':', 1)::int * 60 + split_part(v_open_text, ':', 2)::int;
        v_close_min := split_part(v_close_text, ':', 1)::int * 60 + split_part(v_close_text, ':', 2)::int;
        v_hours_usable := true;
        v_overnight := v_close_min <= v_open_min;
      END IF;
    END IF;
  END IF;

  IF v_req_end_min > 1440 THEN
    -- Not an overnight day, or the start is not before midnight ('24:00' parses
    -- as TIME): the existing M476 rejection, unchanged.
    IF NOT v_overnight OR v_req_start_min >= 1440 THEN
      RAISE EXCEPTION 'past_midnight:Reservation would extend past midnight';
    END IF;
    -- Overnight day: the booking must end at or before the next-day closing.
    IF v_req_end_min > v_close_min + 1440 THEN
      RAISE EXCEPTION 'after_closing:Reservation would extend past closing time %', v_close_text;
    END IF;
  END IF;

  -- ── M510: the start must fall inside the business's opening hours ──
  -- Applies in addition to the table's own window. No check without usable hours.
  IF v_day_closed THEN
    RAISE EXCEPTION 'day_unavailable:The business is closed on %', initcap(v_day_name);
  END IF;
  IF v_hours_usable THEN
    -- Overnight and daytime days alike: start at or after opening, before 24:00.
    IF v_req_start_min < v_open_min OR v_req_start_min >= 1440 THEN
      RAISE EXCEPTION 'before_opening:Earliest reservation time is %', v_open_text;
    END IF;
    -- Daytime day: end at or before closing (overnight ends are checked above).
    IF NOT v_overnight AND v_req_end_min > v_close_min THEN
      RAISE EXCEPTION 'after_closing:Reservation would extend past closing time %', v_close_text;
    END IF;
  END IF;

  IF v_resource.available_to IS NOT NULL THEN
    v_to_min := EXTRACT(HOUR FROM v_resource.available_to)::int * 60
              + EXTRACT(MINUTE FROM v_resource.available_to)::int;
    IF v_req_end_min > v_to_min THEN
      RAISE EXCEPTION 'after_closing:Reservation would extend past closing time %', v_resource.available_to::text;
    END IF;
  END IF;

  -- ── Time overlap check (absolute minutes relative to p_date's midnight) ──
  -- M510: a booking on D-1 may run past midnight into D, and a late booking on D
  -- may run into D+1, so neighbouring dates are compared on one axis:
  -- existing start = (b.date - p_date) * 1440 + minutes of b.time.
  SELECT COUNT(*) INTO v_overlap_count
  FROM bookings b
  WHERE b.seating_resource_id = p_seating_resource_id
    AND b.date BETWEEN p_date - 1 AND p_date + 1
    AND b.status IN ('pending', 'confirmed', 'in_progress')
    AND v_req_start_min < (
          (b.date - p_date) * 1440
          + EXTRACT(HOUR FROM b.time)::int * 60 + EXTRACT(MINUTE FROM b.time)::int
          + COALESCE((b.metadata->>'duration_minutes')::int, v_resource.reservation_duration_minutes)
        )
    AND v_req_end_min > (
          (b.date - p_date) * 1440
          + EXTRACT(HOUR FROM b.time)::int * 60 + EXTRACT(MINUTE FROM b.time)::int
        );

  IF v_overlap_count > 0 THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, false;
    RETURN;
  END IF;

  -- ── Insert booking ──
  INSERT INTO bookings (
    business_id, user_id, seating_resource_id,
    date, time, party_size,
    flow_type, channel,
    deposit_amount, deposit_status, status,
    guest_name, guest_phone, guest_email,
    special_requests, total_amount, quantity,
    bot_session_id, metadata
  ) VALUES (
    p_business_id, p_user_id, p_seating_resource_id,
    p_date, p_time::TIME, p_party_size,
    'table_reservation'::flow_type, 'whatsapp'::booking_channel,
    v_committed_deposit,
    CASE WHEN v_committed_deposit > 0 THEN 'pending'::deposit_status ELSE 'none'::deposit_status END,
    CASE WHEN v_committed_deposit > 0 THEN 'pending'::reservation_status ELSE 'confirmed'::reservation_status END,
    p_guest_name, p_guest_phone, p_guest_email,
    p_special_requests, v_committed_total, p_party_size,
    p_bot_session_id,
    jsonb_build_object('duration_minutes', v_committed_duration)
  )
  RETURNING bookings.id, bookings.reference_code
  INTO v_booking_id, v_ref;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- ACL: service_role only (matches book_slot_atomic pattern)
REVOKE ALL ON FUNCTION public.book_table_atomic(
  UUID, UUID, UUID, UUID, DATE, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER,
  INTEGER, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.book_table_atomic(
  UUID, UUID, UUID, UUID, DATE, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER,
  INTEGER, INTEGER
) FROM anon;
REVOKE ALL ON FUNCTION public.book_table_atomic(
  UUID, UUID, UUID, UUID, DATE, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER,
  INTEGER, INTEGER
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.book_table_atomic(
  UUID, UUID, UUID, UUID, DATE, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER,
  INTEGER, INTEGER
) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Self-check (any failure aborts and rolls back the whole file)
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE
  v_fn regprocedure;
  v_definer BOOLEAN;
  v_config TEXT[];
  v_src TEXT;
BEGIN
  v_fn := to_regprocedure(
    'public.book_table_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,text,integer,integer,integer)'
  );
  IF v_fn IS NULL THEN
    RAISE EXCEPTION '510 SELF-CHECK FAILED: book_table_atomic with the 18-argument signature not found';
  END IF;

  SELECT p.prosecdef, p.proconfig, p.prosrc INTO v_definer, v_config, v_src
  FROM pg_proc p WHERE p.oid = v_fn;
  IF v_definer THEN
    RAISE EXCEPTION '510 SELF-CHECK FAILED: book_table_atomic must be SECURITY INVOKER, not DEFINER';
  END IF;
  IF v_config IS NOT NULL THEN
    RAISE EXCEPTION '510 SELF-CHECK FAILED: book_table_atomic must carry no SET/proconfig, found %', v_config;
  END IF;
  IF v_src NOT LIKE '%v_overnight%' OR v_src NOT LIKE '%p_date - 1 AND p_date + 1%'
     OR v_src NOT LIKE '%v_hours_usable%' OR v_src NOT LIKE '%The business is closed on%' THEN
    RAISE EXCEPTION '510 SELF-CHECK FAILED: book_table_atomic body is not the M510 overnight version';
  END IF;

  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '510 SELF-CHECK FAILED: service_role lacks EXECUTE on book_table_atomic';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '510 SELF-CHECK FAILED: anon can EXECUTE book_table_atomic';
  END IF;
  IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '510 SELF-CHECK FAILED: authenticated can EXECUTE book_table_atomic';
  END IF;

  RAISE NOTICE '510 SELF-CHECK PASSED: book_table_atomic overnight-aware, INVOKER, no proconfig, service_role only';
END;
$$;
