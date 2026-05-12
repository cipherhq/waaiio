-- Atomic booking slot check: prevents double-booking the same time slot
-- Counts existing bookings for the same business/date/time/staff within a transaction,
-- and only inserts if capacity hasn't been exceeded.
CREATE OR REPLACE FUNCTION public.book_slot_atomic(
  p_business_id uuid,
  p_user_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_date date,
  p_time text,
  p_party_size int,
  p_max_capacity int,
  p_flow_type text,
  p_deposit_amount int,
  p_deposit_status text,
  p_status text,
  p_guest_name text,
  p_guest_phone text,
  p_guest_email text,
  p_special_requests text,
  p_venue_address text,
  p_end_date date,
  p_addons_snapshot jsonb,
  p_promo_code_id uuid,
  p_total_amount int,
  p_staff_name text
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
  v_booking_id uuid;
  v_ref text;
BEGIN
  -- Lock rows for this slot to prevent concurrent inserts
  SELECT COUNT(*) INTO v_count
  FROM bookings
  WHERE business_id = p_business_id
    AND date = p_date
    AND time = p_time
    AND status IN ('confirmed', 'pending', 'in_progress')
    AND (p_staff_id IS NULL OR staff_id = p_staff_id)
  FOR UPDATE;

  -- Check capacity
  IF v_count >= p_max_capacity THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, false;
    RETURN;
  END IF;

  -- Insert the booking
  INSERT INTO bookings (
    business_id, user_id, service_id, staff_id, staff_name,
    date, time, party_size, flow_type, channel,
    deposit_amount, deposit_status, status,
    guest_name, guest_phone, guest_email,
    special_requests, venue_address, end_date,
    addons_snapshot, promo_code_id, total_amount, quantity
  ) VALUES (
    p_business_id, p_user_id, p_service_id, p_staff_id, p_staff_name,
    p_date, p_time, p_party_size, p_flow_type, 'whatsapp',
    p_deposit_amount, p_deposit_status, p_status,
    p_guest_name, p_guest_phone, p_guest_email,
    p_special_requests, p_venue_address, p_end_date,
    p_addons_snapshot, p_promo_code_id, p_total_amount, p_party_size
  )
  RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- Grant execute to service_role only (bot uses service client)
REVOKE ALL ON FUNCTION public.book_slot_atomic FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_atomic TO service_role;
