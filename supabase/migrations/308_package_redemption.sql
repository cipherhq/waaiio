-- 308: Atomic package session redemption
--
-- Provides durable booking ↔ enrollment relationship with:
-- * atomic claim (prevents double-consume, oversell)
-- * idempotent release (for cancellation)
-- * concurrency safety via FOR UPDATE row locking

CREATE TABLE IF NOT EXISTS package_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES package_enrollments(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  UNIQUE (enrollment_id, booking_id) -- prevents double-consume for same booking
);

CREATE INDEX idx_package_redemptions_enrollment ON package_redemptions(enrollment_id);
CREATE INDEX idx_package_redemptions_booking ON package_redemptions(booking_id);

ALTER TABLE package_redemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_view_redemptions" ON package_redemptions FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

CREATE POLICY "service_role_redemptions" ON package_redemptions FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════
-- Claim: atomically reserve one session from an enrollment for a booking
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION claim_package_session(
  p_enrollment_id UUID,
  p_booking_id UUID,
  p_business_id UUID,
  p_service_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_enrollment RECORD;
  v_package RECORD;
  v_existing RECORD;
BEGIN
  -- Check for idempotent replay: same enrollment + booking already claimed
  SELECT id, status INTO v_existing FROM package_redemptions
    WHERE enrollment_id = p_enrollment_id AND booking_id = p_booking_id;

  IF FOUND THEN
    IF v_existing.status = 'active' THEN
      RETURN jsonb_build_object('claimed', true, 'already_claimed', true, 'redemption_id', v_existing.id);
    END IF;
    -- Released redemption for the same booking — do not reclaim
    RETURN jsonb_build_object('claimed', false, 'reason', 'previously_released');
  END IF;

  -- Lock the enrollment row for atomic session counting
  SELECT * INTO v_enrollment FROM package_enrollments
    WHERE id = p_enrollment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'enrollment_not_found');
  END IF;

  -- Validate business match
  IF v_enrollment.business_id != p_business_id THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'wrong_business');
  END IF;

  -- Validate enrollment is active
  IF NOT v_enrollment.is_active THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'enrollment_inactive');
  END IF;

  -- Validate not expired
  IF v_enrollment.expires_at IS NOT NULL AND v_enrollment.expires_at < NOW() THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'enrollment_expired');
  END IF;

  -- Validate sessions remaining
  IF v_enrollment.sessions_used >= v_enrollment.sessions_total THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'no_sessions_remaining');
  END IF;

  -- Validate the package exists and is active
  SELECT * INTO v_package FROM service_packages
    WHERE id = v_enrollment.package_id AND is_active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'package_inactive');
  END IF;

  -- Validate service eligibility (empty service_ids = all services)
  IF p_service_id IS NOT NULL AND v_package.service_ids IS NOT NULL
     AND array_length(v_package.service_ids, 1) > 0
     AND NOT (p_service_id = ANY(v_package.service_ids)) THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'service_not_eligible');
  END IF;

  -- Atomic: insert redemption + increment sessions_used
  INSERT INTO package_redemptions (enrollment_id, booking_id, business_id)
  VALUES (p_enrollment_id, p_booking_id, p_business_id);

  UPDATE package_enrollments
  SET sessions_used = sessions_used + 1
  WHERE id = p_enrollment_id
    AND sessions_used < sessions_total; -- Belt-and-suspenders guard

  RETURN jsonb_build_object('claimed', true, 'already_claimed', false,
    'enrollment_id', p_enrollment_id, 'sessions_remaining', v_enrollment.sessions_total - v_enrollment.sessions_used - 1);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Release: return a consumed session (for eligible cancellation)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION release_package_session(
  p_booking_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_redemption RECORD;
BEGIN
  -- Find the active redemption for this booking
  SELECT * INTO v_redemption FROM package_redemptions
    WHERE booking_id = p_booking_id AND status = 'active'
    FOR UPDATE;

  IF NOT FOUND THEN
    -- No active redemption — either never claimed or already released
    RETURN jsonb_build_object('released', false, 'reason', 'no_active_redemption');
  END IF;

  -- Mark as released
  UPDATE package_redemptions
  SET status = 'released', released_at = NOW()
  WHERE id = v_redemption.id
    AND status = 'active'; -- Idempotent guard

  -- Decrement sessions_used (with floor guard)
  UPDATE package_enrollments
  SET sessions_used = GREATEST(0, sessions_used - 1)
  WHERE id = v_redemption.enrollment_id;

  RETURN jsonb_build_object('released', true, 'enrollment_id', v_redemption.enrollment_id);
END;
$$;

-- Restrict to service_role
DO $$ BEGIN
  REVOKE ALL ON FUNCTION claim_package_session(UUID, UUID, UUID, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION release_package_session(UUID) FROM PUBLIC;
  EXECUTE 'GRANT EXECUTE ON FUNCTION claim_package_session(UUID, UUID, UUID, UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION release_package_session(UUID) TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
