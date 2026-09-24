-- Migration 400: Cross-flow convergence
--
-- #389: Adds payment-link convergence for orders, reservations, and donations.
-- Replaces finalize_payment_confirmation with execution-class-aware optional handling.
--
-- A. ensure_campaign_donation_intent_for_payment RPC
-- B. apply_order_stock_once — payment-link convergence (CREATE OR REPLACE)
-- C. confirm_reservation_payment_atomic RPC
-- D. finalize_payment_confirmation — execution-class-aware optional handling (CREATE OR REPLACE)
-- E. ACL grants/revokes

-- ═══════════════════════════════════════════════════════
-- A. ensure_campaign_donation_intent_for_payment
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.ensure_campaign_donation_intent_for_payment(
  p_payment_id UUID,
  p_donor_phone TEXT,
  p_donor_name TEXT DEFAULT NULL,
  p_reference_code TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment RECORD;
  v_existing RECORD;
  v_donation_id UUID;
BEGIN
  -- Read payment to get campaign_id, business_id, amount, currency
  SELECT id, campaign_id, business_id, amount, currency
  INTO v_payment FROM payments WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('created', false, 'reason', 'payment_not_found');
  END IF;

  IF v_payment.campaign_id IS NULL THEN
    RETURN jsonb_build_object('created', false, 'reason', 'no_campaign_id');
  END IF;

  -- Attempt insert with ON CONFLICT DO NOTHING (payment_id is UNIQUE on campaign_donations)
  INSERT INTO campaign_donations (
    campaign_id, business_id, payment_id, donor_phone, donor_name,
    amount, currency, reference_code, status
  ) VALUES (
    v_payment.campaign_id, v_payment.business_id, p_payment_id, p_donor_phone,
    p_donor_name, v_payment.amount, v_payment.currency,
    COALESCE(p_reference_code, 'DON-' || UPPER(TO_HEX(EXTRACT(EPOCH FROM NOW())::BIGINT))),
    'pending'
  )
  ON CONFLICT (payment_id) DO NOTHING
  RETURNING id INTO v_donation_id;

  IF v_donation_id IS NOT NULL THEN
    -- Fresh insert succeeded
    RETURN jsonb_build_object('created', true, 'donation_id', v_donation_id, 'already_existed', false);
  END IF;

  -- Conflict: verify existing row matches payment's campaign/business/amount/currency
  SELECT id, campaign_id, business_id, amount, currency
  INTO v_existing FROM campaign_donations WHERE payment_id = p_payment_id;

  IF NOT FOUND THEN
    -- Should not happen after ON CONFLICT DO NOTHING, but fail closed
    RETURN jsonb_build_object('created', false, 'reason', 'conflict_but_not_found');
  END IF;

  -- Fail closed on mismatch
  IF v_existing.campaign_id != v_payment.campaign_id THEN
    RETURN jsonb_build_object('created', false, 'reason', 'campaign_mismatch',
      'existing_campaign', v_existing.campaign_id, 'payment_campaign', v_payment.campaign_id);
  END IF;
  IF v_existing.business_id != v_payment.business_id THEN
    RETURN jsonb_build_object('created', false, 'reason', 'business_mismatch');
  END IF;
  IF v_existing.amount != v_payment.amount THEN
    RETURN jsonb_build_object('created', false, 'reason', 'amount_mismatch');
  END IF;
  IF v_existing.currency != v_payment.currency THEN
    RETURN jsonb_build_object('created', false, 'reason', 'currency_mismatch');
  END IF;

  RETURN jsonb_build_object('created', false, 'donation_id', v_existing.id, 'already_existed', true);
END;
$$;


-- ═══════════════════════════════════════════════════════
-- B. apply_order_stock_once — payment-link convergence
-- ═══════════════════════════════════════════════════════

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

  -- 3. Validate payment->order relationship AND payment success when payment_id is supplied.
  IF p_payment_id IS NOT NULL THEN
    PERFORM id FROM payments
    WHERE id = p_payment_id
      AND (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text);
    IF NOT FOUND THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'payment_order_mismatch');
    END IF;
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
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.reservation_class = 'committed' THEN
      IF p_payment_id IS NOT NULL AND v_existing.payment_id = p_payment_id THEN
        -- Idempotent replay: same payment committed again
        -- M400: Payment-link convergence — repair NULL orders.payment_id
        IF p_payment_id IS NOT NULL THEN
          UPDATE orders SET payment_id = p_payment_id, updated_at = NOW()
          WHERE id = p_order_id AND (payment_id IS NULL OR payment_id = p_payment_id);
          -- Verify convergence: if a DIFFERENT payment already won, fail closed
          PERFORM id FROM orders WHERE id = p_order_id
            AND payment_id IS NOT NULL AND payment_id != p_payment_id;
          IF FOUND THEN
            RETURN jsonb_build_object('applied', false, 'reason', 'payment_link_conflict');
          END IF;
        END IF;
        RETURN jsonb_build_object('applied', true, 'already_applied', true,
          'order_confirmed', true);
      ELSIF p_payment_id IS NOT NULL AND v_existing.payment_id IS NOT NULL
            AND v_existing.payment_id != p_payment_id THEN
        RETURN jsonb_build_object('applied', false, 'reason', 'payment_conflict');
      ELSIF p_payment_id IS NULL THEN
        RETURN jsonb_build_object('applied', false, 'reason', 'committed_no_winner');
      ELSE
        RETURN jsonb_build_object('applied', false, 'reason', 'committed_no_winner');
      END IF;
    ELSE
      -- Non-committed marker (instant, bank_transfer, prepayment)
      IF p_payment_id IS NOT NULL THEN
        IF v_existing.payment_id IS NOT NULL AND v_existing.payment_id != p_payment_id THEN
          RETURN jsonb_build_object('applied', false, 'reason', 'payment_conflict');
        END IF;

        UPDATE order_stock_applications
        SET reservation_class = 'committed', expires_at = NULL, payment_id = p_payment_id
        WHERE order_id = p_order_id;

        UPDATE pending_transfers SET status = 'cancelled'
        WHERE order_id = p_order_id AND status = 'pending';

        IF v_order.status = 'pending' THEN
          UPDATE orders SET status = 'confirmed', updated_at = NOW()
          WHERE id = p_order_id AND status = 'pending';
        END IF;

        -- M400: Payment-link convergence — set orders.payment_id
        IF p_payment_id IS NOT NULL THEN
          UPDATE orders SET payment_id = p_payment_id, updated_at = NOW()
          WHERE id = p_order_id AND (payment_id IS NULL OR payment_id = p_payment_id);
          -- Verify convergence: if a DIFFERENT payment already won, fail closed
          PERFORM id FROM orders WHERE id = p_order_id
            AND payment_id IS NOT NULL AND payment_id != p_payment_id;
          IF FOUND THEN
            RETURN jsonb_build_object('applied', false, 'reason', 'payment_link_conflict');
          END IF;
        END IF;

        RETURN jsonb_build_object('applied', true, 'already_applied', true,
          'order_confirmed', true);
      ELSE
        IF v_order.status = 'pending' THEN
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
      SELECT pv.id, pv.stock_quantity
      INTO v_variant
      FROM product_variants pv
      WHERE pv.id = v_item.variant_id
      FOR UPDATE;

      IF FOUND AND v_variant.stock_quantity IS NOT NULL THEN
        IF p_validate_sufficient AND v_variant.stock_quantity < v_item.quantity THEN
          v_out_of_stock := array_append(v_out_of_stock,
            COALESCE((SELECT name FROM products WHERE id = v_item.product_id), 'Unknown'));
        ELSE
          UPDATE product_variants
          SET stock_quantity = GREATEST(0, stock_quantity - v_item.quantity)
          WHERE id = v_item.variant_id;
        END IF;
      END IF;
    ELSIF v_item.product_id IS NOT NULL THEN
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

  -- 7. Insert order-level marker
  IF p_payment_id IS NOT NULL THEN
    INSERT INTO order_stock_applications (order_id, payment_id, item_count, reservation_class, expires_at)
    VALUES (p_order_id, p_payment_id, v_count, 'committed', NULL);

    UPDATE pending_transfers SET status = 'cancelled'
    WHERE order_id = p_order_id AND status = 'pending';
  ELSE
    INSERT INTO order_stock_applications (order_id, payment_id, item_count)
    VALUES (p_order_id, p_payment_id, v_count);
  END IF;

  -- 8. Confirm order + set payment_id when payment-confirmed
  IF p_payment_id IS NOT NULL AND v_order.status = 'pending' THEN
    UPDATE orders SET status = 'confirmed', updated_at = NOW()
    WHERE id = p_order_id AND status = 'pending';
  END IF;

  -- M400: Payment-link convergence — set orders.payment_id for fresh winner
  IF p_payment_id IS NOT NULL THEN
    UPDATE orders SET payment_id = p_payment_id, updated_at = NOW()
    WHERE id = p_order_id AND (payment_id IS NULL OR payment_id = p_payment_id);
    -- Verify convergence: if a DIFFERENT payment already won, fail closed
    PERFORM id FROM orders WHERE id = p_order_id
      AND payment_id IS NOT NULL AND payment_id != p_payment_id;
    IF FOUND THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'payment_link_conflict');
    END IF;
  END IF;

  RETURN jsonb_build_object('applied', true, 'already_applied', false, 'items', v_count,
    'order_confirmed', (p_payment_id IS NOT NULL AND v_order.status = 'pending'));
