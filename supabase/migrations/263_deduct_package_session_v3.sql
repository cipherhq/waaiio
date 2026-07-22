CREATE OR REPLACE FUNCTION public.deduct_package_session(
  p_business_id UUID,
  p_customer_phone TEXT,
  p_service_id UUID,
  p_booking_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enrollment_id UUID;
  v_rows INTEGER;
  v_booking_biz UUID;
  v_booking_svc UUID;
BEGIN
  -- Validate booking belongs to the supplied business and service
  SELECT business_id, service_id INTO v_booking_biz, v_booking_svc
  FROM public.bookings
  WHERE id = p_booking_id;

  IF v_booking_biz IS NULL OR v_booking_biz != p_business_id THEN
    RETURN false;  -- Booking not found or wrong business
  END IF;

  IF v_booking_svc IS DISTINCT FROM p_service_id THEN
    RETURN false;  -- Service mismatch
  END IF;

  -- Find the soonest-expiring active enrollment for this service, lock it
  SELECT pe.id INTO v_enrollment_id
  FROM public.package_enrollments pe
  JOIN public.service_packages sp ON pe.package_id = sp.id
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
    RETURN false;  -- No eligible enrollment
  END IF;

  -- Atomic deduction with guard
  UPDATE public.package_enrollments
  SET sessions_used = sessions_used + 1
  WHERE id = v_enrollment_id
    AND sessions_used < sessions_total;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN false;  -- Race: exhausted between SELECT and UPDATE
  END IF;

  -- Log consumption for replay protection — UNIQUE(booking_id) prevents double-deduction
  BEGIN
    INSERT INTO public.package_session_log (enrollment_id, booking_id)
    VALUES (v_enrollment_id, p_booking_id);
  EXCEPTION WHEN unique_violation THEN
    -- Already deducted for this booking — rollback the increment
    UPDATE public.package_enrollments
    SET sessions_used = sessions_used - 1
    WHERE id = v_enrollment_id;
    RETURN false;
  END;

  RETURN true;
END;
$$;


-- auto_approve_limits documentation updated in DO block at top of file
