-- Internal date/time holds share M510's cross-date resource lock and capacity.
-- Local timestamp fields follow bookings.date + bookings.time in business timezone.
CREATE SCHEMA IF NOT EXISTS private;
CREATE UNIQUE INDEX IF NOT EXISTS seating_resources_id_business_key
  ON public.seating_resources(id, business_id);
CREATE TABLE public.seating_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  seating_resource_id uuid NOT NULL,
  starts_at timestamp NOT NULL,
  ends_at timestamp NOT NULL CHECK (ends_at > starts_at),
  seats integer,
  whole_resource boolean NOT NULL DEFAULT false,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 100),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES auth.users(id),
  released_at timestamptz,
  FOREIGN KEY (seating_resource_id, business_id) REFERENCES public.seating_resources(id, business_id),
  UNIQUE (business_id, group_id, seating_resource_id),
  CHECK ((whole_resource AND seats IS NULL) OR (NOT whole_resource AND seats IS NOT NULL AND seats BETWEEN 1 AND 500)),
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE INDEX seating_holds_active_resource ON public.seating_holds(business_id, seating_resource_id, starts_at, ends_at)
  WHERE released_at IS NULL;
ALTER TABLE public.seating_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seating_holds FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.seating_holds TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.seating_holds TO service_role;
CREATE POLICY seating_holds_owner_read ON public.seating_holds FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = business_id AND b.owner_id = auth.uid()));
CREATE POLICY seating_holds_service ON public.seating_holds FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Occupancy peaks at the requested start or an allocation's start. Equal end/start
-- boundaries are half-open, so back-to-back allocations never consume seats together.
CREATE FUNCTION public.seating_occupied_peak(
  p_business_id uuid, p_resource_id uuid, p_start timestamp, p_end timestamp,
  p_capacity integer, p_include_bookings boolean DEFAULT true
) RETURNS integer LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH allocations AS (
    SELECT h.starts_at AS starts, h.ends_at AS ends,
      CASE WHEN h.whole_resource THEN p_capacity ELSE h.seats END AS seats
    FROM public.seating_holds h
    WHERE h.business_id = p_business_id AND h.seating_resource_id = p_resource_id
      AND h.released_at IS NULL AND h.starts_at < p_end AND h.ends_at > p_start
    UNION ALL
    SELECT b.date + b.time,
      b.date + b.time + make_interval(mins => COALESCE((b.metadata->>'duration_minutes')::integer, sr.reservation_duration_minutes)),
      b.party_size
    FROM public.bookings b JOIN public.seating_resources sr ON sr.id = b.seating_resource_id
    WHERE p_include_bookings AND b.business_id = p_business_id AND b.seating_resource_id = p_resource_id
      AND b.status IN ('pending', 'confirmed', 'in_progress')
      AND b.date + b.time < p_end
      AND b.date + b.time + make_interval(mins => COALESCE((b.metadata->>'duration_minutes')::integer, sr.reservation_duration_minutes)) > p_start
  ), boundaries AS (
    SELECT p_start AS at UNION SELECT starts FROM allocations WHERE starts >= p_start
  )
  SELECT COALESCE(MAX((SELECT COALESCE(SUM(a.seats), 0) FROM allocations a WHERE a.starts <= t.at AND a.ends > t.at)), 0)::integer
  FROM boundaries t;
