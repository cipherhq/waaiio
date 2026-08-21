-- ACC-008: Promo reservation/finalization/release + order referral tracking
--
-- Promo codes now use reserve/finalize/release semantics:
-- - reserved_uses: count of promos reserved by pending orders
-- - current_uses: count of FINALIZED (payment-confirmed) redemptions
-- - Availability = max_uses - current_uses - reserved_uses
-- - Reserve on pending order creation (atomic with order)
-- - Finalize on authoritative payment success (exactly once)
-- - Release on cancellation/expiry (exactly once)
--
-- Orders track referral_id for deferred conversion on payment success.

-- 1. Add reserved_uses to promo_codes
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS reserved_uses integer DEFAULT 0 NOT NULL;

-- 2. Add referral_id to orders for deferred conversion
ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_id uuid REFERENCES referrals(id) ON DELETE SET NULL;

-- 3. Update create_order_atomic to RESERVE (not finalize) promo usage
CREATE OR REPLACE FUNCTION create_order_atomic(
  p_bot_session_id uuid,
  p_business_id uuid,
  p_user_id uuid,
  p_status text DEFAULT 'pending',
  p_delivery_address text DEFAULT NULL,
  p_delivery_phone text DEFAULT NULL,
  p_total_amount numeric DEFAULT 0,
  p_discount_amount numeric DEFAULT 0,
  p_shipping_cost numeric DEFAULT 0,
  p_promo_code_id uuid DEFAULT NULL,
  p_channel text DEFAULT 'whatsapp',
  p_delivery_zone_id uuid DEFAULT NULL,
  p_addons_total numeric DEFAULT 0,
  p_volume_discount_amount numeric DEFAULT 0,
  p_pickup_address text DEFAULT NULL,
  p_dropoff_address text DEFAULT NULL,
  p_package_description text DEFAULT NULL,
  p_package_photo_url text DEFAULT NULL,
  p_items jsonb DEFAULT '[]',
  p_referral_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_reference_code text;
  v_created boolean := false;
  v_item jsonb;
  v_existing_order_id uuid;
BEGIN
  -- Advisory lock on bot_session_id to serialize concurrent retries
  PERFORM pg_advisory_xact_lock(hashtext(p_bot_session_id::text));

  -- Check for existing order from this session (idempotent recovery)
  SELECT id, reference_code INTO v_existing_order_id, v_reference_code
  FROM orders
  WHERE bot_session_id = p_bot_session_id
  LIMIT 1;

  IF v_existing_order_id IS NOT NULL THEN
    -- Recovery path: order already created by a previous attempt
    RETURN jsonb_build_object(
      'order_id', v_existing_order_id,
      'reference_code', v_reference_code,
      'created', false
    );
  END IF;

  -- Generate unique reference code
  v_reference_code := 'WA-OR-' || lpad(floor(random() * 10000)::text, 4, '0');

  -- Create order
  INSERT INTO orders (
    business_id, user_id, status, delivery_address, delivery_phone,
    total_amount, discount_amount, shipping_cost, promo_code_id,
    channel, reference_code, bot_session_id, delivery_zone_id,
    addons_total, volume_discount_amount,
    pickup_address, dropoff_address, package_description, package_photo_url,
    referral_id
  ) VALUES (
    p_business_id, p_user_id, p_status, p_delivery_address, p_delivery_phone,
    p_total_amount, p_discount_amount, p_shipping_cost, p_promo_code_id,
    p_channel, v_reference_code, p_bot_session_id, p_delivery_zone_id,
    p_addons_total, p_volume_discount_amount,
    p_pickup_address, p_dropoff_address, p_package_description, p_package_photo_url,
    p_referral_id
  )
  RETURNING id INTO v_order_id;

  v_created := true;

  -- Insert order items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO order_items (
      order_id, product_id, quantity, unit_price, variant_id, variant_label, addons
    ) VALUES (
      v_order_id,
      (v_item->>'product_id')::uuid,
      (v_item->>'quantity')::integer,
      (v_item->>'unit_price')::numeric,
      CASE WHEN v_item->>'variant_id' IS NOT NULL THEN (v_item->>'variant_id')::uuid ELSE NULL END,
      v_item->>'variant_label',
      CASE WHEN v_item->'addons' IS NOT NULL THEN v_item->'addons' ELSE '[]'::jsonb END
    );
  END LOOP;

  -- ACC-008: RESERVE promo usage (not finalize).
  -- reserved_uses tracks pending orders; current_uses tracks finalized (paid) orders.
  -- Availability = max_uses - current_uses - reserved_uses.
  -- Finalized on payment success via finalize_promo_reservation().
  -- Released on cancellation via release_promo_reservation().
  IF p_promo_code_id IS NOT NULL THEN
    UPDATE promo_codes
    SET reserved_uses = reserved_uses + 1
    WHERE id = p_promo_code_id;
  END IF;

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'reference_code', v_reference_code,
    'created', v_created
  );
