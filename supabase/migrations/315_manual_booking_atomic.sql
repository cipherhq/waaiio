-- ═══════════════════════════════════════════════════════
-- 315: Atomic manual dashboard booking wrapper
--
-- Calls book_slot_atomic for capacity/serialization, then applies
-- manual-dashboard-specific fields (channel, confirmed_at, notes)
-- in the SAME transaction. If any step fails, the entire booking
-- rolls back — no partially-created manual bookings.
--
-- Does NOT duplicate capacity logic — book_slot_atomic remains
-- the canonical booking authority.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION book_manual_slot_atomic(
  p_business_id uuid,
  p_user_id uuid,
  p_service_id uuid,
  p_staff_id uuid,
  p_date date,
  p_time text,
  p_party_size int,
  p_max_capacity int,
  p_guest_name text,
  p_guest_phone text,
  p_guest_email text,
  p_notes text,
  p_total_amount int,
  p_staff_name text,
  p_buffer_minutes integer DEFAULT 0,
  p_duration integer DEFAULT 30
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking_id uuid;
  v_ref text;
  v_available boolean;
  v_updated_rows int;
BEGIN
  -- 1. Delegate to canonical book_slot_atomic for capacity check + INSERT
  SELECT bsa.booking_id, bsa.reference_code, bsa.slot_available
  INTO v_booking_id, v_ref, v_available
  FROM book_slot_atomic(
    p_business_id, p_user_id, p_service_id, p_staff_id,
    p_date, p_time, p_party_size, p_max_capacity,
    'scheduling',  -- p_flow_type
    0,             -- p_deposit_amount
    'none',        -- p_deposit_status
    'confirmed',   -- p_status
    p_guest_name, p_guest_phone, p_guest_email,
    NULL,          -- p_special_requests (we use notes column instead)
    NULL,          -- p_venue_address
    NULL,          -- p_end_date
    NULL,          -- p_addons_snapshot
    NULL,          -- p_promo_code_id
    p_total_amount,
    p_staff_name,
    NULL,          -- p_location_id
    NULL,          -- p_appointment_id
    p_buffer_minutes,
    p_duration,
    NULL           -- p_bot_session_id
  ) bsa;

  -- 2. Defensive: treat anything other than slot_available = TRUE as unavailable
  IF v_available IS NOT TRUE THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, false;
    RETURN;
  END IF;

  -- Defensive: booking_id must be valid after a successful slot claim
  IF v_booking_id IS NULL THEN
    RAISE EXCEPTION 'book_manual_slot_atomic: book_slot_atomic returned slot_available=true but booking_id is NULL'
      USING ERRCODE = 'data_exception';
  END IF;

  -- 3. Apply manual-dashboard-specific fields in the SAME transaction.
  --    Verify exactly one row was updated — if not, the booking state
  --    is inconsistent and we must fail (rolling back the INSERT too).
  UPDATE bookings
  SET channel = 'dashboard'::booking_channel,
      confirmed_at = NOW(),
      notes = p_notes
  WHERE id = v_booking_id;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  IF v_updated_rows <> 1 THEN
    RAISE EXCEPTION 'book_manual_slot_atomic: expected 1 row updated for manual metadata, got %', v_updated_rows
      USING ERRCODE = 'data_exception';
  END IF;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- Restrict execution to service_role only
REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer) FROM anon;
REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer) TO service_role;
