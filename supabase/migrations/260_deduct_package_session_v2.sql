
CREATE OR REPLACE FUNCTION deduct_package_session(
  p_business_id UUID,
  p_customer_phone TEXT,
  p_service_id UUID,
  p_booking_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_enrollment_id UUID;
  v_rows INTEGER;
BEGIN
  -- Find the soonest-expiring active enrollment for this service, lock it
  SELECT pe.id INTO v_enrollment_id
  FROM package_enrollments pe
  JOIN service_packages sp ON pe.package_id = sp.id
  WHERE pe.business_id = p_business_id
    AND pe.customer_phone = p_customer_phone
    AND pe.is_active = true
    AND pe.sessions_used < pe.sessions_total
    AND (pe.expires_at IS NULL OR pe.expires_at > NOW())
    AND p_service_id = ANY(sp.service_ids)
  ORDER BY pe.expires_at ASC NULLS LAST
  LIMIT 1
  FOR UPDATE OF pe;

  IF v_enrollment_id IS NULL THEN
    RETURN false;
  END IF;

  -- Atomic deduction with guard
  UPDATE package_enrollments
  SET sessions_used = sessions_used + 1
  WHERE id = v_enrollment_id
    AND sessions_used < sessions_total;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN false;
  END IF;

  -- Log the consumption for replay protection
  BEGIN
    INSERT INTO package_session_log (enrollment_id, booking_id)
    VALUES (v_enrollment_id, p_booking_id);
  EXCEPTION WHEN unique_violation THEN
    -- Already deducted for this booking — rollback the increment
    UPDATE package_enrollments
    SET sessions_used = sessions_used - 1
    WHERE id = v_enrollment_id;
    RETURN false;
  END;

  RETURN true;
END;
$$;

-- 3. Lock down permissions — only service_role can call
