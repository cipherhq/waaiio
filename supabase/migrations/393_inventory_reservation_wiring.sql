-- ═══════════════════════════════════════════════════════════════════════════
-- M393: Inventory Reservation Wiring (#352 Phase 2B+2C)
--
-- Wire ordering into M383 validated product path with reservation lifecycle:
--   1. create_order_atomic — delivery-zone server total, zero-floor, marker class
--   2. apply_order_stock_once — winner conflict/replay, close linked transfers
--   3. cancel_stale_order_atomic — marker-aware expiry authority
--   4. cancel_order_immediate — cancel linked pending transfers
--   5. create_transfer_with_reservation (NEW) — atomic transfer + marker extension
--   6. confirm_order_transfer_atomic (NEW) — bank-transfer winner authority
--   7. reject_order_transfer_atomic (NEW) — bank-transfer rejection authority
--
-- M327/M383/M392 remain immutable history. All bodies start from exact
-- canonical versions and apply only specified additions.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. create_order_atomic (modified from M383) ─────────────────────────
-- Changes:
--   a) Delivery-zone server-authoritative total (re-read from DB)
--   b) Zero-floor: GREATEST(0, v_server_total)
--   c) Marker reservation_class + expires_at based on order status

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
  v_zone RECORD;  -- M393: delivery zone
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
    -- Apply discount and volume discount
    v_server_total := v_server_total - COALESCE(p_discount_amount, 0)
                    - COALESCE(p_volume_discount_amount, 0);

    -- M393: Delivery-zone server-authoritative total
    -- When a delivery zone is specified, re-read its price from DB instead of trusting p_shipping_cost
    IF p_delivery_zone_id IS NOT NULL THEN
      SELECT id, price, name, business_id, is_active
      INTO v_zone
      FROM delivery_zones
      WHERE id = p_delivery_zone_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'zone_not_found:Delivery zone % does not exist', p_delivery_zone_id;
      END IF;
      IF NOT v_zone.is_active THEN
        RAISE EXCEPTION 'zone_unavailable:Delivery zone % is not active', p_delivery_zone_id;
      END IF;
      IF v_zone.business_id != p_business_id THEN
        RAISE EXCEPTION 'zone_wrong_business:Delivery zone % does not belong to this business', p_delivery_zone_id;
      END IF;

      -- Add zone price (replaces shipping for zone orders — no double-count)
      v_server_total := v_server_total + v_zone.price;
    ELSE
      -- No zone: use caller-supplied shipping cost
      v_server_total := v_server_total + COALESCE(p_shipping_cost, 0);
    END IF;

    -- M393: Zero-floor parity with Math.max(0, ...) on client
    v_server_total := GREATEST(0, v_server_total);

    -- When p_validate_products=true, p_expected_total is REQUIRED (fail-closed)
    IF p_expected_total IS NULL THEN
      RAISE EXCEPTION 'expected_total_required:p_expected_total must be provided when p_validate_products=true';
    END IF;
    IF v_server_total != p_expected_total THEN
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
    CASE WHEN p_validate_products THEN v_server_total ELSE p_total_amount END,
    p_discount_amount, p_shipping_cost, p_promo_code_id, p_channel, p_notes,
    p_delivery_zone_id,
    CASE WHEN p_validate_products AND p_delivery_zone_id IS NOT NULL THEN v_zone.name
         ELSE p_delivery_zone_name END,
    p_addons_total, p_volume_discount_amount,
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
  -- M393: Include reservation_class and expires_at based on order status
  IF p_validate_products THEN
    IF p_status = 'confirmed' THEN
      -- Free/confirmed order: committed immediately, no expiry
      INSERT INTO order_stock_applications (order_id, payment_id, reservation_class, expires_at)
      VALUES (v_order_id, NULL, 'committed', NULL);
    ELSE
      -- Pending/paid order: instant hold, 30-minute expiry
      INSERT INTO order_stock_applications (order_id, payment_id, reservation_class, expires_at)
      VALUES (v_order_id, NULL, 'instant', NOW() + INTERVAL '30 minutes');
    END IF;
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

-- ACL: preserve existing (M383 dropped old, we just re-assert)
REVOKE ALL ON FUNCTION public.create_order_atomic(
  uuid, uuid, uuid, text, text, text, int, int, int, uuid, text, text,
  uuid, text, int, int, text, text, text, text, jsonb, uuid, boolean, int
) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.create_order_atomic(
      uuid, uuid, uuid, text, text, text, int, int, int, uuid, text, text,
      uuid, text, int, int, text, text, text, text, jsonb, uuid, boolean, int
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.create_order_atomic(
      uuid, uuid, uuid, text, text, text, int, int, int, uuid, text, text,
      uuid, text, int, int, text, text, text, text, jsonb, uuid, boolean, int
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.create_order_atomic(
      uuid, uuid, uuid, text, text, text, int, int, int, uuid, text, text,
      uuid, text, int, int, text, text, text, text, jsonb, uuid, boolean, int
    ) TO service_role;
  END IF;
END $$;


-- ─── 2. apply_order_stock_once (modified from M327) ─────────────────────
-- Changes:
--   a) Existing-marker winner conflict/replay rules
--   b) Fresh marker: committed when payment, prepayment when no payment
--   c) Close linked pending_transfers on online payment win

