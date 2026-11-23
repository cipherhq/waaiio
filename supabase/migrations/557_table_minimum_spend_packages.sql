-- ═══════════════════════════════════════════════════════
-- Migration 557: minimum spend and bottle packages for table reservations
-- (Owner decision 2026-11-23, "go": sell club VIP tables properly)
--
-- Why: a table could only ask for a flat deposit. Nightclubs sell VIP tables
-- with a minimum spend and bottle packages ("Gold: 2 Hennessy VS + 1 Moët").
--
-- What it changes, on public.seating_resources:
--   * minimum_spend INTEGER NULL (> 0): shown to the customer; NULL = none;
--   * payment_mode TEXT NOT NULL DEFAULT 'deposit': what the customer pays
--     now. 'deposit' = the existing deposit_amount (the rest at the venue);
--     'full' = the chosen package price, or the minimum spend when no
--     package is chosen (the deposit when the table has no minimum spend);
--   * packages JSONB NOT NULL DEFAULT '[]': at most 9 packages (a WhatsApp
--     list has 10 rows; the 10th is "No package"), each exactly
--     {id: uuid text, name: 1-60 chars, includes: 0-300 chars, price: whole
--     number 1..999999999}, ids unique. Checked by the trigger
--     seating_packages_valid (private, SECURITY INVOKER);
--   * CHECK seating_full_payment_needs_offer: 'full' needs a minimum spend
--     or at least one package.
-- Packages live on the table row, so a package can never belong to another
-- business's table. The new columns follow the table's existing grants and
-- RLS (owner manages own tables, admin, service role); no grant, RLS or
-- policy change.
--
-- public.book_table_atomic (last defined by M542) gets four optional
-- parameters: p_package_id, p_expected_payable, p_expected_minimum_spend,
-- p_expected_package_price. The old 18-argument signature is dropped and the
-- function re-created with them (SECURITY INVOKER, no SET clause, exactly as
-- M542; nothing ever ALTERed it). It works out the amount to pay now from
-- the locked table row, refuses a changed amount, minimum spend or package
-- price with deposit_changed, refuses an unknown package with
-- package_unavailable, and stores the offer in bookings.metadata.table_offer
-- ({payment_mode, minimum_spend, package}). A caller without
-- p_expected_payable (the app before this change) can still book every table
-- that has no package and pays only the deposit; any other table is refused
-- with deposit_changed, never charged a wrong amount.
--
-- Existing rows get NULL / 'deposit' / '[]': they book exactly as before,
-- with the same deposit, total, status and metadata.
--
-- Must be applied after M542 and before the app code that reads these
-- columns is deployed. Idempotent: a re-run changes nothing.
-- No BEGIN/COMMIT: applied as one whole-file statement.
-- ═══════════════════════════════════════════════════════

