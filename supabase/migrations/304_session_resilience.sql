-- Session resilience hardening
--
-- 1. deactivate_session_atomic: bumps version so pending CAS workers fail
-- 2. CREATE_NEW idempotency: bot_session_id + partial unique indexes on durable tables
-- 3. Queue/waitlist atomic uniqueness: partial unique indexes for active entries
-- 4. book_slot_atomic: idempotent retry by bot_session_id (checked BEFORE capacity)
-- 5. create_order_atomic: atomic order + order_items creation with idempotent retry
-- 6. finalize_free_ticket_booking: idempotent ticket counter finalization

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
    RETURN jsonb_build_object('success', true, 'already_inactive', true);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'already_inactive', false,
    'version', v_result.version
  );
END;
$$;

REVOKE ALL ON FUNCTION deactivate_session_atomic(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION deactivate_session_atomic(UUID) FROM anon;
REVOKE ALL ON FUNCTION deactivate_session_atomic(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION deactivate_session_atomic(UUID) TO service_role;

-- ═══════════════════════════════════════════════════════
-- 2. CREATE_NEW idempotency: bot_session_id on durable tables
-- ═══════════════════════════════════════════════════════

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS bot_session_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_session_idempotent
  ON reservations (bot_session_id)
  WHERE bot_session_id IS NOT NULL AND status IN ('pending', 'confirmed');

ALTER TABLE orders ADD COLUMN IF NOT EXISTS bot_session_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_session_idempotent
  ON orders (bot_session_id)
  WHERE bot_session_id IS NOT NULL AND status IN ('pending', 'confirmed');

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS bot_session_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_session_idempotent
  ON bookings (bot_session_id)
  WHERE bot_session_id IS NOT NULL AND status IN ('pending', 'confirmed');

-- Finalization marker for free tickets (prevents double counter increment)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tickets_finalized BOOLEAN NOT NULL DEFAULT false;

-- ═══════════════════════════════════════════════════════
-- 3. Queue/waitlist atomic uniqueness
-- ═══════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_entries_customer_active
  ON queue_entries (business_id, customer_phone, queue_date)
  WHERE status IN ('waiting', 'serving');

CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_entries_customer_active
  ON waitlist_entries (business_id, customer_phone)
  WHERE status = 'waiting';

-- ═══════════════════════════════════════════════════════
-- 4. book_slot_atomic: idempotent retry BEFORE capacity check
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
  -- ── FIRST: idempotent retry check (before capacity) ──
  -- If a booking already exists for this bot session, return it immediately.
  -- This prevents the original booking from blocking its own retry via capacity.
  IF p_bot_session_id IS NOT NULL THEN
    SELECT id, bookings.reference_code INTO v_booking_id, v_ref
    FROM bookings
    WHERE bot_session_id = p_bot_session_id
      AND status IN ('pending', 'confirmed')
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_booking_id, v_ref, true;
      RETURN;
    END IF;
  END IF;

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

  -- Insert the booking
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

-- ═══════════════════════════════════════════════════════
-- 5. create_order_atomic: atomic order + items in one transaction
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_order_atomic(
  p_bot_session_id uuid,
  p_business_id uuid,
  p_user_id uuid,
  p_status text,
  p_delivery_address text,
  p_delivery_phone text,
  p_total_amount int,
  p_discount_amount int DEFAULT 0,
  p_shipping_cost int DEFAULT 0,
  p_promo_code_id uuid DEFAULT NULL,
  p_channel text DEFAULT 'whatsapp',
  p_notes text DEFAULT NULL,
  p_delivery_zone_id uuid DEFAULT NULL,
  p_delivery_zone_name text DEFAULT NULL,
  p_addons_total int DEFAULT 0,
  p_volume_discount_amount int DEFAULT 0,
  p_pickup_address text DEFAULT NULL,
  p_dropoff_address text DEFAULT NULL,
  p_package_description text DEFAULT NULL,
  p_package_photo_url text DEFAULT NULL,
  p_items jsonb DEFAULT '[]'::jsonb
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_ref text;
  v_item jsonb;
  v_existing_id uuid;
  v_existing_ref text;
BEGIN
  -- Idempotent: check for existing order from same bot session
  SELECT id, reference_code INTO v_existing_id, v_existing_ref
  FROM orders
  WHERE bot_session_id = p_bot_session_id
    AND status IN ('pending', 'confirmed')
  LIMIT 1;

  IF FOUND THEN
    -- Reconcile items atomically: delete all existing, re-insert from cart
    DELETE FROM order_items WHERE order_id = v_existing_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, variant_id, variant_label, addons)
      VALUES (
        v_existing_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'quantity')::int,
        (v_item->>'unit_price')::int,
        NULLIF(v_item->>'variant_id', '')::uuid,
        NULLIF(v_item->>'variant_label', ''),
        CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
             THEN v_item->'addons' ELSE NULL END
      );
    END LOOP;

    RETURN jsonb_build_object(
      'order_id', v_existing_id,
      'reference_code', v_existing_ref,
      'created', false
    );
  END IF;

  -- Create new order
  INSERT INTO orders (
    bot_session_id, business_id, user_id, status,
    delivery_address, delivery_phone, total_amount,
    discount_amount, shipping_cost, promo_code_id, channel, notes,
    delivery_zone_id, delivery_zone_name, addons_total, volume_discount_amount,
    pickup_address, dropoff_address, package_description, package_photo_url
  ) VALUES (
    p_bot_session_id, p_business_id, p_user_id, p_status::order_status,
    p_delivery_address, p_delivery_phone, p_total_amount,
    p_discount_amount, p_shipping_cost, p_promo_code_id, p_channel, p_notes,
    p_delivery_zone_id, p_delivery_zone_name, p_addons_total, p_volume_discount_amount,
    p_pickup_address, p_dropoff_address, p_package_description, p_package_photo_url
  )
  RETURNING id, reference_code INTO v_order_id, v_ref;

  -- Insert all items atomically
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO order_items (order_id, product_id, quantity, unit_price, variant_id, variant_label, addons)
    VALUES (
      v_order_id,
      (v_item->>'product_id')::uuid,
      (v_item->>'quantity')::int,
      (v_item->>'unit_price')::int,
      NULLIF(v_item->>'variant_id', '')::uuid,
      NULLIF(v_item->>'variant_label', ''),
      CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
           THEN v_item->'addons' ELSE NULL END
    );
  END LOOP;

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'reference_code', v_ref,
    'created', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_order_atomic(
  uuid, uuid, uuid, text, text, text, int, int, int, uuid,
  text, text, uuid, text, int, int, text, text, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_order_atomic(
  uuid, uuid, uuid, text, text, text, int, int, int, uuid,
  text, text, uuid, text, int, int, text, text, text, text, jsonb
) FROM anon;
REVOKE ALL ON FUNCTION public.create_order_atomic(
  uuid, uuid, uuid, text, text, text, int, int, int, uuid,
  text, text, uuid, text, int, int, text, text, text, text, jsonb
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_atomic(
  uuid, uuid, uuid, text, text, text, int, int, int, uuid,
  text, text, uuid, text, int, int, text, text, text, text, jsonb
) TO service_role;

-- ═══════════════════════════════════════════════════════
-- 6. finalize_free_ticket_booking: idempotent counter finalization
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.finalize_free_ticket_booking(
  p_booking_id uuid,
  p_event_id uuid,
  p_ticket_type_id uuid DEFAULT NULL,
  p_quantity int DEFAULT 1
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_already boolean;
BEGIN
  -- Lock the booking row to prevent concurrent finalization
  SELECT tickets_finalized INTO v_already
  FROM bookings
  WHERE id = p_booking_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'booking_not_found');
  END IF;

  IF v_already THEN
    -- Already finalized — idempotent success
    RETURN jsonb_build_object('success', true, 'already_finalized', true);
  END IF;

  -- Increment event tickets_sold
  UPDATE events
  SET tickets_sold = tickets_sold + p_quantity
  WHERE id = p_event_id;

  -- Increment ticket type tickets_sold if applicable
  IF p_ticket_type_id IS NOT NULL THEN
    UPDATE event_ticket_types
    SET tickets_sold = COALESCE(tickets_sold, 0) + p_quantity
    WHERE id = p_ticket_type_id;
  END IF;

  -- Mark booking as finalized
  UPDATE bookings
  SET tickets_finalized = true
  WHERE id = p_booking_id;

  RETURN jsonb_build_object('success', true, 'already_finalized', false);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_free_ticket_booking(uuid, uuid, uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_free_ticket_booking(uuid, uuid, uuid, int) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_free_ticket_booking(uuid, uuid, uuid, int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_free_ticket_booking(uuid, uuid, uuid, int) TO service_role;
