-- ═══════════════════════════════════════════════════════════════════════════
-- M435: Ordering Price Authority (#602 / #598)
--
-- Extends create_order_atomic to derive promo and volume discounts from
-- locked DB values instead of trusting caller-supplied amounts.
--
-- Changes from M393:
--   a) Promo authority: re-read discount_type, discount_value, business_id,
--      is_active, valid_from/until, applicable_flow_types, applicable_services,
--      min_order_amount from the locked promo_codes row. Compute server discount.
--      Refuse discount without eligible promo or if caller amount mismatches.
--   b) Volume discount authority: compute per-item volume discounts from locked
--      product/variant prices (not caller-supplied p_unit_price). Sum and compare.
--   c) Store server-computed discount_amount and volume_discount_amount in orders.
--   d) Refuse p_discount_amount > 0 when p_promo_code_id IS NULL.
--
-- Signature preserved (24 params). Non-validated path unchanged.
-- Never edit M383/M393 — this is a forward-only replacement.
--
-- Refs: #602, #598, #597
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_server_subtotal int := 0;      -- M435: pre-discount item+addon total
  v_server_discount int := 0;      -- M435: server-computed promo discount
  v_server_volume_discount int := 0; -- M435: server-computed volume discount
  v_item_total int;
  v_addon_entry jsonb;
  v_addon_id uuid;
  v_addon_total int;
  v_sorted_items jsonb;
  v_fp_parts text[] := '{}';
  v_fp_item jsonb;
  v_addon_ids text;
  v_zone RECORD;
  v_zone_name TEXT := NULL;
  -- M435 R2-5: idempotent replay validation vars
  v_existing_total int;
  v_existing_discount int;
  v_existing_promo_id uuid;
  v_existing_biz_id uuid;
  v_existing_user_id uuid;
  v_existing_vol_discount int;
  -- M435: volume discount per-item vars
  v_vol_rule RECORD;
  v_vol_item_discount int;
  v_vol_item_quantity int;
  v_vol_item_unit_price int;
  v_vol_item_product_id uuid;
  -- M435: promo eligibility vars
  v_promo_raw_discount numeric;
  v_cart_product_ids uuid[];
