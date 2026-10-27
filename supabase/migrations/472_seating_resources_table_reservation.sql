-- ═══════════════════════════════════════════════════════
-- Migration 472: Seating Resources & Table Reservation
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

  CONSTRAINT seating_min_lte_max CHECK (min_party_size <= capacity)
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
  p_total_amount INTEGER DEFAULT 0
)
RETURNS TABLE(booking_id UUID, reference_code TEXT, slot_available BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_booking_id UUID;
  v_ref TEXT;
  v_lock_key BIGINT;
  v_resource RECORD;
  v_overlap_count INTEGER;
  v_req_start TIME;
  v_req_end TIME;
  v_biz_tz TEXT;
  v_day_name TEXT;
BEGIN
  -- ── Bot session idempotency ──
  IF p_bot_session_id IS NOT NULL THEN
    SELECT b.id, b.reference_code INTO v_booking_id, v_ref
    FROM bookings b
    WHERE b.bot_session_id = p_bot_session_id
      AND b.status IN ('pending', 'confirmed')
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_booking_id, v_ref, true;
      RETURN;
    END IF;
  END IF;

  -- ── Advisory lock: serialize ALL reservations for same resource+date ──
  -- Lock excludes time so overlapping requests with different start times
  -- still serialize (Codex P1: concurrent overlap race)
  v_lock_key := abs(hashtext(
    p_business_id::text || '|sr|' || p_seating_resource_id::text
    || '|' || p_date::text
  ));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- ── Validate seating resource ──
  SELECT sr.id, sr.business_id, sr.capacity, sr.min_party_size,
         sr.is_active, sr.reservation_duration_minutes,
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

  -- ── Party size validation ──
  IF p_party_size < v_resource.min_party_size THEN
    RAISE EXCEPTION 'party_too_small:Minimum party size is %', v_resource.min_party_size;
  END IF;
  IF p_party_size > v_resource.capacity THEN
    RAISE EXCEPTION 'party_too_large:Maximum capacity is %', v_resource.capacity;
  END IF;

  -- ── Availability enforcement (day + time window) ──
  -- Get business timezone for day-of-week
  SELECT COALESCE(b.timezone, 'Africa/Lagos') INTO v_biz_tz
  FROM businesses b WHERE b.id = p_business_id;

  v_day_name := lower(to_char(p_date AT TIME ZONE COALESCE(v_biz_tz, 'Africa/Lagos'), 'fmday'));

  -- Day-of-week check
  IF v_resource.available_days IS NOT NULL AND array_length(v_resource.available_days, 1) > 0 THEN
    IF NOT (v_day_name = ANY(v_resource.available_days)) THEN
      RAISE EXCEPTION 'day_unavailable:This resource is not available on %', initcap(v_day_name);
    END IF;
  END IF;

  -- Time window check
  v_req_start := p_time::TIME;
  IF v_resource.available_from IS NOT NULL AND v_req_start < v_resource.available_from THEN
    RAISE EXCEPTION 'before_opening:Earliest reservation time is %', v_resource.available_from::text;
  END IF;

  v_req_end := v_req_start + make_interval(mins => COALESCE(p_duration_minutes, v_resource.reservation_duration_minutes));

  IF v_resource.available_to IS NOT NULL AND v_req_end > v_resource.available_to THEN
    RAISE EXCEPTION 'after_closing:Reservation would extend past closing time %', v_resource.available_to::text;
  END IF;

  -- ── Time overlap check (v_req_start/v_req_end already set above) ──

  SELECT COUNT(*) INTO v_overlap_count
  FROM bookings b
  WHERE b.seating_resource_id = p_seating_resource_id
    AND b.date = p_date
    AND b.status IN ('pending', 'confirmed', 'in_progress')
    AND b.time < v_req_end
    AND (b.time + make_interval(
           mins => COALESCE(
             (b.metadata->>'duration_minutes')::int,
             v_resource.reservation_duration_minutes
           )
         )) > v_req_start;

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
    p_deposit_amount, p_deposit_status::deposit_status,
    p_status::reservation_status,
    p_guest_name, p_guest_phone, p_guest_email,
    p_special_requests, p_total_amount, p_party_size,
    p_bot_session_id,
    jsonb_build_object('duration_minutes', COALESCE(p_duration_minutes, v_resource.reservation_duration_minutes))
  )
  RETURNING bookings.id, bookings.reference_code
  INTO v_booking_id, v_ref;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- ACL: service_role only (matches book_slot_atomic pattern)
REVOKE ALL ON FUNCTION public.book_table_atomic(
  UUID, UUID, UUID, UUID, DATE, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.book_table_atomic(
  UUID, UUID, UUID, UUID, DATE, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER
) FROM anon;
REVOKE ALL ON FUNCTION public.book_table_atomic(
  UUID, UUID, UUID, UUID, DATE, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.book_table_atomic(
  UUID, UUID, UUID, UUID, DATE, TEXT, INTEGER, INTEGER,
  TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, INTEGER
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
    RAISE EXCEPTION '472 SELF-CHECK FAILED: seating_resources table not found';
  END IF;

  -- Verify RLS is enabled
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'seating_resources'
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION '472 SELF-CHECK FAILED: RLS not enabled on seating_resources';
  END IF;

  -- Verify seating_resource_id column on bookings
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bookings'
      AND column_name = 'seating_resource_id'
  ) THEN
    RAISE EXCEPTION '472 SELF-CHECK FAILED: seating_resource_id column not found on bookings';
  END IF;

  -- Verify book_table_atomic function exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'book_table_atomic'
  ) THEN
    RAISE EXCEPTION '472 SELF-CHECK FAILED: book_table_atomic function not found';
  END IF;

  -- Verify book_table_atomic is SECURITY DEFINER with search_path
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'book_table_atomic'
      AND p.prosecdef = true
      AND ('search_path=public' = ANY(p.proconfig))
  ) THEN
    RAISE EXCEPTION '472 SELF-CHECK FAILED: book_table_atomic missing SECURITY DEFINER or search_path';
  END IF;

  -- Verify service_role has EXECUTE on book_table_atomic
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_schema = 'public' AND routine_name = 'book_table_atomic'
      AND grantee = 'service_role' AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION '472 SELF-CHECK FAILED: service_role lacks EXECUTE on book_table_atomic';
  END IF;

  -- Verify flow_type enum includes table_reservation
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'flow_type' AND e.enumlabel = 'table_reservation'
  ) THEN
    RAISE EXCEPTION '472 SELF-CHECK FAILED: table_reservation not in flow_type enum';
  END IF;

  -- Verify updated_at trigger
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_seating_resources_updated_at'
      AND tgrelid = 'public.seating_resources'::regclass
  ) THEN
    RAISE EXCEPTION '472 SELF-CHECK FAILED: updated_at trigger not found on seating_resources';
  END IF;

  RAISE NOTICE '472 SELF-CHECK PASSED: seating_resources + book_table_atomic + RLS + flow_type verified';
END;
$$;
