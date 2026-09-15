-- Migration 383: Entity-commit revalidation
--
-- Adds server-side price/product/availability revalidation to all atomic RPCs.
-- No BEGIN/COMMIT/ROLLBACK — transaction ownership is external (Supabase migration runner).
--
-- Changes:
--   1. Schema: orders.items_fingerprint, quote_requests.snapshot_version + anti-forge trigger
--   2. DROP old RPC signatures (create_order_atomic 22-arg, book_slot_atomic 28-arg, purchase_tickets_atomic 10-arg)
--   3. CREATE new create_order_atomic (24-arg) with p_validate_products + p_expected_total
--   4. CREATE new book_slot_atomic (30-arg) with p_expected_price + p_expected_deposit
--   5. CREATE new purchase_tickets_atomic (12-arg) with p_bot_session_id + p_expected_price
--   6. CREATE cancel_order_immediate (2-arg)
--   7. CREATE create_payment_booking_atomic (9-arg)
--   8. CREATE create_reservation_atomic (13-arg)
--   9. Revised accept_order_quote_atomic (body-only replacement, same signature)
--  10. Stale-overload assertion + ACL blocks

-- ═══════════════════════════════════════════════════════
-- Part 1: Schema changes
-- ═══════════════════════════════════════════════════════

-- items_fingerprint for canonical order-request identity
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_fingerprint TEXT;

-- snapshot_version: v1=legacy (existing rows), v2=new format (future inserts)
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS snapshot_version INT NOT NULL DEFAULT 1;
ALTER TABLE quote_requests ALTER COLUMN snapshot_version SET DEFAULT 2;

-- Anti-forge trigger: prevent v1 insert or downgrade
CREATE OR REPLACE FUNCTION prevent_snapshot_version_downgrade()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.snapshot_version < 2 THEN
    RAISE EXCEPTION 'snapshot_version_forge:Cannot create quote_requests with snapshot_version < 2';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.snapshot_version < OLD.snapshot_version THEN
    RAISE EXCEPTION 'snapshot_version_downgrade:Cannot decrease snapshot_version from % to %',
      OLD.snapshot_version, NEW.snapshot_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_snapshot_version_guard ON quote_requests;
CREATE TRIGGER trg_snapshot_version_guard
  BEFORE INSERT OR UPDATE ON quote_requests
  FOR EACH ROW
  EXECUTE FUNCTION prevent_snapshot_version_downgrade();

-- ═══════════════════════════════════════════════════════
-- Part 2: DROP old RPC signatures
-- ═══════════════════════════════════════════════════════

-- Drop old create_order_atomic (22-arg from M333)
DROP FUNCTION IF EXISTS public.create_order_atomic(
  uuid, uuid, uuid, text, text, text, int, int, int, uuid,
  text, text, uuid, text, int, int, text, text, text, text, jsonb, uuid
);

-- Drop old book_slot_atomic (28-arg from M325)
DROP FUNCTION IF EXISTS public.book_slot_atomic(
  uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,
  text,text,date,jsonb,uuid,int,text,uuid,uuid,integer,integer,uuid,uuid
);

-- Drop old purchase_tickets_atomic (10-arg from M149)
DROP FUNCTION IF EXISTS public.purchase_tickets_atomic(
  uuid, uuid, uuid, integer, uuid, text, text, text, integer, text
);

