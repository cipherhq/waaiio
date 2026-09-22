-- ═══════════════════════════════════════════════════════════════════════════
-- M394: Direct Order Payment Authority (#352 Phase 2D)
--
-- 1. Redefine confirm_order_transfer_atomic — add payment_authority_version=1
--    + _direct_transfer=true metadata provenance (M393 body preserved)
-- 2. Redefine initialize_terminal_effects — add customer_order_email to catalog,
--    exempt direct order bank transfers from owner_notif_whatsapp/email requirement
--
-- M393 remains immutable history.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. confirm_order_transfer_atomic (from exact M393 body) ────────────
-- Changes:
--   a) Payment INSERT adds payment_authority_version = 1
--   b) Payment INSERT metadata adds _direct_transfer = true
-- All lock/winner/inventory/promo semantics preserved exactly.

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

  -- 2. Lock transfer (R29: include customer_phone, customer_name for payment metadata)
  SELECT id, order_id, business_id, expected_amount, currency, reference_code,
         status, expires_at, metadata, customer_phone, customer_name
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
  -- M394: Add payment_authority_version=1 and _direct_transfer=true for Phase 2D recovery
  INSERT INTO payments (
    business_id, amount, currency, status, payment_method, gateway,
    gateway_reference, gateway_status, order_id, paid_at,
    payment_authority_version,
    metadata
  ) VALUES (
    p_business_id,
    v_order.total_amount,
    v_transfer.currency,
    'success',
    'bank_transfer',
    'direct',
    'transfer:' || v_transfer.reference_code,
    'merchant_confirmed',
    p_order_id,
    v_now,
    1,  -- M394: durable Payment Authority provenance
    jsonb_build_object(
      'pending_transfer_id', p_transfer_id,
      'confirmed_by', p_confirmed_by,
      'customer_phone', v_transfer.customer_phone,
      'customer_name', v_transfer.customer_name,
      'transfer_reference', v_transfer.reference_code,
      'transfer_currency', v_transfer.currency,
      'transfer_expected_amount', v_transfer.expected_amount,
      '_inbound_channel_id', v_transfer.metadata->>'_inbound_channel_id',
      '_confirmation_origin', v_transfer.metadata->>'_confirmation_origin',
      '_direct_transfer', true  -- M394: durable direct-transfer provenance
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

-- ACL: preserve exact existing
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


-- ─── 2. initialize_terminal_effects (from exact M385 body) ──────────────
-- Changes:
--   a) Add 'customer_order_email' to v_allowed_keys catalog (optional)
--   b) For direct order bank transfers: exempt owner_notif_whatsapp/email from required check
--   c) Read payment.gateway + metadata for direct-transfer detection