CREATE OR REPLACE FUNCTION public.apply_order_stock_once(
  p_order_id UUID,
  p_payment_id UUID DEFAULT NULL,
  p_validate_sufficient BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_existing RECORD;
  v_item RECORD;
  v_product RECORD;
  v_variant RECORD;
  v_count INTEGER := 0;
  v_out_of_stock TEXT[] := '{}';
BEGIN
  -- 1. Lock order row (serializes all stock operations for this order)
  SELECT id, status
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'order_not_found');
  END IF;

  -- 2. Reject cancelled orders (cleanup already restored stock)
  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'order_cancelled');
  END IF;

  -- 3. Validate payment→order relationship AND payment success when payment_id is supplied.
  --    INVARIANT: stock/order mutation requires payment.status = 'success'.
  --    p_payment_id = NULL is allowed for trusted pre-payment paths (quote acceptance, free orders).
  IF p_payment_id IS NOT NULL THEN
    PERFORM id FROM payments
    WHERE id = p_payment_id
      AND (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text);
    IF NOT FOUND THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'payment_order_mismatch');
    END IF;
    -- Payment must be successful before any stock/order mutation
    PERFORM id FROM payments
    WHERE id = p_payment_id AND status = 'success';
    IF NOT FOUND THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_successful');
    END IF;
  END IF;

  -- 4. Check order-level marker
  SELECT id, reservation_class, expires_at, payment_id
  INTO v_existing
  FROM order_stock_applications
  WHERE order_id = p_order_id
  FOR UPDATE;  -- M393: lock marker for winner conflict

  IF FOUND THEN
    -- M393: Exact winner conflict/replay rules
    IF v_existing.reservation_class = 'committed' THEN
      -- Already committed
      IF p_payment_id IS NOT NULL AND v_existing.payment_id = p_payment_id THEN
        -- Idempotent replay: same payment committed again
        RETURN jsonb_build_object('applied', true, 'already_applied', true,
          'order_confirmed', true);
      ELSIF p_payment_id IS NOT NULL AND v_existing.payment_id IS NOT NULL
            AND v_existing.payment_id != p_payment_id THEN
        -- Different payment trying to claim: conflict
        RETURN jsonb_build_object('applied', false, 'reason', 'payment_conflict');
      ELSIF p_payment_id IS NULL THEN
        -- NULL payment on committed marker: fail closed
        RETURN jsonb_build_object('applied', false, 'reason', 'committed_no_winner');
      ELSE
        -- R28/B7: committed + NULL existing winner + new payment => fail closed
        -- No silently attaching a new winner to an already-committed marker
        RETURN jsonb_build_object('applied', false, 'reason', 'committed_no_winner');
      END IF;
    ELSE
      -- Non-committed marker (instant, bank_transfer, prepayment)
      IF p_payment_id IS NOT NULL THEN
        -- Payment winning: check for existing different payment_id
        IF v_existing.payment_id IS NOT NULL AND v_existing.payment_id != p_payment_id THEN
          RETURN jsonb_build_object('applied', false, 'reason', 'payment_conflict');
        END IF;

        -- Upgrade marker to committed with winning payment
        UPDATE order_stock_applications
        SET reservation_class = 'committed', expires_at = NULL, payment_id = p_payment_id
        WHERE order_id = p_order_id;

        -- Close linked pending transfers (online payment supersedes them)
        UPDATE pending_transfers SET status = 'cancelled'
        WHERE order_id = p_order_id AND status = 'pending';

        -- Confirm order if pending
        IF v_order.status = 'pending' THEN
          UPDATE orders SET status = 'confirmed', updated_at = NOW()
          WHERE id = p_order_id AND status = 'pending';
        END IF;

        RETURN jsonb_build_object('applied', true, 'already_applied', true,
          'order_confirmed', true);
      ELSE
        -- NULL payment on non-committed marker: preserve (legacy/quote path)
        IF v_order.status = 'pending' THEN
          -- Legacy quote path: confirm order
          UPDATE orders SET status = 'confirmed', updated_at = NOW()
          WHERE id = p_order_id AND status = 'pending';
          RETURN jsonb_build_object('applied', true, 'already_applied', true,
            'order_confirmed', true);
        END IF;
        RETURN jsonb_build_object('applied', true, 'already_applied', true,
          'order_confirmed', false);
      END IF;
    END IF;
  END IF;

  -- 5. Lock inventory deterministically + validate + decrement
  FOR v_item IN
    SELECT oi.product_id, oi.variant_id, oi.quantity
    FROM order_items oi
    WHERE oi.order_id = p_order_id
    ORDER BY oi.product_id, oi.variant_id NULLS FIRST
  LOOP
    IF v_item.variant_id IS NOT NULL THEN
      -- Lock variant row
      SELECT pv.id, pv.stock_quantity
      INTO v_variant
      FROM product_variants pv
      WHERE pv.id = v_item.variant_id
      FOR UPDATE;

      IF FOUND AND v_variant.stock_quantity IS NOT NULL THEN
        -- Validate sufficiency if requested
        IF p_validate_sufficient AND v_variant.stock_quantity < v_item.quantity THEN
          -- Collect name for error reporting
          v_out_of_stock := array_append(v_out_of_stock,
            COALESCE((SELECT name FROM products WHERE id = v_item.product_id), 'Unknown'));
        ELSE
          UPDATE product_variants
          SET stock_quantity = GREATEST(0, stock_quantity - v_item.quantity)
          WHERE id = v_item.variant_id;
        END IF;
      END IF;
    ELSIF v_item.product_id IS NOT NULL THEN
      -- Lock product row
      SELECT p.id, p.stock_quantity, p.track_inventory, p.name
      INTO v_product
      FROM products p
      WHERE p.id = v_item.product_id
      FOR UPDATE;

      IF FOUND AND v_product.track_inventory AND v_product.stock_quantity IS NOT NULL THEN
        IF p_validate_sufficient AND v_product.stock_quantity < v_item.quantity THEN
          v_out_of_stock := array_append(v_out_of_stock, COALESCE(v_product.name, 'Unknown'));
        ELSE
          UPDATE products
          SET stock_quantity = GREATEST(0, stock_quantity - v_item.quantity)
          WHERE id = v_item.product_id;
        END IF;
      END IF;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  -- 6. If stock validation was requested and items are out of stock, roll back
  IF p_validate_sufficient AND array_length(v_out_of_stock, 1) > 0 THEN
    RAISE EXCEPTION 'insufficient_stock:%', array_to_string(v_out_of_stock, ',');
  END IF;

  -- 7. Insert order-level marker (atomic with stock decrement)
  -- M393: Set reservation_class based on payment context
  IF p_payment_id IS NOT NULL THEN
    -- Payment-confirmed: committed immediately
    INSERT INTO order_stock_applications (order_id, payment_id, item_count, reservation_class, expires_at)
    VALUES (p_order_id, p_payment_id, v_count, 'committed', NULL);

    -- Close linked pending transfers (online payment supersedes them)
    UPDATE pending_transfers SET status = 'cancelled'
    WHERE order_id = p_order_id AND status = 'pending';
  ELSE
    -- Pre-payment path (legacy/quote): preserve prepayment default
    INSERT INTO order_stock_applications (order_id, payment_id, item_count)
    VALUES (p_order_id, p_payment_id, v_count);
    -- reservation_class defaults to 'prepayment', expires_at defaults to NULL
  END IF;

  -- 8. When called with a payment_id (payment-confirmed context), also transition
  --    order from pending→confirmed INSIDE this same transaction/lock.
  IF p_payment_id IS NOT NULL AND v_order.status = 'pending' THEN
    UPDATE orders SET status = 'confirmed', updated_at = NOW()
    WHERE id = p_order_id AND status = 'pending';
  END IF;

  RETURN jsonb_build_object('applied', true, 'already_applied', false, 'items', v_count,
    'order_confirmed', (p_payment_id IS NOT NULL AND v_order.status = 'pending'));