-- ═══════════════════════════════════════════════════════
-- Part 3: CREATE new create_order_atomic (24-arg)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.create_order_atomic(
  p_bot_session_id uuid,
  p_business_id uuid,
  p_user_id uuid,
  p_status text DEFAULT 'pending',
  p_delivery_address text DEFAULT NULL,
  p_delivery_phone text DEFAULT NULL,
  p_total_amount int DEFAULT 0,
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
  p_items jsonb DEFAULT '[]'::jsonb,
  p_referral_id uuid DEFAULT NULL,
  p_validate_products boolean DEFAULT false,
  p_expected_total int DEFAULT NULL
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
  v_existing_fingerprint text;
  v_promo RECORD;
  v_active_count int;
  v_fingerprint text;
  v_product RECORD;
  v_variant RECORD;
  v_addon RECORD;
  v_server_total int := 0;
  v_item_total int;
  v_addon_entry jsonb;
  v_addon_id uuid;
  v_addon_total int;
  v_sorted_items jsonb;
  v_fp_parts text[] := '{}';
  v_fp_item jsonb;
  v_addon_ids text;
BEGIN
  -- ── Phase 1: Lock + idempotency ──
  PERFORM pg_advisory_xact_lock(abs(hashtext(p_bot_session_id::text)));

  -- Compute canonical fingerprint: md5 of sorted (product_id:variant_id:quantity:addon_ids_with_quantities)
  SELECT jsonb_agg(elem ORDER BY elem->>'product_id', elem->>'variant_id') INTO v_sorted_items
  FROM jsonb_array_elements(p_items) AS elem;

  IF v_sorted_items IS NOT NULL THEN
    FOR v_fp_item IN SELECT * FROM jsonb_array_elements(v_sorted_items)
    LOOP
      -- Build addon fingerprint component
      v_addon_ids := '';
      IF v_fp_item->'addons' IS NOT NULL AND v_fp_item->'addons' != 'null'::jsonb THEN
        SELECT string_agg(
          COALESCE(a->>'id', '') || ':' || COALESCE(a->>'quantity', '1'),
          ',' ORDER BY a->>'id'
        ) INTO v_addon_ids
        FROM jsonb_array_elements(v_fp_item->'addons') AS a;
      END IF;
      v_fp_parts := array_append(v_fp_parts,
        COALESCE(v_fp_item->>'product_id', '') || ':' ||
        COALESCE(v_fp_item->>'variant_id', '') || ':' ||
        COALESCE(v_fp_item->>'quantity', '1') || ':' ||
        COALESCE(v_addon_ids, '')
      );
    END LOOP;
    v_fingerprint := md5(array_to_string(v_fp_parts, '|'));
  ELSE
    v_fingerprint := md5('');
  END IF;

  -- Idempotent: check for existing order from same bot session
  SELECT id, reference_code, items_fingerprint
  INTO v_existing_id, v_existing_ref, v_existing_fingerprint
  FROM orders
  WHERE bot_session_id = p_bot_session_id
    AND status IN ('pending', 'confirmed')
  LIMIT 1;

  IF FOUND THEN
    IF p_validate_products THEN
      -- On validated path: compare fingerprints for idempotent retry
      IF v_existing_fingerprint IS NOT NULL AND v_existing_fingerprint = v_fingerprint THEN
        -- Identical cart: return existing order
        RETURN jsonb_build_object(
          'order_id', v_existing_id,
          'reference_code', v_existing_ref,
          'created', false
        );
      ELSIF v_existing_fingerprint IS NOT NULL THEN
        -- Mismatch: fail closed (cart changed between retries)
        RAISE EXCEPTION 'fingerprint_mismatch:Order % exists with different cart contents', v_existing_id;
      END IF;
      -- No fingerprint on existing order (legacy): fall through to recovery
    END IF;

    -- Recovery: reconcile items atomically (legacy behavior)
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

  -- ── Phase 2: Validations (only when p_validate_products = true) ──
  IF p_validate_products THEN
    -- 2a. Promo capacity (FOR UPDATE on promo_codes)
    IF p_promo_code_id IS NOT NULL THEN
      SELECT id, max_uses, current_uses INTO v_promo
      FROM promo_codes WHERE id = p_promo_code_id FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'promo_not_found:Promo code does not exist';
      END IF;

      IF v_promo.max_uses IS NOT NULL THEN
        SELECT count(*) INTO v_active_count
        FROM promo_reservations
        WHERE promo_code_id = p_promo_code_id
          AND state = 'reserved';

        IF (v_promo.current_uses + v_active_count) >= v_promo.max_uses THEN
          RAISE EXCEPTION 'promo_exhausted:Promo code has reached maximum uses';
        END IF;
      END IF;
    END IF;

    -- 2b. Product validation: lock products ORDER BY product_id, variant_id
    FOR v_item IN
      SELECT * FROM jsonb_array_elements(p_items) AS elem
      ORDER BY elem->>'product_id', elem->>'variant_id'
    LOOP
      v_item_total := 0;

      -- Lock and validate product
      SELECT id, price, is_active, deleted_at, business_id, track_inventory, stock_quantity
      INTO v_product
      FROM products
      WHERE id = (v_item->>'product_id')::uuid
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'product_not_found:Product % does not exist', v_item->>'product_id';
      END IF;
      IF NOT v_product.is_active THEN
        RAISE EXCEPTION 'product_unavailable:Product % is not active', v_item->>'product_id';
      END IF;
      IF v_product.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'product_deleted:Product % has been deleted', v_item->>'product_id';
      END IF;
      IF v_product.business_id != p_business_id THEN
        RAISE EXCEPTION 'product_wrong_business:Product % does not belong to this business', v_item->>'product_id';
      END IF;

      -- Variant validation
      IF NULLIF(v_item->>'variant_id', '') IS NOT NULL THEN
        SELECT id, price, product_id, is_active, stock_quantity
        INTO v_variant
        FROM product_variants
        WHERE id = (v_item->>'variant_id')::uuid
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'variant_not_found:Variant % does not exist', v_item->>'variant_id';
        END IF;
        IF NOT v_variant.is_active THEN
          RAISE EXCEPTION 'variant_unavailable:Variant % is not active', v_item->>'variant_id';
        END IF;
        IF v_variant.product_id != (v_item->>'product_id')::uuid THEN
          RAISE EXCEPTION 'variant_wrong_product:Variant % does not belong to product %',
            v_item->>'variant_id', v_item->>'product_id';
        END IF;

        v_item_total := v_variant.price * COALESCE((v_item->>'quantity')::int, 1);
      ELSE
        v_item_total := v_product.price * COALESCE((v_item->>'quantity')::int, 1);
      END IF;

      -- Addon validation
      IF v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb THEN
        FOR v_addon_entry IN SELECT * FROM jsonb_array_elements(v_item->'addons')
        LOOP
          -- Missing addon.id on validated path: fail closed
          IF v_addon_entry->>'id' IS NULL OR v_addon_entry->>'id' = '' THEN
            RAISE EXCEPTION 'addon_missing_id:Addon entry missing id in product %', v_item->>'product_id';
          END IF;

          v_addon_id := (v_addon_entry->>'id')::uuid;

          SELECT id, price, price_type, is_active, business_id, product_id
          INTO v_addon
          FROM product_addons
          WHERE id = v_addon_id
          FOR UPDATE;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'addon_not_found:Addon % does not exist', v_addon_id;
          END IF;
          IF NOT v_addon.is_active THEN
            RAISE EXCEPTION 'addon_unavailable:Addon % is not active', v_addon_id;
          END IF;
          IF v_addon.business_id != p_business_id THEN
            RAISE EXCEPTION 'addon_wrong_business:Addon % does not belong to this business', v_addon_id;
          END IF;
          -- product_id binding: NULL = business-wide, or must match
          IF v_addon.product_id IS NOT NULL AND v_addon.product_id != (v_item->>'product_id')::uuid THEN
            RAISE EXCEPTION 'addon_wrong_product:Addon % does not belong to product %',
              v_addon_id, v_item->>'product_id';
          END IF;
          -- Reject quote price_type addons on validated path
          IF v_addon.price_type = 'quote' THEN
            RAISE EXCEPTION 'addon_quote_price:Addon % has quote price_type and cannot be committed at fixed price', v_addon_id;
          END IF;

          v_addon_total := v_addon.price * COALESCE((v_addon_entry->>'quantity')::int, 1);
          v_item_total := v_item_total + v_addon_total;
        END LOOP;
      END IF;

      v_server_total := v_server_total + v_item_total;
    END LOOP;

    -- 2c. Total validation: server-recomputed vs p_expected_total
    -- Apply discount and shipping to match caller's total
    v_server_total := v_server_total - COALESCE(p_discount_amount, 0)
                    - COALESCE(p_volume_discount_amount, 0)
                    + COALESCE(p_shipping_cost, 0);

    IF p_expected_total IS NOT NULL AND v_server_total != p_expected_total THEN
      RAISE EXCEPTION 'total_mismatch:Server total % does not match expected total %',
        v_server_total, p_expected_total;
    END IF;
  END IF;

  -- ── Non-validated promo check (legacy path) ──
  IF NOT p_validate_products AND p_promo_code_id IS NOT NULL THEN
    SELECT id, max_uses, current_uses INTO v_promo
    FROM promo_codes WHERE id = p_promo_code_id FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'promo_not_found');
    END IF;

    IF v_promo.max_uses IS NOT NULL THEN
      SELECT count(*) INTO v_active_count
      FROM promo_reservations
      WHERE promo_code_id = p_promo_code_id
        AND state = 'reserved';

      IF (v_promo.current_uses + v_active_count) >= v_promo.max_uses THEN
        RETURN jsonb_build_object('error', 'promo_exhausted');
      END IF;
    END IF;
  END IF;

  -- ── Phase 3: Mutations ──

  -- 3a. Stock decrement (only on validated path)
  IF p_validate_products THEN
    FOR v_item IN
      SELECT * FROM jsonb_array_elements(p_items) AS elem
      ORDER BY elem->>'product_id', elem->>'variant_id'
    LOOP
      IF NULLIF(v_item->>'variant_id', '') IS NOT NULL THEN
        UPDATE product_variants
        SET stock_quantity = stock_quantity - (v_item->>'quantity')::int
        WHERE id = (v_item->>'variant_id')::uuid
          AND stock_quantity IS NOT NULL
          AND stock_quantity >= (v_item->>'quantity')::int;

        IF NOT FOUND THEN
          -- Check if this variant tracks stock
          IF EXISTS (
            SELECT 1 FROM product_variants
            WHERE id = (v_item->>'variant_id')::uuid AND stock_quantity IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'insufficient_stock:Variant % has insufficient stock', v_item->>'variant_id';
          END IF;
        END IF;
      ELSE
        UPDATE products
        SET stock_quantity = stock_quantity - (v_item->>'quantity')::int
        WHERE id = (v_item->>'product_id')::uuid
          AND track_inventory = true
          AND stock_quantity IS NOT NULL
          AND stock_quantity >= (v_item->>'quantity')::int;

        IF NOT FOUND THEN
          IF EXISTS (
            SELECT 1 FROM products
            WHERE id = (v_item->>'product_id')::uuid
              AND track_inventory = true
              AND stock_quantity IS NOT NULL
          ) THEN
            RAISE EXCEPTION 'insufficient_stock:Product % has insufficient stock', v_item->>'product_id';
          END IF;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- 3b. Order INSERT (use server-recomputed total on validated path)
  INSERT INTO orders (
    bot_session_id, business_id, user_id, status,
    delivery_address, delivery_phone, total_amount,
    discount_amount, shipping_cost, promo_code_id, channel, notes,
    delivery_zone_id, delivery_zone_name, addons_total, volume_discount_amount,
    pickup_address, dropoff_address, package_description, package_photo_url,
    referral_id, items_fingerprint
  ) VALUES (
    p_bot_session_id, p_business_id, p_user_id, p_status::order_status,
    p_delivery_address, p_delivery_phone,
    CASE WHEN p_validate_products AND p_expected_total IS NOT NULL THEN v_server_total ELSE p_total_amount END,
    p_discount_amount, p_shipping_cost, p_promo_code_id, p_channel, p_notes,
    p_delivery_zone_id, p_delivery_zone_name, p_addons_total, p_volume_discount_amount,
    p_pickup_address, p_dropoff_address, p_package_description, p_package_photo_url,
    p_referral_id, v_fingerprint
  )
  RETURNING id, reference_code INTO v_order_id, v_ref;

  -- 3c. Items INSERT with server-authoritative prices on validated path
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF p_validate_products THEN
      -- Use server prices
      IF NULLIF(v_item->>'variant_id', '') IS NOT NULL THEN
        SELECT price INTO v_variant FROM product_variants WHERE id = (v_item->>'variant_id')::uuid;
        INSERT INTO order_items (order_id, product_id, quantity, unit_price, variant_id, variant_label, addons)
        VALUES (
          v_order_id,
          (v_item->>'product_id')::uuid,
          (v_item->>'quantity')::int,
          v_variant.price,
          (v_item->>'variant_id')::uuid,
          NULLIF(v_item->>'variant_label', ''),
          CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
               THEN v_item->'addons' ELSE NULL END
        );
      ELSE
        SELECT price INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
        INSERT INTO order_items (order_id, product_id, quantity, unit_price, variant_id, variant_label, addons)
        VALUES (
          v_order_id,
          (v_item->>'product_id')::uuid,
          (v_item->>'quantity')::int,
          v_product.price,
          NULL,
          NULLIF(v_item->>'variant_label', ''),
          CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
               THEN v_item->'addons' ELSE NULL END
        );
      END IF;
    ELSE
      -- Legacy: use caller-supplied prices
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
    END IF;
  END LOOP;

  -- 3d. Stock marker INSERT (validated path only)
  IF p_validate_products THEN
    INSERT INTO order_stock_applications (order_id, payment_id)
    VALUES (v_order_id, NULL);
  END IF;

  -- 3e. Promo reservation
  IF p_promo_code_id IS NOT NULL THEN
    IF p_status = 'confirmed' THEN
      INSERT INTO promo_reservations (order_id, promo_code_id, state)
      VALUES (v_order_id, p_promo_code_id, 'finalized');
      UPDATE promo_codes SET current_uses = current_uses + 1
      WHERE id = p_promo_code_id;
    ELSE
      INSERT INTO promo_reservations (order_id, promo_code_id, state)
      VALUES (v_order_id, p_promo_code_id, 'reserved');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'reference_code', v_ref,
    'created', true,
    'items_fingerprint', v_fingerprint,
    'server_total', CASE WHEN p_validate_products THEN v_server_total ELSE NULL END
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Part 4: CREATE new book_slot_atomic (30-arg)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.book_slot_atomic(
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
  p_guest_name text, p_guest_phone text, p_guest_email text,
  p_special_requests text, p_venue_address text, p_end_date date,
  p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
  p_location_id uuid DEFAULT NULL, p_appointment_id uuid DEFAULT NULL,
  p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30,
  p_bot_session_id uuid DEFAULT NULL, p_class_session_id uuid DEFAULT NULL,
  p_expected_price int DEFAULT NULL, p_expected_deposit int DEFAULT NULL
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int; v_buffer_count int; v_booking_id uuid; v_ref text;
  v_lock_key bigint; v_sched_allowed boolean; v_sched_reason text;
  v_requires_staff boolean; v_cs record; v_occupied bigint;
  v_cs_duration integer; v_canonical_staff_name text;
  v_service RECORD;
  v_effective_max_capacity int;
  v_effective_buffer int;
  v_effective_duration int;
BEGIN
  -- ── Bot session idempotency ──
  IF p_bot_session_id IS NOT NULL THEN
    SELECT id, bookings.reference_code INTO v_booking_id, v_ref
    FROM bookings WHERE bot_session_id = p_bot_session_id AND status IN ('pending', 'confirmed') LIMIT 1;
    IF FOUND THEN RETURN QUERY SELECT v_booking_id, v_ref, true; RETURN; END IF;
  END IF;

  -- ── Service revalidation (when p_expected_price IS NOT NULL) ──
  IF p_expected_price IS NOT NULL AND p_service_id IS NOT NULL THEN
    SELECT id, price, deposit_amount, is_active, max_capacity, duration_minutes,
           business_id, metadata
    INTO v_service
    FROM services WHERE id = p_service_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'service_not_found:Service % does not exist', p_service_id;
    END IF;
    IF NOT v_service.is_active THEN
      RAISE EXCEPTION 'service_unavailable:Service % is not active', p_service_id;
    END IF;
    IF v_service.business_id != p_business_id THEN
      RAISE EXCEPTION 'service_wrong_business:Service % does not belong to this business', p_service_id;
    END IF;
    IF v_service.price != p_expected_price THEN
      RAISE EXCEPTION 'price_changed:Service price changed from % to %', p_expected_price, v_service.price;
    END IF;
    IF p_expected_deposit IS NOT NULL AND v_service.deposit_amount != p_expected_deposit THEN
      RAISE EXCEPTION 'deposit_changed:Service deposit changed from % to %', p_expected_deposit, v_service.deposit_amount;
    END IF;

    -- Override caller-supplied values with DB-authoritative values
    v_effective_max_capacity := COALESCE(v_service.max_capacity, p_max_capacity);
    v_effective_buffer := COALESCE((v_service.metadata->>'buffer_minutes')::int, p_buffer_minutes);
    v_effective_duration := COALESCE(v_service.duration_minutes, p_duration);
  ELSE
    -- Legacy: use caller-supplied values
    v_effective_max_capacity := p_max_capacity;
    v_effective_buffer := p_buffer_minutes;
    v_effective_duration := p_duration;
  END IF;

  -- ── Class session path ──
  IF p_class_session_id IS NOT NULL THEN
    IF p_service_id IS NULL THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF p_appointment_id IS NOT NULL THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    v_lock_key := abs(hashtext('class_session:' || p_class_session_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);
    SELECT cs.id, cs.business_id, cs.service_id, cs.date, cs.start_time,
           cs.capacity, cs.status, cs.staff_id, cs.location_id,
           s.is_class, s.requires_staff, s.duration_minutes, s.is_active AS svc_active
    INTO v_cs FROM class_sessions cs JOIN services s ON s.id = cs.service_id
    WHERE cs.id = p_class_session_id;
    IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.business_id != p_business_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.service_id != p_service_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF NOT COALESCE(v_cs.is_class, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF NOT COALESCE(v_cs.svc_active, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.status != 'scheduled' THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    v_cs_duration := COALESCE(v_cs.duration_minutes, 60);
    IF v_cs.staff_id IS NOT NULL THEN
      IF p_staff_id IS NOT NULL AND p_staff_id != v_cs.staff_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(v_cs.staff_id, p_business_id, v_cs.date, v_cs.start_time::text, v_cs_duration) csa;
      IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      SELECT bs.name INTO v_canonical_staff_name FROM business_staff bs WHERE bs.id = v_cs.staff_id;
    ELSE
      IF COALESCE(v_cs.requires_staff, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      v_canonical_staff_name := NULL;
    END IF;
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied FROM bookings b WHERE b.class_session_id = p_class_session_id AND b.status IN ('confirmed', 'pending', 'in_progress');
    IF v_occupied + p_party_size > v_cs.capacity THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    INSERT INTO bookings (business_id, user_id, service_id, appointment_id, staff_id, staff_name, date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status, guest_name, guest_phone, guest_email, special_requests, venue_address, end_date, addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id, class_session_id)
    VALUES (p_business_id, p_user_id, v_cs.service_id, NULL, v_cs.staff_id, v_canonical_staff_name, v_cs.date, v_cs.start_time, p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel, p_deposit_amount, p_deposit_status::deposit_status, p_status::reservation_status, p_guest_name, p_guest_phone, p_guest_email, p_special_requests, p_venue_address, p_end_date, p_addons_snapshot, p_promo_code_id, p_total_amount, p_party_size, v_cs.location_id, p_bot_session_id, p_class_session_id)
    RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;
    RETURN QUERY SELECT v_booking_id, v_ref, true; RETURN;
  END IF;

  -- ── Standard booking path ──
  IF p_service_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM services WHERE id = p_service_id AND is_class = true) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_appointment_id IS NOT NULL THEN
    SELECT cas.allowed INTO v_sched_allowed FROM check_appointment_schedule(p_appointment_id, p_business_id, p_date, p_time) cas;
    IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_staff_id IS NOT NULL THEN
    SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(p_staff_id, p_business_id, p_date, p_time, COALESCE(v_effective_duration, 30)) csa;
    IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_staff_id IS NULL THEN
    v_requires_staff := false;
    IF p_appointment_id IS NOT NULL THEN SELECT COALESCE(a.requires_staff, false) INTO v_requires_staff FROM appointments a WHERE a.id = p_appointment_id;
    ELSIF p_service_id IS NOT NULL THEN SELECT COALESCE(s.requires_staff, false) INTO v_requires_staff FROM services s WHERE s.id = p_service_id;
    END IF;
    IF v_requires_staff THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  v_lock_key := abs(hashtext(p_business_id::text || '|' || p_date::text || '|' || p_time::time::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);
  SELECT COUNT(*) INTO v_count FROM bookings WHERE business_id = p_business_id AND date = p_date AND time = p_time::time AND status IN ('confirmed', 'pending', 'in_progress') AND (p_staff_id IS NULL OR staff_id = p_staff_id);
  IF v_count >= v_effective_max_capacity THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  IF v_effective_buffer > 0 THEN
    SELECT COUNT(*) INTO v_buffer_count FROM bookings WHERE business_id = p_business_id AND date = p_date AND status IN ('pending', 'confirmed', 'in_progress') AND (p_staff_id IS NULL OR staff_id = p_staff_id) AND time != p_time::time AND (p_time::time < (time + make_interval(mins => COALESCE(v_effective_duration, 30) + v_effective_buffer)) AND (p_time::time + make_interval(mins => COALESCE(v_effective_duration, 30))) > (time - make_interval(mins => v_effective_buffer)));
    IF v_buffer_count > 0 THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  INSERT INTO bookings (business_id, user_id, service_id, appointment_id, staff_id, staff_name, date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status, guest_name, guest_phone, guest_email, special_requests, venue_address, end_date, addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id)
  VALUES (p_business_id, p_user_id, CASE WHEN p_appointment_id IS NOT NULL THEN NULL ELSE p_service_id END, p_appointment_id, p_staff_id, p_staff_name, p_date, p_time::time, p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel, p_deposit_amount, p_deposit_status::deposit_status, p_status::reservation_status, p_guest_name, p_guest_phone, p_guest_email, p_special_requests, p_venue_address, p_end_date, p_addons_snapshot, p_promo_code_id, p_total_amount, p_party_size, p_location_id, p_bot_session_id)
  RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;
  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Part 5: CREATE new purchase_tickets_atomic (12-arg)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.purchase_tickets_atomic(
  p_business_id UUID,
  p_event_id UUID,
  p_ticket_type_id UUID,
  p_quantity INT,
  p_user_id UUID,
  p_guest_name TEXT,
  p_guest_phone TEXT,
  p_guest_email TEXT,
  p_total_amount INT,
  p_channel TEXT DEFAULT 'web',
  p_bot_session_id UUID DEFAULT NULL,
  p_expected_price INT DEFAULT NULL
) RETURNS TABLE(booking_id UUID, reference_code TEXT, tickets_available BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_available INT;
  v_booking_id UUID;
  v_ref TEXT;
  v_event_date DATE;
  v_event_time TIME;
  v_event_name TEXT;
  v_event_status TEXT;
  v_existing_booking_id UUID;
  v_existing_ref TEXT;
  v_ticket_price INT;
BEGIN
  -- Bot session idempotency
  IF p_bot_session_id IS NOT NULL THEN
    SELECT id, bookings.reference_code INTO v_existing_booking_id, v_existing_ref
    FROM bookings
    WHERE bot_session_id = p_bot_session_id
      AND status IN ('pending', 'confirmed')
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_existing_booking_id, v_existing_ref, true;
      RETURN;
    END IF;
  END IF;

  -- Lock event row to prevent overselling
  SELECT date, time, name, status::text INTO v_event_date, v_event_time, v_event_name, v_event_status
  FROM events WHERE id = p_event_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, false;
    RETURN;
  END IF;

  -- Event must be published
  IF v_event_status != 'published' THEN
    RAISE EXCEPTION 'event_not_published:Event % is not published (status=%)', p_event_id, v_event_status;
  END IF;

  -- Price validation
  IF p_expected_price IS NOT NULL THEN
    IF p_ticket_type_id IS NOT NULL THEN
      SELECT price INTO v_ticket_price FROM event_ticket_types WHERE id = p_ticket_type_id;
      IF v_ticket_price IS NULL THEN
        RAISE EXCEPTION 'ticket_type_not_found:Ticket type % does not exist', p_ticket_type_id;
      END IF;
    ELSE
      SELECT price INTO v_ticket_price FROM events WHERE id = p_event_id;
    END IF;

    IF v_ticket_price != p_expected_price THEN
      RAISE EXCEPTION 'price_changed:Ticket price changed from % to %', p_expected_price, v_ticket_price;
    END IF;
  END IF;

  -- Check availability
  IF p_ticket_type_id IS NOT NULL THEN
    PERFORM id FROM event_ticket_types WHERE id = p_ticket_type_id FOR UPDATE;
    SELECT (total_tickets - tickets_sold) INTO v_available
    FROM event_ticket_types WHERE id = p_ticket_type_id;
  ELSE
    SELECT (total_tickets - tickets_sold) INTO v_available
    FROM events WHERE id = p_event_id;
  END IF;

  IF v_available IS NULL OR v_available < p_quantity THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, false;
    RETURN;
  END IF;

  -- Increment tickets_sold
  UPDATE events SET tickets_sold = tickets_sold + p_quantity WHERE id = p_event_id;
  IF p_ticket_type_id IS NOT NULL THEN
    UPDATE event_ticket_types SET tickets_sold = tickets_sold + p_quantity WHERE id = p_ticket_type_id;
  END IF;

  -- Create booking
  INSERT INTO bookings (
    business_id, user_id, event_id, date, time, party_size, quantity,
    flow_type, channel, deposit_amount, deposit_status, status,
    total_amount, guest_name, guest_phone, guest_email, notes,
    bot_session_id, tickets_finalized
  ) VALUES (
    p_business_id,
    p_user_id,
    p_event_id,
    v_event_date,
    COALESCE(v_event_time, '00:00'::TIME),
    p_quantity,
    p_quantity,
    'ticketing'::flow_type,
    p_channel::booking_channel,
    p_total_amount,
    CASE WHEN p_total_amount > 0 THEN 'pending'::deposit_status ELSE 'none'::deposit_status END,
    CASE WHEN p_total_amount > 0 THEN 'pending' ELSE 'confirmed' END,
    p_total_amount,
    p_guest_name,
    p_guest_phone,
    p_guest_email,
    'Tickets for: ' || v_event_name,
    p_bot_session_id,
    true
  ) RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Part 6: CREATE cancel_order_immediate (2-arg)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cancel_order_immediate(
  p_order_id UUID,
  p_reason TEXT DEFAULT 'customer_cancel'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_item RECORD;
  v_count INTEGER := 0;
  v_had_marker BOOLEAN := false;
  v_has_payment BOOLEAN := false;
  v_quote_id UUID;
BEGIN
  -- 1. Lock order row
  SELECT id, status, promo_code_id, quote_request_id
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  -- 2. Status gate: only pending orders
  IF v_order.status != 'pending' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', v_order.status);
  END IF;

  -- 3. Payment authority fence: lock payment rows FOR UPDATE, check for success/active finalization
  PERFORM id FROM payments
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
  FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM payments
    WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
      AND (
        status = 'success'
        OR (finalization_processing_at IS NOT NULL
            AND finalization_processing_at > NOW() - INTERVAL '5 minutes')
      )
  ) INTO v_has_payment;

  IF v_has_payment THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'has_successful_payment');
  END IF;

  -- 4. Void pending payments
  UPDATE payments
  SET status = 'failed',
      gateway_status = p_reason,
      updated_at = NOW()
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
    AND status = 'pending';

  -- 5. Check canonical stock marker and restore if present
  PERFORM id FROM order_stock_applications WHERE order_id = p_order_id;

  IF FOUND THEN
    v_had_marker := true;

    -- Deterministically lock and restore inventory
    FOR v_item IN
      SELECT oi.product_id, oi.variant_id, oi.quantity
      FROM order_items oi
      WHERE oi.order_id = p_order_id
      ORDER BY oi.product_id, oi.variant_id NULLS FIRST
    LOOP
      IF v_item.variant_id IS NOT NULL THEN
        UPDATE product_variants
        SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
        WHERE id = v_item.variant_id AND stock_quantity IS NOT NULL;
      ELSIF v_item.product_id IS NOT NULL THEN
        UPDATE products
        SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
        WHERE id = v_item.product_id AND track_inventory = true;
      END IF;
      v_count := v_count + 1;
    END LOOP;

    -- Delete marker
    DELETE FROM order_stock_applications WHERE order_id = p_order_id;
  END IF;

  -- 6. Release promo reservation
  IF v_order.promo_code_id IS NOT NULL THEN
    -- Delete reservation (unreserve)
    DELETE FROM promo_reservations
    WHERE order_id = p_order_id AND state = 'reserved';

    -- If finalized, also decrement current_uses
    IF EXISTS (SELECT 1 FROM promo_reservations WHERE order_id = p_order_id AND state = 'finalized') THEN
      UPDATE promo_codes SET current_uses = GREATEST(current_uses - 1, 0)
      WHERE id = v_order.promo_code_id;
      DELETE FROM promo_reservations WHERE order_id = p_order_id AND state = 'finalized';
    END IF;
  END IF;

  -- 7. Cancel order
  UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = p_order_id;

  -- 8. Revert quote status if quote-origin
  IF v_order.quote_request_id IS NOT NULL THEN
    UPDATE quote_requests
    SET status = 'quoted', order_id = NULL, responded_at = NULL
    WHERE id = v_order.quote_request_id
      AND status = 'accepted';
  END IF;

  RETURN jsonb_build_object(
    'cancelled', true,
    'reason', p_reason,
    'stock_restored', v_had_marker,
    'items_restored', v_count
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Part 7: CREATE create_payment_booking_atomic (9-arg)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.create_payment_booking_atomic(
  p_bot_session_id UUID,
  p_business_id UUID,
  p_user_id UUID,
  p_service_id UUID,
  p_amount INT,
  p_guest_name TEXT,
  p_guest_phone TEXT,
  p_service_name TEXT DEFAULT NULL,
  p_expected_price INT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_booking_id UUID;
  v_ref TEXT;
  v_existing_id UUID;
  v_existing_ref TEXT;
  v_service RECORD;
BEGIN
  -- Advisory lock on bot_session_id
  PERFORM pg_advisory_xact_lock(abs(hashtext(p_bot_session_id::text)));

  -- Idempotency: check for existing booking from same bot session
  SELECT id, bookings.reference_code INTO v_existing_id, v_existing_ref
  FROM bookings
  WHERE bot_session_id = p_bot_session_id
    AND status IN ('pending', 'confirmed')
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'booking_id', v_existing_id,
      'reference_code', v_existing_ref,
      'created', false
    );
  END IF;

  -- Service revalidation (when service_id provided)
  IF p_service_id IS NOT NULL THEN
    SELECT id, price, is_active, business_id, price_is_variable
    INTO v_service
    FROM services WHERE id = p_service_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'service_not_found:Service % does not exist', p_service_id;
    END IF;
    IF NOT v_service.is_active THEN
      RAISE EXCEPTION 'service_unavailable:Service % is not active', p_service_id;
    END IF;
    IF v_service.business_id != p_business_id THEN
      RAISE EXCEPTION 'service_wrong_business:Service % does not belong to this business', p_service_id;
    END IF;

    -- Fixed-price check: skip for variable/donation
    IF NOT COALESCE(v_service.price_is_variable, false) THEN
      IF p_expected_price IS NOT NULL AND v_service.price != p_expected_price THEN
        RAISE EXCEPTION 'price_changed:Service price changed from % to %', p_expected_price, v_service.price;
      END IF;
    END IF;
  END IF;

  -- Create booking
  INSERT INTO bookings (
    business_id, user_id, service_id, date, time,
    party_size, flow_type, channel, payment_source,
    deposit_amount, deposit_status, status,
    total_amount, quantity,
    guest_name, guest_phone, notes,
    bot_session_id
  ) VALUES (
    p_business_id,
    p_user_id,
    p_service_id,
    CURRENT_DATE,
    LOCALTIME(0),
    1,
    'payment'::flow_type,
    'whatsapp'::booking_channel,
    'payment_request',
    p_amount,
    CASE WHEN p_amount > 0 THEN 'pending'::deposit_status ELSE 'none'::deposit_status END,
    CASE WHEN p_amount > 0 THEN 'pending' ELSE 'confirmed' END,
    p_amount,
    1,
    p_guest_name,
    p_guest_phone,
    COALESCE(p_service_name, 'Payment') || ' payment',
    p_bot_session_id
  ) RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;

  RETURN jsonb_build_object(
    'booking_id', v_booking_id,
    'reference_code', v_ref,
    'created', true
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Part 8: CREATE create_reservation_atomic (13-arg)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.create_reservation_atomic(
  p_bot_session_id UUID,
  p_business_id UUID,
  p_user_id UUID,
  p_property_id UUID,
  p_check_in DATE,
  p_check_out DATE,
  p_guests INT DEFAULT 1,
  p_nightly_rate INT DEFAULT 0,
  p_total_amount INT DEFAULT 0,
  p_deposit_amount INT DEFAULT 0,
  p_special_requests TEXT DEFAULT NULL,
  p_guest_name TEXT DEFAULT NULL,
  p_guest_phone TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservation_id UUID;
  v_ref TEXT;
  v_existing_id UUID;
  v_existing_ref TEXT;
  v_property RECORD;
  v_overlap_count INT;
  v_blocked_count INT;
  v_payable INT;
BEGIN
  -- Advisory lock on business_id + property_id
  PERFORM pg_advisory_xact_lock(abs(hashtext(p_business_id::text || '|' || p_property_id::text)));

  -- Idempotency: check for existing reservation from same bot session
  SELECT id, reference_code INTO v_existing_id, v_existing_ref
  FROM reservations
  WHERE bot_session_id = p_bot_session_id
    AND status IN ('pending', 'confirmed')
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'reservation_id', v_existing_id,
      'reference_code', v_existing_ref,
      'created', false
    );
  END IF;

  -- Lock property FOR UPDATE and validate
  SELECT id, price, deposit_amount, is_active, business_id, price_is_variable
  INTO v_property
  FROM properties WHERE id = p_property_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'property_not_found:Property % does not exist', p_property_id;
  END IF;
  IF NOT v_property.is_active THEN
    RAISE EXCEPTION 'property_unavailable:Property % is not active', p_property_id;
  END IF;
  IF v_property.business_id != p_business_id THEN
    RAISE EXCEPTION 'property_wrong_business:Property % does not belong to this business', p_property_id;
  END IF;

  -- Price validation (skip for variable-price properties)
  IF NOT COALESCE(v_property.price_is_variable, false) THEN
    IF v_property.price::int != p_nightly_rate THEN
      RAISE EXCEPTION 'price_changed:Property nightly rate changed from % to %', p_nightly_rate, v_property.price::int;
    END IF;
    IF v_property.deposit_amount::int != p_deposit_amount THEN
      RAISE EXCEPTION 'deposit_changed:Property deposit changed from % to %', p_deposit_amount, v_property.deposit_amount::int;
    END IF;
  END IF;

  -- Overlap check (under lock)
  SELECT COUNT(*) INTO v_overlap_count
  FROM reservations
  WHERE business_id = p_business_id
    AND (property_id = p_property_id OR service_id = p_property_id)
    AND status IN ('pending', 'confirmed')
    AND check_in < p_check_out
    AND check_out > p_check_in;

  IF v_overlap_count > 0 THEN
    RAISE EXCEPTION 'dates_unavailable:Property is already booked for the selected dates';
  END IF;

  -- Blocked dates check
  SELECT COUNT(*) INTO v_blocked_count
  FROM property_blocked_dates
  WHERE property_id = p_property_id
    AND date_from < p_check_out
    AND date_to >= p_check_in;

  IF v_blocked_count > 0 THEN
    RAISE EXCEPTION 'dates_blocked:Property has blocked dates in the selected range';
  END IF;

  -- Determine payable amount
  v_payable := CASE WHEN p_deposit_amount > 0 THEN p_deposit_amount ELSE p_total_amount END;

  -- INSERT reservation
  INSERT INTO reservations (
    business_id, user_id, property_id,
    check_in, check_out, guests,
    nightly_rate, total_amount, deposit_amount,
    deposit_status, status,
    special_requests, guest_name, guest_phone,
    channel, bot_session_id
  ) VALUES (
    p_business_id, p_user_id, p_property_id,
    p_check_in, p_check_out, p_guests,
    p_nightly_rate, p_total_amount, p_deposit_amount,
    CASE WHEN v_payable > 0 THEN 'pending' ELSE 'none' END,
    CASE WHEN v_payable > 0 THEN 'pending' ELSE 'confirmed' END,
    p_special_requests, p_guest_name, p_guest_phone,
    'whatsapp', p_bot_session_id
  ) RETURNING id, reference_code INTO v_reservation_id, v_ref;

  RETURN jsonb_build_object(
    'reservation_id', v_reservation_id,
    'reference_code', v_ref,
    'created', true,
    'total_amount', p_total_amount,
    'deposit_amount', p_deposit_amount,
    'payable', v_payable
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Part 9: Revised accept_order_quote_atomic (body-only replacement)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.accept_order_quote_atomic(
  p_quote_id UUID,
  p_customer_phone TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote RECORD;
  v_biz RECORD;
  v_trusted TEXT;
  v_stored TEXT;
  v_total INTEGER;
  v_deposit_pct INTEGER;
  v_deposit_amount INTEGER;
  v_balance_amount INTEGER;
  v_order_id UUID;
  v_ref TEXT;
  v_item JSONB;
  v_existing_order RECORD;
  v_stock_result JSONB;
  v_custom_config JSONB;
  v_has_custom_data BOOLEAN;
  v_product RECORD;
  v_variant RECORD;
  v_addon RECORD;
  v_addon_entry JSONB;
  v_addon_id UUID;
BEGIN
  -- 1. Identity validation: fail closed
  v_trusted := regexp_replace(COALESCE(p_customer_phone, ''), '^\+', '');
  IF v_trusted = '' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'identity_missing');
  END IF;

  -- 2. Lock quote row
  SELECT * INTO v_quote
  FROM quote_requests WHERE id = p_quote_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;

  -- 3. Verify identity
  v_stored := regexp_replace(COALESCE(v_quote.customer_phone, ''), '^\+', '');
  IF v_stored = '' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'quote_phone_missing');
  END IF;
  IF v_trusted != v_stored THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'identity_mismatch');
  END IF;

  -- 4. Status checks
  IF v_quote.status = 'accepted' THEN
    SELECT id, reference_code, total_amount, deposit_amount, balance_amount
    INTO v_existing_order
    FROM orders WHERE quote_request_id = p_quote_id LIMIT 1;
    RETURN jsonb_build_object(
      'accepted', true, 'already_accepted', true,
      'order_id', v_existing_order.id,
      'reference_code', v_existing_order.reference_code,
      'total', COALESCE(v_existing_order.total_amount, 0),
      'deposit_amount', COALESCE(v_existing_order.deposit_amount, 0),
      'balance_amount', COALESCE(v_existing_order.balance_amount, 0),
      'customer_phone', v_quote.customer_phone,
      'business_id', v_quote.business_id
    );
  END IF;

  IF v_quote.status = 'rejected' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'already_rejected');
  END IF;
  IF v_quote.status = 'expired' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'expired');
  END IF;
  IF v_quote.status = 'cancelled' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'cancelled');
  END IF;
  IF v_quote.status = 'pending' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_yet_quoted');
  END IF;
  IF v_quote.status != 'quoted' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'invalid_status');
  END IF;

  -- 5. Check expiry
  IF v_quote.expires_at IS NOT NULL AND v_quote.expires_at < NOW() THEN
    UPDATE quote_requests SET status = 'expired' WHERE id = p_quote_id;
    RETURN jsonb_build_object('accepted', false, 'reason', 'expired');
  END IF;

  -- 6. Derive total — fail closed on NULL quoted_amount
  IF v_quote.quoted_amount IS NULL THEN
    RAISE EXCEPTION 'quoted_amount_missing:Quote % has no quoted_amount — cannot accept', p_quote_id;
  END IF;
  v_total := v_quote.quoted_amount;

  SELECT id, name, country_code, subscription_tier, trial_ends_at, metadata
  INTO v_biz FROM businesses WHERE id = v_quote.business_id;

  v_has_custom_data := v_quote.custom_order_data IS NOT NULL;
  v_custom_config := COALESCE(v_biz.metadata->'custom_order_config', '{}'::jsonb);
  v_deposit_pct := CASE
    WHEN v_has_custom_data THEN COALESCE((v_custom_config->>'deposit_percentage')::int, 0)
    ELSE 0
  END;
  v_deposit_amount := CASE WHEN v_deposit_pct > 0 THEN (v_total * v_deposit_pct / 100) ELSE 0 END;
  v_balance_amount := CASE WHEN v_deposit_pct > 0 THEN v_total - v_deposit_amount ELSE 0 END;

  -- 7. Phase 2: Product/variant/addon validation from cart_snapshot
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_quote.cart_snapshot, '[]'::jsonb))
  LOOP
    -- Validate product
    IF v_item->>'product_id' IS NOT NULL THEN
      SELECT id, is_active, deleted_at, business_id
      INTO v_product
      FROM products WHERE id = (v_item->>'product_id')::uuid FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'product_not_found:Product % in quote cart does not exist', v_item->>'product_id';
      END IF;
      IF NOT v_product.is_active THEN
        RAISE EXCEPTION 'product_unavailable:Product % is no longer active', v_item->>'product_id';
      END IF;
      IF v_product.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'product_deleted:Product % has been deleted', v_item->>'product_id';
      END IF;
      IF v_product.business_id != v_quote.business_id THEN
        RAISE EXCEPTION 'product_wrong_business:Product % does not belong to this business', v_item->>'product_id';
      END IF;

      -- Validate variant
      IF NULLIF(v_item->>'variant_id', '') IS NOT NULL THEN
        SELECT id, product_id, is_active
        INTO v_variant
        FROM product_variants WHERE id = (v_item->>'variant_id')::uuid FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'variant_not_found:Variant % does not exist', v_item->>'variant_id';
        END IF;
        IF NOT v_variant.is_active THEN
          RAISE EXCEPTION 'variant_unavailable:Variant % is no longer active', v_item->>'variant_id';
        END IF;
        IF v_variant.product_id != (v_item->>'product_id')::uuid THEN
          RAISE EXCEPTION 'variant_wrong_product:Variant % does not belong to product %',
            v_item->>'variant_id', v_item->>'product_id';
        END IF;
      END IF;

      -- Validate addons
      IF v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb THEN
        FOR v_addon_entry IN SELECT * FROM jsonb_array_elements(v_item->'addons')
        LOOP
          -- snapshot_version-gated addon ID requirement
          IF v_addon_entry->>'id' IS NULL OR v_addon_entry->>'id' = '' THEN
            IF COALESCE(v_quote.snapshot_version, 1) >= 2 THEN
              RAISE EXCEPTION 'addon_missing_id:v2 snapshot requires addon id in product %', v_item->>'product_id';
            END IF;
            -- v1: permissive — skip validation for this addon
            CONTINUE;
          END IF;

          v_addon_id := (v_addon_entry->>'id')::uuid;

          SELECT id, is_active, business_id, product_id
          INTO v_addon
          FROM product_addons WHERE id = v_addon_id FOR UPDATE;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'addon_not_found:Addon % does not exist', v_addon_id;
          END IF;
          IF NOT v_addon.is_active THEN
            RAISE EXCEPTION 'addon_unavailable:Addon % is no longer active', v_addon_id;
          END IF;
          IF v_addon.business_id != v_quote.business_id THEN
            RAISE EXCEPTION 'addon_wrong_business:Addon % does not belong to this business', v_addon_id;
          END IF;
          -- product_id binding: NULL = business-wide, or must match
          IF v_addon.product_id IS NOT NULL AND v_addon.product_id != (v_item->>'product_id')::uuid THEN
            RAISE EXCEPTION 'addon_wrong_product:Addon % does not belong to product %',
              v_addon_id, v_item->>'product_id';
          END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;

  -- 8. Create order
  INSERT INTO orders (
    business_id, user_id, status,
    delivery_address, delivery_phone, total_amount,
    delivery_zone_id, delivery_zone_name,
    quote_request_id, channel, notes,
    custom_order_data,
    deposit_percentage, deposit_amount, balance_amount
  ) VALUES (
    v_quote.business_id,
    v_quote.user_id,
    CASE WHEN v_total > 0 THEN 'pending'::order_status ELSE 'confirmed'::order_status END,
    v_quote.delivery_address,
    v_quote.customer_phone,
    v_total,
    v_quote.delivery_zone_id,
    v_quote.delivery_zone_name,
    p_quote_id,
    COALESCE(v_quote.channel, 'whatsapp'),
    v_quote.quote_notes,
    v_quote.custom_order_data,
    CASE WHEN v_deposit_pct > 0 THEN v_deposit_pct ELSE NULL END,
    v_deposit_amount,
    v_balance_amount
  ) RETURNING id, reference_code INTO v_order_id, v_ref;

  -- 9. Create order items from cart_snapshot
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_quote.cart_snapshot, '[]'::jsonb))
  LOOP
    INSERT INTO order_items (
      order_id, product_id, quantity, unit_price,
      variant_id, variant_label, addons
    ) VALUES (
      v_order_id,
      (v_item->>'product_id')::uuid,
      COALESCE((v_item->>'quantity')::int, 1),
      COALESCE((v_item->>'price')::int, 0),
      NULLIF(v_item->>'variant_id', '')::uuid,
      NULLIF(v_item->>'variant_label', ''),
      CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
           THEN v_item->'addons' ELSE NULL END
    );
  END LOOP;

  -- 10. Reserve inventory via canonical RPC (same transaction)
  v_stock_result := apply_order_stock_once(v_order_id, NULL, true);

  IF NOT (v_stock_result->>'applied')::boolean THEN
    RAISE EXCEPTION 'stock_application_failed:%', v_stock_result->>'reason';
  END IF;

  -- 11. Update quote
  UPDATE quote_requests SET
    status = 'accepted',
    order_id = v_order_id,
    responded_at = NOW()
  WHERE id = p_quote_id;

  RETURN jsonb_build_object(
    'accepted', true,
    'already_accepted', false,
    'order_id', v_order_id,
    'reference_code', v_ref,
    'total', v_total,
    'deposit_amount', v_deposit_amount,
    'balance_amount', v_balance_amount,
    'customer_phone', v_quote.customer_phone,
    'business_id', v_quote.business_id
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Part 10: Stale-overload assertion + ACL blocks
-- ═══════════════════════════════════════════════════════

-- Assert exactly 1 signature per function name (no stale overloads)
DO $$
DECLARE
  v_fn TEXT;
  v_count INT;
  v_fns TEXT[] := ARRAY[
    'create_order_atomic',
    'book_slot_atomic',
    'purchase_tickets_atomic',
    'cancel_order_immediate',
    'create_payment_booking_atomic',
    'create_reservation_atomic',
    'accept_order_quote_atomic'
  ];
BEGIN
  FOREACH v_fn IN ARRAY v_fns
  LOOP
    SELECT COUNT(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_fn;

    IF v_count != 1 THEN
      RAISE EXCEPTION 'stale_overload:Function % has % signatures (expected 1)', v_fn, v_count;
    END IF;
  END LOOP;

  RAISE NOTICE 'Stale-overload assertion passed: all functions have exactly 1 signature';
END $$;

-- ACL: create_order_atomic
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.create_order_atomic(
    uuid, uuid, uuid, text, text, text, int, int, int, uuid,
    text, text, uuid, text, int, int, text, text, text, text, jsonb, uuid,
    boolean, int
  ) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.create_order_atomic(
      uuid, uuid, uuid, text, text, text, int, int, int, uuid,
      text, text, uuid, text, int, int, text, text, text, text, jsonb, uuid,
      boolean, int
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.create_order_atomic(
      uuid, uuid, uuid, text, text, text, int, int, int, uuid,
      text, text, uuid, text, int, int, text, text, text, text, jsonb, uuid,
      boolean, int
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.create_order_atomic(
      uuid, uuid, uuid, text, text, text, int, int, int, uuid,
      text, text, uuid, text, int, int, text, text, text, text, jsonb, uuid,
      boolean, int
    ) TO service_role;
  END IF;
END $$;

-- ACL: book_slot_atomic
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.book_slot_atomic(
    uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,
    text,text,date,jsonb,uuid,int,text,uuid,uuid,integer,integer,uuid,uuid,
    int,int
  ) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.book_slot_atomic(
      uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,
      text,text,date,jsonb,uuid,int,text,uuid,uuid,integer,integer,uuid,uuid,
      int,int
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.book_slot_atomic(
      uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,
      text,text,date,jsonb,uuid,int,text,uuid,uuid,integer,integer,uuid,uuid,
      int,int
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.book_slot_atomic(
      uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,
      text,text,date,jsonb,uuid,int,text,uuid,uuid,integer,integer,uuid,uuid,
      int,int
    ) TO service_role;
  END IF;
END $$;

-- ACL: purchase_tickets_atomic
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.purchase_tickets_atomic(
    uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, int
  ) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.purchase_tickets_atomic(
      uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, int
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.purchase_tickets_atomic(
      uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, int
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.purchase_tickets_atomic(
      uuid, uuid, uuid, integer, uuid, text, text, text, integer, text, uuid, int
    ) TO service_role;
  END IF;
END $$;

-- ACL: cancel_order_immediate
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.cancel_order_immediate(uuid, text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.cancel_order_immediate(uuid, text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.cancel_order_immediate(uuid, text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.cancel_order_immediate(uuid, text) TO service_role;
  END IF;
END $$;

-- ACL: create_payment_booking_atomic
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.create_payment_booking_atomic(
    uuid, uuid, uuid, uuid, int, text, text, text, int
  ) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.create_payment_booking_atomic(
      uuid, uuid, uuid, uuid, int, text, text, text, int
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.create_payment_booking_atomic(
      uuid, uuid, uuid, uuid, int, text, text, text, int
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.create_payment_booking_atomic(
      uuid, uuid, uuid, uuid, int, text, text, text, int
    ) TO service_role;
  END IF;
END $$;

-- ACL: create_reservation_atomic
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.create_reservation_atomic(
    uuid, uuid, uuid, uuid, date, date, int, int, int, int, text, text, text
  ) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.create_reservation_atomic(
      uuid, uuid, uuid, uuid, date, date, int, int, int, int, text, text, text
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.create_reservation_atomic(
      uuid, uuid, uuid, uuid, date, date, int, int, int, int, text, text, text
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.create_reservation_atomic(
      uuid, uuid, uuid, uuid, date, date, int, int, int, int, text, text, text
    ) TO service_role;
  END IF;
END $$;

-- ACL: accept_order_quote_atomic (re-applied after body replacement)
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.accept_order_quote_atomic(UUID, TEXT) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.accept_order_quote_atomic(UUID, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.accept_order_quote_atomic(UUID, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.accept_order_quote_atomic(UUID, TEXT) TO service_role;
  END IF;
END $$;
