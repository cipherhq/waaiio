-- 308: Atomic package session redemption
--
-- Booking + package claim in ONE PostgreSQL transaction.
-- No JavaScript compensation — atomic or nothing.

CREATE TABLE IF NOT EXISTS package_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES package_enrollments(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  UNIQUE (enrollment_id, booking_id), -- prevents double-consume for same enrollment+booking
  UNIQUE (booking_id)                 -- prevents one booking consuming multiple enrollments
);

CREATE INDEX idx_package_redemptions_enrollment ON package_redemptions(enrollment_id);

ALTER TABLE package_redemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_view_redemptions" ON package_redemptions FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

CREATE POLICY "service_role_redemptions" ON package_redemptions FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════
-- Atomic booking + package claim in ONE transaction
-- Validates everything from authoritative DB state.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION book_with_package_atomic(
  -- Booking params (same as book_slot_atomic)
  p_business_id UUID, p_user_id UUID, p_service_id UUID,
  p_staff_id UUID, p_date TEXT, p_time TEXT,
  p_party_size INT, p_max_capacity INT,
  p_flow_type TEXT, p_deposit_amount INT, p_deposit_status TEXT, p_status TEXT,
  p_guest_name TEXT, p_guest_phone TEXT, p_guest_email TEXT,
  p_special_requests TEXT, p_venue_address TEXT, p_end_date TEXT,
  p_addons_snapshot JSONB, p_promo_code_id UUID,
  p_bot_session_id UUID, p_appointment_id UUID, p_buffer_minutes INT,
  -- Package params
  p_enrollment_id UUID,
  p_uncovered_amount INT DEFAULT 0  -- add-on amount not covered by package
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_enrollment RECORD;
  v_package RECORD;
  v_existing_redemption RECORD;
  v_booking_id UUID;
  v_booking_ref TEXT;
  v_overlap_count INT;
BEGIN
  -- ── 1. Validate the enrollment (FOR UPDATE lock) ──
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
  -- Validate customer: enrollment phone must match booking phone
  IF v_enrollment.customer_phone NOT IN (p_guest_phone, CASE WHEN p_guest_phone LIKE '+%' THEN substring(p_guest_phone from 2) ELSE '+' || p_guest_phone END) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_customer');
  END IF;

  -- ── 2. Validate the package ──
  SELECT * INTO v_package FROM service_packages
    WHERE id = v_enrollment.package_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'package_inactive');
  END IF;
  -- Service eligibility (empty = all)
  IF p_service_id IS NOT NULL AND v_package.service_ids IS NOT NULL
     AND array_length(v_package.service_ids, 1) > 0
     AND NOT (p_service_id = ANY(v_package.service_ids)) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'service_not_eligible');
  END IF;

  -- ── 3. Check capacity (same logic as book_slot_atomic) ──
  IF p_appointment_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_overlap_count FROM bookings
      WHERE business_id = p_business_id AND appointment_id = p_appointment_id
      AND date = p_date::date AND time = p_time AND status NOT IN ('cancelled', 'no_show');
  ELSE
    SELECT COUNT(*) INTO v_overlap_count FROM bookings
      WHERE business_id = p_business_id AND service_id = p_service_id
      AND date = p_date::date AND time = p_time AND status NOT IN ('cancelled', 'no_show');
  END IF;
  IF v_overlap_count >= p_max_capacity THEN
    RETURN jsonb_build_object('success', false, 'reason', 'slot_full');
  END IF;

  -- ── 4. Create the booking ──
  INSERT INTO bookings (
    business_id, user_id, service_id, staff_id, date, time,
    party_size, flow_type, channel, deposit_amount, deposit_status,
    status, guest_name, guest_phone, guest_email,
    special_requests, total_amount, quantity,
    appointment_id
  ) VALUES (
    p_business_id, p_user_id,
    CASE WHEN p_appointment_id IS NOT NULL THEN NULL ELSE p_service_id END,
    p_staff_id, p_date::date, p_time,
    p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel,
    p_uncovered_amount, -- deposit = only uncovered add-on amount
    CASE WHEN p_uncovered_amount > 0 THEN 'pending'::deposit_status ELSE 'none'::deposit_status END,
    CASE WHEN p_uncovered_amount > 0 THEN 'pending'::reservation_status ELSE 'confirmed'::reservation_status END,
    p_guest_name, p_guest_phone, p_guest_email,
    p_special_requests, p_uncovered_amount, p_party_size,
    p_appointment_id
  ) RETURNING id, reference_code INTO v_booking_id, v_booking_ref;

  -- ── 5. Create the durable redemption ──
  INSERT INTO package_redemptions (enrollment_id, booking_id, business_id)
  VALUES (p_enrollment_id, v_booking_id, p_business_id);

  -- ── 6. Increment sessions_used ──
  UPDATE package_enrollments
  SET sessions_used = sessions_used + 1
  WHERE id = p_enrollment_id AND sessions_used < sessions_total;

  RETURN jsonb_build_object(
    'success', true,
    'booking_id', v_booking_id,
    'reference_code', v_booking_ref,
    'package_covered', true,
    'uncovered_amount', p_uncovered_amount
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Release: return a consumed session (for eligible cancellation)
-- Idempotent — duplicate release is safe.
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION release_package_session(
  p_booking_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_redemption RECORD;
BEGIN
  SELECT * INTO v_redemption FROM package_redemptions
    WHERE booking_id = p_booking_id AND status = 'active'
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'no_active_redemption');
  END IF;

  UPDATE package_redemptions
  SET status = 'released', released_at = NOW()
  WHERE id = v_redemption.id AND status = 'active';

  UPDATE package_enrollments
  SET sessions_used = GREATEST(0, sessions_used - 1)
  WHERE id = v_redemption.enrollment_id;

  RETURN jsonb_build_object('released', true, 'enrollment_id', v_redemption.enrollment_id);
END;
$$;

-- Restrict to service_role
DO $$ BEGIN
  REVOKE ALL ON FUNCTION book_with_package_atomic(UUID, UUID, UUID, UUID, TEXT, TEXT, INT, INT, TEXT, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID, UUID, UUID, INT, UUID, INT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION release_package_session(UUID) FROM PUBLIC;
  EXECUTE 'GRANT EXECUTE ON FUNCTION book_with_package_atomic(UUID, UUID, UUID, UUID, TEXT, TEXT, INT, INT, TEXT, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, UUID, UUID, UUID, INT, UUID, INT) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION release_package_session(UUID) TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