END;
$$;

-- ACL: preserve existing (M327 signature)
REVOKE ALL ON FUNCTION public.apply_order_stock_once(UUID, UUID, BOOLEAN) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.apply_order_stock_once(UUID, UUID, BOOLEAN) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.apply_order_stock_once(UUID, UUID, BOOLEAN) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.apply_order_stock_once(UUID, UUID, BOOLEAN) TO service_role;
  END IF;
END $$;


-- ─── 3. cancel_stale_order_atomic (modified from M392) ──────────────────
-- Changes:
--   a) Replace hardcoded 48h gate with marker-aware expiry logic
--   b) Cancel linked pending_transfers on expiry-driven cancellation

CREATE OR REPLACE FUNCTION public.cancel_stale_order_atomic(
  p_order_id UUID
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
  v_marker RECORD;
BEGIN
  -- 1. Lock order row
  SELECT id, status, created_at, promo_code_id
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  -- 2. Status gate: only pending orders
  IF v_order.status != 'pending' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', v_order.status);
  END IF;

  -- 3. M393: Marker-aware expiry logic (replaces hardcoded 48h gate)
  SELECT reservation_class, expires_at
  INTO v_marker
  FROM order_stock_applications
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF FOUND THEN
    -- Committed markers are never cancellable by stale cleanup
    IF v_marker.reservation_class = 'committed' THEN
      RETURN jsonb_build_object('cancelled', false, 'reason', 'committed_not_cancellable');
    END IF;

    -- Instant/bank_transfer: check expiry
    IF v_marker.reservation_class IN ('instant', 'bank_transfer') THEN
      IF v_marker.expires_at IS NOT NULL AND v_marker.expires_at > NOW() THEN
        RETURN jsonb_build_object('cancelled', false, 'reason',
          v_marker.reservation_class || '_not_expired');
      END IF;
      -- Expired: eligible for cancellation (fall through)
    END IF;

    -- Prepayment: use legacy 48h staleness
    IF v_marker.reservation_class = 'prepayment' THEN
      IF v_order.created_at >= NOW() - INTERVAL '48 hours' THEN
        RETURN jsonb_build_object('cancelled', false, 'reason', 'prepayment_not_stale');
      END IF;
      -- Stale: eligible (fall through)
    END IF;
  ELSE
    -- No marker: legacy 48h staleness
    IF v_order.created_at >= NOW() - INTERVAL '48 hours' THEN
      RETURN jsonb_build_object('cancelled', false, 'reason', 'legacy_no_marker_not_stale');
    END IF;
    -- Stale: eligible (fall through)
  END IF;

  -- 4. Payment gate: lock payment rows + check for success/finalization
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

  -- 4b. Void pending payments
  UPDATE payments
  SET status = 'failed',
      gateway_status = 'stale_order_cancelled'
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
    AND status = 'pending';

  -- 5. Check canonical stock marker and restore
  -- Re-read marker presence (FOUND may have been clobbered by payment UPDATE above)
  PERFORM id FROM order_stock_applications WHERE order_id = p_order_id;
  IF FOUND THEN
    v_had_marker := true;

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
        -- FIX (a): Added AND stock_quantity IS NOT NULL to prevent NULL→finite corruption
        UPDATE products
        SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
        WHERE id = v_item.product_id
          AND track_inventory = true
          AND stock_quantity IS NOT NULL;
      END IF;
      v_count := v_count + 1;
    END LOOP;

    DELETE FROM order_stock_applications WHERE order_id = p_order_id;
  END IF;

  -- 6. Release promo reservation (PRESERVED from canonical M333/M392)
  IF v_order.promo_code_id IS NOT NULL THEN
    PERFORM release_promo_reservation(p_order_id);
  END IF;

  -- 7. Cancel order
  UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = p_order_id;

  -- 8. M393: Cancel linked pending transfers (expiry-driven → status 'expired')
  UPDATE pending_transfers SET status = 'expired'
  WHERE order_id = p_order_id AND status = 'pending';

  RETURN jsonb_build_object(
    'cancelled', true,
    'stock_restored', v_had_marker,
    'items_restored', v_count
  );
END;
$$;

-- ACL: preserve existing
REVOKE ALL ON FUNCTION public.cancel_stale_order_atomic(UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.cancel_stale_order_atomic(UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.cancel_stale_order_atomic(UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.cancel_stale_order_atomic(UUID) TO service_role;
  END IF;
END $$;


-- ─── 4. cancel_order_immediate (modified from M392) ─────────────────────
-- Changes:
--   a) Cancel linked pending_transfers (status='cancelled' for explicit cancel)

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
      gateway_status = p_reason
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
        -- FIX: Added AND stock_quantity IS NOT NULL to prevent NULL→finite corruption
        UPDATE products
        SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
        WHERE id = v_item.product_id
          AND track_inventory = true
          AND stock_quantity IS NOT NULL;
      END IF;
      v_count := v_count + 1;
    END LOOP;

    -- Delete marker
    DELETE FROM order_stock_applications WHERE order_id = p_order_id;
  END IF;

  -- 6. Release promo reservation (PRESERVED from canonical M383)
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

  -- 8. Revert quote status if quote-origin (PRESERVED from canonical M383)
  IF v_order.quote_request_id IS NOT NULL THEN
    UPDATE quote_requests
    SET status = 'quoted', order_id = NULL, responded_at = NULL
    WHERE id = v_order.quote_request_id
      AND status = 'accepted';
  END IF;

  -- 9. M393: Cancel linked pending transfers (explicit cancel → status 'cancelled')
  UPDATE pending_transfers SET status = 'cancelled'
  WHERE order_id = p_order_id AND status = 'pending';

  RETURN jsonb_build_object(
    'cancelled', true,
    'reason', p_reason,
    'stock_restored', v_had_marker,
    'items_restored', v_count
  );
END;
$$;

-- ACL: preserve existing
REVOKE ALL ON FUNCTION public.cancel_order_immediate(UUID, TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.cancel_order_immediate(UUID, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.cancel_order_immediate(UUID, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.cancel_order_immediate(UUID, TEXT) TO service_role;
  END IF;
END $$;


-- ─── 5. create_transfer_with_reservation (NEW) ──────────────────────────
-- Atomic: lock order → lock marker → validate channel → INSERT transfer → UPDATE marker

CREATE OR REPLACE FUNCTION public.create_transfer_with_reservation(
  p_order_id UUID,
  p_business_id UUID,
  p_customer_phone TEXT,
  p_customer_name TEXT,
  p_country_code TEXT,
  p_transfer_expiry_hours INT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_marker RECORD;
  v_session RECORD;
  v_channel_id TEXT;
  v_channel RECORD;
  v_business RECORD;
  v_expected_amount INT;
  v_deadline TIMESTAMPTZ;
  v_ref TEXT;
  v_transfer_id UUID;
  v_currency TEXT;
BEGIN
  -- 1. Lock order FOR UPDATE
  SELECT id, status, business_id, total_amount, channel, bot_session_id
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', true, 'reason', 'order_not_found');
  END IF;
  IF v_order.status != 'pending' THEN
    RETURN jsonb_build_object('error', true, 'reason', 'order_not_pending');
  END IF;
  IF v_order.business_id != p_business_id THEN
    RETURN jsonb_build_object('error', true, 'reason', 'business_mismatch');
  END IF;

  -- 2. Lock marker FOR UPDATE
  SELECT id, reservation_class, expires_at, payment_id
  INTO v_marker
  FROM order_stock_applications
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', true, 'reason', 'no_stock_marker');
  END IF;
  IF v_marker.reservation_class != 'instant' THEN
    RETURN jsonb_build_object('error', true, 'reason', 'marker_not_instant');
  END IF;
  IF v_marker.expires_at IS NULL THEN
    RETURN jsonb_build_object('error', true, 'reason', 'marker_no_expiry');
  END IF;
  IF v_marker.expires_at <= NOW() THEN
    RETURN jsonb_build_object('error', true, 'reason', 'marker_expired');
  END IF;
  IF v_marker.payment_id IS NOT NULL THEN
    RETURN jsonb_build_object('error', true, 'reason', 'marker_has_payment');
  END IF;

  -- 3. Check for existing active order-linked transfer (prevent duplicates)
  IF EXISTS (
    SELECT 1 FROM pending_transfers
    WHERE order_id = p_order_id AND status = 'pending'
  ) THEN
    RETURN jsonb_build_object('error', true, 'reason', 'active_transfer_exists');
  END IF;

  -- 4. R28/B4: Derive bot_session from locked order (no caller override)
  IF v_order.bot_session_id IS NULL THEN
    RETURN jsonb_build_object('error', true, 'reason', 'order_has_no_session');
  END IF;

  SELECT id, session_data, business_id AS sess_business_id
  INTO v_session
  FROM bot_sessions
  WHERE id = v_order.bot_session_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', true, 'reason', 'session_not_found');
  END IF;

  -- Verify session belongs to the same business
  IF v_session.sess_business_id != p_business_id THEN
    RETURN jsonb_build_object('error', true, 'reason', 'session_business_mismatch');
  END IF;

  v_channel_id := v_session.session_data->>'_inbound_channel_id';
  IF v_channel_id IS NULL OR v_channel_id = '' THEN
    RETURN jsonb_build_object('error', true, 'reason', 'no_inbound_channel');
  END IF;

  -- 5. Validate channel is active + authorized for this business
  SELECT id, channel_type, business_id, is_active
  INTO v_channel
  FROM whatsapp_channels
  WHERE id = v_channel_id::uuid AND is_active = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', true, 'reason', 'channel_not_found_or_inactive');
  END IF;

  -- Authorization: shared channels = any business; dedicated = must own or be assigned
  IF v_channel.channel_type != 'shared' AND v_channel.business_id != p_business_id THEN
    -- Check if business has this channel assigned
    SELECT assigned_channel_id, whatsapp_channel_id
    INTO v_business
    FROM businesses
    WHERE id = p_business_id;

    IF v_business.assigned_channel_id != v_channel_id::uuid
       AND v_business.whatsapp_channel_id != v_channel_id::uuid THEN
      RETURN jsonb_build_object('error', true, 'reason', 'channel_not_authorized');
    END IF;
  END IF;

  -- 6. Derive expected_amount from locked order (major→minor: ×100)
  v_expected_amount := ROUND(v_order.total_amount * 100);

  -- 7. Compute ONE deadline for both transfer and marker
  v_deadline := NOW() + (p_transfer_expiry_hours * INTERVAL '1 hour');

  -- 8. Determine currency from country code
  v_currency := CASE
    WHEN p_country_code = 'GH' THEN 'GHS'
    WHEN p_country_code = 'US' THEN 'USD'
    WHEN p_country_code = 'GB' THEN 'GBP'
    WHEN p_country_code = 'CA' THEN 'CAD'
    ELSE 'NGN'
  END;

  -- 9. Generate transfer reference
  v_ref := 'WA-' || upper(substr(md5(random()::text), 1, 4));

  -- 10. INSERT pending_transfer with channel provenance
  INSERT INTO pending_transfers (
    business_id, order_id, customer_phone, customer_name,
    expected_amount, currency, reference_code, status, expires_at,
    metadata
  ) VALUES (
    p_business_id, p_order_id,
    CASE WHEN left(p_customer_phone, 1) = '+' THEN p_customer_phone
         ELSE '+' || p_customer_phone END,
    p_customer_name,
    v_expected_amount, v_currency, v_ref, 'pending', v_deadline,
    jsonb_build_object(
      '_confirmation_origin', 'whatsapp',
      '_inbound_channel_id', v_channel_id
    )
  )
  RETURNING id INTO v_transfer_id;

  -- 11. UPDATE marker: instant → bank_transfer with exact same deadline
  UPDATE order_stock_applications
  SET reservation_class = 'bank_transfer', expires_at = v_deadline
  WHERE order_id = p_order_id;

  -- 12. Return success
  RETURN jsonb_build_object(
    'transfer_id', v_transfer_id,
    'reference_code', v_ref,
    'expected_amount', v_expected_amount,
    'expires_at', v_deadline,
    'inbound_channel_id', v_channel_id,
    'currency', v_currency
  );
END;
$$;

-- ACL: service_role only
REVOKE ALL ON FUNCTION public.create_transfer_with_reservation(UUID, UUID, TEXT, TEXT, TEXT, INT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.create_transfer_with_reservation(UUID, UUID, TEXT, TEXT, TEXT, INT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.create_transfer_with_reservation(UUID, UUID, TEXT, TEXT, TEXT, INT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.create_transfer_with_reservation(UUID, UUID, TEXT, TEXT, TEXT, INT) TO service_role;
  END IF;
END $$;


-- ─── 6. confirm_order_transfer_atomic (NEW) ─────────────────────────────
-- Bank-transfer winner authority: lock order → transfer → marker → payments

CREATE OR REPLACE FUNCTION public.confirm_order_transfer_atomic(
  p_transfer_id UUID,
  p_order_id UUID,
  p_business_id UUID,
  p_confirmed_by UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_transfer RECORD;
  v_marker RECORD;
  v_has_payment BOOLEAN := false;
  v_new_payment_id UUID;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- 1. Lock order FOR UPDATE
  SELECT id, status, business_id, total_amount, promo_code_id
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'order_not_found');
  END IF;
  IF v_order.status = 'confirmed' THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'already_confirmed');
  END IF;
  IF v_order.status != 'pending' THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', v_order.status);
  END IF;
  IF v_order.business_id != p_business_id THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'business_mismatch');
  END IF;

  -- 2. Lock transfer
  SELECT id, order_id, business_id, expected_amount, currency, reference_code,
         status, expires_at, metadata
  INTO v_transfer
  FROM pending_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'transfer_not_found');
  END IF;
  IF v_transfer.status = 'confirmed' THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'transfer_already_confirmed');
  END IF;
  IF v_transfer.status != 'pending' THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'transfer_' || v_transfer.status);
  END IF;
  IF v_transfer.order_id != p_order_id THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'transfer_order_mismatch');
  END IF;
  IF v_transfer.business_id != p_business_id THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'transfer_business_mismatch');
  END IF;

  -- 3. Lock marker
  SELECT id, reservation_class, expires_at, payment_id
  INTO v_marker
  FROM order_stock_applications
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'no_stock_marker');
  END IF;
  IF v_marker.reservation_class != 'bank_transfer' THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'marker_class_' || v_marker.reservation_class);
  END IF;
  -- Exact deadline equality: marker must match transfer
  IF v_marker.expires_at IS NULL OR v_transfer.expires_at IS NULL
     OR v_marker.expires_at != v_transfer.expires_at THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'deadline_mismatch');
  END IF;
  -- Must not be expired
  IF v_marker.expires_at <= v_now THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'reservation_expired');
  END IF;
  -- R28/B7: marker must have no existing winner
  IF v_marker.payment_id IS NOT NULL THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'marker_has_payment');
  END IF;

  -- 4. Lock ALL linked payment rows
  PERFORM id FROM payments
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
  FOR UPDATE;

  -- 5. Payment/finalization fence
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
    RETURN jsonb_build_object('confirmed', false, 'reason', 'online_payment_won');
  END IF;

  -- 6. Validate amount: transfer.expected_amount = ROUND(order.total_amount * 100)
  IF v_transfer.expected_amount != ROUND(v_order.total_amount * 100) THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'amount_mismatch');
  END IF;

  -- ── Winner mutations (atomic) ──

  -- 7. Void pending online payment attempts
  UPDATE payments
  SET status = 'failed', gateway_status = 'bank_transfer_won'
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
    AND status = 'pending';

  -- 8. Insert exactly one direct bank-transfer success payment
  --    amount = order.total_amount (MAJOR units, canonical)
  --    currency = transfer.currency
  -- R28/B2: Use only real production payment columns
  INSERT INTO payments (
    business_id, amount, currency, status, payment_method, gateway,
    gateway_reference, gateway_status, order_id, paid_at, metadata
  ) VALUES (
    p_business_id,
    v_order.total_amount,  -- MAJOR units
    v_transfer.currency,
    'success',
    'bank_transfer',
    'direct',
    'transfer:' || v_transfer.reference_code,
    'merchant_confirmed',
    p_order_id,
    v_now,
    jsonb_build_object(
      'pending_transfer_id', p_transfer_id,
      'confirmed_by', p_confirmed_by,
      'customer_phone', v_transfer.customer_phone,
      'customer_name', v_transfer.customer_name,
      '_inbound_channel_id', v_transfer.metadata->>'_inbound_channel_id',
      '_confirmation_origin', v_transfer.metadata->>'_confirmation_origin'
    )
  )
  RETURNING id INTO v_new_payment_id;

  -- 9. Commit marker: bank_transfer → committed, clear expiry, attach winner
  UPDATE order_stock_applications
  SET reservation_class = 'committed', expires_at = NULL, payment_id = v_new_payment_id
  WHERE order_id = p_order_id;

  -- 10. Confirm transfer
  UPDATE pending_transfers
  SET status = 'confirmed', confirmed_by = p_confirmed_by, confirmed_at = v_now
  WHERE id = p_transfer_id;

  -- 11. Confirm order
  UPDATE orders SET status = 'confirmed', paid_at = v_now, updated_at = v_now
  WHERE id = p_order_id;

  -- 12. Finalize promo if applicable
  IF v_order.promo_code_id IS NOT NULL THEN
    UPDATE promo_reservations SET state = 'finalized'
    WHERE order_id = p_order_id AND state = 'reserved';

    IF FOUND THEN
      UPDATE promo_codes SET current_uses = current_uses + 1
      WHERE id = v_order.promo_code_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'confirmed', true,
    'order_total', v_order.total_amount,
    'payment_id', v_new_payment_id,
    'currency', v_transfer.currency,
    'reference_code', v_transfer.reference_code,
    'inbound_channel_id', v_transfer.metadata->>'_inbound_channel_id'
  );
