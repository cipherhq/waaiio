-- Migration 328: Atomic quote acceptance/rejection RPCs
--
-- Implements:
--   accept_order_quote_atomic(p_quote_id, p_customer_phone) — creates order,
--     reserves inventory via apply_order_stock_once, updates quote status
--   reject_order_quote_atomic(p_quote_id, p_customer_phone) — rejects quote
--
-- Security:
--   - p_customer_phone must be the Meta-verified WhatsApp sender
--   - All financial values derived from stored data, never caller input
--   - SECURITY DEFINER, SET search_path, service_role only
--   - Identity verification: fail closed on mismatch/null/empty
--
-- Also adds partial UNIQUE on orders.quote_request_id to enforce
-- one-quote → one-order at the database level.

-- ═══════════════════════════════════════════════════════
-- Partial UNIQUE: one quote creates at most one order
-- ═══════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_quote_request_id_unique
  ON orders (quote_request_id)
  WHERE quote_request_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════
-- accept_order_quote_atomic
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
BEGIN
  -- ── 1. Identity validation: fail closed ──
  v_trusted := regexp_replace(COALESCE(p_customer_phone, ''), '^\+', '');
  IF v_trusted = '' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'identity_missing');
  END IF;

  -- ── 2. Lock quote row ──
  SELECT * INTO v_quote
  FROM quote_requests WHERE id = p_quote_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_found');
  END IF;

  -- ── 3. Verify identity ──
  v_stored := regexp_replace(COALESCE(v_quote.customer_phone, ''), '^\+', '');
  IF v_stored = '' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'quote_phone_missing');
  END IF;
  IF v_trusted != v_stored THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'identity_mismatch');
  END IF;

  -- ── 4. Status checks ──
  IF v_quote.status = 'accepted' THEN
    -- Idempotent: return existing order with full financial data for payment recovery
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

  -- ── 5. Check expiry ──
  IF v_quote.expires_at IS NOT NULL AND v_quote.expires_at < NOW() THEN
    UPDATE quote_requests SET status = 'expired' WHERE id = p_quote_id;
    RETURN jsonb_build_object('accepted', false, 'reason', 'expired');
  END IF;

  -- ── 6. Derive all values from DB ──
  v_total := COALESCE(v_quote.quoted_amount, v_quote.estimated_subtotal, 0);

  SELECT id, name, country_code, subscription_tier, trial_ends_at, metadata
  INTO v_biz FROM businesses WHERE id = v_quote.business_id;

  -- Deposit configuration from business metadata
  v_has_custom_data := v_quote.custom_order_data IS NOT NULL;
  v_custom_config := COALESCE(v_biz.metadata->'custom_order_config', '{}'::jsonb);
  v_deposit_pct := CASE
    WHEN v_has_custom_data THEN COALESCE((v_custom_config->>'deposit_percentage')::int, 0)
    ELSE 0
  END;
  v_deposit_amount := CASE WHEN v_deposit_pct > 0 THEN (v_total * v_deposit_pct / 100) ELSE 0 END;
  v_balance_amount := CASE WHEN v_deposit_pct > 0 THEN v_total - v_deposit_amount ELSE 0 END;

  -- ── 7. Create order ──
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

  -- ── 8. Create order items from cart_snapshot ──
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

  -- ── 9. Reserve inventory via canonical RPC (same transaction) ──
  -- p_validate_sufficient = true → rolls back entire acceptance on insufficiency
  v_stock_result := apply_order_stock_once(v_order_id, NULL, true);

  IF NOT (v_stock_result->>'applied')::boolean THEN
    -- This should not happen (order was just created, can't be cancelled or have marker)
    -- but fail safely
    RAISE EXCEPTION 'stock_application_failed:%', v_stock_result->>'reason';
  END IF;

  -- ── 10. Update quote ──
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
-- reject_order_quote_atomic
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.reject_order_quote_atomic(
  p_quote_id UUID,
  p_customer_phone TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote RECORD;
  v_trusted TEXT;
  v_stored TEXT;
BEGIN
  -- ── 1. Identity validation: fail closed ──
  v_trusted := regexp_replace(COALESCE(p_customer_phone, ''), '^\+', '');
  IF v_trusted = '' THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'identity_missing');
  END IF;

  -- ── 2. Lock quote row ──
  SELECT * INTO v_quote
  FROM quote_requests WHERE id = p_quote_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'not_found');
  END IF;

  -- ── 3. Verify identity ──
  v_stored := regexp_replace(COALESCE(v_quote.customer_phone, ''), '^\+', '');
  IF v_stored = '' THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'quote_phone_missing');
  END IF;
  IF v_trusted != v_stored THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'identity_mismatch');
  END IF;

  -- ── 4. Status checks ──
  IF v_quote.status = 'rejected' THEN
    RETURN jsonb_build_object('rejected', true, 'already_rejected', true);
  END IF;
  IF v_quote.status = 'accepted' THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'already_accepted');
  END IF;
  IF v_quote.status = 'expired' THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'expired');
  END IF;
  IF v_quote.status = 'cancelled' THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'cancelled');
  END IF;
  IF v_quote.status = 'pending' THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'not_yet_quoted');
  END IF;
  IF v_quote.status != 'quoted' THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'invalid_status');
  END IF;

  -- ── 5. Check expiry ──
  IF v_quote.expires_at IS NOT NULL AND v_quote.expires_at < NOW() THEN
    UPDATE quote_requests SET status = 'expired' WHERE id = p_quote_id;
    RETURN jsonb_build_object('rejected', false, 'reason', 'expired');
  END IF;

  -- ── 6. Reject ──
  UPDATE quote_requests SET
    status = 'rejected',
    responded_at = NOW()
  WHERE id = p_quote_id;

  RETURN jsonb_build_object(
    'rejected', true,
    'already_rejected', false,
    'business_id', v_quote.business_id,
    'customer_phone', v_quote.customer_phone,
    'customer_name', v_quote.customer_name,
    'quoted_amount', v_quote.quoted_amount,
    'estimated_subtotal', v_quote.estimated_subtotal
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Privilege hardening
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  -- accept_order_quote_atomic
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

  -- reject_order_quote_atomic
  REVOKE ALL ON FUNCTION public.reject_order_quote_atomic(UUID, TEXT) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.reject_order_quote_atomic(UUID, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.reject_order_quote_atomic(UUID, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.reject_order_quote_atomic(UUID, TEXT) TO service_role;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════
-- Executable privilege tests (hard gate)
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  -- accept_order_quote_atomic
  SELECT has_function_privilege('anon', 'accept_order_quote_atomic(uuid, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'PRIVILEGE VIOLATION: anon can execute accept_order_quote_atomic'; END IF;

  SELECT has_function_privilege('authenticated', 'accept_order_quote_atomic(uuid, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'PRIVILEGE VIOLATION: authenticated can execute accept_order_quote_atomic'; END IF;

  SELECT has_function_privilege('service_role', 'accept_order_quote_atomic(uuid, text)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION 'PRIVILEGE VIOLATION: service_role cannot execute accept_order_quote_atomic'; END IF;

  -- reject_order_quote_atomic
  SELECT has_function_privilege('anon', 'reject_order_quote_atomic(uuid, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'PRIVILEGE VIOLATION: anon can execute reject_order_quote_atomic'; END IF;

  SELECT has_function_privilege('authenticated', 'reject_order_quote_atomic(uuid, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'PRIVILEGE VIOLATION: authenticated can execute reject_order_quote_atomic'; END IF;

  SELECT has_function_privilege('service_role', 'reject_order_quote_atomic(uuid, text)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION 'PRIVILEGE VIOLATION: service_role cannot execute reject_order_quote_atomic'; END IF;

  RAISE NOTICE 'All privilege checks passed for quote acceptance/rejection RPCs';
END $$;