$$;
REVOKE ALL ON FUNCTION public.seating_occupied_peak(uuid,uuid,timestamp,timestamp,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.seating_occupied_peak(uuid,uuid,timestamp,timestamp,integer,boolean) TO service_role;

CREATE FUNCTION public.create_seating_hold(
  p_business_id uuid, p_actor_id uuid, p_group_id uuid, p_resource_ids uuid[],
  p_start timestamp, p_end timestamp, p_seats integer, p_whole_resource boolean, p_label text
) RETURNS SETOF public.seating_holds LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_ids uuid[];
  v_resource public.seating_resources%ROWTYPE;
  v_id uuid;
  v_existing integer;
BEGIN
  IF current_setting('transaction_isolation') != 'read committed' THEN
    RAISE EXCEPTION 'seating_holds_requires_read_committed' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id=p_business_id AND owner_id=p_actor_id) THEN
    RAISE EXCEPTION 'hold_unauthorized' USING ERRCODE='42501';
  END IF;
  SELECT array_agg(DISTINCT id ORDER BY id) INTO v_ids FROM unnest(p_resource_ids) id;
  IF p_group_id IS NULL OR COALESCE(cardinality(v_ids),0)=0 OR array_position(v_ids,NULL) IS NOT NULL
    OR p_start IS NULL OR p_end IS NULL OR p_start >= p_end OR p_whole_resource IS NULL
    OR p_label IS NULL OR length(btrim(p_label)) NOT BETWEEN 1 AND 100
    OR (NOT p_whole_resource AND (p_seats IS NULL OR p_seats NOT BETWEEN 1 AND 500)) THEN
    RAISE EXCEPTION 'hold_invalid' USING ERRCODE='22023';
  END IF;
  -- Serialize request identity before resource locks, including concurrent retries.
  PERFORM pg_advisory_xact_lock(abs(hashtext(p_business_id::text || '|hold|' || p_group_id::text)::bigint));
  SELECT count(*) INTO v_existing FROM public.seating_holds WHERE business_id=p_business_id AND group_id=p_group_id;
  IF v_existing > 0 THEN
    IF v_existing != cardinality(v_ids) OR EXISTS (
      SELECT 1 FROM public.seating_holds h WHERE h.business_id=p_business_id AND h.group_id=p_group_id
        AND (NOT h.seating_resource_id=ANY(v_ids) OR h.starts_at!=p_start OR h.ends_at!=p_end
          OR h.whole_resource!=p_whole_resource OR h.seats IS DISTINCT FROM CASE WHEN p_whole_resource THEN NULL ELSE p_seats END
          OR h.label!=btrim(p_label) OR h.created_by!=p_actor_id)
    ) THEN RAISE EXCEPTION 'hold_retry_mismatch' USING ERRCODE='22023'; END IF;
    RETURN QUERY SELECT * FROM public.seating_holds WHERE business_id=p_business_id AND group_id=p_group_id;
    RETURN;
  END IF;
  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM pg_advisory_xact_lock(abs(hashtext(p_business_id::text || '|sr|' || v_id::text)::bigint));
  END LOOP;
  FOREACH v_id IN ARRAY v_ids LOOP
    SELECT * INTO v_resource FROM public.seating_resources WHERE id=v_id AND business_id=p_business_id FOR UPDATE;
    IF NOT FOUND OR NOT v_resource.is_active THEN RAISE EXCEPTION 'hold_resource_unavailable' USING ERRCODE='22023'; END IF;
    IF public.seating_occupied_peak(p_business_id,v_id,p_start,p_end,v_resource.capacity,true)
      + (CASE WHEN p_whole_resource THEN v_resource.capacity ELSE p_seats END) > v_resource.capacity THEN
      RAISE EXCEPTION 'hold_capacity_conflict' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.seating_holds(group_id,business_id,seating_resource_id,starts_at,ends_at,seats,whole_resource,label,created_by)
    VALUES(p_group_id,p_business_id,v_id,p_start,p_end,CASE WHEN p_whole_resource THEN NULL ELSE p_seats END,p_whole_resource,btrim(p_label),p_actor_id);
  END LOOP;
  RETURN QUERY SELECT * FROM public.seating_holds WHERE business_id=p_business_id AND group_id=p_group_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_seating_hold(uuid,uuid,uuid,uuid[],timestamp,timestamp,integer,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_seating_hold(uuid,uuid,uuid,uuid[],timestamp,timestamp,integer,boolean,text) TO service_role;

CREATE FUNCTION public.release_seating_hold(p_business_id uuid,p_actor_id uuid,p_group_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_id uuid; v_count integer;
BEGIN
  IF current_setting('transaction_isolation') != 'read committed' THEN
    RAISE EXCEPTION 'seating_holds_requires_read_committed' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.businesses WHERE id=p_business_id AND owner_id=p_actor_id) THEN
    RAISE EXCEPTION 'hold_unauthorized' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(abs(hashtext(p_business_id::text || '|hold|' || p_group_id::text)::bigint));
  FOR v_id IN SELECT seating_resource_id FROM public.seating_holds
    WHERE business_id=p_business_id AND group_id=p_group_id ORDER BY seating_resource_id LOOP
    PERFORM pg_advisory_xact_lock(abs(hashtext(p_business_id::text || '|sr|' || v_id::text)::bigint));
  END LOOP;
  UPDATE public.seating_holds SET released_at=now(),released_by=p_actor_id
    WHERE business_id=p_business_id AND group_id=p_group_id AND released_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.release_seating_hold(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.release_seating_hold(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION private.seating_hold_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF ROW(NEW.id,NEW.group_id,NEW.business_id,NEW.seating_resource_id,NEW.starts_at,NEW.ends_at,NEW.seats,NEW.whole_resource,NEW.label,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.group_id,OLD.business_id,OLD.seating_resource_id,OLD.starts_at,OLD.ends_at,OLD.seats,OLD.whole_resource,OLD.label,OLD.created_by,OLD.created_at)
    OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR NEW.released_by IS NULL THEN
    RAISE EXCEPTION 'hold_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.seating_hold_immutable() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER seating_hold_immutable BEFORE UPDATE ON public.seating_holds FOR EACH ROW EXECUTE FUNCTION private.seating_hold_immutable();

-- Preserve M510 signature, retry handling, hours and financial behavior.
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
  -- M510: business open time on one minute axis relative to p_date
  v_hours JSONB;
  v_entry JSONB;
  v_open_text TEXT;
  v_close_text TEXT;
  v_open_min INTEGER;
  v_close_min INTEGER;
  v_state TEXT;
  v_day_state TEXT := 'unknown';  -- p_date's own entry: open | closed | unknown
  v_k INTEGER;
  v_i INTEGER;
  v_iv_start INTEGER;
  v_iv_end INTEGER;
  v_starts INTEGER[] := '{}';     -- joined stretches of open time
  v_ends INTEGER[] := '{}';
  v_inside BOOLEAN := false;
  v_next_open INTEGER;
BEGIN
  IF current_setting('transaction_isolation') != 'read committed' THEN
    RAISE EXCEPTION 'seating_holds_requires_read_committed' USING ERRCODE='40001';
  END IF;
  -- ── Advisory lock FIRST: serialize ALL reservations for the same resource ──
  -- M510: no date in the key — a late booking on D and an early booking on D+1
  -- can overlap, so neighbouring dates must serialise too.
  -- Must precede idempotency lookup so concurrent retries see each other's inserts.
  -- ::bigint before abs(): abs() of int4 -2147483648 raises "integer out of range",
  -- and with a per-table key one unlucky table would then always fail.
  v_lock_key := abs(hashtext(
    p_business_id::text || '|sr|' || p_seating_resource_id::text
  )::bigint);
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

  -- ── M510: business opening hours (Owner decision 2026-11-04, revised) ──
  -- A booking is allowed when [start, end] lies inside one stretch of open time.
  -- Each weekday entry of operating_hours is one of:
  --   closed:  an object with closed = true or is_open = false (no open time);
  --   open:    an object, closed absent/false, is_open absent/true, and open and
  --            close both "HH:MM". Open time is [open, close], with close + 24h
  --            when close <= open (so open == close is 24 hours from open);
  --   unknown: anything else ({} hours, missing day or keys, bad shapes).
  -- The open time of D-1, D and D+1 is placed on one minute axis relative to
  -- p_date (shifted by -1440 / 0 / +1440), and stretches that touch or overlap
  -- are joined, so back-to-back open days join up. If p_date's own entry is
  -- unknown there is no business-hours check, exactly as M476.

  -- '24:00' parses as TIME but is not a time on p_date (it is D+1 00:00).
  IF v_req_start_min >= 1440 THEN
    RAISE EXCEPTION 'past_midnight:Reservation would extend past midnight';
  END IF;

  SELECT b.operating_hours INTO v_hours
  FROM businesses b
  WHERE b.id = p_business_id;

  FOR v_k IN -1..1 LOOP
    v_entry := v_hours -> lower(to_char(p_date + v_k, 'fmday'));
    v_state := 'unknown';
    IF jsonb_typeof(v_entry) = 'object' THEN
      IF v_entry -> 'closed' = 'true'::jsonb OR v_entry -> 'is_open' = 'false'::jsonb THEN
        v_state := 'closed';
      ELSIF (NOT (v_entry ? 'closed') OR v_entry -> 'closed' = 'false'::jsonb)
        AND (NOT (v_entry ? 'is_open') OR v_entry -> 'is_open' = 'true'::jsonb)
      THEN
        -- (A non-string open/close can never match the HH:MM pattern below.)
        v_open_text := v_entry ->> 'open';
        v_close_text := v_entry ->> 'close';
        IF v_open_text ~ '^([01]\d|2[0-3]):[0-5]\d$' AND v_close_text ~ '^([01]\d|2[0-3]):[0-5]\d$' THEN
          v_state := 'open';
          v_open_min := split_part(v_open_text, ':', 1)::int * 60 + split_part(v_open_text, ':', 2)::int;
          v_close_min := split_part(v_close_text, ':', 1)::int * 60 + split_part(v_close_text, ':', 2)::int;
          v_iv_start := v_open_min + v_k * 1440;
          v_iv_end := CASE WHEN v_close_min <= v_open_min THEN v_close_min + 1440 ELSE v_close_min END + v_k * 1440;
          -- Starts increase with v_k, so joining with the previous stretch is enough.
          v_i := cardinality(v_starts);
          IF v_i > 0 AND v_iv_start <= v_ends[v_i] THEN
            v_ends[v_i] := greatest(v_ends[v_i], v_iv_end);
          ELSE
            v_starts := v_starts || v_iv_start;
            v_ends := v_ends || v_iv_end;
          END IF;
        END IF;
      END IF;
    END IF;
    IF v_k = 0 THEN
      v_day_state := v_state;
    END IF;
  END LOOP;

  IF v_day_state = 'unknown' THEN
    -- No usable hours for p_date: the existing M476 rejection, unchanged.
    IF v_req_end_min > 1440 THEN
      RAISE EXCEPTION 'past_midnight:Reservation would extend past midnight';
    END IF;
  ELSE
    FOR v_i IN 1..cardinality(v_starts) LOOP
      IF v_starts[v_i] <= v_req_start_min AND v_req_start_min < v_ends[v_i] THEN
        v_inside := true;
        IF v_req_end_min > v_ends[v_i] THEN
          RAISE EXCEPTION 'after_closing:Reservation would extend past closing time %',
            lpad((v_ends[v_i] % 1440 / 60)::text, 2, '0') || ':'
            || lpad((v_ends[v_i] % 60)::text, 2, '0');
        END IF;
        -- Joined stretches can run past the end of D+1, but the overlap check
        -- only reads D-1..D+1: nothing may end after 2880 (D+2 00:00).
        IF v_req_end_min > 2880 THEN
          RAISE EXCEPTION 'after_closing:Reservation would extend past closing time 00:00 (end of the next day)';
        END IF;
      END IF;
    END LOOP;
    IF NOT v_inside THEN
      -- Starts outside any open time: before_opening when the business still
      -- opens later on p_date, otherwise day_unavailable.
      SELECT min(s) INTO v_next_open FROM unnest(v_starts) AS s
      WHERE s > v_req_start_min AND s < 1440;
      IF v_next_open IS NOT NULL THEN
        RAISE EXCEPTION 'before_opening:Earliest reservation time is %',
          lpad((v_next_open / 60)::text, 2, '0') || ':' || lpad((v_next_open % 60)::text, 2, '0');
      ELSIF v_day_state = 'closed' THEN
        RAISE EXCEPTION 'day_unavailable:The business is closed on %', initcap(v_day_name);
      ELSE
        RAISE EXCEPTION 'day_unavailable:The business is not open at that time on %', initcap(v_day_name);
      END IF;
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

  -- Partial internal holds consume seats while customer bookings remain exclusive.
  IF public.seating_occupied_peak(p_business_id, p_seating_resource_id,
      p_date + p_time::time, p_date + p_time::time + make_interval(mins => v_committed_duration),
      v_resource.capacity, false) + p_party_size > v_resource.capacity THEN
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

-- A direct UPDATE already owns its row before a row trigger fires. Never wait
-- for the advisory lock in that order: fail the transaction with 40001 instead.
CREATE FUNCTION private.guard_seating_capacity() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now timestamp; v_peak integer;
BEGIN
  IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    RAISE EXCEPTION 'seating_business_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.capacity IS NOT DISTINCT FROM OLD.capacity THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation') != 'read committed' THEN
    RAISE EXCEPTION 'seating_capacity_requires_read_committed' USING ERRCODE='40001';
  END IF;
  IF NOT pg_try_advisory_xact_lock(abs(hashtext(OLD.business_id::text || '|sr|' || OLD.id::text)::bigint)) THEN
    RAISE EXCEPTION 'seating_capacity_retry' USING ERRCODE='40001';
  END IF;
  -- Separate SPI statement after acquiring the lock gets a fresh RC snapshot.
  SELECT now() AT TIME ZONE COALESCE(timezone,'UTC') INTO v_now FROM public.businesses WHERE id=OLD.business_id;
  SELECT public.seating_occupied_peak(OLD.business_id,OLD.id,v_now,'infinity'::timestamp,NEW.capacity,true) INTO v_peak;
  IF v_peak > NEW.capacity THEN
    RAISE EXCEPTION 'seating_capacity_conflict' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.guard_seating_capacity() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_seating_capacity BEFORE UPDATE OF capacity,business_id ON public.seating_resources
FOR EACH ROW EXECUTE FUNCTION private.guard_seating_capacity();

-- Existing dashboard/status writers can reactivate or move a table booking.
-- Release-only writes (cancel/complete/delete/resource removal) bypass this guard:
-- removing occupancy cannot overbook, and must remain possible under contention.
CREATE FUNCTION private.guard_seating_booking_occupancy() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_resource public.seating_resources%ROWTYPE;
  v_old_duration integer;
  v_duration integer;
  v_key bigint;
  v_keys bigint[];
  v_start timestamp;
  v_end timestamp;
BEGIN
  IF NEW.seating_resource_id IS NULL OR NEW.status NOT IN ('pending','confirmed','in_progress') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.seating_resource_id IS NOT NULL AND OLD.status IN ('pending','confirmed','in_progress') THEN
    SELECT COALESCE((OLD.metadata->>'duration_minutes')::integer,reservation_duration_minutes)
      INTO v_old_duration FROM public.seating_resources WHERE id=OLD.seating_resource_id;
    SELECT COALESCE((NEW.metadata->>'duration_minutes')::integer,reservation_duration_minutes)
      INTO v_duration FROM public.seating_resources WHERE id=NEW.seating_resource_id;
    IF ROW(OLD.business_id,OLD.seating_resource_id,OLD.date,OLD.time,OLD.party_size,v_old_duration)
      IS NOT DISTINCT FROM ROW(NEW.business_id,NEW.seating_resource_id,NEW.date,NEW.time,NEW.party_size,v_duration) THEN RETURN NEW; END IF;
  END IF;
  IF current_setting('transaction_isolation') != 'read committed' THEN
    RAISE EXCEPTION 'seating_booking_requires_read_committed' USING ERRCODE='40001';
  END IF;
  v_keys := ARRAY[abs(hashtext(NEW.business_id::text || '|sr|' || NEW.seating_resource_id::text)::bigint)];
  IF TG_OP='UPDATE' AND OLD.seating_resource_id IS NOT NULL THEN
    v_keys := array_append(v_keys,abs(hashtext(OLD.business_id::text || '|sr|' || OLD.seating_resource_id::text)::bigint));
  END IF;
  FOR v_key IN SELECT DISTINCT k FROM unnest(v_keys) k ORDER BY k LOOP
    IF NOT pg_try_advisory_xact_lock(v_key) THEN
      RAISE EXCEPTION 'seating_booking_retry' USING ERRCODE='40001';
    END IF;
  END LOOP;
  -- Separate statement after try-lock: fresh RC view, including committed holds.
  SELECT * INTO v_resource FROM public.seating_resources
    WHERE id=NEW.seating_resource_id AND business_id=NEW.business_id;
  IF NOT FOUND OR NOT v_resource.is_active THEN RAISE EXCEPTION 'seating_booking_resource_invalid' USING ERRCODE='23514'; END IF;
  v_duration := COALESCE((NEW.metadata->>'duration_minutes')::integer,v_resource.reservation_duration_minutes);
  IF NEW.date IS NULL OR NEW.time IS NULL OR NEW.party_size IS NULL OR NEW.party_size < 1
    OR NEW.party_size > v_resource.capacity OR v_duration IS NULL OR v_duration < 1 THEN
    RAISE EXCEPTION 'seating_booking_values_invalid' USING ERRCODE='23514';
  END IF;
  v_start := NEW.date + NEW.time;
  v_end := v_start + make_interval(mins=>v_duration);
  IF EXISTS (
    SELECT 1 FROM public.bookings b WHERE b.id IS DISTINCT FROM NEW.id
      AND b.business_id=NEW.business_id AND b.seating_resource_id=NEW.seating_resource_id
      AND b.status IN ('pending','confirmed','in_progress')
      AND b.date+b.time < v_end
      AND b.date+b.time+make_interval(mins=>COALESCE((b.metadata->>'duration_minutes')::integer,v_resource.reservation_duration_minutes)) > v_start
  ) OR public.seating_occupied_peak(NEW.business_id,NEW.seating_resource_id,v_start,v_end,v_resource.capacity,false)+NEW.party_size > v_resource.capacity THEN
    RAISE EXCEPTION 'seating_booking_capacity_conflict' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.guard_seating_booking_occupancy() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_seating_booking_occupancy BEFORE INSERT OR UPDATE ON public.bookings
FOR EACH ROW EXECUTE FUNCTION private.guard_seating_booking_occupancy();

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.seating_holds'::regclass) THEN RAISE EXCEPTION '542 RLS missing'; END IF;
  IF has_table_privilege('authenticated','public.seating_holds','INSERT')
    OR has_table_privilege('authenticated','public.seating_holds','UPDATE')
    OR has_table_privilege('anon','public.seating_holds','SELECT') THEN RAISE EXCEPTION '542 hold grants unsafe'; END IF;
  IF has_function_privilege('authenticated','public.create_seating_hold(uuid,uuid,uuid,uuid[],timestamp,timestamp,integer,boolean,text)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.create_seating_hold(uuid,uuid,uuid,uuid[],timestamp,timestamp,integer,boolean,text)','EXECUTE')
    THEN RAISE EXCEPTION '542 RPC grants invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.bookings'::regclass AND tgname='guard_seating_booking_occupancy' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.seating_resources'::regclass AND tgname='guard_seating_capacity' AND NOT tgisinternal)
    THEN RAISE EXCEPTION '542 occupancy guards missing'; END IF;
  IF pg_get_functiondef('public.book_table_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,text,integer,integer,integer)'::regprocedure)
    NOT LIKE '%public.seating_occupied_peak%' THEN RAISE EXCEPTION '542 booking authority missing'; END IF;
END;
$$;