END;
$$;

-- ACL: service_role only
REVOKE ALL ON FUNCTION public.confirm_order_transfer_atomic(UUID, UUID, UUID, UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.confirm_order_transfer_atomic(UUID, UUID, UUID, UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.confirm_order_transfer_atomic(UUID, UUID, UUID, UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.confirm_order_transfer_atomic(UUID, UUID, UUID, UUID) TO service_role;
  END IF;
END $$;


-- ─── 7. reject_order_transfer_atomic (NEW) ──────────────────────────────
-- Bank-transfer rejection authority: restore stock, cancel order

CREATE OR REPLACE FUNCTION public.reject_order_transfer_atomic(
  p_transfer_id UUID,
  p_order_id UUID,
  p_business_id UUID,
  p_reason TEXT DEFAULT 'merchant_rejected'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_transfer RECORD;
  v_marker RECORD;
  v_has_payment BOOLEAN := false;
  v_item RECORD;
  v_count INTEGER := 0;
BEGIN
  -- 1. Lock order FOR UPDATE
  SELECT id, status, business_id, promo_code_id, quote_request_id
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'order_not_found');
  END IF;
  IF v_order.status != 'pending' THEN
    RETURN jsonb_build_object('rejected', false, 'reason', v_order.status);
  END IF;
  IF v_order.business_id != p_business_id THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'business_mismatch');
  END IF;

  -- 2. Lock transfer
  SELECT id, order_id, business_id, status, expires_at
  INTO v_transfer
  FROM pending_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'transfer_not_found');
  END IF;
  IF v_transfer.status != 'pending' THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'transfer_' || v_transfer.status);
  END IF;
  IF v_transfer.order_id != p_order_id THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'transfer_order_mismatch');
  END IF;
  -- R28/B8: Exact business binding
  IF v_transfer.business_id != p_business_id THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'transfer_business_mismatch');
  END IF;

  -- 3. Lock marker
  SELECT id, reservation_class, expires_at, payment_id
  INTO v_marker
  FROM order_stock_applications
  WHERE order_id = p_order_id
  FOR UPDATE;

  -- Marker validation for bank_transfer class
  IF FOUND THEN
    IF v_marker.reservation_class = 'committed' THEN
      RETURN jsonb_build_object('rejected', false, 'reason', 'committed_not_rejectable');
    END IF;
    IF v_marker.reservation_class = 'instant' THEN
      RETURN jsonb_build_object('rejected', false, 'reason', 'instant_not_rejectable');
    END IF;
    IF v_marker.reservation_class = 'prepayment' THEN
      RETURN jsonb_build_object('rejected', false, 'reason', 'prepayment_not_rejectable');
    END IF;
    -- bank_transfer: verify deadline matches transfer
    IF v_marker.reservation_class = 'bank_transfer' THEN
      IF v_marker.expires_at IS NULL OR v_transfer.expires_at IS NULL
         OR v_marker.expires_at != v_transfer.expires_at THEN
        RETURN jsonb_build_object('rejected', false, 'reason', 'deadline_mismatch');
      END IF;
    END IF;
  END IF;
  -- If no marker found (legacy): proceed with cancel, no stock restore

  -- 4. Lock ALL linked payment rows + payment fence
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
    RETURN jsonb_build_object('rejected', false, 'reason', 'has_successful_payment');
  END IF;

  -- ── Rejection mutations ──

  -- 5. Reject the target transfer
  UPDATE pending_transfers
  SET status = 'rejected', rejected_reason = p_reason
  WHERE id = p_transfer_id;

  -- 6. Cancel other pending order transfers
  UPDATE pending_transfers SET status = 'cancelled'
  WHERE order_id = p_order_id AND status = 'pending' AND id != p_transfer_id;

  -- 7. Void pending online payment attempts
  UPDATE payments
  SET status = 'failed', gateway_status = 'transfer_rejected'
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
    AND status = 'pending';

  -- 8. Restore stock if marker exists (exact M392 pattern)
  -- Re-read marker presence (FOUND may have been clobbered by payment UPDATE above)
  PERFORM id FROM order_stock_applications WHERE order_id = p_order_id;
  IF FOUND THEN
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
        WHERE id = v_item.product_id
          AND track_inventory = true
          AND stock_quantity IS NOT NULL;
      END IF;
      v_count := v_count + 1;
    END LOOP;

    DELETE FROM order_stock_applications WHERE order_id = p_order_id;
  END IF;

  -- 9. Release promo (canonical reserved+finalized semantics)
  IF v_order.promo_code_id IS NOT NULL THEN
    DELETE FROM promo_reservations
    WHERE order_id = p_order_id AND state = 'reserved';

    IF EXISTS (SELECT 1 FROM promo_reservations WHERE order_id = p_order_id AND state = 'finalized') THEN
      UPDATE promo_codes SET current_uses = GREATEST(current_uses - 1, 0)
      WHERE id = v_order.promo_code_id;
      DELETE FROM promo_reservations WHERE order_id = p_order_id AND state = 'finalized';
    END IF;
  END IF;

  -- 10. Cancel order
  UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = p_order_id;

  -- 11. Quote reversion if applicable
  IF v_order.quote_request_id IS NOT NULL THEN
    UPDATE quote_requests
    SET status = 'quoted', order_id = NULL, responded_at = NULL
    WHERE id = v_order.quote_request_id
      AND status = 'accepted';
  END IF;

  RETURN jsonb_build_object(
    'rejected', true,
    'reason', p_reason,
    'stock_restored', v_count > 0,
    'items_restored', v_count
  );
END;
$$;

-- ACL: service_role only
REVOKE ALL ON FUNCTION public.reject_order_transfer_atomic(UUID, UUID, UUID, TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.reject_order_transfer_atomic(UUID, UUID, UUID, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.reject_order_transfer_atomic(UUID, UUID, UUID, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.reject_order_transfer_atomic(UUID, UUID, UUID, TEXT) TO service_role;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Self-verification DO block
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fn TEXT;
  v_fns TEXT[] := ARRAY[
    'create_order_atomic',
    'apply_order_stock_once',
    'cancel_stale_order_atomic',
    'cancel_order_immediate',
    'create_transfer_with_reservation',
    'confirm_order_transfer_atomic',
    'reject_order_transfer_atomic'
  ];
BEGIN
  FOREACH v_fn IN ARRAY v_fns
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = v_fn
    ) THEN
      RAISE EXCEPTION 'M393 verification FAILED: function % not found', v_fn;
    END IF;
  END LOOP;
  RAISE NOTICE 'M393 self-verification PASSED: all 7 functions exist';
END $$;
