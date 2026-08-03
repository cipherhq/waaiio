-- Session resilience hardening
--
-- 1. deactivate_session_atomic: bumps version so pending CAS workers fail
-- 2. CREATE_NEW idempotency: bot_session_id + partial unique indexes on durable tables
-- 3. Queue/waitlist atomic uniqueness: partial unique indexes for active entries

-- ═══════════════════════════════════════════════════════
-- 1. Atomic session deactivation with version bump
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION deactivate_session_atomic(
  p_session_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result bot_sessions;
BEGIN
  UPDATE bot_sessions
  SET
    is_active = false,
    version = version + 1,
    updated_at = NOW()
  WHERE id = p_session_id
    AND is_active = true
  RETURNING * INTO v_result;

  IF NOT FOUND THEN
    -- Already inactive or not found — idempotent success
    RETURN jsonb_build_object('success', true, 'already_inactive', true);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_inactive', false,
    'version', v_result.version
  );
END;
$$;

-- Only service role should call this
REVOKE ALL ON FUNCTION deactivate_session_atomic(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION deactivate_session_atomic(UUID) FROM anon;
REVOKE ALL ON FUNCTION deactivate_session_atomic(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION deactivate_session_atomic(UUID) TO service_role;

-- ═══════════════════════════════════════════════════════
-- 2. CREATE_NEW idempotency: bot_session_id on durable tables
-- Prevents duplicate durable effects when a session retries after crash.
-- One pending/confirmed entity per bot session per table.
-- ═══════════════════════════════════════════════════════

-- Reservations: one pending/confirmed reservation per bot session
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS bot_session_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_session_idempotent
  ON reservations (bot_session_id)
  WHERE bot_session_id IS NOT NULL AND status IN ('pending', 'confirmed');

-- Orders: one pending/confirmed order per bot session
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bot_session_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_session_idempotent
  ON orders (bot_session_id)
  WHERE bot_session_id IS NOT NULL AND status IN ('pending', 'confirmed');

-- Bookings (scheduling + ticketing): one pending/confirmed booking per bot session
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bot_session_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_session_idempotent
  ON bookings (bot_session_id)
  WHERE bot_session_id IS NOT NULL AND status IN ('pending', 'confirmed');

-- ═══════════════════════════════════════════════════════
-- 3. Queue/waitlist atomic uniqueness
-- Prevents duplicate active entries for the same customer+business+date.
-- ═══════════════════════════════════════════════════════

-- Queue: one active entry per customer per business per day
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_entries_customer_active
  ON queue_entries (business_id, customer_phone, queue_date)
  WHERE status IN ('waiting', 'serving');

-- Waitlist: one active entry per customer per business
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_entries_customer_active
  ON waitlist_entries (business_id, customer_phone)
  WHERE status = 'waiting';

-- ═══════════════════════════════════════════════════════
-- 4. Add bot_session_id to book_slot_atomic
-- ═══════════════════════════════════════════════════════

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
  p_duration integer DEFAULT 30,
  p_bot_session_id uuid DEFAULT NULL
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int; v_buffer_count int; v_booking_id uuid; v_ref text;
BEGIN
  -- Lock rows for this slot to prevent concurrent inserts
  PERFORM id FROM bookings
  WHERE business_id = p_business_id AND date = p_date AND time = p_time::time
    AND status IN ('confirmed', 'pending', 'in_progress')
    AND (p_staff_id IS NULL OR staff_id = p_staff_id)
  FOR UPDATE;

  -- Capacity check
  SELECT COUNT(*) INTO v_count FROM bookings
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
    FROM bookings
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

  -- Insert the booking (with optional bot_session_id for idempotency)
  INSERT INTO bookings (
    business_id, user_id, service_id, appointment_id, staff_id, staff_name,
    date, time, party_size, flow_type, channel,
    deposit_amount, deposit_status, status,
    guest_name, guest_phone, guest_email,
    special_requests, venue_address, end_date,
    addons_snapshot, promo_code_id, total_amount, quantity,
    location_id, bot_session_id
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
    p_location_id, p_bot_session_id
  )
  RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- Permissions: revoke from public, grant to service_role
-- (uses the new 27-argument signature)
REVOKE ALL ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer, uuid
) TO service_role;