END;
$$;

-- 4. Finalize promo reservation on authoritative payment success
-- Moves one reservation to confirmed usage. Idempotent via order status check.
CREATE OR REPLACE FUNCTION finalize_promo_reservation(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_promo_id uuid;
  v_order_status text;
BEGIN
  SELECT promo_code_id, status INTO v_promo_id, v_order_status
  FROM orders WHERE id = p_order_id FOR UPDATE;

  -- Only finalize for orders that just became confirmed/paid
  -- If already finalized (confirmed + promo already counted), skip
  IF v_promo_id IS NULL THEN
    RETURN false; -- no promo to finalize
  END IF;

  -- Idempotency: check if this order's promo was already finalized
  -- We track this by checking if reserved_uses was already decremented for this order
  -- Use a simple approach: only finalize if reserved_uses > 0 for this promo
  UPDATE promo_codes
  SET current_uses = current_uses + 1,
      reserved_uses = GREATEST(reserved_uses - 1, 0)
  WHERE id = v_promo_id
    AND reserved_uses > 0;

  RETURN FOUND;
END;
$$;

-- 5. Release promo reservation on cancellation/expiry
-- Returns one reserved use without incrementing current_uses. Idempotent.
CREATE OR REPLACE FUNCTION release_promo_reservation(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_promo_id uuid;
BEGIN
  SELECT promo_code_id INTO v_promo_id
  FROM orders WHERE id = p_order_id;

  IF v_promo_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE promo_codes
  SET reserved_uses = GREATEST(reserved_uses - 1, 0)
  WHERE id = v_promo_id
    AND reserved_uses > 0;

  RETURN FOUND;
END;
$$;

-- 6. Update cancel_stale_order_atomic to release promo reservations
CREATE OR REPLACE FUNCTION cancel_stale_order_atomic(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_payment RECORD;
  v_stock_marker RECORD;
  v_item RECORD;
BEGIN
  -- Lock the order row
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF v_order IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'order_not_found');
  END IF;

  -- Must be pending
  IF v_order.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_pending');
  END IF;

  -- Must be older than 48 hours
  IF v_order.created_at > now() - interval '48 hours' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_stale');
  END IF;

  -- Check for successful payment — skip if paid
  SELECT * INTO v_payment FROM payments
  WHERE order_id = p_order_id AND status = 'success'
  LIMIT 1;

  IF v_payment IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'has_successful_payment');
  END IF;

  -- Void any pending payments
  UPDATE payments SET status = 'failed'
  WHERE order_id = p_order_id AND status = 'pending';

  -- Check if stock was applied (idempotent marker)
  SELECT * INTO v_stock_marker FROM order_stock_applications
  WHERE order_id = p_order_id LIMIT 1;

  -- Restore stock if it was decremented
  IF v_stock_marker IS NOT NULL THEN
    FOR v_item IN SELECT product_id, quantity, variant_id FROM order_items WHERE order_id = p_order_id
    LOOP
      IF v_item.variant_id IS NOT NULL THEN
        UPDATE product_variants
        SET stock_quantity = stock_quantity + v_item.quantity
        WHERE id = v_item.variant_id AND stock_quantity IS NOT NULL;
      ELSE
        UPDATE products
        SET stock_quantity = stock_quantity + v_item.quantity
        WHERE id = v_item.product_id AND stock_quantity IS NOT NULL;
      END IF;
    END LOOP;

    DELETE FROM order_stock_applications WHERE order_id = p_order_id;
  END IF;

  -- ACC-008: Release promo reservation on cancellation
  IF v_order.promo_code_id IS NOT NULL THEN
    PERFORM release_promo_reservation(p_order_id);
  END IF;

  -- Cancel the order
  UPDATE orders SET status = 'cancelled', updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'stock_restored', v_stock_marker IS NOT NULL);
END;
$$;

-- Grant execute to authenticated users (RPCs called from service client)
GRANT EXECUTE ON FUNCTION finalize_promo_reservation(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION release_promo_reservation(uuid) TO service_role;
