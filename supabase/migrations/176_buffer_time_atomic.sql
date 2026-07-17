-- Migration 176: Final production version of book_slot_atomic
-- Adds buffer time enforcement. Uses advisory lock on business+date+staff
-- to serialize ALL booking attempts for the same resource, preventing both
-- identical-slot races and buffer-overlap races.

CREATE OR REPLACE FUNCTION public.book_slot_atomic(
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
  p_guest_name text, p_guest_phone text, p_guest_email text,
  p_special_requests text, p_venue_address text, p_end_date date,
  p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
  p_location_id uuid DEFAULT NULL,
  p_appointment_id uuid DEFAULT NULL,
  p_buffer_minutes integer DEFAULT 0,
  p_duration integer DEFAULT 30
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_count int;
  v_buffer_count int;
  v_booking_id uuid;
  v_ref text;
  v_lock_key bigint;
BEGIN
  -- Advisory lock serializes booking attempts to prevent races.
  -- When p_staff_id IS NULL the capacity query matches ALL staff,
  -- so the lock must cover the entire business+date to be safe.
  -- When p_staff_id is set, lock is scoped to that staff member.
  v_lock_key := hashtext(
    p_business_id::text || p_date::text
    || COALESCE(p_staff_id::text, '')
  );
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Capacity check for this exact time slot
  SELECT COUNT(*) INTO v_count FROM public.bookings
  WHERE business_id = p_business_id AND date = p_date AND time = p_time::time
    AND status IN ('confirmed', 'pending', 'in_progress')
    AND (p_staff_id IS NULL OR staff_id = p_staff_id);

  IF v_count >= p_max_capacity THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, false;
    RETURN;
  END IF;

  -- Buffer overlap check (only if buffer_minutes > 0)
  IF p_buffer_minutes > 0 THEN
    SELECT COUNT(*) INTO v_buffer_count
    FROM public.bookings
    WHERE business_id = p_business_id
      AND date = p_date
      AND status IN ('pending', 'confirmed', 'in_progress')
      AND (p_staff_id IS NULL OR staff_id = p_staff_id)
      AND time != p_time::time
      AND (
        p_time::time < (time + make_interval(mins => COALESCE(p_duration, 30) + p_buffer_minutes))
        AND (p_time::time + make_interval(mins => COALESCE(p_duration, 30))) > (time - make_interval(mins => p_buffer_minutes))
      );

    IF v_buffer_count > 0 THEN
      RETURN QUERY SELECT NULL::uuid, NULL::text, false;
      RETURN;
    END IF;
  END IF;

  -- Insert the booking
  INSERT INTO public.bookings (
    business_id, user_id, service_id, appointment_id, staff_id, staff_name,
    date, time, party_size, flow_type, channel,
    deposit_amount, deposit_status, status,
    guest_name, guest_phone, guest_email,
    special_requests, venue_address, end_date,
    addons_snapshot, promo_code_id, total_amount, quantity,
    location_id
  ) VALUES (
    p_business_id, p_user_id,
    CASE WHEN p_appointment_id IS NOT NULL THEN NULL ELSE p_service_id END,
    p_appointment_id,
    p_staff_id, p_staff_name,
    p_date, p_time::time, p_party_size,
    p_flow_type::flow_type,
    'whatsapp'::booking_channel,
    p_deposit_amount,
    p_deposit_status::deposit_status,
    p_status::reservation_status,
    p_guest_name, p_guest_phone, p_guest_email,
    p_special_requests, p_venue_address, p_end_date,
    p_addons_snapshot, p_promo_code_id, p_total_amount, p_party_size,
    p_location_id
  )
  RETURNING id, public.bookings.reference_code INTO v_booking_id, v_ref;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;
