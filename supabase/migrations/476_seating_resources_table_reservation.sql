-- ═══════════════════════════════════════════════════════
-- Migration 476: Seating Resources & Table Reservation
-- Issue: #730 — Booking UX parity
--
-- Creates seating_resources table for restaurant/lounge
-- table/section/VIP inventory. Extends flow_type enum.
-- Adds book_table_atomic RPC with advisory-lock concurrency.
-- ═══════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════
-- 1A. Extend flow_type enum
-- ═══════════════════════════════════════════════════════
ALTER TYPE flow_type ADD VALUE IF NOT EXISTS 'table_reservation';

-- ═══════════════════════════════════════════════════════
-- 1B. seating_resources table
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.seating_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  resource_type VARCHAR(30) NOT NULL DEFAULT 'table'
    CHECK (resource_type IN ('table', 'booth', 'section', 'vip_area', 'private_room', 'bar_seat')),
  capacity INTEGER NOT NULL DEFAULT 2
    CHECK (capacity > 0 AND capacity <= 500),
  min_party_size INTEGER NOT NULL DEFAULT 1
    CHECK (min_party_size > 0),
  section VARCHAR(100),
  reservation_duration_minutes INTEGER NOT NULL DEFAULT 90
    CHECK (reservation_duration_minutes > 0 AND reservation_duration_minutes <= 480),
  deposit_amount INTEGER NOT NULL DEFAULT 0
    CHECK (deposit_amount >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  available_days TEXT[],
  available_from TIME,
  available_to TIME,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT seating_min_lte_max CHECK (min_party_size <= capacity),
  -- Reject overnight availability windows (e.g. 22:00-06:00).
  -- Overnight policy is not authorized — requires Owner decision.
  CONSTRAINT seating_no_overnight CHECK (
    available_from IS NULL OR available_to IS NULL
    OR available_from < available_to
  )
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_seating_resources_business
  ON public.seating_resources(business_id);
CREATE INDEX IF NOT EXISTS idx_seating_resources_business_active
  ON public.seating_resources(business_id) WHERE is_active = true;

-- updated_at trigger
CREATE TRIGGER trg_seating_resources_updated_at
  BEFORE UPDATE ON public.seating_resources
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ═══════════════════════════════════════════════════════
-- 1C. RLS on seating_resources (follows properties pattern)
-- ═══════════════════════════════════════════════════════
ALTER TABLE public.seating_resources ENABLE ROW LEVEL SECURITY;

CREATE POLICY seating_resources_owner_select ON public.seating_resources FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY seating_resources_owner_insert ON public.seating_resources FOR INSERT
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY seating_resources_owner_update ON public.seating_resources FOR UPDATE
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
-- No DELETE policy: archive-only semantics (is_active=false).
-- Hard deletes blocked by trigger below to preserve booking history.
CREATE POLICY seating_resources_service_all ON public.seating_resources FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Admin read access (support, operations, admin)
CREATE POLICY seating_resources_admin_select ON public.seating_resources FOR SELECT
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin', 'support', 'operations']));

-- Admin write access (admin only — platform-admin CRUD)
CREATE POLICY seating_resources_admin_write ON public.seating_resources FOR ALL
  TO authenticated
  USING (public.has_admin_role(ARRAY['admin']))
  WITH CHECK (public.has_admin_role(ARRAY['admin']));

-- Authenticated role needs table-level grants for RLS policies to take effect
GRANT SELECT, INSERT, UPDATE ON public.seating_resources TO authenticated;

-- ═══════════════════════════════════════════════════════
-- 1D. FK on bookings table
-- ═══════════════════════════════════════════════════════
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS seating_resource_id UUID
    REFERENCES public.seating_resources(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_bookings_seating_resource
  ON public.bookings(seating_resource_id)
  WHERE seating_resource_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════
-- 1D-2. Delete guard: prevent destroying referenced resources
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.guard_seating_resource_delete()
RETURNS TRIGGER AS $$
DECLARE v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM bookings WHERE seating_resource_id = OLD.id;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete seating resource with % existing booking(s). Archive it instead (is_active=false).', v_count
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_seating_resource_delete
  BEFORE DELETE ON public.seating_resources
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_seating_resource_delete();

-- ═══════════════════════════════════════════════════════
-- 1E. book_table_atomic RPC
--
-- Atomic table reservation with:
-- - Advisory lock per (business, resource, date, time)
-- - Bot session idempotency
-- - Resource validation (active, business match)
-- - Party size bounds (min/max)
-- - Time-overlap prevention on same resource
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
BEGIN
  -- ── Advisory lock FIRST: serialize ALL reservations for same resource+date ──
  -- Must precede idempotency lookup so concurrent retries see each other's inserts.
  v_lock_key := abs(hashtext(
    p_business_id::text || '|sr|' || p_seating_resource_id::text
    || '|' || p_date::text
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

  -- Reject any reservation extending past midnight (no overnight policy authorized)
  IF v_req_end_min > 1440 THEN
    RAISE EXCEPTION 'past_midnight:Reservation would extend past midnight';
  END IF;

  IF v_resource.available_to IS NOT NULL THEN
    v_to_min := EXTRACT(HOUR FROM v_resource.available_to)::int * 60
              + EXTRACT(MINUTE FROM v_resource.available_to)::int;
    IF v_req_end_min > v_to_min THEN
      RAISE EXCEPTION 'after_closing:Reservation would extend past closing time %', v_resource.available_to::text;
    END IF;
  END IF;

  -- ── Time overlap check (using minutes to avoid midnight wrap) ──
  SELECT COUNT(*) INTO v_overlap_count
  FROM bookings b
  WHERE b.seating_resource_id = p_seating_resource_id
    AND b.date = p_date
    AND b.status IN ('pending', 'confirmed', 'in_progress')
    AND v_req_start_min < (
          EXTRACT(HOUR FROM b.time)::int * 60 + EXTRACT(MINUTE FROM b.time)::int
          + COALESCE((b.metadata->>'duration_minutes')::int, v_resource.reservation_duration_minutes)
        )
    AND v_req_end_min > (
          EXTRACT(HOUR FROM b.time)::int * 60 + EXTRACT(MINUTE FROM b.time)::int
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

-- ═══════════════════════════════════════════════════════
-- 1F. Minimum service_role grants for SECURITY INVOKER RPC
-- book_table_atomic needs: SELECT seating_resources (FOR UPDATE),
-- SELECT/INSERT bookings, SELECT businesses (timezone).
-- Earlier migrations grant SELECT+UPDATE on bookings (M415) and
-- ALL on businesses (M293), but INSERT on bookings and SELECT on
-- seating_resources are missing for service_role.
-- ═══════════════════════════════════════════════════════
GRANT INSERT ON public.bookings TO service_role;
-- SELECT + UPDATE: reading resource data + FOR UPDATE row lock in book_table_atomic
-- INSERT: admin seating-resource creation via service_role (app/api/admin/seating-resources)
GRANT SELECT, INSERT, UPDATE ON public.seating_resources TO service_role;

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
-- 1F. Self-check
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  -- Verify seating_resources table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'seating_resources'
  ) THEN
    RAISE EXCEPTION '476 SELF-CHECK FAILED: seating_resources table not found';
  END IF;

  -- Verify RLS is enabled
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'seating_resources'
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION '476 SELF-CHECK FAILED: RLS not enabled on seating_resources';
  END IF;

  -- Verify seating_resource_id column on bookings
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bookings'
      AND column_name = 'seating_resource_id'
  ) THEN
    RAISE EXCEPTION '476 SELF-CHECK FAILED: seating_resource_id column not found on bookings';
  END IF;

  -- Verify book_table_atomic function exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'book_table_atomic'
  ) THEN
    RAISE EXCEPTION '476 SELF-CHECK FAILED: book_table_atomic function not found';
  END IF;

  -- Verify book_table_atomic is SECURITY INVOKER (not DEFINER)
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'book_table_atomic'
      AND p.prosecdef = true
  ) THEN
    RAISE EXCEPTION '476 SELF-CHECK FAILED: book_table_atomic must be SECURITY INVOKER, not DEFINER';
  END IF;

  -- Verify service_role has EXECUTE on book_table_atomic
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'book_table_atomic'
      AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION '476 SELF-CHECK FAILED: service_role lacks EXECUTE on book_table_atomic';
  END IF;

  -- Verify flow_type enum includes table_reservation
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'flow_type' AND e.enumlabel = 'table_reservation'
  ) THEN
    RAISE EXCEPTION '476 SELF-CHECK FAILED: table_reservation not in flow_type enum';
  END IF;

  -- Verify updated_at trigger
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_seating_resources_updated_at'
      AND tgrelid = 'public.seating_resources'::regclass
  ) THEN
    RAISE EXCEPTION '476 SELF-CHECK FAILED: updated_at trigger not found on seating_resources';
  END IF;

  RAISE NOTICE '476 SELF-CHECK PASSED: seating_resources + book_table_atomic + RLS + flow_type verified';
END;
$$;