ALTER TABLE public.seating_resources
  ADD COLUMN IF NOT EXISTS minimum_spend INTEGER,
  ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'deposit',
  ADD COLUMN IF NOT EXISTS packages JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.seating_resources'::regclass AND conname = 'seating_minimum_spend_positive') THEN
    ALTER TABLE public.seating_resources ADD CONSTRAINT seating_minimum_spend_positive
      CHECK (minimum_spend IS NULL OR minimum_spend > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.seating_resources'::regclass AND conname = 'seating_payment_mode_valid') THEN
    ALTER TABLE public.seating_resources ADD CONSTRAINT seating_payment_mode_valid
      CHECK (payment_mode IN ('deposit', 'full'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.seating_resources'::regclass AND conname = 'seating_full_payment_needs_offer') THEN
    ALTER TABLE public.seating_resources ADD CONSTRAINT seating_full_payment_needs_offer
      CHECK (payment_mode = 'deposit' OR minimum_spend IS NOT NULL
        OR (jsonb_typeof(packages) = 'array' AND jsonb_array_length(packages) > 0));
  END IF;
END;
$$;

-- Package list shape. A trigger, not a CHECK, so the dashboard gets one clear
-- error name. SECURITY INVOKER: it only reads NEW.
CREATE OR REPLACE FUNCTION private.seating_packages_valid() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_e jsonb;
  v_ids text[] := '{}';
BEGIN
  IF jsonb_typeof(NEW.packages) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'seating_packages_invalid:packages must be a list' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(NEW.packages) > 9 THEN
    RAISE EXCEPTION 'seating_packages_too_many:A table can have at most 9 packages' USING ERRCODE = '23514';
  END IF;
  FOR v_e IN SELECT e FROM jsonb_array_elements(NEW.packages) AS e LOOP
    IF jsonb_typeof(v_e) IS DISTINCT FROM 'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_e) AS k) IS DISTINCT FROM ARRAY['id', 'includes', 'name', 'price']
      OR jsonb_typeof(v_e -> 'id') IS DISTINCT FROM 'string'
      OR NOT (v_e ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (v_e ->> 'id') = ANY (v_ids)
      OR jsonb_typeof(v_e -> 'name') IS DISTINCT FROM 'string'
      OR length(btrim(v_e ->> 'name')) < 1 OR length(v_e ->> 'name') > 60
      OR jsonb_typeof(v_e -> 'includes') IS DISTINCT FROM 'string'
      OR length(v_e ->> 'includes') > 300
      OR jsonb_typeof(v_e -> 'price') IS DISTINCT FROM 'number'
      OR NOT (v_e ->> 'price') ~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'seating_packages_invalid:Each package needs a name, what it includes and a whole-number price' USING ERRCODE = '23514';
    END IF;
    v_ids := v_ids || (v_e ->> 'id');
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.seating_packages_valid() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS seating_packages_valid ON public.seating_resources;
CREATE TRIGGER seating_packages_valid BEFORE INSERT OR UPDATE OF packages ON public.seating_resources
FOR EACH ROW EXECUTE FUNCTION private.seating_packages_valid();

-- Old signature (M542): replaced by the one below, which has four more
-- optional parameters. PostgREST callers that name only the old parameters
-- reach the new function.
DROP FUNCTION IF EXISTS public.book_table_atomic(
  UUID, UUID, UUID, UUID, DATE, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER,
  INTEGER, INTEGER
);

-- Preserve M542 signature order, locks, hours, holds and financial behavior;
-- M557 lines are marked.
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
  p_expected_duration INTEGER DEFAULT NULL,
  -- M557: the package the customer chose and the terms they were shown.
  p_package_id UUID DEFAULT NULL,
  p_expected_payable INTEGER DEFAULT NULL,
  p_expected_minimum_spend INTEGER DEFAULT NULL,
  p_expected_package_price INTEGER DEFAULT NULL
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
  -- M557: minimum spend and packages
  v_has_offer BOOLEAN;
  v_package JSONB;
  v_package_price INTEGER;
  v_payable INTEGER;
  v_metadata JSONB;
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
      AND (b.metadata #>> '{table_offer,package,id}') IS NOT DISTINCT FROM p_package_id::text
      AND (p_expected_payable IS NULL OR b.deposit_amount = p_expected_payable)
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_booking_id, v_ref, true;
      RETURN;
    END IF;
  END IF;

  -- ── Validate seating resource ──
  SELECT sr.id, sr.business_id, sr.capacity, sr.min_party_size,
         sr.is_active, sr.reservation_duration_minutes, sr.deposit_amount,
         sr.available_days, sr.available_from, sr.available_to,
         sr.minimum_spend, sr.payment_mode, sr.packages
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

  -- ── M557: minimum spend and packages (Owner decision 2026-11-23) ──
  -- A table with neither keeps the flat deposit exactly as before.
  v_has_offer := v_resource.minimum_spend IS NOT NULL OR jsonb_array_length(v_resource.packages) > 0;
  IF p_package_id IS NOT NULL THEN
    SELECT e INTO v_package
    FROM jsonb_array_elements(v_resource.packages) AS e
    WHERE e ->> 'id' = p_package_id::text
    LIMIT 1;
    IF v_package IS NULL THEN
      RAISE EXCEPTION 'package_unavailable:Package % is not offered on this table', p_package_id;
    END IF;
    v_package_price := (v_package ->> 'price')::int;
  END IF;
  -- Pay in full: the package price, else the minimum spend, else the deposit.
  v_payable := CASE WHEN v_resource.payment_mode = 'full' AND v_has_offer
    THEN COALESCE(v_package_price, v_resource.minimum_spend, v_resource.deposit_amount)
    ELSE v_resource.deposit_amount END;
  IF p_expected_payable IS NOT NULL THEN
    IF v_payable != p_expected_payable
      OR v_resource.minimum_spend IS DISTINCT FROM p_expected_minimum_spend
      OR v_package_price IS DISTINCT FROM p_expected_package_price THEN
      RAISE EXCEPTION 'deposit_changed:Amount to pay changed from % to %', p_expected_payable, v_payable;
    END IF;
  ELSIF p_expected_deposit IS NOT NULL AND (p_package_id IS NOT NULL OR v_payable != v_resource.deposit_amount) THEN
    -- A caller that does not know about packages must not book a table it
    -- would charge the wrong amount for.
    RAISE EXCEPTION 'deposit_changed:Amount to pay changed from % to %', p_expected_deposit, v_payable;
  END IF;

  -- DB-authoritative values: flat deposit per reservation (Owner decision 2026-10-27),
  -- or the M557 amount to pay now.
  v_committed_deposit := CASE WHEN p_expected_deposit IS NOT NULL
    THEN v_payable ELSE p_deposit_amount END;
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

  -- M557: the booking keeps the offer as the customer saw it. Tables without
  -- a minimum spend or packages store exactly the metadata they did before.
  v_metadata := jsonb_build_object('duration_minutes', v_committed_duration);
  IF v_has_offer THEN
    v_metadata := v_metadata || jsonb_build_object('table_offer', jsonb_build_object(
      'payment_mode', v_resource.payment_mode,
      'minimum_spend', v_resource.minimum_spend,
      'package', v_package));
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
    v_metadata
  )
  RETURNING bookings.id, bookings.reference_code
  INTO v_booking_id, v_ref;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;


-- ACL: service_role only (unchanged from M542, re-applied to the new signature)
REVOKE ALL ON FUNCTION public.book_table_atomic(
  UUID, UUID, UUID, UUID, DATE, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER,
  INTEGER, INTEGER, UUID, INTEGER, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.book_table_atomic(
  UUID, UUID, UUID, UUID, DATE, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER,
  INTEGER, INTEGER, UUID, INTEGER, INTEGER, INTEGER
) TO service_role;

-- Self-check: final state of everything M557 touches.
DO $$
DECLARE
  v_sig CONSTANT text := 'public.book_table_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,text,integer,integer,integer,uuid,integer,integer,integer)';
  v_fn regprocedure;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'book_table_atomic') <> 1 THEN
    RAISE EXCEPTION 'M557 self-check failed: book_table_atomic must have exactly one signature';
  END IF;
  v_fn := v_sig::regprocedure;
  IF (SELECT prosecdef OR proconfig IS NOT NULL FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'M557 self-check failed: book_table_atomic must stay SECURITY INVOKER with no SET clause';
  END IF;
  IF has_function_privilege('anon', v_sig, 'EXECUTE')
    OR has_function_privilege('authenticated', v_sig, 'EXECUTE')
    OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'M557 self-check failed: book_table_atomic must be service_role only';
  END IF;
  IF pg_get_functiondef(v_fn) NOT LIKE '%public.seating_occupied_peak%'
    OR pg_get_functiondef(v_fn) NOT LIKE '%package_unavailable%' THEN
    RAISE EXCEPTION 'M557 self-check failed: book_table_atomic body is not the M557 one';
  END IF;
  IF has_function_privilege('authenticated', 'private.seating_packages_valid()', 'EXECUTE')
    OR has_function_privilege('anon', 'private.seating_packages_valid()', 'EXECUTE')
    OR (SELECT prosecdef FROM pg_proc WHERE oid = 'private.seating_packages_valid()'::regprocedure) THEN
    RAISE EXCEPTION 'M557 self-check failed: seating_packages_valid must be SECURITY INVOKER and not callable by API roles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.seating_resources'::regclass
      AND tgname = 'seating_packages_valid' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M557 self-check failed: seating_packages_valid trigger missing';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.seating_resources'::regclass
      AND conname IN ('seating_minimum_spend_positive', 'seating_payment_mode_valid', 'seating_full_payment_needs_offer')) <> 3 THEN
    RAISE EXCEPTION 'M557 self-check failed: seating_resources checks missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.seating_resources'::regclass) THEN
    RAISE EXCEPTION 'M557 self-check failed: RLS is off on seating_resources';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.seating_resources'::regclass
      AND attname IN ('minimum_spend', 'payment_mode', 'packages') AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'M557 self-check failed: new seating_resources columns must have no column grants';
  END IF;
END;
$$;