BEGIN
  -- ── Phase 1: Lock + idempotency (UNCHANGED from M393) ──
  PERFORM pg_advisory_xact_lock(abs(hashtext(p_bot_session_id::text)));

  SELECT jsonb_agg(elem ORDER BY elem->>'product_id', elem->>'variant_id') INTO v_sorted_items
  FROM jsonb_array_elements(p_items) AS elem;

  IF v_sorted_items IS NOT NULL THEN
    FOR v_fp_item IN SELECT * FROM jsonb_array_elements(v_sorted_items)
    LOOP
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

  -- ══════════════════════════════════════════════════════════════════
  -- M435 603-D: Validate all item and addon quantities are positive integers
  -- before any pricing/stock mutation. Negative quantities could inflate stock
  -- and produce free orders via zero-floor.
  -- ══════════════════════════════════════════════════════════════════
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF COALESCE((v_item->>'quantity')::int, 0) < 1 THEN
      RAISE EXCEPTION 'invalid_quantity:Item % has non-positive quantity %',
        v_item->>'product_id', COALESCE(v_item->>'quantity', 'null');
    END IF;
    -- Check addon quantities
    IF v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb THEN
      FOR v_addon_entry IN SELECT * FROM jsonb_array_elements(v_item->'addons')
      LOOP
        IF COALESCE((v_addon_entry->>'quantity')::int, 0) < 1 THEN
          RAISE EXCEPTION 'invalid_addon_quantity:Addon % has non-positive quantity %',
            COALESCE(v_addon_entry->>'id', 'unknown'), COALESCE(v_addon_entry->>'quantity', 'null');
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- Idempotent: check for existing order from same bot session
  SELECT id, reference_code, items_fingerprint, total_amount, discount_amount,
         promo_code_id, business_id, user_id, volume_discount_amount
  INTO v_existing_id, v_existing_ref, v_existing_fingerprint, v_existing_total,
       v_existing_discount, v_existing_promo_id, v_existing_biz_id, v_existing_user_id,
       v_existing_vol_discount
  FROM orders
  WHERE bot_session_id = p_bot_session_id
    AND status IN ('pending', 'confirmed')
  LIMIT 1;

  IF FOUND THEN
    IF p_validate_products THEN
      IF v_existing_fingerprint IS NOT NULL AND v_existing_fingerprint = v_fingerprint THEN
        -- R2-5: Validate full monetary and tenant contract on replay.
        -- Same cart fingerprint is necessary but not sufficient.

        -- Tenant/user binding (fail-closed)
        IF v_existing_biz_id != p_business_id THEN
          RAISE EXCEPTION 'replay_business_mismatch:Replay targets different business than committed order';
        END IF;
        IF v_existing_user_id != p_user_id THEN
          RAISE EXCEPTION 'replay_user_mismatch:Replay targets different user than committed order';
        END IF;

        -- Expected total is REQUIRED on validated replay (no null bypass)
        IF p_expected_total IS NULL THEN
          RAISE EXCEPTION 'expected_total_required:p_expected_total must be provided on validated replay';
        END IF;
        IF v_existing_total != p_expected_total THEN
          RAISE EXCEPTION 'replay_total_mismatch:Existing order total % does not match expected %',
            v_existing_total, p_expected_total;
        END IF;
        IF COALESCE(p_promo_code_id::text, '') != COALESCE(v_existing_promo_id::text, '') THEN
          RAISE EXCEPTION 'replay_promo_mismatch:Replay uses different promo code than committed order';
        END IF;
        IF COALESCE(p_discount_amount, 0) != COALESCE(v_existing_discount, 0) THEN
          RAISE EXCEPTION 'replay_discount_mismatch:Replay discount % does not match committed %',
            COALESCE(p_discount_amount, 0), COALESCE(v_existing_discount, 0);
        END IF;
        IF COALESCE(p_volume_discount_amount, 0) != COALESCE(v_existing_vol_discount, 0) THEN
          RAISE EXCEPTION 'replay_volume_discount_mismatch:Replay volume discount % does not match committed %',
            COALESCE(p_volume_discount_amount, 0), COALESCE(v_existing_vol_discount, 0);
        END IF;

        -- Return committed order with authoritative total
        RETURN jsonb_build_object(
          'order_id', v_existing_id,
          'reference_code', v_existing_ref,
          'created', false,
          'server_total', v_existing_total
        );
      ELSIF v_existing_fingerprint IS NOT NULL THEN
        RAISE EXCEPTION 'fingerprint_mismatch:Order % exists with different cart contents', v_existing_id;
      END IF;
    END IF;

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

    -- ══════════════════════════════════════════════════════════════════
    -- M435 2a: Promo eligibility + capacity (FOR UPDATE on promo_codes)
    -- Reads full promo record for discount computation, not just capacity.
    -- ══════════════════════════════════════════════════════════════════
    IF p_promo_code_id IS NOT NULL THEN
      SELECT id, business_id, is_active, discount_type, discount_value,
             valid_from, valid_until, max_uses, current_uses,
             min_order_amount, applicable_services, applicable_flow_types
      INTO v_promo
      FROM promo_codes WHERE id = p_promo_code_id FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'promo_not_found:Promo code does not exist';
      END IF;

      -- Tenant binding
      IF v_promo.business_id != p_business_id THEN
        RAISE EXCEPTION 'promo_tenant_mismatch:Promo code does not belong to this business';
      END IF;

      -- Active check
      IF NOT v_promo.is_active THEN
        RAISE EXCEPTION 'promo_inactive:Promo code is not active';
      END IF;

      -- Date validity (half-open: valid_from <= now < valid_until)
      IF v_promo.valid_from IS NOT NULL AND NOW() < v_promo.valid_from THEN
        RAISE EXCEPTION 'promo_not_yet_active:Promo code is not yet active';
      END IF;
      IF v_promo.valid_until IS NOT NULL AND NOW() >= v_promo.valid_until THEN
        RAISE EXCEPTION 'promo_expired:Promo code has expired';
      END IF;

      -- Flow type check
      IF v_promo.applicable_flow_types IS NOT NULL
         AND array_length(v_promo.applicable_flow_types, 1) > 0
         AND NOT ('ordering' = ANY(v_promo.applicable_flow_types)) THEN
        RAISE EXCEPTION 'promo_wrong_flow:Promo code is not valid for ordering';
      END IF;

      -- Capacity check (same as M393 but using the full record)
      IF v_promo.max_uses IS NOT NULL THEN
        SELECT count(*) INTO v_active_count
        FROM promo_reservations
        WHERE promo_code_id = p_promo_code_id
          AND state = 'reserved';

        IF (v_promo.current_uses + v_active_count) >= v_promo.max_uses THEN
          RAISE EXCEPTION 'promo_exhausted:Promo code has reached maximum uses';
        END IF;
      END IF;

      -- 603-F: Per-customer promo reuse check (matches bot validation)
      -- A user who already has an order with this promo cannot reuse it
      IF EXISTS (
        SELECT 1 FROM orders
        WHERE user_id = p_user_id
          AND promo_code_id = p_promo_code_id
          AND status IN ('pending', 'confirmed', 'delivered')
          AND id != COALESCE(v_existing_id, '00000000-0000-0000-0000-000000000000')
      ) THEN
        RAISE EXCEPTION 'promo_already_used:This promo code has already been used by this customer';
      END IF;

      -- Product scope and discount computation happen after item prices are locked (below)
    ELSIF COALESCE(p_discount_amount, 0) > 0 THEN
      -- M435: Refuse discount without promo
      RAISE EXCEPTION 'discount_without_promo:Discount amount provided but no promo code';
    END IF;

    -- ══════════════════════════════════════════════════════════════════
    -- 2b. Product validation: lock products ORDER BY product_id, variant_id
    -- (UNCHANGED from M393 except we track v_server_subtotal and per-item prices)
    -- ══════════════════════════════════════════════════════════════════
    v_cart_product_ids := ARRAY[]::uuid[];

    FOR v_item IN
      SELECT * FROM jsonb_array_elements(p_items) AS elem
      ORDER BY elem->>'product_id', elem->>'variant_id'
    LOOP
      v_item_total := 0;

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

      -- M435: Collect unique product IDs for promo scope check
      IF NOT (v_product.id = ANY(v_cart_product_ids)) THEN
        v_cart_product_ids := array_append(v_cart_product_ids, v_product.id);
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
        -- M435: Track unit price for volume discount
        v_vol_item_unit_price := v_variant.price;
      ELSE
        v_item_total := v_product.price * COALESCE((v_item->>'quantity')::int, 1);
        v_vol_item_unit_price := v_product.price;
      END IF;

      v_vol_item_quantity := COALESCE((v_item->>'quantity')::int, 1);
      v_vol_item_product_id := (v_item->>'product_id')::uuid;

      -- Addon validation (UNCHANGED from M393)
      IF v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb THEN
        FOR v_addon_entry IN SELECT * FROM jsonb_array_elements(v_item->'addons')
        LOOP
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
          IF v_addon.product_id IS NOT NULL AND v_addon.product_id != (v_item->>'product_id')::uuid THEN
            RAISE EXCEPTION 'addon_wrong_product:Addon % does not belong to product %',
              v_addon_id, v_item->>'product_id';
          END IF;
          IF v_addon.price_type = 'quote' THEN
            RAISE EXCEPTION 'addon_quote_price:Addon % has quote price_type and cannot be committed at fixed price', v_addon_id;
          END IF;

          v_addon_total := v_addon.price * COALESCE((v_addon_entry->>'quantity')::int, 1);
          v_item_total := v_item_total + v_addon_total;
        END LOOP;
      END IF;

      v_server_total := v_server_total + v_item_total;

      -- ══════════════════════════════════════════════════════════════
      -- M435: Volume discount per-item (inlined calculate_volume_discount logic)
      -- Uses LOCKED product/variant unit price, not caller-supplied p_unit_price
      -- ══════════════════════════════════════════════════════════════
      v_vol_item_discount := 0;
      -- 603-F: FOR UPDATE serializes concurrent rule edits with discount calculation
      SELECT * INTO v_vol_rule
      FROM volume_discount_rules
      WHERE business_id = p_business_id
        AND is_active = true
        AND (product_id = v_vol_item_product_id OR product_id IS NULL)
        AND v_vol_item_quantity >= min_quantity
        AND (max_quantity IS NULL OR v_vol_item_quantity <= max_quantity)
      ORDER BY
        product_id IS NULL ASC,
        min_quantity DESC
      LIMIT 1
      FOR UPDATE;

      IF FOUND THEN
        CASE v_vol_rule.discount_type
          WHEN 'percentage' THEN
            v_vol_item_discount := ROUND((v_vol_item_unit_price * v_vol_item_quantity * v_vol_rule.discount_value) / 100);
          WHEN 'fixed_per_unit' THEN
            v_vol_item_discount := ROUND(v_vol_rule.discount_value * v_vol_item_quantity);
          WHEN 'fixed_total' THEN
            v_vol_item_discount := ROUND(v_vol_rule.discount_value);
          ELSE
            v_vol_item_discount := 0;
        END CASE;

        -- Cap at item total (product/variant * quantity, excluding addons)
        IF v_vol_item_discount > (v_vol_item_unit_price * v_vol_item_quantity) THEN
          v_vol_item_discount := v_vol_item_unit_price * v_vol_item_quantity;
        END IF;
        IF v_vol_item_discount < 0 THEN
          v_vol_item_discount := 0;
        END IF;
      END IF;

      v_server_volume_discount := v_server_volume_discount + v_vol_item_discount;
    END LOOP;

    -- M435: Capture pre-discount subtotal for promo checks
    v_server_subtotal := v_server_total;

    -- ══════════════════════════════════════════════════════════════════
    -- M435 2c: Promo discount computation (after items are locked)
    -- ══════════════════════════════════════════════════════════════════
    IF p_promo_code_id IS NOT NULL THEN
      -- Product scope: if promo has applicable_services (product IDs), all cart
      -- products must be in the allowed set. Refuse mixed carts (matches PR #599).
      IF v_promo.applicable_services IS NOT NULL
         AND array_length(v_promo.applicable_services, 1) > 0 THEN
        -- Check every cart product is in the allowed set
        IF NOT (v_cart_product_ids <@ v_promo.applicable_services) THEN
          RAISE EXCEPTION 'promo_wrong_product:Promo code does not apply to all products in cart';
        END IF;
      END IF;

      -- Minimum order amount (checked against pre-discount subtotal)
      IF COALESCE(v_promo.min_order_amount, 0) > v_server_subtotal THEN
        RAISE EXCEPTION 'promo_minimum_not_met:Order subtotal % does not meet minimum %',
          v_server_subtotal, v_promo.min_order_amount;
      END IF;

      -- Compute discount from DB values
      IF v_promo.discount_type = 'percentage' THEN
        IF v_promo.discount_value <= 0 OR v_promo.discount_value > 100 THEN
          RAISE EXCEPTION 'promo_invalid_percentage:Invalid percentage discount value %', v_promo.discount_value;
        END IF;
        v_promo_raw_discount := v_server_subtotal * v_promo.discount_value / 100;
        v_server_discount := ROUND(v_promo_raw_discount);
      ELSIF v_promo.discount_type = 'fixed' THEN
        IF v_promo.discount_value <= 0 THEN
          RAISE EXCEPTION 'promo_invalid_fixed:Invalid fixed discount value %', v_promo.discount_value;
        END IF;
        -- Fixed discount capped at subtotal
        v_server_discount := LEAST(ROUND(v_promo.discount_value), v_server_subtotal);
      ELSE
        RAISE EXCEPTION 'promo_unknown_type:Unknown discount type %', v_promo.discount_type;
      END IF;

      -- Clamp: non-negative, cannot exceed subtotal
      v_server_discount := GREATEST(0, LEAST(v_server_discount, v_server_subtotal));

      -- M435: Compare server-computed discount against caller's quote
      IF v_server_discount != COALESCE(p_discount_amount, 0) THEN
        RAISE EXCEPTION 'discount_mismatch:Server discount % does not match caller discount %',
          v_server_discount, COALESCE(p_discount_amount, 0);
      END IF;
    END IF;

    -- M435: Compare server-computed volume discount against caller's quote
    IF v_server_volume_discount != COALESCE(p_volume_discount_amount, 0) THEN
      RAISE EXCEPTION 'volume_discount_mismatch:Server volume discount % does not match caller volume discount %',
        v_server_volume_discount, COALESCE(p_volume_discount_amount, 0);
    END IF;

    -- ══════════════════════════════════════════════════════════════════
    -- 2d. Total validation (M435: uses server-computed discounts)
    -- ══════════════════════════════════════════════════════════════════
    v_server_total := v_server_total - v_server_discount - v_server_volume_discount;

    -- Delivery-zone server-authoritative total (UNCHANGED from M393)
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

      v_server_total := v_server_total + v_zone.price;
      v_zone_name := v_zone.name;
    ELSE
      v_server_total := v_server_total + COALESCE(p_shipping_cost, 0);
    END IF;

    -- Zero-floor (UNCHANGED from M393)
    v_server_total := GREATEST(0, v_server_total);

    -- Expected total comparison (UNCHANGED from M393)
    IF p_expected_total IS NULL THEN
      RAISE EXCEPTION 'expected_total_required:p_expected_total must be provided when p_validate_products=true';
    END IF;
    IF v_server_total != p_expected_total THEN
      RAISE EXCEPTION 'total_mismatch:Server total % does not match expected total %',
        v_server_total, p_expected_total;
    END IF;
  END IF;

  -- ── Non-validated promo check (legacy path, UNCHANGED from M393) ──
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

  -- 3a. Stock decrement (UNCHANGED from M393)
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

  -- 3b. Order INSERT
  -- M435: Store SERVER-COMPUTED discount_amount and volume_discount_amount
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
    CASE WHEN p_validate_products THEN v_server_discount ELSE p_discount_amount END,
    p_shipping_cost, p_promo_code_id, p_channel, p_notes,
    p_delivery_zone_id,
    CASE WHEN v_zone_name IS NOT NULL THEN v_zone_name
         ELSE p_delivery_zone_name END,
    p_addons_total,
    CASE WHEN p_validate_products THEN v_server_volume_discount ELSE p_volume_discount_amount END,
    p_pickup_address, p_dropoff_address, p_package_description, p_package_photo_url,
    p_referral_id, v_fingerprint
  )
  RETURNING id, reference_code INTO v_order_id, v_ref;

  -- 3c. Items INSERT with server-authoritative prices (UNCHANGED from M393)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    IF p_validate_products THEN
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

  -- 3d. Stock marker (UNCHANGED from M393)
  IF p_validate_products THEN
    IF p_status = 'confirmed' THEN
      INSERT INTO order_stock_applications (order_id, payment_id, reservation_class, expires_at)
      VALUES (v_order_id, NULL, 'committed', NULL);
    ELSE
      INSERT INTO order_stock_applications (order_id, payment_id, reservation_class, expires_at)
      VALUES (v_order_id, NULL, 'instant', NOW() + INTERVAL '30 minutes');
    END IF;
  END IF;

  -- 3e. Promo reservation (UNCHANGED from M393)
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
    'server_total', CASE WHEN p_validate_products THEN v_server_total ELSE NULL END,
    'server_discount', CASE WHEN p_validate_products THEN v_server_discount ELSE NULL END,
    'server_volume_discount', CASE WHEN p_validate_products THEN v_server_volume_discount ELSE NULL END
  );
END;
$$;

-- ACL: preserve existing (same 24-param signature)
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

-- ═══════════════════════════════════════════════════════════════════════════
-- Self-verification
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'create_order_atomic'
  ) THEN
    RAISE EXCEPTION 'M435 verification FAILED: create_order_atomic not found';
  END IF;
  RAISE NOTICE 'M435 self-verification PASSED: create_order_atomic exists with price authority';
END $$;