END;
$$;

-- ACL: preserve existing (M327 signature)
REVOKE ALL ON FUNCTION public.apply_order_stock_once(UUID, UUID, BOOLEAN) FROM PUBLIC;


-- ═══════════════════════════════════════════════════════
-- C. confirm_reservation_payment_atomic
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.confirm_reservation_payment_atomic(
  p_reservation_id UUID,
  p_payment_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservation RECORD;
  v_payment RECORD;
BEGIN
  -- Lock reservation
  SELECT id, status, deposit_status, payment_id
  INTO v_reservation FROM reservations WHERE id = p_reservation_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'reservation_not_found');
  END IF;

  -- Validate payment exists and is successful
  SELECT id, status, reservation_id
  INTO v_payment FROM payments WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'payment_not_found');
  END IF;

  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'payment_not_successful');
  END IF;

  -- Validate payment.reservation_id matches
  IF v_payment.reservation_id IS NULL OR v_payment.reservation_id != p_reservation_id THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'reservation_mismatch');
  END IF;

  -- Reject cancelled state
  IF v_reservation.status = 'cancelled' THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'reservation_cancelled');
  END IF;

  -- Payment link logic: NULL -> bind, same -> idempotent, different -> conflict
  IF v_reservation.payment_id IS NOT NULL AND v_reservation.payment_id != p_payment_id THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'payment_conflict');
  END IF;

  -- Track initial state
  IF v_reservation.status = 'pending' THEN
    -- pending -> confirmed + paid + payment_id + confirmed_at
    UPDATE reservations
    SET status = 'confirmed',
        deposit_status = 'paid',
        payment_id = p_payment_id,
        confirmed_at = NOW(),
        updated_at = NOW()
    WHERE id = p_reservation_id;

    RETURN jsonb_build_object('confirmed', true, 'reason', 'pending_to_confirmed',
      'was_pending', true,
      'was_null_link', v_reservation.payment_id IS NULL);
  END IF;

  -- confirmed/in_progress/completed + NULL/same payment -> repair paid state + link
  IF v_reservation.status IN ('confirmed', 'in_progress', 'completed') THEN
    UPDATE reservations
    SET deposit_status = 'paid',
        payment_id = COALESCE(v_reservation.payment_id, p_payment_id),
        updated_at = NOW()
    WHERE id = p_reservation_id;

    RETURN jsonb_build_object('confirmed', true, 'reason', 'repair_paid_state',
      'was_pending', false,
      'was_null_link', v_reservation.payment_id IS NULL);
  END IF;

  -- Unexpected status (e.g., no_show) — fail closed
  RETURN jsonb_build_object('confirmed', false, 'reason', 'unexpected_status',
    'status', v_reservation.status);