CREATE OR REPLACE FUNCTION initialize_terminal_effects(
  p_payment_id UUID,
  p_claim_token UUID,
  p_effect_keys TEXT[],
  p_categories TEXT[],
  p_execution_classes TEXT[],
  p_provider_channels TEXT[],
  p_manifest_version INTEGER DEFAULT 1
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_existing RECORD;
  v_effect_count INTEGER;
  v_semantic_hash TEXT;
  v_tuples TEXT[];
  v_i INTEGER;
  v_inserted INTEGER := 0;
  v_contract_version INTEGER := 1;
  v_is_direct_order BOOLEAN := false;  -- M394: direct order bank transfer flag
  -- Closed Stage-3 canonical catalog (DB authority)
  -- M394: Added 'customer_order_email'
  v_allowed_keys TEXT[] := ARRAY[
    'loyalty_award', 'ticket_inventory_finalization', 'ticket_row_creation',
    'session_deactivation', 'owner_notif_inapp',
    'customer_whatsapp', 'owner_notif_whatsapp', 'owner_notif_email',
    'donation_receipt_email',
    'customer_loyalty_whatsapp', 'receipt_pdf_generation', 'receipt_pdf_delivery',
    'customer_booking_email', 'ticket_delivery_whatsapp', 'ticket_delivery_email',
    'referral_generation', 'crm_visit_increment', 'automation_rule_handoff',
    'automation_sequences', 'membership_tier_assignment', 'feedback_marker',
    'customer_order_email'  -- M394: direct order bank transfer email
  ];
BEGIN
  -- Array lengths must match
  IF array_length(p_effect_keys, 1) IS DISTINCT FROM array_length(p_categories, 1)
     OR array_length(p_effect_keys, 1) IS DISTINCT FROM array_length(p_execution_classes, 1)
     OR array_length(p_effect_keys, 1) IS DISTINCT FROM array_length(p_provider_channels, 1) THEN
    RETURN jsonb_build_object('error', 'array_length_mismatch');
  END IF;

  v_effect_count := COALESCE(array_length(p_effect_keys, 1), 0);

  -- ── CANONICAL CATALOG VALIDATION ──
  FOR v_i IN 1..v_effect_count LOOP
    IF NOT (p_effect_keys[v_i] = ANY(v_allowed_keys)) THEN
      RETURN jsonb_build_object('error', 'unknown_effect_key',
        'key', p_effect_keys[v_i]);
    END IF;

    -- Validate category + execution_class match canonical mapping
    -- Required internal effects
    IF p_effect_keys[v_i] IN ('loyalty_award', 'ticket_inventory_finalization',
      'ticket_row_creation', 'session_deactivation', 'owner_notif_inapp') THEN
      IF p_categories[v_i] != 'required_internal' OR p_execution_classes[v_i] != 'internal' THEN
        RETURN jsonb_build_object('error', 'semantic_mismatch',
          'key', p_effect_keys[v_i], 'expected_category', 'required_internal');
      END IF;
    -- Required external effects
    ELSIF p_effect_keys[v_i] IN ('customer_whatsapp', 'owner_notif_whatsapp',
      'owner_notif_email', 'donation_receipt_email') THEN
      IF p_categories[v_i] != 'required_external' OR p_execution_classes[v_i] != 'external' THEN
        RETURN jsonb_build_object('error', 'semantic_mismatch',
          'key', p_effect_keys[v_i], 'expected_category', 'required_external');
      END IF;
    -- Optional effects: verify category = optional
    ELSE
      IF p_categories[v_i] != 'optional' THEN
        RETURN jsonb_build_object('error', 'semantic_mismatch',
          'key', p_effect_keys[v_i], 'expected_category', 'optional');
      END IF;
    END IF;
  END LOOP;

  -- 1. Lock payment row (with entity FKs for required-effect derivation)
  -- M394: Also read gateway + metadata for direct-transfer detection
  SELECT id, confirmation_claim_token, confirmation_processing_at,
         confirmation_sent_at, confirmation_terminal_reason,
         finalization_completed_at,
         booking_id, reservation_id, order_id, invoice_id, campaign_id,
         gateway, metadata, payment_authority_version
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'payment_not_found');
  END IF;

  -- 2. Verify master claim token
  IF v_payment.confirmation_claim_token IS NULL
     OR v_payment.confirmation_claim_token != p_claim_token THEN
    RETURN jsonb_build_object('error', 'token_mismatch');
  END IF;

  -- 3. Not already finalized or terminated
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'already_finalized');
  END IF;
  IF v_payment.confirmation_terminal_reason IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'payment_already_terminated');
  END IF;

  -- 4. Stage-2 must be complete
  IF v_payment.finalization_completed_at IS NULL THEN
    RETURN jsonb_build_object('error', 'stage2_not_complete');
  END IF;

  -- M394: Detect direct order bank transfer
  v_is_direct_order := (
    v_payment.gateway = 'direct'
    AND v_payment.order_id IS NOT NULL
    AND v_payment.payment_authority_version IS NOT NULL
    AND v_payment.metadata IS NOT NULL
    AND (v_payment.metadata->>'_direct_transfer')::boolean IS TRUE
  );

  -- 4b. Required-effect completeness validation.
  -- M394: Direct order bank transfers exempt from owner_notif_whatsapp/email
  IF NOT v_is_direct_order THEN
    -- All non-direct payments require owner_notif_whatsapp and owner_notif_email
    IF NOT ('owner_notif_whatsapp' = ANY(p_effect_keys)) THEN
      RETURN jsonb_build_object('error', 'missing_required_effect', 'key', 'owner_notif_whatsapp');
    END IF;
    IF NOT ('owner_notif_email' = ANY(p_effect_keys)) THEN
      RETURN jsonb_build_object('error', 'missing_required_effect', 'key', 'owner_notif_email');
    END IF;
  END IF;

  -- session_deactivation: required for invoice/campaign (non-exact-entity-family)
  IF v_payment.invoice_id IS NOT NULL OR v_payment.campaign_id IS NOT NULL THEN
    IF NOT ('session_deactivation' = ANY(p_effect_keys)) THEN
      RETURN jsonb_build_object('error', 'missing_required_effect', 'key', 'session_deactivation');
    END IF;
  END IF;

  -- owner_notif_inapp: required for booking, reservation, campaign, or direct order
  IF v_payment.booking_id IS NOT NULL OR v_payment.reservation_id IS NOT NULL
     OR v_payment.campaign_id IS NOT NULL OR v_is_direct_order THEN
    IF NOT ('owner_notif_inapp' = ANY(p_effect_keys)) THEN
      RETURN jsonb_build_object('error', 'missing_required_effect', 'key', 'owner_notif_inapp');
    END IF;
  END IF;

  -- 5. Compute semantic hash from the input arrays
  v_tuples := ARRAY[]::TEXT[];
  FOR v_i IN 1..v_effect_count LOOP
    v_tuples := array_append(v_tuples,
      p_effect_keys[v_i] || '|' || p_categories[v_i] || '|' ||
      p_execution_classes[v_i] || '|' ||
      COALESCE(p_provider_channels[v_i], 'none') || '|' ||
      v_contract_version::TEXT
    );
  END LOOP;
  -- Sort for determinism
  SELECT array_agg(t ORDER BY t) INTO v_tuples FROM unnest(v_tuples) AS t;
  v_semantic_hash := encode(digest(array_to_string(COALESCE(v_tuples, ARRAY[]::TEXT[]), ','), 'sha256'), 'hex');

  -- 6. Check for existing manifest header
  SELECT * INTO v_existing FROM payment_terminal_manifests
  WHERE payment_id = p_payment_id FOR UPDATE;

  IF FOUND THEN
    IF v_existing.initialization_state = 'initialized' THEN
      -- Verify exact match for idempotent replay
      IF v_existing.expected_semantic_hash = v_semantic_hash
         AND v_existing.expected_effect_count = v_effect_count
         AND v_existing.manifest_version = p_manifest_version THEN
        RETURN jsonb_build_object('initialized', true, 'already_initialized', true,
          'effect_count', v_effect_count, 'semantic_hash', v_semantic_hash);
      ELSE
        RETURN jsonb_build_object('error', 'manifest_mismatch',
          'expected_hash', v_existing.expected_semantic_hash,
          'computed_hash', v_semantic_hash);
      END IF;
    ELSE
      -- Prior crash left initializing state. Clean up and re-initialize.
      DELETE FROM payment_terminal_effects WHERE payment_id = p_payment_id;
      DELETE FROM payment_terminal_manifests WHERE payment_id = p_payment_id;
    END IF;
  END IF;

  -- 7. Insert manifest header with initializing state
  INSERT INTO payment_terminal_manifests
    (payment_id, manifest_version, initialization_state, expected_effect_count,
     expected_semantic_hash, contract_version)
  VALUES
    (p_payment_id, p_manifest_version, 'initializing', v_effect_count,
     v_semantic_hash, v_contract_version);

  -- 8. Insert all effect rows
  FOR v_i IN 1..v_effect_count LOOP
    INSERT INTO payment_terminal_effects
      (payment_id, effect_key, category, execution_class, provider_channel, contract_version)
    VALUES
      (p_payment_id, p_effect_keys[v_i], p_categories[v_i],
       p_execution_classes[v_i], p_provider_channels[v_i], v_contract_version);
    v_inserted := v_inserted + 1;
  END LOOP;

  -- 9. Verify count
  IF v_inserted != v_effect_count THEN
    RAISE EXCEPTION 'Effect count mismatch: expected %, inserted %', v_effect_count, v_inserted;
  END IF;

  -- 10. Mark initialized
  UPDATE payment_terminal_manifests
  SET initialization_state = 'initialized', initialized_at = NOW()
  WHERE payment_id = p_payment_id;

  RETURN jsonb_build_object('initialized', true, 'already_initialized', false,
    'effect_count', v_effect_count, 'semantic_hash', v_semantic_hash);
END;
$$;

-- ACL: preserve exact existing from M385
REVOKE ALL ON FUNCTION initialize_terminal_effects(UUID, UUID, TEXT[], TEXT[], TEXT[], TEXT[], INTEGER) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION initialize_terminal_effects(UUID, UUID, TEXT[], TEXT[], TEXT[], TEXT[], INTEGER) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION initialize_terminal_effects(UUID, UUID, TEXT[], TEXT[], TEXT[], TEXT[], INTEGER) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION initialize_terminal_effects(UUID, UUID, TEXT[], TEXT[], TEXT[], TEXT[], INTEGER) TO service_role;
  END IF;
END $$;


-- ─── Self-verification ──────────────────────────────────────────────────

DO $$
BEGIN
  -- Verify confirm_order_transfer_atomic exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'confirm_order_transfer_atomic'
  ) THEN
    RAISE EXCEPTION 'M394 verification FAILED: confirm_order_transfer_atomic not found';
  END IF;

  -- Verify initialize_terminal_effects exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'initialize_terminal_effects'
  ) THEN
    RAISE EXCEPTION 'M394 verification FAILED: initialize_terminal_effects not found';
  END IF;

  RAISE NOTICE 'M394 self-verification PASSED: both functions exist';
END $$;
