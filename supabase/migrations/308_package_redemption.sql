-- 308: Atomic package session redemption
--
-- book_with_package_atomic: wraps canonical book_slot_atomic + package claim
-- cancel_booking_with_release: atomic cancellation + package session release
-- release_package_session: standalone release for non-cancellation paths

CREATE TABLE IF NOT EXISTS package_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES package_enrollments(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  UNIQUE (enrollment_id, booking_id),
  UNIQUE (booking_id)
);

CREATE INDEX idx_package_redemptions_enrollment ON package_redemptions(enrollment_id);

ALTER TABLE package_redemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_view_redemptions" ON package_redemptions FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "service_role_redemptions" ON package_redemptions FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════
-- Atomic booking + package claim
-- Calls the CANONICAL book_slot_atomic inside a single transaction.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION book_with_package_atomic(
  -- Same params as book_slot_atomic
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
  -- Package-specific params
  p_enrollment_id uuid DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_enrollment RECORD;
  v_package RECORD;
  v_slot RECORD;
BEGIN
  -- ── 1. Validate + lock enrollment ──
  SELECT * INTO v_enrollment FROM package_enrollments
    WHERE id = p_enrollment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'enrollment_not_found');
  END IF;
  IF v_enrollment.business_id != p_business_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_business');
  END IF;
  IF NOT v_enrollment.is_active THEN
    RETURN jsonb_build_object('success', false, 'reason', 'enrollment_inactive');
  END IF;
  IF v_enrollment.expires_at IS NOT NULL AND v_enrollment.expires_at < NOW() THEN
    RETURN jsonb_build_object('success', false, 'reason', 'enrollment_expired');
  END IF;
  IF v_enrollment.sessions_used >= v_enrollment.sessions_total THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_sessions_remaining');
  END IF;
  -- Customer phone match (with/without + prefix)
  IF v_enrollment.customer_phone NOT IN (
    p_guest_phone,
    CASE WHEN p_guest_phone LIKE '+%' THEN substring(p_guest_phone from 2) ELSE '+' || p_guest_phone END
  ) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_customer');
  END IF;

  -- ── 2. Validate package ──
  SELECT * INTO v_package FROM service_packages
    WHERE id = v_enrollment.package_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'package_inactive');
  END IF;
  -- Service eligibility (empty service_ids = all services, NULL service_id = skip check)
  IF p_service_id IS NOT NULL AND v_package.service_ids IS NOT NULL
     AND array_length(v_package.service_ids, 1) > 0
     AND NOT (p_service_id = ANY(v_package.service_ids)) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'service_not_eligible');
  END IF;

  -- ── 3. Call canonical book_slot_atomic (all normal booking behavior preserved) ──
  SELECT * INTO v_slot FROM book_slot_atomic(
    p_business_id, p_user_id, p_service_id, p_staff_id,
    p_date, p_time, p_party_size, p_max_capacity,
    p_flow_type, p_deposit_amount, p_deposit_status, p_status,
    p_guest_name, p_guest_phone, p_guest_email,
    p_special_requests, p_venue_address, p_end_date,
    p_addons_snapshot, p_promo_code_id, p_total_amount, p_staff_name,
    p_location_id, p_appointment_id, p_buffer_minutes, p_duration, p_bot_session_id
  );

  IF NOT v_slot.slot_available THEN
    RETURN jsonb_build_object('success', false, 'reason', 'slot_full');
  END IF;

  -- ── 4. Create durable redemption (UNIQUE booking_id prevents double-consume) ──
  INSERT INTO package_redemptions (enrollment_id, booking_id, business_id)
  VALUES (p_enrollment_id, v_slot.booking_id, p_business_id);

  -- ── 5. Increment sessions_used (belt-and-suspenders guard) ──
  UPDATE package_enrollments
  SET sessions_used = sessions_used + 1
  WHERE id = p_enrollment_id AND sessions_used < sessions_total;

  RETURN jsonb_build_object(
    'success', true,
    'booking_id', v_slot.booking_id,
    'reference_code', v_slot.reference_code,
    'package_covered', true
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Atomic cancellation + package release
-- Cancels booking + releases any active package redemption in ONE transaction.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION cancel_booking_with_release(
  p_booking_id uuid,
  p_cancelled_by text DEFAULT 'guest'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking RECORD;
  v_redemption RECORD;
BEGIN
  -- Lock the booking
  SELECT id, status, business_id INTO v_booking FROM bookings
    WHERE id = p_booking_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  -- Only cancellable statuses
  IF v_booking.status NOT IN ('pending', 'confirmed') THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_cancellable', 'status', v_booking.status);
  END IF;

  -- Cancel the booking
  UPDATE bookings
  SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = p_cancelled_by
  WHERE id = p_booking_id AND status IN ('pending', 'confirmed');

  -- Release any active package redemption atomically
  SELECT * INTO v_redemption FROM package_redemptions
    WHERE booking_id = p_booking_id AND status = 'active'
    FOR UPDATE;

  IF FOUND THEN
    UPDATE package_redemptions
    SET status = 'released', released_at = NOW()
    WHERE id = v_redemption.id AND status = 'active';

    UPDATE package_enrollments
    SET sessions_used = GREATEST(0, sessions_used - 1)
    WHERE id = v_redemption.enrollment_id;
  END IF;

  RETURN jsonb_build_object('cancelled', true, 'session_released', FOUND);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Standalone release (for non-cancellation paths if needed)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION release_package_session(
  p_booking_id uuid
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_redemption RECORD;
BEGIN
  SELECT * INTO v_redemption FROM package_redemptions
    WHERE booking_id = p_booking_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'no_active_redemption');
  END IF;
  UPDATE package_redemptions SET status = 'released', released_at = NOW()
    WHERE id = v_redemption.id AND status = 'active';
  UPDATE package_enrollments SET sessions_used = GREATEST(0, sessions_used - 1)
    WHERE id = v_redemption.enrollment_id;
  RETURN jsonb_build_object('released', true, 'enrollment_id', v_redemption.enrollment_id);
END;
$$;

-- Restrict to service_role
DO $$ BEGIN
  REVOKE ALL ON FUNCTION book_with_package_atomic FROM PUBLIC;
  REVOKE ALL ON FUNCTION cancel_booking_with_release FROM PUBLIC;
  REVOKE ALL ON FUNCTION release_package_session(uuid) FROM PUBLIC;
  EXECUTE 'GRANT EXECUTE ON FUNCTION book_with_package_atomic TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION cancel_booking_with_release TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION release_package_session(uuid) TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