END;
$$;


-- ═══════════════════════════════════════════════════════
-- D. finalize_payment_confirmation — execution-class-aware optional handling
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION finalize_payment_confirmation(
  p_payment_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_payment RECORD;
  v_manifest RECORD;
  v_has_manifest BOOLEAN := false;
  v_total INTEGER;
  v_actual_hash TEXT;
  v_actual_tuples TEXT[];
  v_incomplete INTEGER;
  v_pending_ext INTEGER;
  v_unexcused INTEGER;
  v_terminal_reason TEXT;
  v_whatsapp_applicable BOOLEAN;
  v_whatsapp_status TEXT;
  v_has_successful_delivery BOOLEAN;
  v_has_indeterminate BOOLEAN;
  v_has_any_delivery BOOLEAN;
  v_active_internal INTEGER;
BEGIN
  SELECT confirmation_sent_at, confirmation_processing_at,
         confirmation_claim_token, confirmation_terminal_reason,
         payment_authority_version
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'not_found');
  END IF;
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('finalized', true, 'already_finalized', true);
  END IF;
  IF v_payment.confirmation_terminal_reason IS NOT NULL THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'already_terminated');
  END IF;
  IF v_payment.confirmation_claim_token IS NULL
     OR v_payment.confirmation_claim_token != p_claim_token THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'token_mismatch');
  END IF;

  -- Check if manifest exists
  SELECT * INTO v_manifest FROM payment_terminal_manifests
  WHERE payment_id = p_payment_id;

  IF FOUND THEN
    v_has_manifest := true;

    IF v_manifest.initialization_state != 'initialized' THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'manifest_not_initialized');
    END IF;

    -- Recompute and verify semantic hash
    SELECT COUNT(*),
           array_agg(
             effect_key || '|' || category || '|' || execution_class || '|' ||
             COALESCE(provider_channel, 'none') || '|' || contract_version::TEXT
             ORDER BY effect_key || '|' || category || '|' || execution_class || '|' ||
             COALESCE(provider_channel, 'none') || '|' || contract_version::TEXT
           )
    INTO v_total, v_actual_tuples
    FROM payment_terminal_effects WHERE payment_id = p_payment_id;

    v_actual_hash := encode(digest(
      array_to_string(COALESCE(v_actual_tuples, ARRAY[]::TEXT[]), ','), 'sha256'), 'hex');

    IF v_total != v_manifest.expected_effect_count THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'effect_count_mismatch',
        'expected', v_manifest.expected_effect_count, 'actual', v_total);
    END IF;
    IF v_actual_hash != v_manifest.expected_semantic_hash THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'semantic_hash_mismatch');
    END IF;

    -- Required internal: all must be completed
    SELECT COUNT(*) INTO v_incomplete FROM payment_terminal_effects
    WHERE payment_id = p_payment_id AND category = 'required_internal'
      AND status != 'completed';
    IF v_incomplete > 0 THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'incomplete_required_internal',
        'remaining', v_incomplete);
    END IF;

    -- Required external: must be in terminal state
    SELECT COUNT(*) INTO v_pending_ext FROM payment_terminal_effects
    WHERE payment_id = p_payment_id AND category = 'required_external'
      AND status NOT IN ('completed', 'failed', 'indeterminate');
    IF v_pending_ext > 0 THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'pending_required_external',
        'remaining', v_pending_ext);
    END IF;

    -- ── M400: Execution-class-aware optional handling ──

    -- Phase 1: Auto-skip internal optional pending
    UPDATE payment_terminal_effects SET status = 'skipped',
      suppression_reason = 'auto_skipped_at_finalization:internal_pending',
      completed_at = NOW(), updated_at = NOW()
    WHERE payment_id = p_payment_id AND category = 'optional'
      AND execution_class = 'internal' AND status = 'pending';

    -- Stale internal claims -> indeterminate
    UPDATE payment_terminal_effects SET status = 'indeterminate',
      suppression_reason = 'stale_claim_internal:side_effect_unknown',
      completed_at = NOW(), updated_at = NOW()
    WHERE payment_id = p_payment_id AND category = 'optional'
      AND execution_class = 'internal' AND status = 'claimed'
      AND claim_expires_at <= NOW();

    -- Check active internal claims
    SELECT COUNT(*) INTO v_active_internal FROM payment_terminal_effects
    WHERE payment_id = p_payment_id AND category = 'optional'
      AND execution_class = 'internal' AND status = 'claimed'
      AND claim_expires_at > NOW();
    IF v_active_internal > 0 THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'optional_internal_in_progress',
        'remaining', v_active_internal);
    END IF;

    -- Phase 2: Auto-skip external optional
    UPDATE payment_terminal_effects SET status = 'skipped',
      suppression_reason = 'auto_skipped_at_finalization:external',
      completed_at = NOW(), updated_at = NOW()
    WHERE payment_id = p_payment_id AND category = 'optional'
      AND execution_class = 'external'
      AND (status = 'pending' OR (status = 'claimed' AND emission_started_at IS NULL));

    -- No dangling_optional gate — finalization proceeds after auto-skip

    SELECT COUNT(*) INTO v_unexcused FROM payment_terminal_effects
    WHERE payment_id = p_payment_id AND status = 'skipped'
      AND (suppression_reason IS NULL OR suppression_reason = '');
    IF v_unexcused > 0 THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'skipped_without_reason',
        'count', v_unexcused);
    END IF;

    -- DB-derived terminal outcome (v11 truth table)
    SELECT EXISTS(
      SELECT 1 FROM payment_terminal_effects
      WHERE payment_id = p_payment_id AND effect_key = 'customer_whatsapp'
    ) INTO v_whatsapp_applicable;

    IF NOT v_whatsapp_applicable THEN
      v_terminal_reason := NULL;
    ELSE
      SELECT status INTO v_whatsapp_status FROM payment_terminal_effects
      WHERE payment_id = p_payment_id AND effect_key = 'customer_whatsapp';

      IF v_whatsapp_status = 'completed' THEN
        v_terminal_reason := NULL;
      ELSIF v_whatsapp_status = 'indeterminate' THEN
        v_terminal_reason := 'ambiguous_delivery';
      ELSIF v_whatsapp_status = 'failed' THEN
        SELECT EXISTS(
          SELECT 1 FROM payment_confirmation_deliveries
          WHERE payment_id = p_payment_id
        ) INTO v_has_any_delivery;

        IF NOT v_has_any_delivery THEN
          v_terminal_reason := 'delivery_failure';
        ELSE
          SELECT EXISTS(
            SELECT 1 FROM payment_confirmation_deliveries
            WHERE payment_id = p_payment_id AND delivery_status = 'indeterminate'
          ) INTO v_has_indeterminate;

          IF v_has_indeterminate THEN
            v_terminal_reason := 'ambiguous_delivery';
          ELSE
            v_terminal_reason := 'delivery_failure';
          END IF;
        END IF;
      ELSE
        v_terminal_reason := 'ambiguous_delivery';
      END IF;
    END IF;
  ELSE
    IF v_payment.payment_authority_version IS NOT NULL THEN
      RETURN jsonb_build_object('finalized', false, 'reason', 'manifest_required_for_phase_a',
        'payment_authority_version', v_payment.payment_authority_version);
    END IF;
    v_terminal_reason := NULL;
  END IF;

  -- Finalize
  UPDATE payments
  SET confirmation_sent_at = NOW(),
      confirmation_processing_at = NULL,
      confirmation_claim_token = NULL,
      confirmation_terminal_reason = v_terminal_reason
  WHERE id = p_payment_id;

  RETURN jsonb_build_object('finalized', true, 'already_finalized', false,
    'has_manifest', v_has_manifest,
    'terminal_reason', v_terminal_reason);
END;
$$;


-- ═══════════════════════════════════════════════════════
-- E. ACL grants/revokes
-- ═══════════════════════════════════════════════════════

-- ensure_campaign_donation_intent_for_payment: service-role only
REVOKE ALL ON FUNCTION public.ensure_campaign_donation_intent_for_payment(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_campaign_donation_intent_for_payment(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_campaign_donation_intent_for_payment(UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_campaign_donation_intent_for_payment(UUID, TEXT, TEXT, TEXT) TO service_role;

-- confirm_reservation_payment_atomic: service-role only
REVOKE ALL ON FUNCTION public.confirm_reservation_payment_atomic(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_reservation_payment_atomic(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.confirm_reservation_payment_atomic(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_reservation_payment_atomic(UUID, UUID) TO service_role;

-- apply_order_stock_once: preserve existing ACL (service-role only from M327)
GRANT EXECUTE ON FUNCTION public.apply_order_stock_once(UUID, UUID, BOOLEAN) TO service_role;

-- finalize_payment_confirmation: preserve existing ACL
GRANT EXECUTE ON FUNCTION finalize_payment_confirmation(UUID, UUID) TO service_role;


-- ═══════════════════════════════════════════════════════
-- Self-verification
-- ═══════════════════════════════════════════════════════

DO $$
DECLARE
  v_fn RECORD;
BEGIN
  -- Verify all RPCs exist
  FOR v_fn IN
    SELECT proname FROM pg_proc
    WHERE proname IN (
      'ensure_campaign_donation_intent_for_payment',
      'apply_order_stock_once',
      'confirm_reservation_payment_atomic',
      'finalize_payment_confirmation'
    )
    AND pronamespace = 'public'::regnamespace
  LOOP
    RAISE NOTICE 'M400: verified function %', v_fn.proname;
  END LOOP;
END;
$$;
